"""
clip_renderer.py — cuts the chosen highlight windows into finished clips.

One FFmpeg process per clip, run sequentially. Sequential is deliberate: this
app targets a 2-core / 4 GB laptop, libx264 already uses both cores, and two
concurrent encodes there are slower *and* riskier than one at a time (RAM).

Per clip it does, in a single pass:
  * accurate cut            -ss/-t on the input, so seeking is cheap
  * tighten                 optional: cut dead air and filler words out
  * reframe                 centre crop, blurred-background fill, or a crop
                            that follows the movement
  * look                    one cheap eq/colorbalance/curves preset
  * hook + logo             optional headline at the top, optional watermark
  * captions                word-by-word .ass burned in (plus a .srt kept)
  * music                   per-clip file, per-clip volume, optional ducking

It also writes a small .txt beside each clip with a title, a description and
hashtags built from that clip's own speech.

If FFmpeg refuses a command, the clip is retried with features peeled off one
at a time (duck -> caption burn -> source audio) instead of failing the whole
batch, and the reason is reported back as a per-clip warning.

Usage: python clip_renderer.py <config_json_path>
"""

import json
import os
import re
import subprocess
import sys

import progress
from render_video import run_ffmpeg, _ts_ass, _ts_srt, _ass_escape

PRESET = "veryfast"        # real footage, not slideshows: veryfast pays off
CRF = "23"
AUDIO_BITRATE = "128k"

RESOLUTIONS = {
    "vertical": {"720": (720, 1280), "1080": (1080, 1920)},
    "square":   {"720": (720, 720),  "1080": (1080, 1080)},
    "wide":     {"720": (1280, 720), "1080": (1920, 1080)},
}

CROP_SIZES = {
    "vertical": ("min(iw,ih*9/16)", "min(ih,iw*16/9)"),
    "square":   ("min(iw,ih)",      "min(iw,ih)"),
    "wide":     ("min(iw,ih*16/9)", "min(ih,iw*9/16)"),
}

CROPS = {key: "crop='%s':'%s'" % value for key, value in CROP_SIZES.items()}

# How the source frame is fitted into the output frame. Mirrored in
# FRAMING_KEYS (main.js) and FRAMINGS (renderer.js).
#   crop  — centre crop: fills the frame, loses the sides
#   blur  — whole frame kept, a blurred copy of it fills the space around it
#   track — a crop that follows wherever the movement is
FRAMING_MODES = ("crop", "blur", "track")
FRAMING_FALLBACK = "crop"

# The blurred background is made from a thumbnail-sized copy, not the full
# frame. Blurring 72x128 pixels costs nothing and, once it is scaled back up,
# looks the same as an expensive large-radius blur on the full frame. That
# matters on a 2-core laptop, where a full-frame gblur can cost more than the
# encode itself.
BLUR_SMALL_EDGE = 72
BLUR_SIGMA = 6

# Motion tracking samples this many frames per second of clip.
TRACK_FPS = 4
TRACK_GRID_W = 64
TRACK_GRID_H = 36
TRACK_MAX_POINTS = 12          # breakpoints in the crop-x expression
TRACK_MAX_STEP = 0.10          # how far the crop may travel between samples

# Cheap looks only — every one of these is a per-pixel LUT-ish operation, not a
# multi-frame filter, so they cost almost nothing next to the encode itself.
LOOKS = {
    "none": "",
    "vivid": "eq=saturation=1.35:contrast=1.12",
    "warm": "colorbalance=rs=0.06:gs=0.01:bs=-0.06,eq=saturation=1.10",
    "cool": "colorbalance=rs=-0.06:bs=0.08,eq=saturation=1.05",
    "cinematic": "curves=preset=increase_contrast,eq=saturation=0.92:contrast=1.06",
    "bright": "eq=brightness=0.06:contrast=1.06:saturation=1.10",
    "bw": "hue=s=0,eq=contrast=1.15",
    "sharp": "unsharp=5:5:0.9:5:5:0.0",
    "soft": "gblur=sigma=0.65,eq=brightness=0.025:saturation=1.04",
    "moody": "eq=brightness=-0.045:contrast=1.20:saturation=0.82",
    "golden": "colorbalance=rs=0.10:gs=0.045:bs=-0.10,eq=saturation=1.14",
    "teal_orange": "colorbalance=rs=0.07:gs=0.015:bs=0.09,eq=contrast=1.10:saturation=1.08",
    "pastel": "eq=brightness=0.055:contrast=0.88:saturation=0.78",
    "dream": "gblur=sigma=1.05,eq=brightness=0.065:saturation=1.12",
    "noir": "hue=s=0,eq=contrast=1.32:brightness=-0.035",
    "vhs": "eq=saturation=0.78:contrast=1.12,noise=alls=7:allf=t",
    "grain": "noise=alls=9:allf=t,eq=contrast=1.06:saturation=0.96",
    "neon": "eq=saturation=1.55:contrast=1.18:brightness=-0.01",
    "fade": "eq=contrast=0.82:brightness=0.045:saturation=0.72",
    "vignette": "vignette=PI/5,eq=contrast=1.08",
}

# ----------------------------------------------------------------- captions
#
# Caption templates. Adding a key here means adding it in two other places too:
#   * CAPTION_TEMPLATE_KEYS in main.js   — the IPC whitelist
#   * CAPTION_TEMPLATES in renderer.js   — the gallery tile and both dropdowns
#
# Colours are ASS BGR hex (blue, green, red) — byte-reversed from web #RRGGBB.
# Fonts are restricted to faces a stock Windows install actually has; libass
# silently falls back to a default face for anything missing, which turns a
# distinctive template into a plain one.
CAPTION_DEFAULTS = {
    "font": None,            # None = whatever the config asked for
    "size": 0.050,           # share of frame height
    "primary": "FFFFFF",     # the text itself
    "outline_colour": "000000",
    "back": "000000",        # box colour when border == 3, else shadow colour
    "back_alpha": "80",      # 00 solid … FF invisible
    "border": 1,             # 1 = outline + shadow, 3 = filled box
    "outline": 3,
    "shadow": 0,
    "bold": -1,              # -1 = on, 0 = off
    "italic": 0,
    "spacing": 0,            # extra px between letters
    "scale_x": 100,
    "scale_y": 100,
    "align": 2,              # ASS numpad: 2 bottom-centre, 5 middle, 8 top
    "margin_v": 0.16,        # share of frame height
    "upper": False,
    "words": 3,              # words per caption
    "highlight": None,       # active-word colour (BGR) → one event per word
    "hl_scale": None,        # active-word scale, percent
    "fade": None,            # (in_ms, out_ms)
    "pop": False,            # scale-in on every caption
}

CAPTION_TEMPLATES = {
    # -- the three original styles, kept under their old keys ---------------
    "bold": {"font": "Impact", "size": 0.058, "outline": 5, "shadow": 1,
             "upper": True, "spacing": 1},
    "boxed": {"font": "Arial Black", "size": 0.046, "border": 3, "outline": 2,
              "back_alpha": "A0", "margin_v": 0.12},
    "clean": {"font": "Arial", "size": 0.042, "outline": 2, "bold": 0,
              "words": 5},

    # -- word-by-word highlight, the look most caption tools sell -----------
    "karaoke": {"font": "Arial Black", "size": 0.052, "outline": 4,
                "upper": True, "highlight": "00E5FF", "hl_scale": 108},
    "karaoke_green": {"font": "Arial Black", "size": 0.052, "outline": 4,
                      "upper": True, "highlight": "40E070", "hl_scale": 108},
    "hormozi": {"font": "Impact", "size": 0.060, "outline": 6, "shadow": 2,
                "upper": True, "spacing": 1, "highlight": "00D9FF",
                "hl_scale": 112, "margin_v": 0.20},
    "beast": {"font": "Arial Black", "size": 0.058, "outline": 6, "shadow": 2,
              "upper": True, "highlight": "3030FF", "hl_scale": 110},
    "pop_word": {"font": "Impact", "size": 0.080, "outline": 6, "shadow": 1,
                 "upper": True, "words": 1, "pop": True, "align": 5,
                 "spacing": 2},
    "one_word": {"font": "Arial Black", "size": 0.070, "outline": 5,
                 "upper": True, "words": 1, "fade": (60, 60)},

    # -- colour-led looks ---------------------------------------------------
    "neon": {"font": "Arial Black", "size": 0.052, "primary": "FFFF00",
             "outline_colour": "800040", "outline": 4, "upper": True,
             "highlight": "FF40FF", "hl_scale": 106},
    "sunset": {"font": "Arial Black", "size": 0.052, "primary": "40C0FF",
               "outline_colour": "201040", "outline": 4, "upper": True},
    "yellow": {"font": "Arial Black", "size": 0.048, "primary": "00E0FF",
               "outline": 4, "upper": True},
    "mint": {"font": "Verdana", "size": 0.046, "primary": "C0FFD0",
             "outline_colour": "203020", "outline": 3, "words": 4},
    "alert": {"font": "Arial Black", "size": 0.046, "border": 3,
              "back": "2020D0", "back_alpha": "20", "outline": 2,
              "upper": True, "margin_v": 0.14},
    "sticker": {"font": "Arial Black", "size": 0.044, "primary": "101010",
                "border": 3, "back": "F0F0F0", "back_alpha": "10",
                "outline": 2, "upper": True, "margin_v": 0.13},

    # -- quieter, editorial looks -------------------------------------------
    "podcast": {"font": "Verdana", "size": 0.040, "border": 3, "outline": 2,
                "back_alpha": "70", "bold": 0, "words": 6, "margin_v": 0.11},
    "tiktok": {"font": "Arial", "size": 0.042, "border": 3, "outline": 2,
               "back_alpha": "50", "words": 4, "margin_v": 0.22},
    "minimal": {"font": "Segoe UI", "size": 0.038, "outline": 0, "shadow": 2,
                "bold": 0, "words": 5, "spacing": 1},
    "serif": {"font": "Georgia", "size": 0.040, "primary": "DCF8FF",
              "italic": -1, "bold": 0, "outline": 2, "words": 5},
    "mono": {"font": "Courier New", "size": 0.038, "primary": "60FF60",
             "border": 3, "back_alpha": "30", "outline": 2, "words": 5},
    "news": {"font": "Franklin Gothic Medium", "size": 0.040, "border": 3,
             "back": "301010", "back_alpha": "30", "outline": 2,
             "upper": True, "margin_v": 0.09, "spacing": 1},

    # -- placement variants, for sources that already carry burned-in text --
    "top": {"font": "Impact", "size": 0.054, "outline": 5, "shadow": 1,
            "upper": True, "align": 8, "margin_v": 0.08},
    "top_box": {"font": "Arial Black", "size": 0.044, "border": 3,
                "outline": 2, "back_alpha": "90", "align": 8,
                "margin_v": 0.07, "words": 4},
    "middle": {"font": "Arial Black", "size": 0.060, "outline": 5,
               "upper": True, "align": 5, "highlight": "00E5FF"},
}

CAPTION_FALLBACK = "bold"

SLUG_RE = re.compile(r"[^A-Za-z0-9]+")

# Ducking: lower the music while the original audio is loud.
#
# The first version of this used threshold=0.03 with ratio=12, far past FFmpeg's
# own defaults (0.125 and 2). On a football highlight the crowd never drops
# below -30 dBFS, so the compressor held the music roughly 14 dB down for the
# whole clip and the result sounded like no music had been added at all. These
# values duck two or three dB in normal passages and more only under a genuinely
# loud moment, which is what ducking is supposed to do.
DUCK_FILTER = "sidechaincompress=threshold=0.125:ratio=4:attack=20:release=400"

# amix with normalize=0 sums both tracks, so loud source audio plus loud music
# can push past full scale and clip in the AAC encoder. One cheap limiter on the
# mix keeps the peaks in range; it is the first thing dropped if this FFmpeg
# build does not have alimiter.
LIMIT_FILTER = "alimiter=limit=0.95:attack=5:release=50"

# Words dropped when "cut filler words" is on. Both English and the Roman-Urdu
# equivalents, because that is what this tool is mostly pointed at.
FILLER_WORDS = {
    "um", "umm", "uh", "uhh", "uhm", "er", "err", "ah", "ahh", "hmm", "hm",
    "mm", "mmm", "eh", "aa", "aaa", "oh", "ohh", "like", "basically",
    "actually", "literally", "yeah", "ya", "yah", "matlab", "yani", "yaani",
    "acha", "achha", "bas", "toh", "phir", "haan", "han", "jee", "ji",
}

# Not worth turning into a hashtag.
STOPWORDS = {
    "the", "and", "for", "you", "your", "that", "this", "with", "have", "has",
    "was", "were", "are", "but", "not", "all", "can", "will", "just", "from",
    "they", "them", "then", "than", "what", "when", "who", "why", "how", "his",
    "her", "him", "she", "their", "there", "here", "been", "being", "into",
    "out", "over", "very", "more", "most", "some", "any", "one", "two", "get",
    "got", "going", "gonna", "know", "think", "want", "make", "made", "did",
    "does", "done", "say", "says", "said", "see", "look", "come", "came",
    "would", "could", "should", "about", "because", "also", "even", "much",
    "many", "well", "back", "time", "thing", "things", "let", "lets", "our",
    "yes", "yeah", "okay", "right", "now", "still", "only", "which", "where",
    "hai", "hain", "tha", "thi", "the", "kar", "karo", "karna", "ka", "ki",
    "ke", "ko", "se", "me", "mein", "aur", "yeh", "yah", "wo", "woh", "kya",
    "nahi", "ni", "bhi", "hi", "ho", "hoga", "par", "pe", "apni", "apna",
}
STOPWORDS |= FILLER_WORDS

WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’]+")

_FILTER_CACHE = {}


def available_filters(ffmpeg_path):
    """The set of filter names this FFmpeg build has.

    Cheaper and far clearer than discovering a missing filter through a failed
    encode: gblur, alimiter and sidechaincompress are all absent from some
    minimal builds, and each one has a usable substitute. If the probe itself
    fails, an empty set is returned and every caller falls back to assuming the
    filter exists — DEGRADE_STEPS is still there as the second net.
    """
    key = str(ffmpeg_path)
    if key in _FILTER_CACHE:
        return _FILTER_CACHE[key]
    names = set()
    try:
        out = subprocess.run(
            [key, "-hide_banner", "-filters"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=25, text=True, encoding="utf-8", errors="replace",
        ).stdout or ""
        for line in out.splitlines():
            parts = line.split()
            # " T.. gblur   V->V  Apply Gaussian Blur filter."
            if len(parts) >= 3 and len(parts[0]) <= 4:
                names.add(parts[1])
    except Exception:                                   # noqa: BLE001
        names = set()
    _FILTER_CACHE[key] = names
    return names


def has_filter(ffmpeg_path, name):
    names = available_filters(ffmpeg_path)
    return (not names) or (name in names)


def clamp(value, low, high):
    return max(low, min(high, value))


def to_float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def resolution_for(aspect, quality):
    table = RESOLUTIONS.get(aspect) or RESOLUTIONS["vertical"]
    return table.get(str(quality)) or table["720"]


def _even(value):
    value = int(round(value))
    return value if value % 2 == 0 else value + 1


# ------------------------------------------------------------------- framing

def scan_motion(ffmpeg_path, source, start, duration):
    """Where the movement is, sampled across the clip.

    Decodes the clip once into 64x36 greyscale frames and compares each frame
    with the one before it. The columns that changed the most are where the
    action is, so a crop that follows that centroid keeps the ball, the player
    or the speaker in shot instead of whatever happens to sit in the middle.

    This is motion, not face recognition — it needs no extra library and no
    model download, which is the whole reason it is done this way. Returns a
    list of (time, 0..1 horizontal position), or [] if anything goes wrong.
    """
    frame_bytes = TRACK_GRID_W * TRACK_GRID_H
    cmd = [
        str(ffmpeg_path), "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", "%.3f" % start, "-t", "%.3f" % duration, "-i", source,
        "-an", "-sn",
        "-vf", "fps=%d,scale=%d:%d,format=gray" % (TRACK_FPS, TRACK_GRID_W, TRACK_GRID_H),
        "-f", "rawvideo", "-",
    ]
    try:
        raw = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=max(40.0, duration * 4.0),
        ).stdout or b""
    except Exception:                                   # noqa: BLE001
        return []

    count = len(raw) // frame_bytes
    if count < 3:
        return []

    still = frame_bytes * 2          # below this the frame barely changed
    points = []
    for index in range(1, count):
        before = raw[(index - 1) * frame_bytes:index * frame_bytes]
        after = raw[index * frame_bytes:(index + 1) * frame_bytes]
        cols = [0] * TRACK_GRID_W
        for row in range(TRACK_GRID_H):
            base = row * TRACK_GRID_W
            for col in range(TRACK_GRID_W):
                delta = before[base + col] - after[base + col]
                cols[col] += delta if delta >= 0 else -delta
        total = sum(cols)
        moment = index / float(TRACK_FPS)
        if total < still:
            points.append((moment, None))               # nothing moved: hold
        else:
            centre = sum(col * cols[col] for col in range(TRACK_GRID_W))
            points.append((moment, (centre / total) / (TRACK_GRID_W - 1)))
    return points


def smooth_track(points):
    """Turn raw per-frame centroids into a path a camera could plausibly take.

    Three passes: hold the last known position through still frames, average
    each point with its neighbours, then refuse to move more than
    TRACK_MAX_STEP per sample. Without the last one the crop snaps across the
    frame on a cut and the clip looks broken.
    """
    filled = []
    last = 0.5
    for moment, ratio in points:
        if ratio is None:
            ratio = last
        last = clamp(ratio, 0.0, 1.0)
        filled.append((moment, last))
    if not filled:
        return []

    averaged = []
    for index, (moment, ratio) in enumerate(filled):
        window = filled[max(0, index - 2):index + 3]
        averaged.append((moment, sum(item[1] for item in window) / len(window)))

    limited = [averaged[0]]
    for moment, ratio in averaged[1:]:
        previous = limited[-1][1]
        step = clamp(ratio - previous, -TRACK_MAX_STEP, TRACK_MAX_STEP)
        limited.append((moment, clamp(previous + step, 0.0, 1.0)))

    # Thin the path down to a handful of breakpoints: the crop expression is
    # evaluated for every frame, so it has to stay short.
    if len(limited) > TRACK_MAX_POINTS:
        stride = len(limited) / float(TRACK_MAX_POINTS)
        picked = [limited[min(len(limited) - 1, int(i * stride))]
                  for i in range(TRACK_MAX_POINTS)]
        limited = picked
    return limited


def track_ratio_expr(points):
    """An FFmpeg expression for the 0..1 crop centre at time t, straight lines
    between the sampled points and a hold after the last one."""
    if not points:
        return "0.5"
    if len(points) == 1:
        return "%.4f" % points[0][1]
    expr = "%.4f" % points[-1][1]
    for index in range(len(points) - 2, -1, -1):
        moment, ratio = points[index]
        next_moment, next_ratio = points[index + 1]
        span = max(0.05, next_moment - moment)
        slope = (next_ratio - ratio) / span
        expr = "if(lt(t,%.3f),(%.4f+(%.4f)*(t-%.3f)),%s)" % (
            next_moment, ratio, slope, moment, expr
        )
    return "clip(%s,0,1)" % expr


def framing_chains(plan, opts, in_label, out_label):
    """The filter chains that fit one source frame into the output frame.

    Every mode ends by writing `out_label`, so the look, the captions and the
    logo can be appended by the caller without caring which mode ran.
    """
    width, height = plan["geometry"]
    aspect = plan["aspect"]
    mode = opts.get("framing") or FRAMING_FALLBACK
    fit = "scale=%d:%d:force_original_aspect_ratio=decrease" % (width, height)
    pad = "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black" % (width, height)

    if mode == "blur":
        # A thumbnail-sized copy is blurred and blown back up to fill the frame,
        # so nothing is cropped away and there are no black bars either.
        if width <= height:
            small_w = BLUR_SMALL_EDGE
        else:
            small_w = _even(BLUR_SMALL_EDGE * width / float(height))
        small_h = _even(small_w * height / float(width))
        blur = opts.get("blur_filter") or ("gblur=sigma=%d" % BLUR_SIGMA)
        return [
            "[%s]split=2[bgsrc][fgsrc]" % in_label,
            "[bgsrc]scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,%s,"
            "scale=%d:%d,eq=brightness=-0.06:saturation=1.15[bgv]"
            % (small_w, small_h, small_w, small_h, blur, width, height),
            "[fgsrc]%s[fgv]" % fit,
            "[bgv][fgv]overlay=(W-w)/2:(H-h)/2[%s]" % out_label,
        ]

    if mode == "track" and plan.get("track_expr"):
        w_expr, h_expr = CROP_SIZES.get(aspect, CROP_SIZES["vertical"])
        # x is re-evaluated every frame; clip() keeps the window inside the
        # source however far the tracked centre wanders.
        crop = ("crop=w='%s':h='%s':x='clip((%s)*iw-ow/2,0,iw-ow)':y='(ih-oh)/2'"
                % (w_expr, h_expr, plan["track_expr"]))
        return ["[%s]%s,%s,%s[%s]" % (in_label, crop, fit, pad, out_label)]

    return ["[%s]%s,%s,%s[%s]"
            % (in_label, CROPS.get(aspect, CROPS["vertical"]), fit, pad, out_label)]


def _flush(group):
    # The per-word timings are kept, not just the joined phrase: the highlight
    # templates need to know when each individual word is spoken.
    return {
        "text": " ".join(item["text"] for item in group),
        "start": group[0]["start"],
        "end": group[-1]["end"],
        "words": [dict(item) for item in group],
    }


def template_for(name):
    """A full template dict — the named one merged over the defaults."""
    tpl = dict(CAPTION_DEFAULTS)
    tpl.update(CAPTION_TEMPLATES.get(str(name or ""), CAPTION_TEMPLATES[CAPTION_FALLBACK]))
    return tpl


def cue_span_for(words_per_cue):
    """How long one caption may stay up. Longer captions need a longer window
    or every line would be cut off after three words anyway."""
    return 1.6 if words_per_cue <= 3 else 0.55 * words_per_cue


def cues_from_words(words, start, end, max_words=3, max_span=1.6):
    """Short 2-3 word cues — the caption rhythm short-form editors actually use."""
    cues = []
    group = []
    for item in words or []:
        text = str(item.get("word", "")).strip()
        word_start = to_float(item.get("start"), -1.0)
        word_end = to_float(item.get("end"), -1.0)
        if not text or word_start < 0 or word_end <= word_start:
            continue
        if word_end <= start or word_start >= end:
            continue
        word_start = max(word_start, start)
        word_end = min(word_end, end)

        if group and (
            len(group) >= max_words
            or (word_end - group[0]["start"]) > max_span
            or (word_start - group[-1]["end"]) > 0.6      # a pause ends the cue
        ):
            cues.append(_flush(group))
            group = []
        group.append({"text": text, "start": word_start, "end": word_end})

    if group:
        cues.append(_flush(group))
    return cues


def cues_from_segments(segments, start, end):
    cues = []
    for seg in segments or []:
        text = " ".join(str(seg.get("text", "")).split())
        seg_start = to_float(seg.get("start"), -1.0)
        seg_end = to_float(seg.get("end"), -1.0)
        if not text or seg_start < 0 or seg_end <= seg_start:
            continue
        if seg_end <= start or seg_start >= end:
            continue
        cues.append({
            "text": text,
            "start": max(seg_start, start),
            "end": min(seg_end, end),
            "words": [],
        })
    return cues


# ------------------------------------------------------ tighten (dead air)

MIN_KEEP = 0.25                # never keep a sliver shorter than this
MAX_KEEP_SEGMENTS = 24         # more than this and the filter graph gets silly
MIN_TIGHTEN_GAIN = 0.4         # not worth the extra filters below this


def normalise_word(text):
    return re.sub(r"[^a-z']", "", str(text).lower())


def keep_segments(words, start, end, max_gap=0.35, drop_fillers=True, pad=0.12):
    """Which parts of the clip survive once dead air is taken out.

    Anything longer than max_gap between two spoken words is a pause worth
    losing; anything shorter is natural rhythm and cutting it makes speech sound
    glued together. Filler words are simply never given a segment of their own.

    Returns absolute (start, end) pairs, or None when there is nothing worth
    cutting — including the case where the clip has no speech at all, which is
    normal for a football or gameplay highlight and must not be mangled.
    """
    spans = []
    for item in words or []:
        text = str(item.get("word", item.get("text", ""))).strip()
        word_start = to_float(item.get("start"), -1.0)
        word_end = to_float(item.get("end"), -1.0)
        if not text or word_start < 0 or word_end <= word_start:
            continue
        if word_end <= start or word_start >= end:
            continue
        if drop_fillers and normalise_word(text) in FILLER_WORDS:
            continue
        spans.append([max(start, word_start - pad), min(end, word_end + pad)])
    if not spans:
        return None

    spans.sort(key=lambda span: span[0])
    merged = [spans[0]]
    for span in spans[1:]:
        if span[0] - merged[-1][1] <= max_gap:
            merged[-1][1] = max(merged[-1][1], span[1])
        else:
            merged.append(span)

    # Keep a breath at the front and let the clip run on a little at the end:
    # the moment after the last word is often the reaction shot.
    merged[0][0] = max(start, merged[0][0] - 0.13)
    merged[-1][1] = min(end, merged[-1][1] + 0.9)

    merged = [span for span in merged if span[1] - span[0] >= MIN_KEEP]
    if not merged:
        return None

    # Too many pieces: give back the smallest gaps until the count is sane.
    while len(merged) > MAX_KEEP_SEGMENTS:
        gaps = [(merged[i + 1][0] - merged[i][1], i) for i in range(len(merged) - 1)]
        _, index = min(gaps)
        merged[index][1] = merged[index + 1][1]
        del merged[index + 1]

    kept = sum(span[1] - span[0] for span in merged)
    if len(merged) < 2 or (end - start) - kept < MIN_TIGHTEN_GAIN:
        return None
    return [(span[0], span[1]) for span in merged]


def compact_time(segments, moment):
    """Map an absolute source time onto the tightened timeline.

    Returns (time, kept) — kept is False when that moment was cut away, and the
    time then lands on the seam where it used to be.
    """
    offset = 0.0
    for seg_start, seg_end in segments:
        if moment < seg_start:
            return offset, False
        if moment <= seg_end:
            return offset + (moment - seg_start), True
        offset += seg_end - seg_start
    return offset, False


def remap_cues(cues, segments):
    """Move cues (and their word timings) onto the tightened timeline."""
    out = []
    for cue in cues:
        cue_start, start_kept = compact_time(segments, cue["start"])
        cue_end, end_kept = compact_time(segments, cue["end"])
        if not start_kept and not end_kept and cue_end - cue_start < 0.08:
            continue                                # this cue was cut away
        if cue_end <= cue_start:
            cue_end = cue_start + 0.30
        words = []
        for word in cue.get("words") or []:
            word_start, _ = compact_time(segments, word["start"])
            word_end, _ = compact_time(segments, word["end"])
            if word_end <= word_start:
                word_end = word_start + 0.12
            words.append({"text": word["text"], "start": word_start, "end": word_end})
        out.append({"text": cue["text"], "start": cue_start, "end": cue_end,
                    "words": words})
    return out


def shift_and_clean(cues, start, duration):
    """Rebase cues onto the clip's own timeline and remove overlaps."""
    out = []
    for cue in cues:
        cue_start = clamp(cue["start"] - start, 0.0, duration)
        cue_end = clamp(cue["end"] - start, 0.0, duration)
        if cue_end - cue_start < 0.12:
            cue_end = min(duration, cue_start + 0.35)
        if cue_end - cue_start < 0.10:
            continue
        words = []
        for word in cue.get("words") or []:
            word_start = clamp(word["start"] - start, 0.0, duration)
            word_end = clamp(word["end"] - start, 0.0, duration)
            if word_end <= word_start:
                word_end = min(duration, word_start + 0.12)
            words.append({"text": word["text"], "start": word_start, "end": word_end})
        out.append({"text": cue["text"], "start": cue_start, "end": cue_end,
                    "words": words})

    out.sort(key=lambda c: c["start"])
    for index in range(len(out) - 1):
        if out[index]["end"] > out[index + 1]["start"]:
            out[index]["end"] = out[index + 1]["start"]
    return [c for c in out if c["end"] - c["start"] >= 0.10]


def _style_colour(bgr, alpha="00"):
    """ASS Style field colour: &HAABBGGRR."""
    return "&H%s%s" % (str(alpha).upper()[:2], str(bgr).upper()[:6].rjust(6, "0"))


def _inline_colour(bgr):
    """Inline override colour: \\1c&HBBGGRR& — no alpha byte here."""
    return "\\1c&H%s&" % str(bgr).upper()[:6].rjust(6, "0")


def _cue_text(text, tpl):
    return str(text).upper() if tpl["upper"] else str(text)


def _cue_prefix(tpl):
    """Tags that apply to a whole caption: fade, and the scale-in 'pop'."""
    tags = ""
    fade = tpl.get("fade")
    if fade:
        tags += "\\fad(%d,%d)" % (int(fade[0]), int(fade[1]))
    if tpl.get("pop") and not tpl.get("highlight"):
        tags += "\\fscx86\\fscy86\\t(0,120,\\fscx%d\\fscy%d)" % (
            tpl["scale_x"], tpl["scale_y"]
        )
    return "{%s}" % tags if tags else ""


def _plain_events(cue, tpl):
    prefix = _cue_prefix(tpl)
    return [(cue["start"], cue["end"],
             prefix + _ass_escape(_cue_text(cue["text"], tpl)))]


def _highlight_events(cue, tpl):
    """One event per word: the whole phrase stays on screen and the word being
    spoken changes colour. That is what every short-form caption tool sells as
    'animated' captions, and libass draws it with plain inline overrides — no
    real animation, so it costs nothing at encode time."""
    words = cue.get("words") or []
    if not words:
        return _plain_events(cue, tpl)

    prefix = _cue_prefix(tpl)
    cold = _inline_colour(tpl["primary"])
    hot = _inline_colour(tpl["highlight"])
    scale = tpl.get("hl_scale")
    events = []
    cursor = cue["start"]

    for position, word in enumerate(words):
        # Two rules here. The phrase must not blink between words, so an event
        # runs until the *next* word starts rather than until this one stops
        # being spoken. And events must never overlap: libass stacks overlapping
        # events vertically, which would show the caption twice for a frame.
        start = max(cursor, cue["start"] if position == 0 else word["start"])
        if position + 1 < len(words):
            end = max(words[position + 1]["start"], start + 0.06)
        else:
            end = cue["end"]
        end = min(end, cue["end"])
        if end - start < 0.05:
            continue
        cursor = end

        parts = []
        for other, item in enumerate(words):
            text = _ass_escape(_cue_text(item["text"], tpl))
            if other != position:
                parts.append(text)
                continue
            lead = hot
            trail = cold
            if scale:
                lead += "\\fscx%d\\fscy%d" % (scale, scale)
                trail += "\\fscx%d\\fscy%d" % (tpl["scale_x"], tpl["scale_y"])
            parts.append("{%s}%s{%s}" % (lead, text, trail))
        events.append((start, end, prefix + " ".join(parts)))

    return events or _plain_events(cue, tpl)


def _style_line(name, tpl, width, height):
    """One [V4+ Styles] row — 23 fields, matching the Format line exactly."""
    font_size = max(16, int(height * tpl["size"]))
    margin_v = int(height * tpl["margin_v"])
    margin_h = int(width * 0.08)
    # Secondary colour is what libass uses for un-sung karaoke text; pointing it
    # at the highlight colour keeps the file sensible if it is ever reused.
    secondary = _style_colour(tpl["highlight"] or "0000FF")
    return (
        "Style: %s,%s,%d,%s,%s,%s,%s,%d,%d,0,0,%d,%d,%d,0,"
        "%d,%d,%d,%d,%d,%d,%d,1\n"
    ) % (name, tpl["font"], font_size,
         _style_colour(tpl["primary"]), secondary,
         _style_colour(tpl["outline_colour"]),
         _style_colour(tpl["back"], tpl["back_alpha"]),
         tpl["bold"], tpl["italic"], tpl["scale_x"], tpl["scale_y"], tpl["spacing"],
         tpl["border"], tpl["outline"], tpl["shadow"], tpl["align"],
         margin_h, margin_h, margin_v)


def hook_template(tpl, font):
    """The headline style: same face as the captions, always at the other end of
    the frame so the two can never collide, and always in a soft box so it stays
    readable over any footage."""
    hook = dict(tpl)
    hook.update({
        "font": font,
        "size": clamp(tpl["size"] * 0.86, 0.038, 0.052),
        "primary": "FFFFFF",
        "outline_colour": "000000",
        "back": "000000",
        "back_alpha": "40",
        "border": 3,
        "outline": 2,
        "shadow": 0,
        "bold": -1,
        "italic": 0,
        "spacing": 0,
        "scale_x": 100,
        "scale_y": 100,
        "upper": False,
        "align": 2 if int(tpl["align"]) == 8 else 8,
        "margin_v": 0.07,
        "highlight": None,
        "hl_scale": None,
        "fade": None,
        "pop": False,
    })
    return hook


def apply_colour_overrides(tpl, overrides):
    """The user's own caption colours, if they asked for them.

    A highlight colour is only applied to a template that already highlights
    word by word — adding one to a plain template would silently change what
    that template is.
    """
    if not overrides:
        return tpl
    primary = str(overrides.get("primary") or "").strip()
    highlight = str(overrides.get("highlight") or "").strip()
    if primary:
        tpl["primary"] = primary[:6].rjust(6, "0")
    if highlight and tpl.get("highlight"):
        tpl["highlight"] = highlight[:6].rjust(6, "0")
    return tpl


def write_clip_subtitles(cues, ass_path, srt_path, width, height, style_name,
                         font_name, hook="", hook_seconds=0.0, overrides=None):
    tpl = apply_colour_overrides(template_for(style_name), overrides)
    font = tpl["font"] or font_name
    tpl["font"] = font
    hook_text = " ".join(str(hook or "").split())

    styles = _style_line("Default", tpl, width, height)
    if hook_text:
        styles += _style_line("Hook", hook_template(tpl, font), width, height)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "PlayResX: %d\n"
        "PlayResY: %d\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "%s\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    ) % (width, height, styles)

    with open(ass_path, "w", encoding="utf-8") as handle:
        handle.write(header)
        if hook_text:
            # Layer 1 so it draws above the captions if a template ever puts
            # them in the same band.
            handle.write(
                "Dialogue: 1,%s,%s,Hook,,0,0,0,,%s\n"
                % (_ts_ass(0.0), _ts_ass(max(1.0, hook_seconds)),
                   _ass_escape(hook_text))
            )
        for cue in cues:
            events = (_highlight_events(cue, tpl) if tpl.get("highlight")
                      else _plain_events(cue, tpl))
            for start, end, text in events:
                handle.write(
                    "Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n"
                    % (_ts_ass(start), _ts_ass(end), text)
                )

    # The .srt keeps the original casing and one entry per phrase — it is meant
    # for uploading alongside the clip, not for matching the burned-in look.
    # srt_path is None for the spare copy of the captions, which only exists in
    # case tightening has to be dropped.
    if srt_path:
        with open(srt_path, "w", encoding="utf-8") as handle:
            for index, cue in enumerate(cues, start=1):
                handle.write(
                    "%d\n%s --> %s\n%s\n\n"
                    % (index, _ts_srt(cue["start"]), _ts_srt(cue["end"]), cue["text"])
                )


# --------------------------------------------------- title, tags, description

BASE_TAGS = {
    "vertical": ["#shorts", "#reels", "#viral"],
    "square": ["#reels", "#viral"],
    "wide": ["#youtube", "#viral"],
}


def clip_speech(item, start, end):
    """Everything said inside the clip, as one line of plain text."""
    parts = []
    for seg in item.get("segments") or []:
        seg_start = to_float(seg.get("start"), -1.0)
        seg_end = to_float(seg.get("end"), -1.0)
        if seg_end <= start or seg_start >= end:
            continue
        text = " ".join(str(seg.get("text", "")).split())
        if text:
            parts.append(text)
    if not parts:
        for word in item.get("words") or []:
            word_start = to_float(word.get("start"), -1.0)
            if start <= word_start < end:
                text = str(word.get("word", "")).strip()
                if text:
                    parts.append(text)
    return " ".join(parts).strip()


def make_title(text, fallback, limit=70):
    """The first sentence, cut at a word boundary — not mid-word."""
    first = re.split(r"(?<=[.!?])\s+", text.strip())[0] if text.strip() else ""
    first = " ".join(first.split())
    if not first:
        return str(fallback)
    if len(first) > limit:
        first = first[:limit].rsplit(" ", 1)[0] + "…"
    return first[0].upper() + first[1:]


def make_hashtags(text, aspect, limit=6):
    counts = {}
    for match in WORD_RE.findall(text.lower()):
        word = match.strip("'’")
        if len(word) < 4 or word in STOPWORDS:
            continue
        counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    tags = list(BASE_TAGS.get(aspect, BASE_TAGS["vertical"]))
    for word, _count in ranked:
        tag = "#" + word
        if tag not in tags:
            tags.append(tag)
        if len(tags) >= limit:
            break
    return tags


def write_meta_file(path, plan, text):
    """A ready-to-paste title, description and hashtag list for one clip.

    Built from the clip's own speech, so it is a starting point rather than a
    finished caption — but it saves retyping the same thing ten times.
    """
    title = make_title(text, plan["title"])
    tags = make_hashtags(text, plan["aspect"])
    description = " ".join(text.split())
    if len(description) > 400:
        description = description[:400].rsplit(" ", 1)[0] + "…"
    body = (
        "TITLE\n%s\n\n"
        "DESCRIPTION\n%s\n\n"
        "HASHTAGS\n%s\n\n"
        "CLIP\n%s in the original video (%.0f seconds long)\n"
    ) % (
        title,
        description or title,
        " ".join(tags),
        _ts_srt(plan["start"]).replace(",", "."),
        plan["out_duration"],
    )
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(body)
    except OSError:
        return None
    return path


def tighten_chains(segments, clip_start, speech_label):
    """split → trim every kept piece → concat, for the picture and the sound
    together. The music is mixed in afterwards, so it plays straight through and
    never hears the joins."""
    count = len(segments)
    heads = "".join("[tvs%d]" % index for index in range(count))
    chains = ["[0:v]split=%d%s" % (count, heads)]
    for index, (seg_start, seg_end) in enumerate(segments):
        chains.append(
            "[tvs%d]trim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS[tv%d]"
            % (index, seg_start - clip_start, seg_end - clip_start, index)
        )
    heads = "".join("[tas%d]" % index for index in range(count))
    chains.append("[%s]asplit=%d%s" % (speech_label, count, heads))
    for index, (seg_start, seg_end) in enumerate(segments):
        chains.append(
            "[tas%d]atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS[ta%d]"
            % (index, seg_start - clip_start, seg_end - clip_start, index)
        )
    pairs = "".join("[tv%d][ta%d]" % (index, index) for index in range(count))
    chains.append("%sconcat=n=%d:v=1:a=1[tcv][tca]" % (pairs, count))
    return chains


# Trial watermark — burned into every exported frame for unlicensed users so a
# watermark cannot be skipped or removed after the fact.  Only applied when the
# config explicitly asks for it (the main process sets trialWatermark), so
# licensed users and development builds see no change.
WATERMARK_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
)


def _pick_drawtext_font():
    for candidate in WATERMARK_FONT_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return ""


def _escape_drawtext(value):
    # Inside drawtext's single-quoted text, escape the characters FFmpeg uses
    # as separators/quote markers so any video title survives verbatim.
    return (str(value).replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace(":", "\\:")
            .replace(",", "\\,"))


def watermark_chain(text, ffmpeg_path):
    """Return a drawtext filter spec, or None when drawtext isn't available."""
    if not has_filter(ffmpeg_path, "drawtext"):
        progress.log("trial watermark skipped: drawtext filter is not available")
        return None
    parts = ["text='%s'" % _escape_drawtext(text)]
    fontfile = _pick_drawtext_font()
    parts.append("fontfile='%s'" % _escape_drawtext(fontfile) if fontfile else "font=Arial")
    parts.append("fontsize=h*0.12")          # matches TRIAL_CONFIG.watermarkScale
    parts.append("fontcolor=white@0.35")     # matches TRIAL_CONFIG.watermarkOpacity
    parts.append("x=(w-text_w-20)")
    parts.append("y=(h-text_h-20)")
    return "drawtext=" + ":".join(parts)


def build_args(source, out_path, plan, opts):
    """Assemble one FFmpeg argv. `opts` says which features are still enabled."""
    duration = plan["duration"]              # window taken out of the source
    out_duration = plan["out_duration"]      # how long the finished clip runs
    args = ["-ss", "%.3f" % plan["start"], "-t", "%.3f" % duration, "-i", source]

    next_input = 1
    if opts["audio"] == "silent":
        args += ["-f", "lavfi", "-t", "%.3f" % duration,
                 "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
        speech = "%d:a" % next_input
        next_input += 1
    else:
        speech = "0:a"

    music_label = None
    if plan["music_path"]:
        args += ["-stream_loop", "-1", "-i", plan["music_path"]]
        music_label = "%d:a" % next_input
        next_input += 1

    logo_label = None
    if opts.get("logo") and plan.get("logo_path"):
        args += ["-i", plan["logo_path"]]
        logo_label = "%d:v" % next_input
        next_input += 1

    chains = []
    video_in = "0:v"
    keep = plan.get("keep") if opts.get("tighten") else None
    if keep:
        chains += tighten_chains(keep, plan["start"], speech)
        video_in, speech = "tcv", "tca"

    chains += framing_chains(plan, opts, video_in, "fr")

    parts = []
    look = LOOKS.get(plan["look"], "")
    if look:
        parts.append(look)
    # Two subtitle files are written per clip: one timed for the tightened clip
    # and one for the untouched window. If tightening has been peeled off by a
    # degrade step, the plain one keeps the captions in sync.
    ass_name = plan["ass_name"] if keep else (plan.get("ass_plain") or plan["ass_name"])
    if opts["burn"] and ass_name:
        parts.append("subtitles=%s" % ass_name)

    if logo_label:
        chains.append("[fr]%s[fx]" % ",".join(parts or ["null"]))
        # format=rgba first: without it a JPG logo has no alpha channel and
        # colorchannelmixer has nothing to fade.
        chains.append("[%s]scale=%d:-1,format=rgba,colorchannelmixer=aa=%.2f[lg]"
                      % (logo_label, plan["logo_width"], plan["logo_opacity"]))
        chains.append("[fx][lg]overlay=W-w-%d:%d,format=yuv420p[v]"
                      % (plan["logo_margin"], plan["logo_margin"]))
    else:
        parts.append("format=yuv420p")
        chains.append("[fr]%s[v]" % ",".join(parts))

    # Trial watermark: re-route the finished [v] through one drawtext stage so
    # the text is literally part of every frame (not removable).
    if opts.get("watermark") and plan.get("watermark_text"):
        wm_chain = watermark_chain(plan["watermark_text"], opts.get("ffmpeg_path") or "ffmpeg")
        if wm_chain:
            chains[-1] = chains[-1].replace("[v]", "[wm0]")
            chains.append("[wm0]%s[v]" % wm_chain)

    fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
    if music_label:
        volume = clamp(plan["music_volume"], 0.0, 1.5)
        chains.append("[%s]%s[sp]" % (speech, fmt))
        chains.append("[%s]%s,volume=%.3f[mu]" % (music_label, fmt, volume))
        mix_opts = "inputs=2:duration=first:dropout_transition=0"
        if not opts["mix_normalize"]:
            mix_opts += ":normalize=0"
        if opts["duck"]:
            chains.append("[sp]asplit=2[sp1][sp2]")
            chains.append("[mu][sp2]%s[mud]" % DUCK_FILTER)
            mixed = "[sp1][mud]amix=%s" % mix_opts
        else:
            mixed = "[sp][mu]amix=%s" % mix_opts
        if opts.get("limit", True):
            mixed += ",%s" % LIMIT_FILTER
        chains.append("%s[a]" % mixed)
    else:
        chains.append("[%s]%s[a]" % (speech, fmt))

    args += ["-filter_complex", ";".join(chains), "-map", "[v]", "-map", "[a]"]
    args += [
        "-c:v", "libx264", "-preset", PRESET, "-crf", CRF,
        "-r", str(plan["fps"]), "-profile:v", "high", "-level", "4.1",
        "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        "-t", "%.3f" % (out_duration if keep else duration),
        out_path,
    ]
    return args


# Peeled off one at a time when FFmpeg refuses a command. Order matters: the
# cheapest thing to lose is listed first, and the limiter goes before ducking
# because losing it only risks a clipped peak, while losing ducking changes how
# the mix sounds. Every entry is cumulative, so nothing below is ever kept once
# a later step runs.
DEGRADE_STEPS = (
    ({}, ""),
    ({"limit": False},
     "The peak limiter is not supported by this FFmpeg build."),
    ({"limit": False, "logo": False},
     "The logo could not be placed on this clip."),
    ({"limit": False, "logo": False, "duck": False},
     "Music ducking is not supported by this FFmpeg build."),
    ({"limit": False, "logo": False, "duck": False, "tighten": False},
     "Dead air could not be cut out of this clip, so the full length was kept."),
    ({"limit": False, "logo": False, "duck": False, "tighten": False,
      "framing": FRAMING_FALLBACK},
     "The chosen framing is not supported by this FFmpeg build, so a centre crop was used."),
    ({"limit": False, "logo": False, "duck": False, "tighten": False,
      "framing": FRAMING_FALLBACK, "mix_normalize": True},
     "Mix levels were adjusted for an older FFmpeg."),
    ({"limit": False, "logo": False, "duck": False, "tighten": False,
      "framing": FRAMING_FALLBACK, "mix_normalize": True, "burn": False},
     "Captions could not be burned in — an .srt file was saved next to the clip."),
    ({"limit": False, "logo": False, "duck": False, "tighten": False,
      "framing": FRAMING_FALLBACK, "mix_normalize": True, "burn": False,
      "audio": "silent"},
     "No audio was found in the source, so a silent audio track was added."),
)


def render_one(ffmpeg_path, source, out_path, plan, base_opts, on_fraction):
    """Try the plan, degrading features until FFmpeg accepts it."""
    last_error = None
    for overrides, note in DEGRADE_STEPS:
        opts = dict(base_opts)
        opts.update(overrides)
        args = build_args(source, out_path, plan, opts)
        try:
            run_ffmpeg(
                ffmpeg_path, args,
                label="clip %d" % plan["index"],
                cwd=plan["cwd"],
                total_seconds=plan["out_duration"],
                on_fraction=on_fraction,
            )
            return note, opts
        except RuntimeError as exc:
            last_error = exc
            progress.log("clip %d attempt failed: %s" % (plan["index"], str(exc)[:400]))
            try:
                if os.path.exists(out_path):
                    os.remove(out_path)
            except OSError:
                pass
    raise RuntimeError(str(last_error) if last_error else "FFmpeg failed")


def slugify(text, fallback):
    slug = SLUG_RE.sub("-", str(text or "")).strip("-").lower()
    return slug[:48] if slug else fallback


def plan_one(item, order, ctx):
    """Everything one clip needs before FFmpeg is called: cut points, cues,
    tightening, tracking and the text file that goes beside it."""
    start = max(0.0, to_float(item.get("start"), 0.0))
    end = to_float(item.get("end"), 0.0)
    if ctx["source_duration"] > 0:
        end = min(end, ctx["source_duration"])
    duration = end - start
    if duration < 1.0:
        progress.log("clip %d skipped: duration %.2fs" % (order, duration))
        return None

    index = int(item.get("index") or order)
    stem = "clip_%02d" % index
    wants_captions = ctx["captions_on"] and item.get("captions", True)
    style = str(item.get("captionStyle") or ctx["default_style"])
    tpl = apply_colour_overrides(template_for(style), ctx["overrides"])

    cues = []
    if wants_captions:
        # Words per caption is part of the template, so the cues have to be
        # grouped after the template is known — a one-word template and a
        # six-word template need completely different grouping.
        per_cue = max(1, int(tpl["words"]))
        cues = cues_from_words(
            item.get("words"), start, end,
            max_words=per_cue, max_span=cue_span_for(per_cue),
        )
        if not cues:
            cues = cues_from_segments(item.get("segments"), start, end)

    # Cutting dead air moves every timestamp after it, so the cues are remapped
    # onto the shortened timeline. A second copy stays on the original timeline
    # in case FFmpeg refuses the trim/concat graph and tightening is dropped.
    keep = keep_segments(item.get("words"), start, end,
                         drop_fillers=ctx["cut_fillers"]) if ctx["tighten"] else None
    plain_cues = shift_and_clean(cues, start, duration) if cues else []
    out_duration = duration
    if keep:
        out_duration = sum(span[1] - span[0] for span in keep)
        cues = shift_and_clean(remap_cues(cues, keep), 0.0, out_duration) if cues else []
    else:
        cues = plain_cues

    track_expr = ""
    if ctx["framing"] == "track":
        points = scan_motion(ctx["ffmpeg_path"], ctx["source"], start, duration)
        if keep:
            # The crop expression is evaluated against the finished clip's clock,
            # so each sample has to move onto the tightened timeline too, and
            # samples that landed inside a removed pause are dropped.
            moved = []
            for moment, ratio in points:
                mapped, kept = compact_time(keep, start + moment)
                if kept:
                    moved.append((mapped, ratio))
            points = moved
        track_expr = track_ratio_expr(smooth_track(points))

    hook = " ".join(str(item.get("hook") or ctx["hook"] or "").split())[:90]
    plan = {
        "index": index,
        "order": order,
        "start": start,
        "end": end,
        "duration": duration,
        "out_duration": out_duration,
        "keep": keep,
        "geometry": ctx["geometry"],
        "aspect": ctx["aspect"],
        "fps": ctx["fps"],
        "look": str(item.get("filter") or ctx["default_look"]),
        "style": style,
        "overrides": ctx["overrides"],
        "framing": ctx["framing"],
        "track_expr": track_expr,
        "hook": hook,
        "hook_seconds": clamp(to_float(ctx["hook_seconds"], 2.5), 0.5, 10.0),
        "logo_path": ctx["logo_path"],
        "logo_width": ctx["logo_width"],
        "logo_margin": ctx["logo_margin"],
        "logo_opacity": ctx["logo_opacity"],
        "watermark_text": ctx["trial_watermark"],
        "music_path": item.get("musicPath") or None,
        "music_volume": clamp(to_float(item.get("musicVolume"), 0.25), 0.0, 1.5),
        "title": item.get("title") or "Clip %d" % index,
        "cues": cues,
        "plain_cues": plain_cues,
        "font_name": ctx["font_name"],
        "out_path": os.path.join(ctx["out_dir"], stem + ".mp4"),
        "srt_path": os.path.join(ctx["out_dir"], stem + ".srt"),
        "ass_path": os.path.join(ctx["out_dir"], stem + ".ass"),
        "plain_ass_path": os.path.join(ctx["out_dir"], stem + "_full.ass"),
        "meta_path": os.path.join(ctx["out_dir"], stem + ".txt"),
        "ass_name": (stem + ".ass") if cues else None,
        # Only written when tightening is actually on, so build_args must not
        # point FFmpeg at a file that was never created.
        "ass_plain": (stem + "_full.ass") if (keep and plain_cues) else None,
        "speech": clip_speech(item, start, end) if ctx["write_meta"] else "",
        "cwd": ctx["out_dir"],
    }
    return plan


def build_plans(config, out_dir, geometry, aspect, fps, ffmpeg_path, source):
    """Validate the requested clips and pre-compute everything per clip."""
    framing = str(config.get("framing") or FRAMING_FALLBACK)
    if framing not in FRAMING_MODES:
        framing = FRAMING_FALLBACK
    blur_filter = ""
    if framing == "blur":
        # Ask FFmpeg once which blur it has instead of finding out through a
        # failed encode: gblur looks better, boxblur is always there.
        if has_filter(ffmpeg_path, "gblur"):
            blur_filter = "gblur=sigma=%d" % BLUR_SIGMA
        elif has_filter(ffmpeg_path, "boxblur"):
            blur_filter = "boxblur=%d:1" % max(2, BLUR_SIGMA // 2)
        else:
            progress.log("no blur filter available, using a centre crop")
            framing = FRAMING_FALLBACK

    logo_path = str(config.get("logoPath") or "")
    if logo_path and not os.path.isfile(logo_path):
        progress.log("logo not found, ignoring: %s" % logo_path)
        logo_path = ""

    ctx = {
        "source_duration": to_float(config.get("sourceDuration"), 0.0),
        "default_look": str(config.get("filter") or "none"),
        "default_style": str(config.get("captionStyle") or "bold"),
        "captions_on": str(config.get("captionMode") or "burn") != "off",
        "font_name": str(config.get("fontName") or "Arial"),
        "overrides": {
            "primary": config.get("captionPrimary") or "",
            "highlight": config.get("captionHighlight") or "",
        },
        "framing": framing,
        "blur_filter": blur_filter,
        "tighten": bool(config.get("tighten")),
        "cut_fillers": bool(config.get("cutFillers", True)),
        "write_meta": bool(config.get("writeMeta")),
        "hook": str(config.get("hook") or ""),
        "hook_seconds": config.get("hookSeconds", 2.5),
        "logo_path": logo_path,
        "logo_width": _even(clamp(to_float(config.get("logoScale"), 0.18), 0.05, 0.5)
                            * geometry[0]),
        "logo_margin": _even(geometry[0] * 0.045),
        "logo_opacity": clamp(to_float(config.get("logoOpacity"), 0.85), 0.1, 1.0),
        # Burned into every frame when set (main process enables it for trial).
        "trial_watermark": str(config.get("trialWatermark") or "").strip(),
        "geometry": geometry,
        "aspect": aspect,
        "fps": fps,
        "ffmpeg_path": ffmpeg_path,
        "source": source,
        "out_dir": out_dir,
    }

    plans = []
    for order, item in enumerate(config.get("clips") or [], start=1):
        plan = plan_one(item, order, ctx)
        if plan:
            plans.append(plan)
    return plans, ctx


def render(config):
    ffmpeg_path = config.get("ffmpegPath") or "ffmpeg"
    source = config.get("sourcePath") or ""
    if not os.path.isfile(source):
        raise RuntimeError("Source video not found: %s" % source)

    out_dir = config.get("outDir") or os.path.dirname(source)
    os.makedirs(out_dir, exist_ok=True)

    aspect = str(config.get("aspect") or "vertical")
    if aspect not in RESOLUTIONS:
        aspect = "vertical"
    geometry = resolution_for(aspect, config.get("quality") or "720")
    fps = int(clamp(to_float(config.get("fps"), 30.0), 15.0, 60.0))

    plans, ctx = build_plans(config, out_dir, geometry, aspect, fps, ffmpeg_path, source)
    if not plans:
        raise RuntimeError("There was no clip worth rendering.")

    total_seconds = sum(plan["out_duration"] for plan in plans) or 1.0
    duck_default = bool(config.get("musicDuck", True))
    elapsed = [0.0]
    results = []
    failures = []

    progress.report("clips", 1.0, "Rendering %d clips…" % len(plans),
                    total=len(plans), done=0)

    for position, plan in enumerate(plans, start=1):
        if plan["cues"]:
            write_clip_subtitles(
                plan["cues"], plan["ass_path"], plan["srt_path"],
                geometry[0], geometry[1], plan["style"], plan["font_name"],
                hook=plan["hook"], hook_seconds=plan["hook_seconds"],
                overrides=plan["overrides"],
            )
        if plan["keep"] and plan["plain_cues"]:
            write_clip_subtitles(
                plan["plain_cues"], plan["plain_ass_path"], None,
                geometry[0], geometry[1], plan["style"], plan["font_name"],
                hook=plan["hook"], hook_seconds=plan["hook_seconds"],
                overrides=plan["overrides"],
            )
        if plan["speech"]:
            try:
                write_meta_file(plan["meta_path"], plan, plan["speech"])
            except OSError as exc:
                progress.log("clip %d meta file failed: %s" % (plan["index"], exc))

        def on_fraction(done, plan=plan):
            covered = elapsed[0] + done * plan["out_duration"]
            progress.report(
                "clips", 1.0 + (covered / total_seconds) * 98.0,
                message="Clip %d/%d — %s" % (position, len(plans), plan["title"][:40]),
                total=len(plans), done=position - 1,
            )

        base_opts = {
            "duck": duck_default and bool(plan["music_path"]),
            "burn": bool(plan["ass_name"]),
            "mix_normalize": False,
            # Only meaningful when there is music to mix; build_args ignores it
            # on the single-track path.
            "limit": bool(plan["music_path"]),
            "audio": "source",
            "framing": plan["framing"],
            "blur_filter": ctx["blur_filter"],
            "tighten": bool(plan["keep"]),
            "logo": bool(plan["logo_path"]),
            "watermark": bool(plan["watermark_text"]),
            "ffmpeg_path": ffmpeg_path,
        }

        try:
            note, used = render_one(
                ffmpeg_path, source, plan["out_path"], plan, base_opts, on_fraction
            )
        except Exception as exc:                       # noqa: BLE001 - reported per clip
            failures.append({"index": plan["index"], "title": plan["title"],
                             "error": str(exc)[:600]})
            elapsed[0] += plan["out_duration"]
            continue

        size = 0
        try:
            size = os.path.getsize(plan["out_path"])
        except OSError:
            size = 0
        if size < 1024:
            failures.append({"index": plan["index"], "title": plan["title"],
                             "error": "FFmpeg produced a file but it is empty."})
            elapsed[0] += plan["out_duration"]
            continue

        for temp_path in (plan["ass_path"], plan["plain_ass_path"]):
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except OSError:
                pass

        tightened = bool(plan["keep"]) and bool(used.get("tighten"))
        results.append({
            "index": plan["index"],
            "title": plan["title"],
            "path": plan["out_path"],
            "name": os.path.basename(plan["out_path"]),
            "slug": slugify(plan["title"], "clip-%02d" % plan["index"]),
            "start": round(plan["start"], 2),
            "end": round(plan["end"], 2),
            "duration": round(plan["out_duration"] if tightened else plan["duration"], 2),
            "sourceDuration": round(plan["duration"], 2),
            "tightened": tightened,
            "cutSeconds": round(plan["duration"] - plan["out_duration"], 2) if tightened else 0,
            "framing": plan["framing"] if used.get("framing") == plan["framing"] else FRAMING_FALLBACK,
            "hook": plan["hook"],
            "logo": bool(plan["logo_path"]) and bool(used.get("logo")),
            "sizeBytes": size,
            "width": geometry[0],
            "height": geometry[1],
            "look": plan["look"],
            "musicPath": plan["music_path"] or "",
            "musicVolume": round(plan["music_volume"], 3),
            "captionsBurned": bool(used.get("burn") and plan["cues"]),
            "captionStyle": plan["style"],
            "cueCount": len(plan["cues"]),
            "subtitlePath": plan["srt_path"] if plan["cues"] else "",
            "metaPath": plan["meta_path"] if plan["speech"] else "",
            "warning": note,
        })
        elapsed[0] += plan["out_duration"]

    if not results:
        detail = failures[0]["error"] if failures else "unknown"
        raise RuntimeError("No clip could be rendered. First reason: %s" % detail)

    progress.report("done", 100.0, "%d clips ready" % len(results),
                    total=len(plans), done=len(results))
    return {
        "success": True,
        "clips": results,
        "failed": failures,
        "aspect": aspect,
        "width": geometry[0],
        "height": geometry[1],
        "fps": fps,
        "framing": ctx["framing"],
        "tightened": sum(1 for clip in results if clip["tightened"]),
        "outDir": out_dir,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        progress.emit_error("Usage: clip_renderer.py <config_json_path>")

    try:
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            cfg = json.load(handle)
        progress.emit_result(render(cfg))
    except KeyboardInterrupt:
        progress.emit_error("Cancelled")
    except Exception as exc:                          # noqa: BLE001
        progress.emit_error(exc)

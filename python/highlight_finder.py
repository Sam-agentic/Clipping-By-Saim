"""
highlight_finder.py — picks the "viral" windows out of one long video.

Input : a JSON config file path (written by utils/clipStudio.js)
Output: one JSON object on stdout, progress on stderr (see progress.py)

There is no LLM in this path on purpose: this app runs on a 2-core / 4 GB
laptop, so scoring is done from two signals we already have or can get cheaply.

  1. WHAT is said  — the transcript from audio_analyzer.py (faster-whisper),
     scored for hook words, questions, numbers, negation, superlatives and
     speech density. Works for English and Roman-Urdu, which is what this user
     actually edits.
  2. HOW it is said — loudness over time, decoded once at 4 kHz mono straight
     from the source file through an ffmpeg pipe and reduced to one RMS value
     per half second. Streaming, so memory stays flat even for a 2 hour video.

Cuts are then snapped to sentence boundaries (a segment start that follows a
pause, and a segment end that precedes one) because a clip that begins
mid-word reads as broken no matter how good the content is.
"""

import array
import json
import math
import os
import re
import subprocess
import sys

import progress

try:                      # removed in Python 3.13, and it is only a fast path
    import audioop as _audioop
except Exception:         # pragma: no cover
    _audioop = None

SAMPLE_RATE = 4000
BUCKET_SECONDS = 0.5
STRIDE = 2                # every 2nd sample is plenty for a loudness envelope
MAX_ANALYZE_SECONDS = 7200

# Words that mark a moment worth clipping. Weight, then the terms.
HOOK_TERMS = (
    (3.0, (
        "secret", "raaz", "nobody tells", "koi nahi batata", "truth", "sach",
        "biggest mistake", "sabse badi ghalti", "never do", "kabhi na",
        "the reason", "asal wajah", "listen carefully", "dhyan se suno",
        "warning", "khabardar", "shocking", "hairan",
    )),
    (2.0, (
        "mistake", "ghalti", "why", "kyun", "kyu", "how to", "kaise", "trick",
        "hack", "tareeqa", "tip", "proof", "saboot", "result", "nateeja",
        "free", "muft", "mufat", "million", "lakh", "crore", "billion",
        "actually", "asal me", "problem", "masla", "solution", "hal",
        "important", "zaroori", "remember", "yaad rakho",
    )),
    (1.2, (
        "best", "behtareen", "worst", "bura", "stop", "ruko", "mat karo",
        "don't", "dont", "imagine", "socho", "believe", "yaqeen", "crazy",
        "insane", "pagal", "amazing", "kamaal", "first", "pehla", "finally",
        "aakhir", "step", "qadam", "example", "misaal", "look", "dekho",
        "everyone", "sab log", "always", "hamesha", "never", "kabhi",
    )),
)

NUMBER_RE = re.compile(r"\d")
MONEY_RE = re.compile(r"[$₹£€]|\b(?:rupees|rupaye|dollar|percent|fisad|%)\b", re.I)
QUESTION_OPENERS = (
    "what", "why", "how", "when", "who", "which", "can you", "do you",
    "kya", "kyun", "kyu", "kaise", "kab", "kaun", "kitna", "kitni",
)
WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def clamp(value, low, high):
    return max(low, min(high, value))


def block_rms(block):
    """RMS of one little-endian s16 block, C fast path when available."""
    if _audioop is not None:
        try:
            return float(_audioop.rms(block, 2))
        except Exception:
            pass
    samples = array.array("h")
    samples.frombytes(block)
    total = 0
    count = 0
    for i in range(0, len(samples), STRIDE):
        value = samples[i]
        total += value * value
        count += 1
    return math.sqrt(total / count) if count else 0.0


def loudness_envelope(ffmpeg_path, media_path, limit_seconds):
    """One RMS value per BUCKET_SECONDS, streamed so memory stays flat.

    Returns [] on any failure — the caller then scores on text alone rather
    than aborting the whole job for a missing audio track.
    """
    if not ffmpeg_path or not os.path.isfile(media_path):
        return []

    command = [
        ffmpeg_path, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", media_path,
    ]
    if limit_seconds and limit_seconds > 0:
        command += ["-t", "%.3f" % limit_seconds]
    command += ["-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"]

    step = int(SAMPLE_RATE * BUCKET_SECONDS) * 2   # bytes per bucket
    buckets = []
    try:
        proc = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL
        )
    except Exception as exc:
        progress.log("loudness: could not start ffmpeg (%s)" % exc)
        return []

    buffer_bytes = b""
    try:
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            buffer_bytes += chunk
            while len(buffer_bytes) >= step:
                buckets.append(block_rms(buffer_bytes[:step]))
                buffer_bytes = buffer_bytes[step:]
    except Exception as exc:
        progress.log("loudness: read failed (%s)" % exc)
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    if len(buffer_bytes) >= 4:
        trimmed = buffer_bytes[: len(buffer_bytes) - (len(buffer_bytes) % 2)]
        buckets.append(block_rms(trimmed))
    return buckets


def percentile(sorted_values, fraction):
    if not sorted_values:
        return 0.0
    index = clamp(int(round(fraction * (len(sorted_values) - 1))), 0, len(sorted_values) - 1)
    return sorted_values[index]


def text_score(text):
    """Score one sentence for 'would this stop a thumb'. Returns (score, reasons)."""
    if not text:
        return 0.0, []
    lowered = " " + text.lower().strip() + " "
    reasons = []
    score = 0.0

    hook_hits = 0
    for weight, terms in HOOK_TERMS:
        for term in terms:
            if term in lowered:
                score += weight
                hook_hits += 1
                if len(reasons) < 3 and weight >= 2.0:
                    reasons.append('hook: "%s"' % term)
                break          # one hit per weight tier keeps long rants honest
    if hook_hits and not reasons:
        reasons.append("hook words")

    if "?" in text:
        score += 2.0
        reasons.append("question")
    else:
        stripped = lowered.strip()
        for opener in QUESTION_OPENERS:
            if stripped.startswith(opener + " "):
                score += 1.2
                reasons.append("opens with a question")
                break

    if NUMBER_RE.search(text):
        score += 1.5
        reasons.append("numbers")
    if MONEY_RE.search(text):
        score += 1.0
        reasons.append("money/percent")
    if "!" in text:
        score += 0.6

    words = WORD_RE.findall(lowered)
    if 4 <= len(words) <= 14:
        score += 1.0            # punchy one-liners cut best
    elif len(words) < 3:
        score -= 1.0            # filler like "okay so"

    return max(0.0, score), reasons


def prepare_segments(raw_segments, duration):
    """Normalise whisper segments and pre-compute the pause around each one."""
    segments = []
    for item in raw_segments or []:
        try:
            start = float(item.get("start", 0.0))
            end = float(item.get("end", 0.0))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        if duration:
            end = min(end, duration)
            if end <= start:
                continue
        segments.append({
            "start": start,
            "end": end,
            "text": str(item.get("text", "")).strip(),
        })

    segments.sort(key=lambda s: s["start"])
    total = len(segments)
    for index, seg in enumerate(segments):
        prev_end = segments[index - 1]["end"] if index else 0.0
        if index + 1 < total:
            next_start = segments[index + 1]["start"]
        else:
            next_start = duration or seg["end"]
        seg["gap_before"] = max(0.0, seg["start"] - prev_end)
        seg["gap_after"] = max(0.0, next_start - seg["end"])
        seg["score"], seg["reasons"] = text_score(seg["text"])
        seg["word_count"] = len(WORD_RE.findall(seg["text"]))
    return segments


def energy_window(buckets, stats, start, end):
    """(relative loudness 0..1, dead-air ratio 0..1) for one time window."""
    if not buckets:
        return 0.5, 0.0
    first = int(start / BUCKET_SECONDS)
    last = int(math.ceil(end / BUCKET_SECONDS))
    slice_ = buckets[max(0, first):max(first + 1, min(len(buckets), last))]
    if not slice_:
        return 0.5, 0.0

    ordered = sorted(slice_, reverse=True)
    keep = max(1, int(len(ordered) * 0.6))
    loud = sum(ordered[:keep]) / keep

    median, p90, floor = stats
    spread = max(1.0, p90 - median)
    relative = clamp((loud - median) / spread, -1.0, 1.0)
    dead = sum(1 for value in slice_ if value < floor) / float(len(slice_))
    return (relative + 1.0) / 2.0, dead


def make_title(segments, first, last):
    """Short human label for the clip card, taken from its strongest line."""
    best = max(segments[first:last + 1], key=lambda s: s["score"])
    text = best["text"] or segments[first]["text"]
    words = text.replace("\n", " ").split()
    if not words:
        return "Clip"
    title = " ".join(words[:9]).strip(" ,.;:-—")
    return (title[:1].upper() + title[1:]) if title else "Clip"


def window_text(segments, first, last, limit=260):
    joined = " ".join(s["text"] for s in segments[first:last + 1] if s["text"]).strip()
    joined = re.sub(r"\s+", " ", joined)
    return joined if len(joined) <= limit else joined[:limit - 1].rstrip() + "…"


def build_windows(segments, buckets, stats, min_d, max_d, target):
    """Every sentence-aligned window between min_d and max_d, scored."""
    windows = []
    total = len(segments)

    for first in range(total):
        head = segments[first]
        opens_clean = first == 0 or head["gap_before"] >= 0.25
        acc_score = 0.0
        acc_words = 0

        for last in range(first, total):
            acc_score += segments[last]["score"]
            acc_words += segments[last]["word_count"]
            start = head["start"]
            end = segments[last]["end"]
            duration = end - start
            if duration > max_d:
                break
            if duration < min_d:
                continue

            loud, dead = energy_window(buckets, stats, start, end)
            text_part = clamp(acc_score / 12.0, 0.0, 1.0)
            density = acc_words / duration if duration else 0.0
            density_part = clamp(density / 3.0, 0.0, 1.0)
            fit_part = clamp(1.0 - abs(duration - target) / max(target, 1.0), 0.0, 1.0)

            score = 100.0 * (
                0.42 * text_part + 0.28 * loud + 0.18 * density_part + 0.12 * fit_part
            )
            score -= 14.0 * dead
            if not opens_clean:
                score -= 4.0
            if segments[last]["gap_after"] >= 0.3:
                score += 3.0

            windows.append({
                "first": first,
                "last": last,
                "start": start,
                "end": end,
                "duration": duration,
                "score": round(clamp(score, 0.0, 100.0), 1),
                "loud": round(loud, 3),
                "dead": round(dead, 3),
                "wps": round(density, 2),
            })
    return windows


def select(windows, count, min_gap=0.4):
    """Greedy best-first, non-overlapping."""
    chosen = []
    for win in sorted(windows, key=lambda w: (-w["score"], w["start"])):
        if len(chosen) >= count:
            break
        clash = any(
            win["start"] < picked["end"] + min_gap and picked["start"] < win["end"] + min_gap
            for picked in chosen
        )
        if not clash:
            chosen.append(win)
    chosen.sort(key=lambda w: w["start"])
    return chosen


def free_ranges(chosen, duration, min_gap=0.4):
    """Timeline stretches not yet used by a chosen clip."""
    gaps = []
    cursor = 0.0
    for win in sorted(chosen, key=lambda w: w["start"]):
        if win["start"] - cursor > min_gap:
            gaps.append((cursor, win["start"] - min_gap))
        cursor = max(cursor, win["end"] + min_gap)
    if duration - cursor > min_gap:
        gaps.append((cursor, duration))
    return gaps


def segments_in_range(segments, start, end):
    first = None
    last = None
    for index, seg in enumerate(segments):
        if seg["end"] <= start or seg["start"] >= end:
            continue
        if first is None:
            first = index
        last = index
    return first, last


def fill_even(chosen, segments, buckets, stats, duration, count, target, min_d):
    """Top up with evenly spaced windows when the video simply has fewer clean
    sentence-aligned candidates than the user asked for."""
    if len(chosen) >= count or duration <= 0:
        return chosen

    extra = []
    for start_gap, end_gap in free_ranges(chosen, duration):
        cursor = start_gap
        while end_gap - cursor >= min_d and len(extra) + len(chosen) < count * 3:
            end = min(cursor + target, end_gap)
            loud, dead = energy_window(buckets, stats, cursor, end)
            first, last = segments_in_range(segments, cursor, end)
            extra.append({
                "first": first if first is not None else -1,
                "last": last if last is not None else -1,
                "start": cursor,
                "end": end,
                "duration": end - cursor,
                "score": round(clamp(100.0 * (0.6 * loud + 0.4) - 14.0 * dead, 0.0, 100.0), 1),
                "loud": round(loud, 3),
                "dead": round(dead, 3),
                "wps": 0.0,
                "filler": True,
            })
            cursor = end
    extra.sort(key=lambda w: -w["score"])
    for win in extra:
        if len(chosen) >= count:
            break
        chosen.append(win)
    chosen.sort(key=lambda w: w["start"])
    return chosen


def describe(win, segments, rank):
    """Turn a scored window into the object the UI shows on a clip card."""
    first = win.get("first", -1)
    last = win.get("last", -1)
    has_text = segments and first is not None and first >= 0 and last is not None and last >= 0

    reasons = []
    if has_text:
        for seg in segments[first:last + 1]:
            for reason in seg["reasons"]:
                if reason not in reasons:
                    reasons.append(reason)
            if len(reasons) >= 3:
                break
    if win.get("loud", 0) >= 0.62:
        reasons.append("high energy")
    if win.get("wps", 0) >= 2.6:
        reasons.append("fast talking")
    if not reasons:
        reasons.append("picked by position")

    return {
        "index": rank,
        "start": round(win["start"], 2),
        "end": round(win["end"], 2),
        "duration": round(win["duration"], 2),
        "score": win["score"],
        "title": make_title(segments, first, last) if has_text else "Clip %d" % rank,
        "text": window_text(segments, first, last) if has_text else "",
        "reasons": reasons[:4],
        "loudness": win.get("loud", 0.0),
        "wordsPerSecond": win.get("wps", 0.0),
        "auto": bool(win.get("filler")),
    }


def main():
    if len(sys.argv) < 2:
        progress.emit_error("usage: highlight_finder.py <config.json>")

    try:
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except Exception as exc:
        progress.emit_error("The config file could not be read: %s" % exc)
        return 1

    media_path = config.get("mediaPath") or ""
    ffmpeg_path = config.get("ffmpegPath") or ""
    raw_segments = config.get("segments") or []
    clip_count = max(1, min(30, int(config.get("clipCount") or 10)))
    min_d = max(4.0, float(config.get("minDuration") or 15.0))
    max_d = max(min_d + 1.0, float(config.get("maxDuration") or 60.0))
    target = clamp(float(config.get("targetDuration") or 30.0), min_d, max_d)
    use_energy = config.get("useAudioEnergy", True)

    duration = float(config.get("duration") or 0.0)
    if duration <= 0 and raw_segments:
        try:
            duration = max(float(item.get("end", 0.0)) for item in raw_segments)
        except (TypeError, ValueError):
            duration = 0.0
    if duration <= 0:
        progress.emit_error("The video length could not be determined, so no clips can be made.")
        return 1

    warnings = []
    progress.report("highlight", 3.0, "Reading the transcript…")
    segments = prepare_segments(raw_segments, duration)
    if not segments:
        warnings.append("The transcript was empty, so clips were chosen from audio energy only.")

    buckets = []
    if use_energy:
        progress.report("highlight", 12.0, "Measuring the audio loudness…")
        limit = min(duration, MAX_ANALYZE_SECONDS)
        if duration > MAX_ANALYZE_SECONDS:
            warnings.append("The video is longer than 2 hours, so only the first 2 hours were analysed.")
        buckets = loudness_envelope(ffmpeg_path, media_path, limit)
        if not buckets:
            warnings.append("No audio energy was found, so scoring used the transcript only.")

    if buckets:
        ordered = sorted(buckets)
        median = percentile(ordered, 0.5)
        p90 = percentile(ordered, 0.9)
        floor = max(1.0, percentile(ordered, 0.15) * 0.9)
        stats = (median, p90, floor)
    else:
        stats = (0.0, 1.0, 0.0)

    progress.report("highlight", 62.0, "Scoring every sentence…")
    windows = build_windows(segments, buckets, stats, min_d, max_d, target) if segments else []

    progress.report("highlight", 86.0, "Choosing the best moments…")
    chosen = select(windows, clip_count)
    if len(chosen) < clip_count:
        chosen = fill_even(chosen, segments, buckets, stats, duration,
                           clip_count, target, min_d)

    clips = [describe(win, segments, rank) for rank, win in enumerate(chosen, 1)]
    if not clips:
        progress.emit_error(
            "No clip could be made from this video — it is too short, or the audio is silent."
        )
        return 1
    if len(clips) < clip_count:
        warnings.append(
            "The video was only long enough for %d clips (%d were requested)." % (len(clips), clip_count)
        )

    progress.report("highlight", 100.0, "Found %d clips" % len(clips),
                    found=len(clips))
    progress.emit_result({
        "success": True,
        "clips": clips,
        "duration": round(duration, 2),
        "candidates": len(windows),
        "energyBuckets": len(buckets),
        "segments": len(segments),
        "warning": " ".join(warnings) if warnings else "",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())

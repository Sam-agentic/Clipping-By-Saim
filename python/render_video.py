"""
render_video.py (v3 — correctness first, then speed)

Assembles images + voiceover (+ optional music, + captions) into an MP4.

WHY v3 EXISTS
-------------
v2 never finished a single render. The cause was a frame-count blow-up in the
Ken Burns filter, not slow hardware:

    v2:  -loop 1 -t 5.2 -i img.png   ... zoompan=d=62:fps=12

`-t` before `-i` limits the INPUT, so the image decoder emitted 5.2s at its
default 25fps = ~130 frames. zoompan's `d` is "frames of effect per INPUT
frame", so it emitted 62 frames for each of those 130 = ~8,060 frames per
clip, i.e. a ~672-second clip for a 5.2-second slot. Times 14 images that is
roughly 2.6 hours of 1080p video to encode for a 72-second video: a ~180x
overrun. Every run died inside the first FFmpeg call.

v3 pins the input frame rate and uses d=1, so one input frame produces exactly
one output frame and a 5.2s slot really is 5.2s.

Two further v2 problems fixed here:
  * v2 packed all 14 images into ONE FFmpeg process (BATCH_SIZE=20), which
    also meant its ThreadPoolExecutor got max_workers=1 — the advertised
    parallelism never happened, and one process held 14 decoders plus 14
    zoompan chains in ~4GB of RAM. v3 renders one clip per process with a
    small, RAM-aware worker cap.
  * v2 chained one `drawtext` filter per transcript segment onto the command
    line: O(frames x segments) work, and it blows the 32KB Windows
    command-line limit on long audio. v3 writes a real .ass subtitle file and
    uses the single `subtitles` filter (and also drops a .srt next to the
    output for reuse).

Usage:
    python render_video.py <config_json_path>
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

import progress

QUALITY_HEIGHTS = {"480": 480, "720": 720, "1080": 1080, "1440": 1440, "2160": 2160}

FFMPEG_PRESET = "ultrafast"   # speed over compression: these are slideshows
CLIP_CRF = "28"               # temp clips; only re-encoded again if captions burn
FINAL_CRF = "23"              # final output
KENBURNS_FPS = 15             # motion clips: enough for a slow zoom
STATIC_FPS = 10               # no-motion clips: a still image needs no more
KENBURNS_UPSCALE = 1.18       # headroom to zoom into, without wasting pixels
ZOOM_AMOUNT = 0.10            # 1.00 -> 1.10 across each clip
DEFAULT_MAX_WORKERS = 2       # overridden by config; 2 is right for ~4GB RAM

# Progress budget, so the UI bar moves at a believable rate across the run.
P_SUBS, P_CLIPS, P_CONCAT, P_MUX = 4.0, 66.0, 4.0, 26.0

def _even(n):
    """x264 with yuv420p needs even dimensions."""
    n = int(n)
    return n + (n % 2)


def get_resolution(quality):
    height = QUALITY_HEIGHTS.get(str(quality), 1080)
    return _even(height * 16 / 9), _even(height)


def run_ffmpeg(ffmpeg_path, args, label="", cwd=None, total_seconds=None, on_fraction=None):
    """Run one FFmpeg command.

    When total_seconds and on_fraction are given, `-progress pipe:1` is parsed
    so a long encode can report real progress instead of looking hung.

    stderr goes to a temp file rather than a pipe: FFmpeg can out-write a pipe
    buffer while we are busy reading stdout, and that deadlocks — which is
    exactly the class of bug that made this app appear frozen before.
    """
    track = bool(total_seconds and on_fraction)
    cmd = [str(ffmpeg_path), "-hide_banner", "-nostdin", "-y", "-loglevel", "error"]
    if track:
        cmd += ["-progress", "pipe:1", "-nostats"]
    cmd += [str(a) for a in args]

    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errfile:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE if track else subprocess.DEVNULL,
            stderr=errfile,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        if track:
            for raw in proc.stdout:
                # Both out_time_us and out_time_ms carry MICROseconds
                # (out_time_ms is a long-standing FFmpeg misnomer).
                match = re.match(r"out_time_(?:us|ms)=(\d+)", raw.strip())
                if match:
                    done = (int(match.group(1)) / 1_000_000.0) / float(total_seconds)
                    on_fraction(max(0.0, min(1.0, done)))
            proc.stdout.close()

        code = proc.wait()
        if code != 0:
            errfile.seek(0)
            tail = errfile.read().strip()[-1500:]
            raise RuntimeError(f"FFmpeg failed ({label}, exit {code}):\n{tail or '(no stderr output)'}")


def _ts_ass(seconds):
    cs = int(round(max(0.0, seconds) * 100))
    hours, cs = divmod(cs, 360000)
    minutes, cs = divmod(cs, 6000)
    secs, cs = divmod(cs, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _ts_srt(seconds):
    ms = int(round(max(0.0, seconds) * 1000))
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def normalize_segments(segments, total_duration):
    """Clean the transcript into safe, non-overlapping, non-empty cues.

    Whisper occasionally emits zero-length or slightly overlapping segments;
    libass renders overlaps stacked on top of each other, which looks like a
    rendering bug to the user.
    """
    cues = []
    for seg in segments or []:
        text = " ".join(str(seg.get("text", "")).split())
        if not text:
            continue
        start = max(0.0, float(seg.get("start", 0.0)))
        end = float(seg.get("end", start))
        if total_duration:
            end = min(end, float(total_duration))
        if end - start < 0.05:
            continue
        cues.append({"text": text, "start": start, "end": end})

    cues.sort(key=lambda c: c["start"])
    for i in range(len(cues) - 1):
        if cues[i]["end"] > cues[i + 1]["start"]:
            cues[i]["end"] = cues[i + 1]["start"]
    return [c for c in cues if c["end"] - c["start"] >= 0.05]


def _ass_escape(text):
    # '{' opens an ASS override block and '\' starts an escape such as \N,
    # so neutralise both before they reach libass.
    return text.replace("\\", "/").replace("{", "(").replace("}", ")")


def write_subtitle_files(cues, ass_path, srt_path, width, height, font_size, font_name="Arial"):
    """Write an .ass (for burning) and a .srt (for reuse / upload)."""
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_name},{int(font_size)},&H00FFFFFF,&H000000FF,&H00000000,"
        "&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,60,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    with open(ass_path, "w", encoding="utf-8") as handle:
        handle.write(header)
        for cue in cues:
            handle.write(
                f"Dialogue: 0,{_ts_ass(cue['start'])},{_ts_ass(cue['end'])},"
                f"Default,,0,0,0,,{_ass_escape(cue['text'])}\n"
            )

    with open(srt_path, "w", encoding="utf-8") as handle:
        for index, cue in enumerate(cues, start=1):
            handle.write(
                f"{index}\n{_ts_srt(cue['start'])} --> {_ts_srt(cue['end'])}\n{cue['text']}\n\n"
            )


def kenburns_filter(width, height, frames):
    """Slow zoom-in, centred.

    d=1 is the whole point: one output frame per input frame. v2 used
    d=<clip frames>, which multiplied the frame count by the clip length.
    """
    up_w = _even(width * KENBURNS_UPSCALE)
    up_h = _even(height * KENBURNS_UPSCALE)
    span = max(1, frames - 1)
    zoom = f"min(1+{ZOOM_AMOUNT}*on/{span},{1 + ZOOM_AMOUNT})"
    return (
        f"scale={up_w}:{up_h}:force_original_aspect_ratio=increase,"
        f"crop={up_w}:{up_h},"
        f"zoompan=z='{zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
        f"d=1:s={width}x{height}:fps={KENBURNS_FPS},"
        f"setsar=1,format=yuv420p"
    )


def static_filter(width, height):
    """Fit the image inside the frame and letterbox the remainder. Cheap:
    one scale per frame, no per-frame geometry maths."""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:-1:-1:color=black,"
        f"setsar=1,format=yuv420p"
    )


def build_clip(ffmpeg_path, ffmpeg_args_extra, slot, image_path, width, height, out_path, motion):
    """Render ONE image into ONE clip in its own FFmpeg process.

    One process per clip keeps peak memory to a single decoder plus a single
    filter chain, which is what makes this survive on a 4GB machine, and it
    gives the UI a real per-image progress step.
    """
    duration = max(0.4, float(slot["end"]) - float(slot["start"]))
    fps = KENBURNS_FPS if motion == "kenburns" else STATIC_FPS
    frames = max(2, int(round(duration * fps)))

    if motion == "kenburns":
        vfilter = kenburns_filter(width, height, frames)
        tune = ["-tune", "zerolatency"]
    else:
        vfilter = static_filter(width, height)
        tune = ["-tune", "stillimage"]

    opacity = max(0.0, min(1.0, float(slot.get("opacity", 1.0))))
    if opacity < 1.0:
        vfilter = f"{vfilter},colorchannelmixer=rr={opacity:.3f}:gg={opacity:.3f}:bb={opacity:.3f}"

    args = [
        "-loop", "1",
        "-framerate", fps,      # pin the input rate so -t maps to real frames
        "-t", f"{duration:.3f}",
        "-i", image_path,
        "-vf", vfilter,
        "-r", fps,
        "-frames:v", frames,    # hard stop: a filter quirk can never overrun
        "-c:v", "libx264",
        "-preset", FFMPEG_PRESET,
        "-crf", CLIP_CRF,
        "-pix_fmt", "yuv420p",
    ] + tune + ffmpeg_args_extra + [out_path]

    run_ffmpeg(ffmpeg_path, args, label=f"clip {os.path.basename(out_path)}")
    return duration


def build_all_clips(ffmpeg_path, schedule, image_paths, width, height, tmp_dir, motion, max_workers):
    """Render every clip, a few at a time, reporting each completion.

    Workers are capped deliberately. More parallel x264 encodes than the
    machine has spare RAM turns into swap thrashing, which is far slower than
    running them two at a time.
    """
    total = len(schedule)
    clip_paths = [None] * total
    done = 0
    first_error = None

    def _build(index, slot):
        image_index = int(slot.get("image_index", index))
        if not 0 <= image_index < len(image_paths):
            image_index = index % len(image_paths)
        out_path = os.path.join(tmp_dir, f"clip_{index:05d}.mp4")
        build_clip(ffmpeg_path, [], slot, image_paths[image_index], width, height, out_path, motion)
        return index, out_path

    progress.report("clips", P_SUBS, message=f"Rendering {total} clips ({motion})")

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(_build, i, slot) for i, slot in enumerate(schedule)]
        for future in as_completed(futures):
            try:
                index, clip_path = future.result()
                clip_paths[index] = clip_path
            except Exception as exc:  # noqa: BLE001 - surfaced verbatim below
                if first_error is None:
                    first_error = exc
                    for pending in futures:
                        pending.cancel()
                continue
            done += 1
            progress.report(
                "clips",
                P_SUBS + P_CLIPS * (done / total),
                message=f"Clip {done} of {total}",
                done=done,
                total=total,
            )

    if first_error is not None:
        raise RuntimeError(f"Clip rendering failed: {first_error}")

    missing = [i for i, p in enumerate(clip_paths) if not p or not os.path.exists(p)]
    if missing:
        raise RuntimeError(f"{len(missing)} clip(s) were not produced (first: index {missing[0]})")

    return clip_paths


def concat_clips(ffmpeg_path, clip_paths, out_path, tmp_dir, transition=None, durations=None):
    """Join clips with a small re-encode for reliable image changes.

    Stream-copy concatenation can retain awkward keyframe/time-base metadata
    from individually encoded still-image clips. Some players then display
    the first decoded image for the whole joined stream. Re-encoding this
    silent intermediate normalizes timestamps and preserves every clip.
    """
    if transition and len(clip_paths) > 1:
        transition_names = {
            "dissolve": "fade",
            "slide": "slideleft",
            "fade": "fade",
            "wipe": "wipeleft",
            "circle open": "circleopen",
        }
        transition_name = transition_names.get(str(transition).lower(), "fade")
        duration = 0.35
        lengths = durations or [1.0] * len(clip_paths)
        inputs = []
        for clip in clip_paths:
            inputs += ["-i", clip]
        filters = []
        current = "0:v"
        accumulated = float(lengths[0])
        for index in range(1, len(clip_paths)):
            next_label = f"v{index}"
            offset = max(0.0, accumulated - duration)
            filters.append(
                f"[{current}][{index}:v]xfade=transition={transition_name}:"
                f"duration={duration}:offset={offset:.3f}[{next_label}]"
            )
            accumulated += float(lengths[index]) - duration
            current = next_label

        # Every xfade overlaps two clips, so the joined video comes out
        # duration x (clips - 1) SHORTER than the clips it was built from — 4.6s
        # on 14 images. mux_final then pairs that short video with the
        # full-length voiceover under `-shortest`, which silently cuts the end
        # of the narration off. Holding the final frame for the lost time keeps
        # video and audio the same length.
        lost = duration * (len(clip_paths) - 1)
        if lost > 0.01:
            filters.append(
                f"[{current}]tpad=stop_mode=clone:stop_duration={lost:.3f}[padded]"
            )
            current = "padded"

        run_ffmpeg(
            ffmpeg_path,
            inputs + ["-filter_complex", ";".join(filters), "-map", f"[{current}]",
                     "-c:v", "libx264", "-preset", FFMPEG_PRESET, "-crf", FINAL_CRF,
                     "-pix_fmt", "yuv420p", out_path],
            label=f"{transition_name} transitions",
            cwd=tmp_dir,
        )
        return
    list_path = os.path.join(tmp_dir, "concat_list.txt")
    with open(list_path, "w", encoding="utf-8") as handle:
        for clip in clip_paths:
            handle.write("file '{}'\n".format(os.path.basename(clip).replace("'", "'\\''")))

    run_ffmpeg(
        ffmpeg_path,
        ["-f", "concat", "-safe", "0", "-i", "concat_list.txt",
         "-c:v", "libx264", "-preset", FFMPEG_PRESET, "-crf", FINAL_CRF,
         "-pix_fmt", "yuv420p", "-vsync", "cfr", out_path],
        label="concat clips",
        cwd=tmp_dir,   # relative names sidestep Windows path escaping in the list
    )


def _drawtext_escape(text):
    return (str(text).replace("\\", "/").replace("'", "\\'")
            .replace(":", "\\:").replace("%", "\\%")
            .replace("\n", " "))


def editor_video_filter(effect_settings, overlays=None, font_path=None, advanced=None):
    """Translate the small UI preset set into safe FFmpeg expressions."""
    filters = []
    if not effect_settings:
        effect_settings = {}
    advanced = advanced or {}
    tool = str(effect_settings.get("type") or "").lower()
    label = str(effect_settings.get("label") or "").lower()
    if tool == "filters" and "cinematic" in label:
        filters.append("eq=saturation=1.28:contrast=1.08")
    if tool == "filters" and "vintage" in label:
        filters.append("curves=vintage")
    if tool == "filters" and "noir" in label:
        filters.append("hue=s=0,eq=contrast=1.35:brightness=-0.05")
    if tool == "filters" and "warm" in label:
        filters.append("colorbalance=rs=.12:gs=.04:bs=-.08")
    if tool == "filters" and "cool" in label:
        filters.append("colorbalance=rs=-.08:gs=.03:bs=.12")
    if tool == "effects" and "blur" in label:
        filters.append("boxblur=2:1")
    if tool == "effects" and ("vignette" in label or "light" in label):
        filters.append("vignette=PI/5")
    if tool == "effects" and "shake" in label:
        filters.append("crop=iw*0.94:ih*0.94:x='(iw-ow)/2+8*sin(18*t)':y='(ih-oh)/2+8*cos(14*t)',scale=iw:ih")
    if tool == "effects" and "flash" in label:
        filters.append("eq=brightness='0.18*between(mod(t,2),0,0.12)'")
    if tool == "effects" and "glitch" in label:
        filters.append("noise=alls=18:allf=t+u")
    if tool == "effects" and "sharpen" in label:
        filters.append("unsharp=5:5:1.0:5:5:0.0")
    if tool == "effects" and "light leak" in label:
        filters.append("eq=brightness='0.10*between(mod(t,3),0,0.45)':saturation=1.15")
    if tool == "effects" and "dreamy" in label:
        filters.append("gblur=sigma=1.2,eq=brightness=0.04:saturation=1.08")
    if tool == "adjust" and "brightness" in label:
        filters.append("eq=brightness=0.10")
    if tool == "adjust" and "contrast" in label:
        filters.append("eq=contrast=1.25")
    if tool == "adjust" and "saturation" in label:
        filters.append("eq=saturation=1.35")
    if tool == "adjust" and "exposure" in label:
        filters.append("eq=brightness=0.08:gamma=1.12")
    if tool == "adjust" and "sharpen" in label:
        filters.append("unsharp=5:5:0.8:5:5:0")
    if advanced.get("chromaEnabled") or advanced.get("aiBackgroundRemoval"):
        color = str(advanced.get("chromaColor", "#00ff00")).lstrip("#")
        if len(color) == 6:
            filters.append(
                f"colorkey=0x{color}:{float(advanced.get('chromaSimilarity', 0.35)):.2f}:0.08"
            )
    for overlay in overlays or []:
        content = _drawtext_escape(overlay.get("content", ""))
        if not content:
            continue
        start = max(0.0, float(overlay.get("start", 0.0)))
        end = max(start + 0.1, float(overlay.get("end", start + 5.0)))
        sticker = str(overlay.get("type", "text")).lower() == "sticker"
        size = max(12, min(160, int(overlay.get("size", 72 if sticker else 42))))
        color = "yellow" if sticker else "white"
        x_percent = max(0.0, min(100.0, float(overlay.get("x", 82 if sticker else 50))))
        y_percent = max(0.0, min(100.0, float(overlay.get("y", 12 if sticker else 78))))
        font = f"fontfile='{_drawtext_escape(font_path)}':" if font_path and os.path.exists(font_path) else ""
        keyframes = sorted(overlay.get("keyframes") or [], key=lambda frame: float(frame.get("time", start)))
        if len(keyframes) >= 2:
            first, last = keyframes[0], keyframes[-1]
            span = max(0.01, float(last.get("time", end)) - float(first.get("time", start)))
            # Named `sweep`, not `progress`: this module imports a module called
            # progress, and a local of the same name makes `progress` local to
            # this whole function — so any later progress.report() call in here
            # would raise UnboundLocalError.
            sweep = f"clip((t-{float(first.get('time', start)):.3f})/{span:.3f},0,1)"
            x = f"(w-text_w)*(({float(first.get('x', x_percent)):.3f}+( {float(last.get('x', x_percent)):.3f}-{float(first.get('x', x_percent)):.3f})*{sweep})/100)"
            y = f"(h-text_h)*(({float(first.get('y', y_percent)):.3f}+( {float(last.get('y', y_percent)):.3f}-{float(first.get('y', y_percent)):.3f})*{sweep})/100)"
        elif overlay.get("animate"):
            x = f"(w-text_w)*({x_percent:.3f}/100)+((w-text_w)*(50-{x_percent:.3f})/100)*(t-{start:.3f})/({end-start:.3f})"
            y = f"(h-text_h)*({y_percent:.3f}/100)+((h-text_h)*(50-{y_percent:.3f})/100)*(t-{start:.3f})/({end-start:.3f})"
        else:
            x = f"(w-text_w)*({x_percent:.3f}/100)"
            y = f"(h-text_h)*({y_percent:.3f}/100)"
        filters.append(
            f"drawtext={font}text='{content}':fontcolor={color}:fontsize={size}:"
            f"borderw=3:bordercolor=black:x={x}:y={y}:"
            f"enable='between(t,{start:.3f},{end:.3f})'"
        )
    return ",".join(filters) or None


def mux_final(ffmpeg_path, video_path, audio_path, music_path, music_volume, fps,
              output_path, tmp_dir, ass_name=None, total_seconds=None,
              video_filter=None, music_tracks=None, video_tracks=None,
              audio_start=0.0, audio_duration=None, speed=1.0,
              active_camera="all"):
    """Attach audio (+ optional music) and, if asked, burn in the subtitles.

    Burning captions means re-encoding the video. Everything else is a stream
    copy, so turning captions off — or shipping the .srt alongside instead —
    skips the single most expensive step in the whole pipeline.
    """
    video_layers = [track for index, track in enumerate(video_tracks or [], start=1)
                    if track.get("path") and os.path.exists(track["path"])
                    and (str(active_camera) == "all" or str(index) == str(active_camera))]
    music_paths = [music_path] if music_path else []
    music_paths.extend(track.get("path") for track in (music_tracks or []) if track.get("path"))
    music_paths = [path for index, path in enumerate(music_paths)
                   if path and path not in music_paths[:index] and os.path.exists(path)]
    inputs = ["-i", video_path]
    if audio_start > 0:
        inputs += ["-ss", f"{audio_start:.3f}"]
    if audio_duration:
        inputs += ["-t", f"{audio_duration:.3f}"]
    inputs += ["-i", audio_path]
    video_input_indexes = []
    for index, track in enumerate(video_layers, start=2):
        inputs += ["-stream_loop", "-1", "-i", track["path"]]
        video_input_indexes.append((index, track))
    audio_graph = []
    speed = max(0.25, min(2.0, float(speed or 1.0)))
    audio_map = "1:a"
    if abs(speed - 1.0) > 0.001:
        audio_graph.append(f"[1:a]atempo={speed:.3f}[voice]")
        audio_map = "[voice]"

    if music_paths:
        volume = max(0, min(100, int(music_volume))) / 100.0
        music_labels = []
        music_start = 2 + len(video_layers)
        for index, path in enumerate(music_paths, start=music_start):
            inputs += ["-stream_loop", "-1", "-i", path]
            label = f"music{index}"
            music_labels.append(f"[{label}]" )
            audio_graph.append(f"[{index}:a]volume={volume:.3f}[{label}]")
        audio_graph.append(
            (audio_map if audio_map.startswith("[") else "[1:a]") + "".join(music_labels) +
            f"amix=inputs={len(music_labels) + 1}:duration=first:dropout_transition=2[aout]"
        )
        audio_map = "[aout]"

    args = list(inputs)

    if ass_name or video_filter or video_input_indexes or abs(speed - 1.0) > 0.001:
        # Referenced by bare filename with cwd=tmp_dir. Passing an absolute
        # Windows path here would need drive-colon escaping inside a filter
        # argument, which is a classic source of silent failures.
        filters = []
        if video_filter:
            filters.append(video_filter)
        if abs(speed - 1.0) > 0.001:
            filters.append(f"setpts=PTS/{speed:.3f}")
        current = "0:v"
        if filters:
            filters = [f"[{current}]{filters[0]}[base]"]
            current = "base"
        for layer_index, track in video_input_indexes:
            start = max(0.0, float(track.get("start", 0.0)))
            end = max(start + 0.1, float(track.get("end", start + 5.0)))
            x = max(0.0, min(100.0, float(track.get("x", 0.0))))
            y = max(0.0, min(100.0, float(track.get("y", 0.0))))
            layer_label = f"layer{layer_index}"
            output_label = f"composite{layer_index}"
            filters.append(f"[{layer_index}:v]setpts=PTS-STARTPTS[{layer_label}]")
            filters.append(
                f"[{current}][{layer_label}]overlay=x='(main_w-overlay_w)*{x / 100:.3f}':"
                f"y='(main_h-overlay_h)*{y / 100:.3f}':"
                f"enable='between(t,{start:.3f},{end:.3f})'[{output_label}]"
            )
            current = output_label
        if ass_name:
            filters.append(f"[{current}]subtitles={ass_name}[captioned]")
            current = "captioned"
        video_graph = ";".join(filters + [f"[{current}]null[vout]"])
        args += ["-filter_complex", ";".join([video_graph] + audio_graph)]
        args += ["-map", "[vout]", "-map", audio_map]
        args += ["-r", fps, "-c:v", "libx264", "-preset", FFMPEG_PRESET,
                 "-crf", FINAL_CRF, "-pix_fmt", "yuv420p"]
    else:
        if audio_graph:
            args += ["-filter_complex", ";".join(audio_graph)]
        args += ["-map", "0:v", "-map", audio_map, "-r", fps,
             "-c:v", "libx264", "-preset", FFMPEG_PRESET,
             "-crf", FINAL_CRF, "-pix_fmt", "yuv420p"]

    args += ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", output_path]

    def _on_fraction(done):
        progress.report("mux", P_SUBS + P_CLIPS + P_CONCAT + P_MUX * done,
                        message="Adding audio and captions" if ass_name else "Adding audio")

    run_ffmpeg(ffmpeg_path, args, label="final mux", cwd=tmp_dir,
               total_seconds=total_seconds, on_fraction=_on_fraction)


def resolve_workers(config, clip_count):
    requested = config.get("maxWorkers")
    if requested:
        workers = int(requested)
    else:
        workers = min(DEFAULT_MAX_WORKERS, os.cpu_count() or 2)
    return max(1, min(workers, clip_count))


MIN_SLOT = 0.4                # shortest clip worth encoding (a few frames)


def sanitize_schedule(schedule, total_duration):
    """Lay the slots end to end so the clips add up to EXACTLY total_duration.

    Every later stage assumes slot N ends where slot N+1 begins: build_clip
    turns (end - start) into a clip length, concat_clips just joins them, and
    mux_final pairs the joined video with the full-length voiceover under
    `-shortest`. So a gap, an overlap, or a padded-up short slot becomes
    audio/video drift, and `-shortest` hides it by truncating whichever stream
    ran short. That is what "my last images never show up" and "the audio cuts
    off early" both actually were.

    The previous version only stretched slots shorter than 0.2s out to 0.4s,
    which made the video LONGER than the audio, and never touched overlaps at
    all. Here each slot instead keeps its share of the runtime in proportion to
    the length the scheduler asked for, with a MIN_SLOT floor, and the last slot
    is pinned to the end.

    @returns (slots, dropped_count)
    """
    raw = []
    for slot in schedule or []:
        start = max(0.0, float(slot.get("start", 0.0)))
        end = float(slot.get("end", start))
        raw.append({
            "image_index": int(slot.get("image_index", len(raw))),
            "start": start,
            "end": max(start, end),
            "opacity": max(0.0, min(1.0, float(slot.get("opacity", 1.0)))),
        })

    if not raw:
        return [], 0

    raw.sort(key=lambda s: (s["start"], s["end"]))
    span = float(total_duration) or max(s["end"] for s in raw)
    if span <= 0:
        return [], len(raw)

    # A 12s voiceover cannot show 100 images for a sane length. Keep an evenly
    # spaced subset and report the rest as dropped, rather than padding every
    # slot to MIN_SLOT and pushing the video far past the audio.
    dropped = 0
    capacity = max(1, int(span // MIN_SLOT))
    if len(raw) > capacity:
        step = len(raw) / float(capacity)
        kept = [raw[min(len(raw) - 1, int(i * step))] for i in range(capacity)]
        dropped = len(raw) - len(kept)
        raw = kept

    count = len(raw)
    weights = [max(1e-6, s["end"] - s["start"]) for s in raw]
    total_weight = sum(weights)

    # Start from each slot's exact share of the runtime, so a timeline that was
    # already sane comes out unchanged rather than being reshaped.
    lengths = [span * (w / total_weight) for w in weights]

    # Then lift anything under MIN_SLOT and pay for it out of the slots that have
    # slack, instead of adding time to the total. Giving every slot a flat
    # MIN_SLOT floor plus a proportional share would quietly compress the pacing
    # of every render, not just the ones with a too-short slot.
    for _ in range(8):
        short = [i for i, length in enumerate(lengths) if length < MIN_SLOT]
        if not short:
            break
        donors = [i for i, length in enumerate(lengths) if length > MIN_SLOT]
        slack = sum(lengths[i] - MIN_SLOT for i in donors)
        if slack <= 0:
            break  # span // MIN_SLOT above makes this unreachable in practice
        deficit = sum(MIN_SLOT - lengths[i] for i in short)
        share = min(1.0, deficit / slack)
        for index in short:
            lengths[index] = MIN_SLOT
        for index in donors:
            lengths[index] -= (lengths[index] - MIN_SLOT) * share

    clean = []
    cursor = 0.0
    for index, slot in enumerate(raw):
        # The last slot is pinned to `span` so rounding can never leave the
        # video a few milliseconds short of the audio.
        end = span if index == count - 1 else cursor + lengths[index]
        end = min(span, max(cursor, end))
        clean.append({**slot, "start": round(cursor, 3), "end": round(end, 3)})
        cursor = end

    clean[-1]["end"] = round(span, 3)
    return clean, dropped


def render(config):
    ffmpeg_path = config["ffmpegPath"]
    audio_path = config["audioPath"]
    image_paths = config["imagePaths"]
    output_path = config["outputPath"]
    export = config.get("exportSettings") or {}
    captions = config.get("captionSettings") or {}
    music = config.get("musicSettings") or {}
    effect_settings = config.get("effectSettings") or {}
    font_path = (config.get("fontSettings") or {}).get("path")
    advanced = config.get("advancedSettings") or {}
    video_filter = editor_video_filter(effect_settings, config.get("overlaySettings"), font_path, advanced)

    missing = [p for p in image_paths if not os.path.exists(p)]
    if missing:
        raise RuntimeError(f"{len(missing)} image file(s) no longer exist, e.g. {missing[0]}")
    if not os.path.exists(audio_path):
        raise RuntimeError(f"Audio file not found: {audio_path}")

    fps = int(export.get("fps", 30))
    width, height = get_resolution(export.get("quality", "1080"))
    motion = "none" if str(export.get("motion", "kenburns")).lower() == "none" else "kenburns"

    source_duration = float(config.get("duration") or 0.0)
    trim = config.get("trimSettings") or {}
    trim_start = max(0.0, float(trim.get("start", 0.0) or 0.0))
    trim_end = float(trim.get("end", 0.0) or 0.0)
    if not trim_end or trim_end > source_duration:
        trim_end = source_duration
    if trim_end <= trim_start:
        trim_start, trim_end = 0.0, source_duration
    target_duration = max(0.0, trim_end - trim_start)

    source_schedule, dropped = sanitize_schedule(config.get("schedule"), source_duration)
    windowed = []
    for slot in source_schedule:
        start = max(float(slot["start"]), trim_start)
        end = min(float(slot["end"]), trim_end)
        if end > start:
            windowed.append({**slot, "start": start - trim_start, "end": end - trim_start})
    # Re-normalise inside the trim window. Clipping slots against the window
    # edges leaves partial slots behind, and the clips still have to add up to
    # exactly the trimmed audio length or the two streams drift apart again.
    schedule, dropped_by_trim = sanitize_schedule(windowed, target_duration)
    dropped += dropped_by_trim
    if not schedule:
        raise RuntimeError("Timeline is empty — nothing to render")
    total_seconds = schedule[-1]["end"]

    caption_mode = str(captions.get("mode") or ("burn" if captions.get("enabled", True) else "off")).lower()
    font_size = int(captions.get("fontSize", 28) or 28)
    # Font size in the transcript UI is calibrated against 1080p height.
    scaled_font = max(12, int(round(font_size * height / 1080.0)))

    output_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(output_dir, exist_ok=True)
    tmp_dir = tempfile.mkdtemp(prefix="render_", dir=output_dir)

    result = {"success": True, "outputPath": output_path, "motion": motion,
              "clipCount": len(schedule), "duration": round(total_seconds, 2)}
    if dropped:
        # Silently showing fewer images than the user picked is what the old
        # scheduler did; say so instead.
        result["scheduleWarning"] = (
            f"{dropped} image(s) were left out: {round(total_seconds, 1)}s of audio "
            f"only fits {len(schedule)} images at {MIN_SLOT}s each"
        )

    try:
        progress.report("prepare", 1.0, message="Preparing timeline")

        trimmed_segments = []
        for segment in config.get("segments") or []:
            start = max(float(segment.get("start", 0.0)), trim_start)
            end = min(float(segment.get("end", 0.0)), trim_end)
            if end - start >= 0.05:
                trimmed_segments.append({**segment, "start": start - trim_start, "end": end - trim_start})
        cues = normalize_segments(trimmed_segments, total_seconds)
        ass_name = None
        srt_path = os.path.splitext(output_path)[0] + ".srt"
        if cues:
            ass_path = os.path.join(tmp_dir, "subs.ass")
            write_subtitle_files(cues, ass_path, srt_path, width, height, scaled_font)
            result["subtitlePath"] = srt_path
            result["cueCount"] = len(cues)
            if caption_mode == "burn":
                ass_name = "subs.ass"
        progress.report("prepare", P_SUBS, message=f"{len(cues)} caption cues ready")

        workers = resolve_workers(config, len(schedule))
        clip_paths = build_all_clips(ffmpeg_path, schedule, image_paths, width, height,
                                     tmp_dir, motion, workers)
        result["workers"] = workers

        transition_settings = config.get("effectSettings") or {}
        transition = transition_settings.get("label") if transition_settings.get("type") == "transitions" else None
        progress.report("concat", P_SUBS + P_CLIPS, message="Joining clips" + (f" with {transition}" if transition else ""))
        silent_path = os.path.join(tmp_dir, "joined.mp4")
        concat_clips(
            ffmpeg_path, clip_paths, silent_path, tmp_dir,
            transition=transition,
            durations=[max(0.4, slot["end"] - slot["start"]) for slot in schedule],
        )

        progress.report("mux", P_SUBS + P_CLIPS + P_CONCAT, message="Adding audio")
        try:
            mux_final(ffmpeg_path, silent_path, audio_path, music.get("path"),
                      music.get("volume", 20), fps, output_path, tmp_dir,
                      ass_name=ass_name, total_seconds=total_seconds,
                      video_filter=video_filter, music_tracks=music.get("tracks"),
                      video_tracks=config.get("videoTracks"), audio_start=trim_start,
                      audio_duration=total_seconds, speed=advanced.get("speed", 1.0),
                      active_camera=advanced.get("activeCamera", "all"))
            result["captionsBurned"] = bool(ass_name)
        except RuntimeError as exc:
            if not ass_name:
                raise
            # libass may be absent from a given FFmpeg build. Losing burned-in
            # captions is far better than losing the whole render; the .srt is
            # already written next to the video either way.
            progress.log(f"Caption burn-in failed, retrying without it: {exc}")
            progress.report("mux", P_SUBS + P_CLIPS + P_CONCAT,
                            message="Captions unavailable — finishing without burn-in")
            mux_final(ffmpeg_path, silent_path, audio_path, music.get("path"),
                      music.get("volume", 20), fps, output_path, tmp_dir,
                      ass_name=None, total_seconds=total_seconds,
                      video_filter=video_filter, music_tracks=music.get("tracks"),
                      video_tracks=config.get("videoTracks"), audio_start=trim_start,
                      audio_duration=total_seconds, speed=advanced.get("speed", 1.0),
                      active_camera=advanced.get("activeCamera", "all"))
            result["captionsBurned"] = False
            result["captionWarning"] = "This FFmpeg build could not burn subtitles; .srt saved instead"

        if not os.path.exists(output_path) or os.path.getsize(output_path) < 1024:
            raise RuntimeError("FFmpeg reported success but produced no usable output file")

        result["sizeBytes"] = os.path.getsize(output_path)
        progress.report("done", 100.0, message="Finished")
        return result

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        progress.emit_error("Usage: render_video.py <config_json_path>")

    try:
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            cfg = json.load(handle)
        progress.emit_result(render(cfg))
    except KeyboardInterrupt:
        progress.emit_error("Cancelled")
    except Exception as exc:  # noqa: BLE001 - the message is the user-facing error
        progress.emit_error(exc)







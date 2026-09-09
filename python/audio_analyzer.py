"""
audio_analyzer.py

Step 1 of the auto-generation engine.

Transcribes the voiceover with word-level timestamps (faster-whisper) and
detects natural "break points" — sentence ends and pauses where switching the
on-screen image feels intentional rather than random.

v2 adds live progress. faster-whisper's transcribe() returns a GENERATOR, and
`info.duration` is known before the first segment is decoded, so we can report
real percentages as segments stream in. Previously this ran silently for tens
of minutes with no output at all, which is what made the app look frozen.

Usage:
    python audio_analyzer.py <audio_path> [model_size] [language] [task]

model_size: tiny | base | small | medium | large-v3
  On a low-end CPU (~2 cores, 4GB RAM) prefer "tiny" or "base"; "small" and up
  are several times slower for a marginal accuracy gain on clear narration.

language: auto (default) or a Whisper code such as en, ur, hi, ar, es
  Naming the language skips the detection pass and stops Whisper guessing wrong
  when the first few seconds are music or crowd noise.

task: transcribe (default) or translate
  "translate" writes English no matter which language was spoken, which is how
  Urdu or Hindi speech ends up with English captions.

Output (stdout, JSON only):
{"duration": 72.4, "words": [...], "segments": [...], "break_points": [...]}
"""

import os
import sys

import progress

# Whisper picks up more threads than this machine can usefully feed, and
# oversubscribing the CPU makes it slower, not faster. Must be set before torch
# or ctranslate2 is imported.
os.environ.setdefault("OMP_NUM_THREADS", str(min(4, os.cpu_count() or 2)))

P_START, P_END = 3.0, 55.0   # this script owns 3%..55% of the overall job


def transcribe(audio_path, model_size="base", language=None, task="transcribe"):
    progress.report("transcribe", P_START,
                    message=f'Loading Whisper "{model_size}" (first run downloads the model)')

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError(
            "faster-whisper is not installed. Run: "
            "python -m pip install -r python/requirements.txt"
        )

    # int8 on CPU: roughly 2x faster than float32 with no audible difference
    # in timestamp quality for narration.
    model = WhisperModel(model_size, device="cpu", compute_type="int8",
                         cpu_threads=min(4, os.cpu_count() or 2))

    if task == "translate":
        progress.report("transcribe", P_START + 1.0,
                        message="Listening to the audio and translating it into English")
    else:
        progress.report("transcribe", P_START + 1.0, message="Listening to the audio")

    # language=None lets Whisper detect it, which is right most of the time but
    # costs a probe pass and guesses badly on the first few seconds of music.
    # task="translate" makes Whisper write English no matter what was spoken.
    segments_iter, info = model.transcribe(
        audio_path,
        language=language or None,
        task="translate" if task == "translate" else "transcribe",
        word_timestamps=True,
        vad_filter=True,                 # skip silence; also sharpens pause detection
        vad_parameters=dict(min_silence_duration_ms=400),
    )

    total = float(getattr(info, "duration", 0.0)) or 0.0
    words, segments = [], []

    for seg in segments_iter:
        segments.append({
            "text": seg.text.strip(),
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
        })
        for word in (seg.words or []):
            words.append({
                "word": word.word.strip(),
                "start": round(word.start, 2),
                "end": round(word.end, 2),
            })

        if total:
            done = min(1.0, seg.end / total)
            progress.report(
                "transcribe",
                P_START + (P_END - P_START) * done,
                message=f"Transcribed {int(seg.end)}s of {int(total)}s",
                sentences=len(segments),
            )

    if not segments:
        raise RuntimeError(
            "No speech was detected in this audio. Check that the file contains "
            "a voiceover and is not silent."
        )

    duration = total or segments[-1]["end"]
    progress.report("transcribe", P_END, message=f"{len(segments)} sentences transcribed")
    return words, segments, duration


def detect_break_points(segments, min_gap=0.35, long_segment=6.0):
    """Timestamps where switching the image looks natural: the start of the
    audio, the start of any sentence preceded by a real pause, and the midpoint
    of any sentence long enough that one image would overstay its welcome."""
    breaks = [0.0]

    for index, seg in enumerate(segments):
        if index > 0 and seg["start"] - segments[index - 1]["end"] >= min_gap:
            breaks.append(seg["start"])

        length = seg["end"] - seg["start"]
        if length > long_segment:
            breaks.append(round(seg["start"] + length / 2, 2))

    return sorted({round(value, 2) for value in breaks})


if __name__ == "__main__":
    if len(sys.argv) < 2:
        progress.emit_error(
            "Usage: audio_analyzer.py <audio_path> [model_size] [language] [task]"
        )

    audio_file = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    # "auto" (or nothing) means let Whisper work the language out for itself.
    lang_arg = sys.argv[3] if len(sys.argv) > 3 else "auto"
    lang_arg = None if str(lang_arg).lower() in ("", "auto", "none") else str(lang_arg)
    task_arg = sys.argv[4] if len(sys.argv) > 4 else "transcribe"

    try:
        if not os.path.exists(audio_file):
            raise RuntimeError(f"Audio file not found: {audio_file}")

        word_list, segment_list, audio_duration = transcribe(
            audio_file, model_name, language=lang_arg, task=task_arg
        )
        progress.emit_result({
            "duration": round(audio_duration, 2),
            "words": word_list,
            "segments": segment_list,
            "break_points": detect_break_points(segment_list),
            "model": model_name,
            "language": lang_arg or "auto",
            "task": task_arg,
        })
    except KeyboardInterrupt:
        progress.emit_error("Cancelled")
    except Exception as exc:  # noqa: BLE001 - the message is shown to the user
        progress.emit_error(exc)

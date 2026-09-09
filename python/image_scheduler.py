"""
image_scheduler.py (v2 — segment-aligned)

Step 2 of the auto-generation engine.

Takes the transcribed SEGMENTS (sentences, with start/end times) from
audio_analyzer.py + the list of uploaded image filenames, and assigns
each image a start/end time that always lines up with sentence
boundaries. This guarantees an image is never left on screen while
the narration has already moved on to something unrelated.

Two cases:
  - Fewer images than sentences: group consecutive sentences into
    image_index buckets, cut only at sentence edges (never mid-sentence).
  - More images than sentences (typical for e.g. 300 images / ~100
    sentences): give every sentence at least 1 image, and hand extra
    images to the LONGER sentences, subdividing that sentence's own time
    evenly. Still never crosses into a different sentence's content.

Usage:
    python image_scheduler.py <segments_json_path> <num_images> <total_duration>

Where segments_json_path is a JSON file with a "segments" array
(each item: {"text":..., "start":..., "end":...}) and a "duration" field
(or you can pass the full audio_analyzer.py output directly).

Output (stdout, JSON only):
{
  "schedule": [
    {"image_index": 0, "start": 0.0, "end": 4.2},
    ...
  ]
}
"""

import sys
import json


def build_schedule(segments, num_images, total_duration):
    if num_images <= 0:
        return []

    if not segments:
        # No transcript available — fall back to a plain even split
        step = total_duration / num_images
        return [
            {
                "image_index": i,
                "start": round(i * step, 2),
                "end": round(total_duration, 2) if i == num_images - 1 else round((i + 1) * step, 2)
            }
            for i in range(num_images)
        ]

    n_seg = len(segments)

    # ---------- Case 1: fewer (or equal) images than sentences ----------
    if num_images <= n_seg:
        target = total_duration / num_images
        buckets = []
        current = []
        current_dur = 0.0

        for seg in segments:
            current.append(seg)
            current_dur += seg["end"] - seg["start"]
            if current_dur >= target and len(buckets) < num_images - 1:
                buckets.append(current)
                current = []
                current_dur = 0.0

        if current:
            buckets.append(current)

        # collapse any overflow buckets into the last one
        while len(buckets) > num_images:
            extra = buckets.pop()
            buckets[-1].extend(extra)

        # split the largest bucket if we somehow came up short
        while len(buckets) < num_images:
            buckets.sort(key=lambda b: b[-1]["end"] - b[0]["start"], reverse=True)
            biggest = buckets[0]
            if len(biggest) < 2:
                break
            mid = len(biggest) // 2
            buckets[0:1] = [biggest[:mid], biggest[mid:]]

        schedule = [
            {
                "image_index": i,
                "start": round(bucket[0]["start"], 2),
                "end": round(bucket[-1]["end"], 2)
            }
            for i, bucket in enumerate(buckets[:num_images])
        ]

    # ---------- Case 2: more images than sentences (typical case) ----------
    else:
        durations = [seg["end"] - seg["start"] for seg in segments]
        total_seg_dur = sum(durations) or 1.0
        remaining = num_images - n_seg  # extra images beyond 1-per-sentence

        counts = [1] * n_seg
        if remaining > 0:
            weights = [d / total_seg_dur for d in durations]
            raw_alloc = [w * remaining for w in weights]
            extra = [int(r) for r in raw_alloc]
            leftover = remaining - sum(extra)

            # give leftover images to sentences with the largest fractional share
            order = sorted(range(n_seg), key=lambda i: raw_alloc[i] - int(raw_alloc[i]), reverse=True)
            for i in range(leftover):
                extra[order[i % n_seg]] += 1

            counts = [1 + e for e in extra]

        schedule = []
        idx = 0
        for seg, count in zip(segments, counts):
            seg_start, seg_end = seg["start"], seg["end"]
            seg_len = seg_end - seg_start
            slot_len = seg_len / count if count > 0 else seg_len
            for k in range(count):
                s = seg_start + k * slot_len
                e = seg_end if k == count - 1 else seg_start + (k + 1) * slot_len
                schedule.append({"image_index": idx, "start": round(s, 2), "end": round(e, 2)})
                idx += 1

    # Bucket splitting sorts by duration, so restore chronological order before
    # anything reads neighbouring slots.
    schedule.sort(key=lambda slot: (slot["start"], slot["end"]))

    # Guarantee EXACTLY num_images slots.
    #
    # Case 1 built buckets by walking sentences and closing one whenever it
    # reached the target length. With lopsided narration (one long sentence
    # followed by several very short ones) that can close fewer buckets than
    # there are images, and the sentence-count-based split loop above gives up
    # the moment every bucket holds a single sentence. The old code just
    # `break`ed there, returned a short schedule, and the leftover images were
    # silently dropped from the video with no warning anywhere in the UI.
    # Splitting by TIME instead always has room to make one more slot.
    while schedule and len(schedule) < num_images:
        widest = max(range(len(schedule)),
                     key=lambda i: schedule[i]["end"] - schedule[i]["start"])
        slot = schedule[widest]
        middle = round((slot["start"] + slot["end"]) / 2.0, 2)
        if middle - slot["start"] < 0.05 or slot["end"] - middle < 0.05:
            break  # genuinely nothing left to subdivide
        schedule[widest:widest + 1] = [
            {"image_index": 0, "start": slot["start"], "end": middle},
            {"image_index": 0, "start": middle, "end": slot["end"]},
        ]
        schedule.sort(key=lambda s: (s["start"], s["end"]))

    del schedule[num_images:]

    # Lay the slots end to end across the runtime.
    #
    # render_video.py turns (end - start) into a clip length and then pairs the
    # joined clips with the full-length voiceover, so any gap or overlap here
    # becomes audio/video drift that `-shortest` resolves by truncating one of
    # them. The previous version read schedule[index + 1]["start"] while
    # rewriting schedule[index], with a 0.2s minimum that could march the cursor
    # past total_duration on dense timelines (e.g. 300 images over 72s) and hand
    # the final slot a negative duration.
    if schedule:
        span = round(float(total_duration), 2)
        cursor = 0.0
        last = len(schedule) - 1
        for index, slot in enumerate(schedule):
            slot["image_index"] = index
            slot["start"] = round(cursor, 2)
            # Silence between two sentences belongs to the image already on
            # screen, so a slot runs until its own end rather than until the
            # next sentence starts.
            nominal = span if index == last else float(slot["end"])
            cursor = min(span, max(slot["start"], round(nominal, 2)))
            slot["end"] = round(cursor, 2)
        schedule[last]["end"] = span

    return schedule


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: image_scheduler.py <segments_json_path> <num_images> <total_duration>"}))
        sys.exit(1)

    segments_path = sys.argv[1]
    num_images = int(sys.argv[2])
    total_duration = float(sys.argv[3])

    try:
        with open(segments_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        segments = data.get("segments", [])

        schedule = build_schedule(segments, num_images, total_duration)
        print(json.dumps({"schedule": schedule}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
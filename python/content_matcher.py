"""
content_matcher.py

Step 2.5 of the pipeline — "smart matching."

Instead of trusting upload order, this actually LOOKS at each image
(using OpenAI's CLIP model) and matches it to the audio segment whose
narration it best fits — so images can be uploaded in ANY order.

How it works:
  1. image_scheduler.py already produced time SLOTS (start/end times,
     one per uploaded image, aligned to sentence boundaries).
  2. For each slot, we gather the narration text spoken during that
     time window.
  3. CLIP encodes every uploaded image AND every slot's text into the
     same "meaning space."
  4. We compute how well each image matches each slot's text, then
     solve the best overall assignment (Hungarian algorithm) so every
     image goes to its best-fitting slot with no two images assigned
     to the same slot.

Usage:
    python content_matcher.py <config_json_path>

Config JSON:
{
  "imagePaths": ["...", "...", ...],
  "segments": [{"text":"...", "start":0.0, "end":1.1}, ...],
  "schedule": [{"image_index":0, "start":0.0, "end":4.2}, ...]
}

Output (stdout, JSON only):
{"schedule": [{"image_index": <matched image's index in imagePaths>, "start":..., "end":...}, ...]}
"""

import sys
import json
import progress

from sentence_transformers import SentenceTransformer, util
from PIL import Image
from scipy.optimize import linear_sum_assignment
import numpy as np


def build_slot_texts(schedule, segments):
    """For each time slot, concatenate the narration text spoken during it."""
    texts = []
    for slot in schedule:
        overlapping = [
            seg["text"] for seg in segments
            if seg["start"] < slot["end"] and seg["end"] > slot["start"]
        ]
        text = " ".join(overlapping).strip()
        texts.append(text if text else "a scene")  # fallback if no overlap found
    return texts


ENCODE_BATCH = 4        # keep peak RAM to a handful of decoded images
CLIP_INPUT_PX = 336     # CLIP works at 224px; anything bigger is wasted memory


def match_images_to_slots(image_paths, slot_texts):
    # CLIP compares image pixels directly with each narration scene. This is
    # deliberately filename-independent and avoids requiring a second,
    # nearly-1GB caption model on machines with limited disk space.
    progress.report("match", 1, message="Loading visual analysis models")
    model = SentenceTransformer('clip-ViT-B-32')

    # Encode in small batches, downscaling first and closing each image as soon
    # as it is encoded. Holding every decoded image at once was ~50MB per 4K
    # source on top of torch, which is how this step ran a 4GB machine into swap.
    valid_indexes = []
    chunks = []
    pending = []

    def flush():
        if not pending:
            return
        chunks.append(model.encode(pending, convert_to_numpy=True, show_progress_bar=False))
        for image in pending:
            image.close()
        pending.clear()

    total = len(image_paths) or 1
    for original_index, path in enumerate(image_paths):
        try:
            with Image.open(path) as handle:
                frame = handle.convert("RGB")
        except Exception:
            continue
        frame.thumbnail((CLIP_INPUT_PX, CLIP_INPUT_PX))
        pending.append(frame)
        valid_indexes.append(original_index)
        if len(pending) >= ENCODE_BATCH:
            flush()
            progress.report("match", 1 + 65 * (len(valid_indexes) / total),
                            message=f"Analyzed {len(valid_indexes)} of {total} image(s)")
    flush()

    if not valid_indexes:
        raise RuntimeError("No images could be loaded")

    image_embeddings = np.vstack(chunks)
    text_embeddings = model.encode(slot_texts, convert_to_numpy=True, show_progress_bar=False)

    # Similarity matrix: rows = images, cols = slots
    sim_matrix = util.cos_sim(image_embeddings, text_embeddings).numpy()

    progress.report("match", 70, message=f"Analyzed {len(valid_indexes)} image(s) from pixels")
    progress.report("match", 85, message="Matching image descriptions to narration")

    n_images = len(valid_indexes)
    n_slots = len(slot_texts)

    # Pad the smaller dimension so linear_sum_assignment works on a square-ish
    # matrix (happens if some images failed to load above)
    size = max(n_images, n_slots)
    padded = np.full((size, size), -1.0, dtype=np.float32)
    padded[:n_images, :n_slots] = sim_matrix

    row_ind, col_ind = linear_sum_assignment(-padded)  # maximize similarity

    # slot_index -> image_index (original imagePaths indexing).
    # Looked up positionally, NOT via image_paths.index(...): list.index returns
    # the FIRST match, so selecting the same file twice (a deliberate way to
    # reuse an image) collapsed both rows onto one index — that image appeared
    # twice and another one never appeared at all.
    slot_to_image = {}
    for row, column in zip(row_ind, col_ind):
        if row < n_images and column < n_slots:
            slot_to_image[column] = valid_indexes[row]

    return slot_to_image


def rebuild_schedule(schedule, slot_to_image):
    new_schedule = []
    for i, slot in enumerate(schedule):
        image_index = slot_to_image.get(i, slot["image_index"])  # fallback to original order
        new_schedule.append({
            "image_index": image_index,
            "start": slot["start"],
            "end": slot["end"]
        })
    return new_schedule


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: content_matcher.py <config_json_path>"}))
        sys.exit(1)

    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            config = json.load(f)

        image_paths = config["imagePaths"]
        segments = config.get("segments", [])
        schedule = config["schedule"]

        slot_texts = build_slot_texts(schedule, segments)
        slot_to_image = match_images_to_slots(image_paths, slot_texts)
        new_schedule = rebuild_schedule(schedule, slot_to_image)

        print(json.dumps({"schedule": new_schedule}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
"""
filename_matcher.py

Faster + more accurate replacement for content_matcher.py (CLIP).

Instead of guessing what's IN an image from pixels, this reads the
image's FILENAME (which, since these are AI-generated images, usually
already describes the scene — e.g. "boy_opens_glowing_door.png") and
matches that description directly against the narration text for each
time slot. Since it's text-to-text (not image-to-text), it uses a much
smaller/faster model than CLIP and skips loading images entirely.

Usage:
    python filename_matcher.py <config_json_path>

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
import os
import re

import progress

from sentence_transformers import SentenceTransformer, util
from scipy.optimize import linear_sum_assignment
import numpy as np


def filename_to_description(path):
    """Turn 'boy_opens_glowing_door_02.png' into 'boy opens glowing door'."""
    name = os.path.splitext(os.path.basename(path))[0]
    name = re.sub(r'[_\-]+', ' ', name)          # underscores/dashes -> spaces
    name = re.sub(r'\b\d+\b', ' ', name)          # drop standalone numbers (e.g. trailing "02")
    name = re.sub(r'\s+', ' ', name).strip()
    return name if name else "a scene"


def build_slot_texts(schedule, segments):
    texts = []
    for slot in schedule:
        overlapping = [
            seg["text"] for seg in segments
            if seg["start"] < slot["end"] and seg["end"] > slot["start"]
        ]
        text = " ".join(overlapping).strip()
        texts.append(text if text else "a scene")
    return texts


def match_by_filename(image_paths, slot_texts):
    # This is the DEFAULT match mode, and the first run downloads ~80MB, so it
    # reports progress like every other worker — otherwise the UI sits still
    # long enough to look hung.
    progress.report("match", 5, message="Loading the text matching model")

    # all-MiniLM-L6-v2: small (~80MB) and fast — plenty for short phrase matching
    model = SentenceTransformer('all-MiniLM-L6-v2')

    descriptions = [filename_to_description(p) for p in image_paths]

    progress.report("match", 40, message=f"Reading {len(descriptions)} image name(s)")
    desc_embeddings = model.encode(descriptions, convert_to_numpy=True, show_progress_bar=False)

    progress.report("match", 65, message=f"Reading {len(slot_texts)} narration slot(s)")
    text_embeddings = model.encode(slot_texts, convert_to_numpy=True, show_progress_bar=False)

    sim_matrix = util.cos_sim(desc_embeddings, text_embeddings).numpy()

    progress.report("match", 85, message="Matching image names to the narration")

    n_images = len(image_paths)
    n_slots = len(slot_texts)
    size = max(n_images, n_slots)
    padded = np.full((size, size), -1.0, dtype=np.float32)
    padded[:n_images, :n_slots] = sim_matrix

    row_ind, col_ind = linear_sum_assignment(-padded)  # maximize similarity

    slot_to_image = {}
    for r, c in zip(row_ind, col_ind):
        if r < n_images and c < n_slots:
            slot_to_image[c] = r

    return slot_to_image


def rebuild_schedule(schedule, slot_to_image):
    new_schedule = []
    for i, slot in enumerate(schedule):
        image_index = slot_to_image.get(i, slot["image_index"])
        new_schedule.append({
            "image_index": image_index,
            "start": slot["start"],
            "end": slot["end"]
        })
    return new_schedule


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: filename_matcher.py <config_json_path>"}))
        sys.exit(1)

    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            config = json.load(f)

        image_paths = config["imagePaths"]
        segments = config.get("segments", [])
        schedule = config["schedule"]

        slot_texts = build_slot_texts(schedule, segments)
        slot_to_image = match_by_filename(image_paths, slot_texts)
        new_schedule = rebuild_schedule(schedule, slot_to_image)

        print(json.dumps({"schedule": new_schedule}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
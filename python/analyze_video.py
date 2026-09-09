"""
analyze_video.py

Samples frames from a video, analyzes brightness/contrast/saturation
using OpenCV histograms, and prints a JSON object with recommended
FFmpeg-style adjustment values (matching the 100 = "no change" scale
used in videoProcessor.js).

Usage:
    python analyze_video.py <video_path> [num_samples]

Output (stdout, JSON only):
    {"brightness": 105.2, "contrast": 112.8, "saturation": 108.4, "samples": 12}
"""

import sys
import json
import cv2
import numpy as np


def sample_frame_indices(total_frames, num_samples):
    if total_frames <= num_samples:
        return list(range(total_frames))
    step = total_frames / num_samples
    return [int(i * step) for i in range(num_samples)]


def analyze_frame(frame):
    """Return (mean_brightness, contrast_std, mean_saturation) for one BGR frame."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    mean_brightness = float(np.mean(gray))
    contrast_std = float(np.std(gray))

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mean_saturation = float(np.mean(hsv[:, :, 1]))

    return mean_brightness, contrast_std, mean_saturation


def compute_adjustments(video_path, num_samples=12):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    indices = sample_frame_indices(total_frames, num_samples)

    brightness_vals, contrast_vals, saturation_vals = [], [], []

    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            continue
        b, c, s = analyze_frame(frame)
        brightness_vals.append(b)
        contrast_vals.append(c)
        saturation_vals.append(s)

    cap.release()

    if not brightness_vals:
        raise RuntimeError("No frames could be read from video")

    avg_brightness = np.mean(brightness_vals)
    avg_contrast = np.mean(contrast_vals)
    avg_saturation = np.mean(saturation_vals)

    brightness_adj = 100 + np.clip((127 - avg_brightness) / 127 * 25, -20, 20)

    target_contrast_std = 58.0
    contrast_adj = 100 + np.clip((target_contrast_std - avg_contrast) / target_contrast_std * 30, -10, 30)

    target_saturation = 100.0
    saturation_adj = 100 + np.clip((target_saturation - avg_saturation) / target_saturation * 25, -10, 25)

    return {
        "brightness": round(float(brightness_adj), 1),
        "contrast": round(float(contrast_adj), 1),
        "saturation": round(float(saturation_adj), 1),
        "samples": len(brightness_vals),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: analyze_video.py <video_path> [num_samples]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    num_samples = int(sys.argv[2]) if len(sys.argv) > 2 else 12

    try:
        result = compute_adjustments(video_path, num_samples)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
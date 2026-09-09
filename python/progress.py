"""
progress.py — tiny helper so every Python worker reports progress the same way.

Contract with utils/pythonRunner.js:
  * stdout carries ONE JSON object (the result), printed once at the end.
  * stderr carries human-readable logs, plus machine-readable progress lines
    of the form:  @@PROGRESS {"stage": "...", "percent": 42.0, "message": "..."}

Progress goes on stderr on purpose. It keeps stdout a clean single-JSON
channel, so Node never has to guess which line was the result.
"""

import sys
import json

MARKER = "@@PROGRESS "


def report(stage, percent=None, message=None, **extra):
    """Emit one progress line. Never raises — a broken pipe or an
    unserialisable extra field must not take the whole render down."""
    payload = {"stage": stage}
    if percent is not None:
        # Clamp so a miscalculated ratio can never drive the UI bar backwards
        # past its bounds or past 100%.
        payload["percent"] = round(max(0.0, min(100.0, float(percent))), 1)
    if message:
        payload["message"] = str(message)
    for key, value in extra.items():
        payload[key] = value

    try:
        sys.stderr.write(MARKER + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def log(message):
    """Plain diagnostic line. Shows up in the error text if the job fails."""
    try:
        sys.stderr.write(str(message) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def emit_result(obj):
    """Print the single stdout JSON result."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def emit_error(message):
    """Print the single stdout JSON error result and exit non-zero."""
    emit_result({"error": str(message)})
    sys.exit(1)

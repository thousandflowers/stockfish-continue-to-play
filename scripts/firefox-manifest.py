#!/usr/bin/env python3
"""Print the Firefox manifest, derived from manifest.json.

Firefox differs in two keys only - an event-page background instead of a
service worker, and its add-on id - so its manifest is derived here rather
than kept by hand beside the Chrome one, where it drifts.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
m = json.loads((ROOT / "manifest.json").read_text())
m["background"] = {"scripts": ["service-worker.js"]}
m["browser_specific_settings"] = {"gecko": {
    "id": "stockfish-continue@thousandflowers",
    "strict_min_version": "128.0",
    "data_collection_permissions": {"required": ["none"]},
}}
print(json.dumps(m, indent=2))

#!/usr/bin/env python3
"""Print the CHANGELOG section for one version, to use as release notes.

Keeps the GitHub Release and the CHANGELOG saying the same thing, and makes an
undocumented release fail the tag rather than ship silently.

Usage: python3 scripts/release-notes.py 3.2.1
"""
import re
import sys
from pathlib import Path

CHANGELOG = Path(__file__).resolve().parent.parent / "CHANGELOG.md"


def section(text, version):
    """Everything under `## [version]`, up to the next version heading."""
    pattern = re.compile(
        r"^## \[" + re.escape(version) + r"\][^\n]*\n(.*?)(?=^## \[|\Z)",
        re.S | re.M,
    )
    match = pattern.search(text)
    if not match:
        raise SystemExit(
            f"✗ no '## [{version}]' section in {CHANGELOG.name} - write the "
            "entry before tagging, or the release goes out undocumented"
        )
    body = match.group(1).strip()
    if not body:
        raise SystemExit(f"✗ the '## [{version}]' section in {CHANGELOG.name} is empty")
    return body


def self_check():
    doc = "# Changelog\n\n## [2.0.0] - x\n\nnew stuff\n\n## [1.0.0] - y\n\nold stuff\n"
    assert section(doc, "2.0.0") == "new stuff", section(doc, "2.0.0")
    assert section(doc, "1.0.0") == "old stuff", section(doc, "1.0.0")
    for version in ["3.0.0", "2.0"]:          # missing, and a prefix that must not match
        try:
            section(doc, version)
        except SystemExit:
            continue
        raise AssertionError(f"should have rejected: {version}")
    try:
        section("## [9.9.9] - x\n\n## [1.0.0] - y\n\nz\n", "9.9.9")
    except SystemExit:
        pass
    else:
        raise AssertionError("should have rejected an empty section")
    print("✓ self-check passed")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-check"]:
        self_check()
    elif len(sys.argv) != 2:
        raise SystemExit(__doc__.strip().splitlines()[-1])
    else:
        print(section(CHANGELOG.read_text(), sys.argv[1]))

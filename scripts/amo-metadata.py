#!/usr/bin/env python3
"""Write the AMO version metadata web-ext sends with the upload.

The reviewer notes are kept in docs/AMO-SOURCE-SUBMISSION.md, in prose a human
can read before a release. This lifts the fenced block out of that document so
the notes AMO receives are the same ones the doc tells you to paste - there is
no second copy to forget to update.

Usage: python3 scripts/amo-metadata.py OUT.json
"""
import json
import re
import sys
from pathlib import Path

DOC = Path(__file__).resolve().parent.parent / "docs" / "AMO-SOURCE-SUBMISSION.md"
BLOCK = re.compile(r"## Notes for the reviewer[^\n]*\n+```\n(.*?)\n```", re.S)


def approval_notes(doc_text):
    match = BLOCK.search(doc_text)
    if not match:
        raise SystemExit(
            f"✗ no fenced 'Notes for the reviewer' block in {DOC.name} - "
            "AMO would get an empty explanation for the minified engine"
        )
    notes = match.group(1).strip()
    if not notes:
        raise SystemExit(f"✗ the 'Notes for the reviewer' block in {DOC.name} is empty")
    return notes


def main(argv):
    if len(argv) != 2:
        raise SystemExit(__doc__.strip().splitlines()[-1])
    notes = approval_notes(DOC.read_text())
    Path(argv[1]).write_text(json.dumps({"version": {"approval_notes": notes}}))
    print(f"✓ reviewer notes for AMO: {len(notes)} characters from {DOC.name}")


def self_check():
    ok = approval_notes("## Notes for the reviewer - paste this\n\n```\nhello\n```\n")
    assert ok == "hello", ok
    for broken in ["nothing here", "## Notes for the reviewer\n\n```\n\n```\n"]:
        try:
            approval_notes(broken)
        except SystemExit:
            continue
        raise AssertionError(f"should have rejected: {broken!r}")
    approval_notes(DOC.read_text())          # and the real document still parses
    print("✓ self-check passed")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-check"]:
        self_check()
    else:
        main(sys.argv)

#!/usr/bin/env python3
"""build_index.py — scan puzzles/*.puz and write puzzles/index.json for the
archive page.

Usage:
    python tools/build_index.py [--puzzles-dir puzzles] [--out puzzles/index.json] [--strict]

Workflow after downloading new puzzles (e.g. with nytxw_puz/get_range.py):
    copy the new YYYY-MM-DD.puz files into puzzles/, run this, commit both.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import puz  # vendored puzpy (MIT)

puz.IGNORE_CHECKSUMS = True
puz.ENCODING = 'cp1252'  # match the browser's windows-1252 decoding

DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
TYPED_RE = re.compile(r'^(mini|midi|bonus)-(\d{4}-\d{2}-\d{2})$')


def classify(stem):
    """-> (type, date|None). Mirrors js/util.js parsePuzzleId."""
    if DATE_RE.match(stem):
        return 'daily', stem
    m = TYPED_RE.match(stem)
    if m:
        return m.group(1), m.group(2)
    return 'special', None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--puzzles-dir', default='puzzles')
    ap.add_argument('--out', default=None, help='default: <puzzles-dir>/index.json')
    ap.add_argument('--strict', action='store_true',
                    help='exit non-zero if any .puz fails to parse')
    args = ap.parse_args()
    out_path = args.out or os.path.join(args.puzzles_dir, 'index.json')

    entries = []
    skipped = []
    for path in sorted(glob.glob(os.path.join(args.puzzles_dir, '*.puz'))):
        stem = os.path.splitext(os.path.basename(path))[0]
        try:
            p = puz.read(path)
        except Exception as exc:  # corrupt/foreign file: warn and move on
            skipped.append(stem)
            print(f'WARNING: skipping {path}: {exc}', file=sys.stderr)
            continue
        ptype, pdate = classify(stem)
        entries.append({
            'id': stem,
            'file': f'puzzles/{os.path.basename(path)}',
            'type': ptype,
            'date': pdate,
            'title': (p.title or '').strip(),
            'author': (p.author or '').strip(),
            'width': p.width,
            'height': p.height,
        })

    entries.sort(key=lambda e: (e['date'] or '0000-00-00', e['id']), reverse=True)
    doc = {
        'schema': 1,
        'generated_at': datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'puzzles': entries,
    }
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print(f'Indexed {len(entries)} puzzles ({len(skipped)} skipped) -> {out_path}')
    return 1 if (skipped and args.strict) else 0


if __name__ == '__main__':
    sys.exit(main())

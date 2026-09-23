#!/usr/bin/env python3
"""fetch_one.py - download one NYT puzzle into puzzles/ and rebuild the index.

The self-hosted server runs this when someone opens a puzzle that isn't in
the archive yet. It prints a single JSON line on stdout:

    {"status": "done" | "missing" | "error", "message": ..., "id": ...}

`id` is the puzzle id actually saved (a monthly bonus can run on a day
other than the 1st it was requested as).

Usage:
    python tools/fetch_one.py <puzzle-id> [--browser Firefox] [--nytxw PATH]

    --browser   Cookie source for nytxw_puz: a browser name, or
                "Cached Cookies" to read nytxw_puz's cached cookie JSON
                (the option for a headless server).
"""
import argparse
import calendar
import json
import os
import re
import subprocess
import sys

from nyt_clues import attach_formatted_clues

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
PUZZLES_DIR = os.path.join(SITE, 'puzzles')
IMAGES_DIR = os.path.join(PUZZLES_DIR, 'images')

# Mirrors js/util.js parsePuzzleId and js/config.js ARCHIVE_START.
TYPED_RE = re.compile(r'^(mini|midi|bonus)-(\d{4}-\d{2}-\d{2})$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
PREFIX = {'daily': '', 'mini': 'mini-', 'midi': 'midi-', 'bonus': 'bonus-'}
# midi isn't listed by the v3 calendar; it needs the per-date v6 endpoint
V6_ONLY = {'midi'}

CALENDAR_API = (
    'https://www.nytimes.com/svc/crosswords/v3/puzzles.json'
    '?publish_type={ptype}&sort_order=asc&sort_by=print_date'
    '&date_start={start}&date_end={end}'
)
V6_DATE_API = 'https://www.nytimes.com/svc/crosswords/v6/puzzle/{ptype}/{date}.json'


def classify(puzzle_id):
    if DATE_RE.match(puzzle_id):
        return 'daily', puzzle_id
    m = TYPED_RE.match(puzzle_id)
    return (m.group(1), m.group(2)) if m else (None, None)


def find_puzzle_id(nyt, cookies, ptype, date):
    """
    -> (NYT's internal puzzle id, its actual print date), or (None, None).

    Bonus puzzles are monthly, and the site asks for them as the 1st of the
    month, so search the whole month rather than that exact day.
    """
    if ptype in V6_ONLY:
        data = json.loads(
            nyt.get_url(cookies, V6_DATE_API.format(ptype=ptype, date=date))
        )
        return (data.get('id'), date) if data.get('body') else (None, None)

    start = end = date
    if ptype == 'bonus':
        year, month = int(date[:4]), int(date[5:7])
        last_day = calendar.monthrange(year, month)[1]
        start = f'{year:04d}-{month:02d}-01'
        end = f'{year:04d}-{month:02d}-{last_day:02d}'

    listing = json.loads(
        nyt.get_url(cookies, CALENDAR_API.format(ptype=ptype, start=start, end=end))
    )
    for entry in listing.get('results') or []:
        if entry.get('format_type') != 'Normal':
            continue
        if ptype == 'bonus' or entry.get('print_date') == date:
            return entry.get('puzzle_id'), entry.get('print_date')
    return None, None


def load_nyt(args):
    """-> (the nytxw_puz `nyt` module, NYT cookies)."""
    nytxw = os.path.abspath(args.nytxw)
    if not os.path.isfile(os.path.join(nytxw, 'nyt.py')):
        raise SystemExit(f"Can't find nytxw_puz at {nytxw} - set nytxwPath in server/config.json")
    sys.path.insert(0, nytxw)
    import nyt  # noqa: PLC0415 - deliberately late, needs sys.path first

    return nyt, nyt.load_cookies(args.browser)


def fetch(args):
    ptype, date = classify(args.puzzle_id)
    if not ptype:
        return {'status': 'error', 'message': f'"{args.puzzle_id}" is not a puzzle id this can fetch.'}

    path = os.path.join(PUZZLES_DIR, f'{PREFIX[ptype]}{date}.puz')
    if os.path.isfile(path):
        return {'status': 'done', 'message': 'Already in the archive.', 'id': args.puzzle_id}

    nyt, cookies = load_nyt(args)
    nyt_id, actual_date = find_puzzle_id(nyt, cookies, ptype, date)
    if nyt_id is None:
        when = date[:7] if ptype == 'bonus' else date
        return {'status': 'missing', 'message': f'NYT has no {ptype} puzzle for {when}.'}

    if actual_date and actual_date != date:
        path = os.path.join(PUZZLES_DIR, f'{PREFIX[ptype]}{actual_date}.puz')
    saved_id = os.path.splitext(os.path.basename(path))[0]
    data = nyt.get_puzzle_from_id(cookies, nyt_id)
    built = nyt.data_to_puz(data)
    attach_formatted_clues(built, data, puzzle_id=saved_id, images_dir=IMAGES_DIR)
    built.save(path)
    subprocess.run(
        [sys.executable, os.path.join(HERE, 'build_index.py')],
        cwd=SITE,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return {'status': 'done', 'message': None, 'id': saved_id}


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('puzzle_id')
    parser.add_argument('--browser', default='Firefox')
    parser.add_argument(
        '--nytxw', default=os.path.join(os.path.dirname(SITE), 'nytxw_puz')
    )
    args = parser.parse_args()
    try:
        result = fetch(args)
    except SystemExit as exc:  # load_nyt exits with a message on setup problems
        result = {'status': 'error', 'message': str(exc.code)[:300]}
    except Exception as exc:  # noqa: BLE001 - report, don't crash
        result = {'status': 'error', 'message': f'{type(exc).__name__}: {exc}'[:300]}
    print(json.dumps(result), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

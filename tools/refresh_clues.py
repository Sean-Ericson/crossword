#!/usr/bin/env python3
"""refresh_clues.py - add NYT's clue formatting to already-downloaded puzzles.

Puzzles fetched before the FCLU section existed (see nyt_clues.py) have no
italics stored. This walks the archive, re-asks NYT for the clue text of
each puzzle that lacks the section, and patches it in place. The grid,
clues and everything else are left exactly as they were.

Puzzles NYT gives no formatting for are marked with an empty section, so
they aren't asked about again on the next run.

Usage:
    python tools/refresh_clues.py [browser] [options]

    --limit N     stop after N puzzles (default 40) so a long archive can
                  be worked through over several runs
    --since DATE  only puzzles dated on or after DATE (YYYY-MM-DD), or a
                  plain number of days back, e.g. --since 7
    --until DATE  only puzzles dated on or before DATE
    --no-git      patch the files but don't commit or push
    --nytxw PATH  path to the nytxw_puz checkout (default: ../nytxw_puz)
"""
import argparse
import datetime
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
PUZZLES_DIR = os.path.join(SITE, 'puzzles')
sys.path.insert(0, HERE)

from fetch_requests import classify, find_puzzle_id, PREFIX  # noqa: E402
from nyt_clues import FCLU, attach_formatted_clues  # noqa: E402


def as_date_bound(value):
    """'2026-08-11' as-is; a bare number means that many days ago."""
    if not value:
        return None
    if value.isdigit():
        back = datetime.date.today() - datetime.timedelta(days=int(value))
        return back.isoformat()
    return value


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('browser', nargs='?', default='Firefox')
    parser.add_argument('--limit', type=int, default=40)
    parser.add_argument('--since')
    parser.add_argument('--until')
    parser.add_argument('--no-git', action='store_true')
    parser.add_argument(
        '--nytxw', default=os.path.join(os.path.dirname(SITE), 'nytxw_puz')
    )
    args = parser.parse_args()

    nytxw = os.path.abspath(args.nytxw)
    if not os.path.isfile(os.path.join(nytxw, 'nyt.py')):
        sys.exit(f"Can't find nytxw_puz at {nytxw} - pass --nytxw PATH")
    sys.path.insert(0, nytxw)
    import nyt  # noqa: PLC0415
    import puz  # noqa: PLC0415 - the vendored reader in tools/

    puz.IGNORE_CHECKSUMS = True
    puz.ENCODING = 'cp1252'

    since = as_date_bound(args.since)
    until = as_date_bound(args.until)

    todo = []
    for name in sorted(os.listdir(PUZZLES_DIR)):
        if not name.endswith('.puz'):
            continue
        ptype, date = classify(os.path.splitext(name)[0])
        if not ptype or not date:
            continue  # undated one-offs have nothing to look up
        if (since and date < since) or (until and date > until):
            continue
        path = os.path.join(PUZZLES_DIR, name)
        try:
            existing = puz.read(path)
        except Exception:  # noqa: BLE001 - a broken file isn't this tool's job
            continue
        if FCLU in existing.extensions:
            continue
        todo.append((name, path, ptype, date))

    if not todo:
        print('Every puzzle already carries its clue formatting.')
        return 0
    print(f'{len(todo)} puzzle(s) without clue formatting.')
    if len(todo) > args.limit:
        print(f'Doing the first {args.limit} this run; re-run for the rest.')
        todo = todo[: args.limit]

    cookies = nyt.load_cookies(args.browser)
    changed, styled = [], 0
    for name, path, ptype, date in todo:
        try:
            nyt_id, _ = find_puzzle_id(nyt, cookies, ptype, date)
            if nyt_id is None:
                print(f'  {name}: NYT no longer lists it; skipping')
                continue
            data = nyt.get_puzzle_from_id(cookies, nyt_id)
            rebuilt = nyt.data_to_puz(data)
            count = attach_formatted_clues(rebuilt, data)
            # Patch the archived file rather than replacing it, so a
            # re-download can't quietly change a puzzle someone is solving.
            existing = puz.read(path)
            existing.extensions[FCLU] = rebuilt.extensions.get(FCLU, b'{}')
            existing.save(path)
            changed.append(name)
            styled += count
            print(f'  {name}: {count} formatted clue(s)')
        except Exception as exc:  # noqa: BLE001
            print(f'  {name}: FAILED {type(exc).__name__}: {exc}'[:160], file=sys.stderr)
        time.sleep(1.0)  # be gentle with the website

    if not changed:
        print('Nothing changed.')
        return 0
    print(f'\nPatched {len(changed)} file(s), {styled} formatted clues in total.')

    if args.no_git:
        return 0
    run = lambda cmd: subprocess.run(cmd, cwd=SITE, check=True)  # noqa: E731
    run(['git', 'add', 'puzzles'])
    run(['git', 'commit', '-m', f'Add clue formatting to {len(changed)} puzzles'])
    run(['git', 'push'])
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""update_puzzles.py - one-shot archive updater.

Downloads every NYT puzzle from the latest one already in puzzles/ through
today (tomorrow's puzzle is included once NYT publishes it at ~10pm ET),
rebuilds puzzles/index.json, and commits + pushes the site repo.

Usage:
    python tools/update_puzzles.py [browser] [options]

    browser        Cookie source, default "Firefox". One of the browsers
                   nytxw_puz supports (Chrome, Chromium, Opera,
                   Microsoft Edge, Firefox) or "Cached Cookies".
    --start DATE   Start date YYYY-MM-DD (default: latest dated .puz in
                   the archive; required if the archive is empty)
    --end DATE     End date YYYY-MM-DD (default: "now" = through tomorrow)
    --nytxw PATH   Path to the nytxw_puz checkout (default: ../nytxw_puz
                   next to this site's folder)
    --no-git       Download + rebuild the index, but don't commit or push

Existing files are never re-downloaded, so re-running is always cheap.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
PUZZLES_DIR = os.path.join(SITE, 'puzzles')
DATED_PUZ_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})\.puz$')

CALENDAR_API = (
    'https://www.nytimes.com/svc/crosswords/v3/puzzles.json'
    '?publish_type=daily&sort_order=asc&sort_by=print_date'
    '&date_start={start}&date_end={end}'
)


def latest_archived_date():
    dates = [
        m.group(1)
        for f in os.listdir(PUZZLES_DIR)
        if (m := DATED_PUZ_RE.match(f))
    ]
    return max(dates) if dates else None


def clean_date(value):
    if value == 'now':
        # Reach one day ahead so tomorrow's puzzle (published ~10pm ET)
        # is picked up in the evening; a too-far end date is harmless.
        return (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    return value


def run(cmd, **kwargs):
    print('+ ' + ' '.join(cmd))
    return subprocess.run(cmd, cwd=SITE, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('browser', nargs='?', default='Firefox')
    parser.add_argument('--start')
    parser.add_argument('--end', default='now')
    parser.add_argument(
        '--nytxw', default=os.path.join(os.path.dirname(SITE), 'nytxw_puz')
    )
    parser.add_argument('--no-git', action='store_true')
    args = parser.parse_args()

    nytxw = os.path.abspath(args.nytxw)
    if not os.path.isfile(os.path.join(nytxw, 'nyt.py')):
        sys.exit(f"Can't find nytxw_puz at {nytxw} - pass --nytxw PATH")
    sys.path.insert(0, nytxw)
    import nyt  # noqa: E402  (from the nytxw_puz checkout)

    if args.browser != 'Cached Cookies' and args.browser not in nyt.get_browsers():
        options = ', '.join(list(nyt.get_browsers()) + ['Cached Cookies'])
        sys.exit(f"Unknown browser {args.browser!r} - choose one of: {options}")

    start = args.start or latest_archived_date()
    if not start:
        sys.exit('The archive has no dated puzzles yet - pass --start YYYY-MM-DD')
    end = clean_date(args.end)

    print(f'Checking NYT for puzzles {start}..{end} (cookies from {args.browser})')
    cookies = nyt.load_cookies(args.browser)
    calendar = json.loads(
        nyt.get_url(cookies, CALENDAR_API.format(start=start, end=end))
    )

    new_dates = []
    for entry in calendar.get('results') or []:
        if entry.get('format_type') != 'Normal':  # skip PDF-only specials
            continue
        date = entry['print_date']
        path = os.path.join(PUZZLES_DIR, f'{date}.puz')
        if os.path.isfile(path):
            continue
        puzzle = nyt.get_puzzle_from_id(cookies, entry['puzzle_id'])
        nyt.data_to_puz(puzzle).save(path)
        new_dates.append(date)
        print(f'  downloaded {date}.puz')
        time.sleep(1.0)  # be gentle with the website

    if not new_dates:
        print('Archive is already up to date - nothing to do.')
        return

    run([sys.executable, os.path.join(HERE, 'build_index.py')])

    if args.no_git:
        print(f'Downloaded {len(new_dates)} puzzle(s); skipping git (--no-git).')
        return

    if len(new_dates) == 1:
        message = f'Add puzzle {new_dates[0]}'
    else:
        message = f'Add {len(new_dates)} puzzles {new_dates[0]}..{new_dates[-1]}'
    run(['git', 'add', 'puzzles'])
    run(['git', 'commit', '-m', message])
    run(['git', 'push'])
    print(f'\nDone: {message}. The site updates in a minute or two.')


if __name__ == '__main__':
    main()

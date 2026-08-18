#!/usr/bin/env python3
"""update_puzzles.py - one-shot archive updater.

Downloads new NYT puzzles of every type - dailies, minis, midis, and the
monthly bonus - rebuilds puzzles/index.json, and commits + pushes the site
repo. Each type resumes from the newest one already in puzzles/; on the
first run, minis/midis start from the earliest archived daily, and bonus
starts 3 months back.

Filenames: dailies are YYYY-MM-DD.puz; other types are prefixed
(mini-YYYY-MM-DD.puz, midi-..., bonus-YYYY-MM-01.puz).

Usage:
    python tools/update_puzzles.py [browser] [options]

    browser        Cookie source, default "Firefox". One of the browsers
                   nytxw_puz supports (Chrome, Chromium, Opera,
                   Microsoft Edge, Firefox) or "Cached Cookies".
    --types LIST   Comma list from: daily,mini,midi,bonus (default: all)
    --start DATE   Start date YYYY-MM-DD for every selected type
                   (default: per-type resume described above)
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

from nyt_clues import attach_formatted_clues

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
PUZZLES_DIR = os.path.join(SITE, 'puzzles')

# (type name, filename prefix, source)
# 'calendar' types are listed by the v3 calendar API (publish_type=<name>);
# midis aren't in that calendar, so they're fetched per-date from the v6
# date-addressed endpoint instead.
PUZZLE_TYPES = [
    ('daily', '', 'calendar'),
    ('mini', 'mini-', 'calendar'),
    ('midi', 'midi-', 'v6date'),
    ('bonus', 'bonus-', 'calendar'),
]

CALENDAR_API = (
    'https://www.nytimes.com/svc/crosswords/v3/puzzles.json'
    '?publish_type={ptype}&sort_order=asc&sort_by=print_date'
    '&date_start={start}&date_end={end}'
)

V6_DATE_API = 'https://www.nytimes.com/svc/crosswords/v6/puzzle/{ptype}/{date}.json'


def archived_dates(prefix):
    rx = re.compile(rf'^{re.escape(prefix)}(\d{{4}}-\d{{2}}-\d{{2}})\.puz$')
    return sorted(
        m.group(1) for f in os.listdir(PUZZLES_DIR) if (m := rx.match(f))
    )


def default_start(ptype):
    """Where a type begins when it has no archived puzzles yet."""
    if ptype in ('mini', 'midi'):
        dailies = archived_dates('')
        return dailies[0] if dailies else None  # as far back as the dailies
    if ptype == 'bonus':
        first = datetime.date.today().replace(day=1)
        for _ in range(2):  # back 2 months -> last 3 monthly puzzles
            first = (first - datetime.timedelta(days=1)).replace(day=1)
        return first.isoformat()
    return None  # daily: requires an archive or --start


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
    parser.add_argument('--types', default='daily,mini,midi,bonus')
    parser.add_argument('--start')
    parser.add_argument('--end', default='now')
    parser.add_argument(
        '--nytxw', default=os.path.join(os.path.dirname(SITE), 'nytxw_puz')
    )
    parser.add_argument('--no-git', action='store_true')
    args = parser.parse_args()

    valid_types = [t for t, _, _ in PUZZLE_TYPES]
    selected = [t.strip() for t in args.types.split(',') if t.strip()]
    unknown = [t for t in selected if t not in valid_types]
    if unknown:
        sys.exit(f"Unknown --types {unknown} - choose from: {', '.join(valid_types)}")

    nytxw = os.path.abspath(args.nytxw)
    if not os.path.isfile(os.path.join(nytxw, 'nyt.py')):
        sys.exit(f"Can't find nytxw_puz at {nytxw} - pass --nytxw PATH")
    sys.path.insert(0, nytxw)
    import nyt  # noqa: E402  (from the nytxw_puz checkout)

    if args.browser != 'Cached Cookies' and args.browser not in nyt.get_browsers():
        options = ', '.join(list(nyt.get_browsers()) + ['Cached Cookies'])
        sys.exit(f"Unknown browser {args.browser!r} - choose one of: {options}")

    end = clean_date(args.end)

    # Start from the remote's latest so two machines running this can't
    # diverge; rebasing before we commit means no conflicts are possible.
    if not args.no_git:
        try:
            run(['git', 'pull', '--rebase', '--autostash'])
        except subprocess.CalledProcessError:
            print('WARNING: git pull failed - continuing, but the push may be rejected')

    cookies = nyt.load_cookies(args.browser)

    def puzzle_ids_from_calendar(ptype, start):
        calendar = json.loads(
            nyt.get_url(
                cookies, CALENDAR_API.format(ptype=ptype, start=start, end=end)
            )
        )
        return [
            (entry['print_date'], entry['puzzle_id'])
            for entry in calendar.get('results') or []
            if entry.get('format_type') == 'Normal'  # skip PDF-only specials
        ]

    def puzzle_ids_from_v6(ptype, start):
        """Per-date lookups for types the v3 calendar doesn't list."""
        out = []
        day = datetime.date.fromisoformat(start)
        last = datetime.date.fromisoformat(end)
        while day <= last:
            date = day.isoformat()
            day += datetime.timedelta(days=1)
            data = json.loads(
                nyt.get_url(cookies, V6_DATE_API.format(ptype=ptype, date=date))
            )
            if data.get('body') and data.get('id'):
                out.append((date, data['id']))
            time.sleep(0.5)
        return out

    new_by_type = {}
    for ptype, prefix, source in PUZZLE_TYPES:
        if ptype not in selected:
            continue
        have = archived_dates(prefix)
        start = args.start or (have[-1] if have else default_start(ptype))
        if not start:
            if ptype == 'daily':
                print('daily: archive is empty - pass --start YYYY-MM-DD; skipping')
            else:
                print(f'{ptype}: no dailies to anchor the start date; skipping')
            continue

        print(f'{ptype}: checking {start}..{end}')
        if source == 'calendar':
            listing = puzzle_ids_from_calendar(ptype, start)
        else:
            listing = puzzle_ids_from_v6(ptype, start)
        for date, puzzle_id in listing:
            path = os.path.join(PUZZLES_DIR, f'{prefix}{date}.puz')
            if os.path.isfile(path):
                continue
            puzzle = nyt.get_puzzle_from_id(cookies, puzzle_id)
            built = nyt.data_to_puz(puzzle)
            attach_formatted_clues(built, puzzle)
            built.save(path)
            new_by_type.setdefault(ptype, []).append(date)
            print(f'  downloaded {prefix}{date}.puz')
            time.sleep(1.0)  # be gentle with the website

    total = sum(len(v) for v in new_by_type.values())
    if not total:
        print('Archive is already up to date - nothing to do.')
        return

    run([sys.executable, os.path.join(HERE, 'build_index.py')])

    if args.no_git:
        print(f'Downloaded {total} puzzle(s); skipping git (--no-git).')
        return

    parts = ', '.join(f'{t} {len(v)}' for t, v in new_by_type.items())
    message = (
        f'Add puzzle {new_by_type["daily"][0]}'
        if total == 1 and 'daily' in new_by_type
        else f'Add {total} puzzles ({parts})'
    )
    run(['git', 'add', 'puzzles'])
    run(['git', 'commit', '-m', message])
    run(['git', 'push'])
    print(f'\nDone: {message}. The site updates in a minute or two.')


if __name__ == '__main__':
    main()

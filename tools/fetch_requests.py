#!/usr/bin/env python3
"""fetch_requests.py - serve on-demand puzzle requests.

Browsers can't download from NYT themselves (no CORS, and the session
cookies are same-site), so the site queues requests as
`requests/<puzzle-id>.json` in the private data repo. This script - run
every minute or so on the machine that has the NYT login - picks them up,
downloads the puzzles, commits them to the site repo, and marks each
request done / missing / error so the waiting browser can react.

Usage:
    python tools/fetch_requests.py [browser] [options]

    browser        Cookie source, default "Firefox".
    --data-repo    owner/name of the private data repo. Defaults to what
                   js/config.js has.
    --limit N      Most requests to serve per run (default 25), so a stuck
                   page or an impatient clicker can't turn into a scrape.
    --nytxw PATH   Path to the nytxw_puz checkout (default: ../nytxw_puz)
    --no-git       Download and update requests, but don't commit or push.
    --once         Alias for the default behaviour; kept for clarity.

Needs the `gh` CLI authenticated (it is what talks to the private repo).
"""
import argparse
import base64
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
PUZZLES_DIR = os.path.join(SITE, 'puzzles')

# Mirrors js/util.js parsePuzzleId and js/config.js ARCHIVE_START.
TYPED_RE = re.compile(r'^(mini|midi|bonus)-(\d{4}-\d{2}-\d{2})$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
PREFIX = {'daily': '', 'mini': 'mini-', 'midi': 'midi-', 'bonus': 'bonus-'}
# midi isn't listed by the v3 calendar; it needs the per-date v6 endpoint
V6_ONLY = {'midi'}

CALENDAR_API = (
    'https://www.nytimes.com/svc/crosswords/v3/puzzles.json'
    '?publish_type={ptype}&sort_order=asc&sort_by=print_date'
    '&date_start={date}&date_end={date}'
)
V6_DATE_API = 'https://www.nytimes.com/svc/crosswords/v6/puzzle/{ptype}/{date}.json'


def classify(puzzle_id):
    if DATE_RE.match(puzzle_id):
        return 'daily', puzzle_id
    m = TYPED_RE.match(puzzle_id)
    return (m.group(1), m.group(2)) if m else (None, None)


def now_iso():
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec='milliseconds')
        .replace('+00:00', 'Z')
    )


# Scheduled tasks don't necessarily inherit the interactive PATH - gh in
# particular is often only on the user's. Resolve the executables once, by
# hand, so a missing PATH entry is a clear message instead of a
# FileNotFoundError on every poll.
EXE_CANDIDATES = {
    'gh': [
        r'C:\Program Files\GitHub CLI\gh.exe',
        r'C:\Program Files (x86)\GitHub CLI\gh.exe',
        os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe'),
        os.path.expandvars(r'%LOCALAPPDATA%\GitHubCLI\gh.exe'),
    ],
    'git': [
        r'C:\Program Files\Git\cmd\git.exe',
        r'C:\Program Files (x86)\Git\cmd\git.exe',
    ],
}
TOOLS = {}


def find_exe(name):
    """-> absolute path to `name`, or None. Env override: XWORD_GH / XWORD_GIT."""
    override = os.environ.get(f'XWORD_{name.upper()}')
    if override and os.path.isfile(override):
        return override
    found = shutil.which(name)
    if found:
        return found
    for candidate in EXE_CANDIDATES.get(name, []):
        if os.path.isfile(candidate):
            return candidate
    return None


def resolve_tools(need_git=True):
    """Work out how to reach the GitHub API, and find git for the archive."""
    TOOLS['token'] = find_token()
    if not TOOLS['token']:
        gh = find_exe('gh')
        if not gh:
            suggested = (
                TOKEN_FILES[0] if TOKEN_FILES else os.path.join(SITE, '.github_token')
            )
            sys.exit(
                "Can't reach GitHub: no token and no gh.exe.\n"
                'Fix either way:\n'
                '  (a) Give it a token - the same fine-grained token the site\n'
                '      uses for the data repo works. Save it as\n'
                f'      {suggested}\n'
                '      (that path is gitignored), or set XWORD_GITHUB_TOKEN.\n'
                '  (b) Install the GitHub CLI and sign in:\n'
                '      winget install GitHub.cli  &&  gh auth login\n'
                '      If it is installed but not on this process\'s PATH,\n'
                '      set XWORD_GH to the full path of gh.exe.'
            )
        TOOLS['gh'] = gh

    if need_git:
        git = find_exe('git')
        if not git:
            sys.exit(
                "Can't find git.exe - needed to commit fetched puzzles. "
                'Install Git, or set XWORD_GIT to its full path '
                r'(e.g. setx XWORD_GIT "C:\Program Files\Git\cmd\git.exe").'
            )
        TOOLS['git'] = git


TOKEN_FILES = [
    os.path.join(SITE, '.github_token'),
    os.path.expanduser('~/.crossword_github_token'),
]


def find_token():
    """A GitHub token for the data repo: env var, then file, then gh."""
    env = os.environ.get('XWORD_GITHUB_TOKEN')
    if env and env.strip():
        return env.strip()
    for path in TOKEN_FILES:
        try:
            with open(path, encoding='utf-8') as f:
                token = f.read().strip()
            if token:
                return token
        except OSError:
            continue
    gh = find_exe('gh')
    if gh:
        result = subprocess.run(
            [gh, 'auth', 'token'], capture_output=True, text=True, encoding='utf-8'
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return None


def gh_api(path, method='GET', payload=None, repo=None):
    """
    Call the GitHub contents API. Uses a token directly when one is
    configured (no external tools needed); otherwise shells out to gh.
    """
    token = TOOLS.get('token')
    if token:
        import urllib.error  # noqa: PLC0415 - only needed on this path
        import urllib.request

        request = urllib.request.Request(
            f'https://api.github.com/repos/{repo}/{path}',
            method=method,
            data=json.dumps(payload).encode('utf-8') if payload is not None else None,
            headers={
                'Authorization': f'Bearer {token}',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
                'User-Agent': 'crossword-site-fetcher',
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read().decode('utf-8')
            return json.loads(body) if body.strip() else None
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            detail = exc.read().decode('utf-8', 'replace')[:200]
            raise RuntimeError(f'GitHub {method} {path} -> {exc.code}: {detail}') from exc

    cmd = [TOOLS.get('gh', 'gh'), 'api', f'repos/{repo}/{path}', '-X', method]
    if payload is not None:
        cmd += ['--input', '-']
    result = subprocess.run(
        cmd,
        input=json.dumps(payload) if payload is not None else None,
        capture_output=True,
        text=True,
        encoding='utf-8',
    )
    if result.returncode != 0:
        stderr = result.stderr or ''
        if '404' in stderr or 'Not Found' in stderr:
            return None
        raise RuntimeError(f'gh api {path} failed: {stderr.strip()[:200]}')
    return json.loads(result.stdout) if result.stdout.strip() else None


def default_data_repo():
    """Read the data repo out of js/config.js so there's one source."""
    try:
        with open(os.path.join(SITE, 'js', 'config.js'), encoding='utf-8') as f:
            text = f.read()
        owner = re.search(r"owner:\s*'([^']*)'", text)
        repo = re.search(r"repo:\s*'([^']*)'", text)
        if owner and repo and owner.group(1):
            return f'{owner.group(1)}/{repo.group(1)}'
    except OSError:
        pass
    return None


def run(cmd, **kwargs):
    if cmd and cmd[0] == 'git':
        cmd = [TOOLS.get('git', 'git'), *cmd[1:]]
    print('+ ' + ' '.join(cmd))
    return subprocess.run(cmd, cwd=SITE, check=True, **kwargs)


def find_puzzle_id(nyt, cookies, ptype, date):
    """-> NYT's internal puzzle id for this type+date, or None."""
    if ptype in V6_ONLY:
        data = json.loads(
            nyt.get_url(cookies, V6_DATE_API.format(ptype=ptype, date=date))
        )
        return data.get('id') if data.get('body') else None
    listing = json.loads(
        nyt.get_url(cookies, CALENDAR_API.format(ptype=ptype, date=date))
    )
    for entry in listing.get('results') or []:
        if entry.get('print_date') == date and entry.get('format_type') == 'Normal':
            return entry.get('puzzle_id')
    return None


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('browser', nargs='?', default='Firefox')
    parser.add_argument('--data-repo', default=default_data_repo())
    parser.add_argument('--limit', type=int, default=25)
    parser.add_argument(
        '--nytxw', default=os.path.join(os.path.dirname(SITE), 'nytxw_puz')
    )
    parser.add_argument('--no-git', action='store_true')
    parser.add_argument('--once', action='store_true')
    parser.add_argument(
        '--keep-days',
        type=int,
        default=3,
        help='delete served requests older than this many days (0 = never)',
    )
    parser.add_argument(
        '--watch',
        action='store_true',
        help='keep running, polling every --interval seconds',
    )
    parser.add_argument('--interval', type=float, default=5.0)
    args = parser.parse_args()

    if not args.data_repo:
        sys.exit('No data repo configured - pass --data-repo owner/name')

    resolve_tools(need_git=not args.no_git)

    if not args.watch:
        return serve_once(args, quiet=False)

    print(
        f'Watching {args.data_repo} for puzzle requests '
        f'(every {args.interval:g}s). Ctrl+C to stop.'
    )
    last_heartbeat = 0.0
    last_error, repeats = None, 0
    while True:
        try:
            serve_once(args, quiet=True)
            last_error, repeats = None, 0
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001 - a bad poll shouldn't stop the loop
            detail = f'{type(exc).__name__}: {exc}'[:200]
            # Don't fill the log with the same failure every few seconds.
            if detail == last_error:
                repeats += 1
                if repeats in (10, 100) or repeats % 1000 == 0:
                    print(f'  (still failing, {repeats} times)', file=sys.stderr, flush=True)
            else:
                print(f'poll failed: {detail}', file=sys.stderr, flush=True)
                last_error, repeats = detail, 1
        # Occasional proof of life, so a silent log doesn't look like a crash.
        if time.time() - last_heartbeat > 3600:
            print(f'[{now_iso()}] watching...', flush=True)
            last_heartbeat = time.time()
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            raise


# Loaded once and reused across watch passes.
_NYT = {'module': None, 'cookies': None, 'loaded_at': 0.0}
COOKIE_TTL = 30 * 60  # re-read the browser's cookies this often


def load_nyt(args):
    if _NYT['module'] is None:
        nytxw = os.path.abspath(args.nytxw)
        if not os.path.isfile(os.path.join(nytxw, 'nyt.py')):
            sys.exit(f"Can't find nytxw_puz at {nytxw} - pass --nytxw PATH")
        sys.path.insert(0, nytxw)
        import nyt  # noqa: PLC0415 - deliberately late, needs sys.path first

        _NYT['module'] = nyt
    if time.time() - _NYT['loaded_at'] > COOKIE_TTL:
        # Picks up a fresh NYT login without restarting the watcher.
        _NYT['cookies'] = _NYT['module'].load_cookies(args.browser)
        _NYT['loaded_at'] = time.time()
    return _NYT['module'], _NYT['cookies']


def serve_once(args, quiet=False):
    """One pass over the request queue. -> exit code."""
    listing = gh_api('contents/requests', repo=args.data_repo)
    if not listing:
        if not quiet:
            print('No pending requests.')
        return 0

    cutoff = (
        datetime.datetime.now(datetime.timezone.utc)
        - datetime.timedelta(days=args.keep_days)
    ).isoformat()

    pending, stale = [], []
    for entry in listing:
        if entry.get('type') != 'file' or not entry['name'].endswith('.json'):
            continue
        record = gh_api(f'contents/requests/{entry["name"]}', repo=args.data_repo)
        if not record:
            continue
        body = json.loads(base64.b64decode(record['content']).decode('utf-8'))
        if body.get('status') == 'pending':
            pending.append((entry['name'], record['sha'], body))
        elif args.keep_days and (body.get('updated_at') or '') < cutoff:
            stale.append((entry['name'], record['sha']))

    # Served requests are only a mailbox between the browser and here;
    # sweep them once nobody could still be waiting on the answer.
    for name, sha in stale:
        gh_api(
            f'contents/requests/{name}',
            method='DELETE',
            payload={'message': f'clean up served request {name}', 'sha': sha},
            repo=args.data_repo,
        )
    if stale:
        print(f'Cleaned up {len(stale)} served request(s).')

    if not pending:
        if not quiet:
            print(f'{len(listing)} request file(s), none pending.')
        return 0

    pending.sort(key=lambda item: item[2].get('requested_at') or '')
    if len(pending) > args.limit:
        print(f'{len(pending)} pending; serving the oldest {args.limit} this run.')
        pending = pending[: args.limit]

    nyt, cookies = load_nyt(args)

    downloaded, outcomes = [], []
    for name, sha, body in pending:
        puzzle_id = body.get('id') or name[:-5]
        ptype, date = classify(puzzle_id)
        status, message, blob = 'error', None, None

        if not ptype:
            message = f'"{puzzle_id}" is not a puzzle id this can fetch.'
        else:
            path = os.path.join(PUZZLES_DIR, f'{PREFIX[ptype]}{date}.puz')
            if os.path.isfile(path):
                status, message = 'done', 'Already in the archive.'
            else:
                try:
                    nyt_id = find_puzzle_id(nyt, cookies, ptype, date)
                    if nyt_id is None:
                        status = 'missing'
                        message = f'NYT has no {ptype} puzzle for {date}.'
                    else:
                        data = nyt.get_puzzle_from_id(cookies, nyt_id)
                        nyt.data_to_puz(data).save(path)
                        downloaded.append(os.path.basename(path))
                        status = 'done'
                        print(f'  downloaded {os.path.basename(path)}')
                        time.sleep(1.0)  # be gentle with the website
                except Exception as exc:  # noqa: BLE001 - report, don't crash
                    message = f'{type(exc).__name__}: {exc}'[:200]
                    print(f'  ERROR {puzzle_id}: {message}', file=sys.stderr)
            # Hand the bytes back through the request itself so the browser
            # can start playing immediately, instead of waiting ~40s for
            # GitHub Pages to publish the committed copy.
            if status == 'done' and os.path.isfile(path):
                try:
                    with open(path, 'rb') as f:
                        blob = base64.b64encode(f.read()).decode('ascii')
                except OSError:
                    blob = None

        outcomes.append((name, sha, body, status, message, blob))

    # Answer the waiting browsers first - delivery no longer depends on the
    # commit, so there's no reason to make anyone wait for git.
    for name, sha, body, status, message, blob in outcomes:
        body.update(status=status, message=message, updated_at=now_iso())
        if blob:
            body['content'] = blob
        gh_api(
            f'contents/requests/{name}',
            method='PUT',
            payload={
                'message': f'fetch {body.get("id", name)}: {status}',
                'content': base64.b64encode(
                    json.dumps(body, indent=1).encode('utf-8')
                ).decode('ascii'),
                'sha': sha,
            },
            repo=args.data_repo,
        )

    # Then archive them properly, so they're served from the site from now on.
    if downloaded and not args.no_git:
        try:
            run(['git', 'pull', '--rebase', '--autostash'])
        except subprocess.CalledProcessError:
            print('WARNING: git pull failed - the push may be rejected')
        run([sys.executable, os.path.join(HERE, 'build_index.py')])
        run(['git', 'add', 'puzzles'])
        label = downloaded[0] if len(downloaded) == 1 else f'{len(downloaded)} puzzles'
        run(['git', 'commit', '-m', f'Fetch on demand: {label}'])
        run(['git', 'push'])

    served = ', '.join(f'{s}={sum(1 for o in outcomes if o[3] == s)}' for s in
                       ('done', 'missing', 'error'))
    print(f'Served {len(outcomes)} request(s): {served}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

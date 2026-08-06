# Running the daily update on an always-on PC

One machine should own the scheduled update. It needs: Git, Python, a Firefox
logged into nytimes.com, and push access to the site repo.

## 1. Install prerequisites

```powershell
winget install Git.Git
winget install Python.Python.3.12
winget install GitHub.cli        # easiest way to get non-interactive git push
winget install Mozilla.Firefox   # if it isn't already there
```

Close and reopen the terminal afterwards so PATH updates.

## 2. Clone both repos side by side

Two repos, **in the same parent folder** — the updater looks for `nytxw_puz`
as a sibling of the site repo (override with `--nytxw PATH` otherwise). The
site folder's own name doesn't matter.

```powershell
mkdir C:\Crossword
cd C:\Crossword
git clone https://github.com/Sean-Ericson/crossword.git
git clone https://github.com/Q726kbXuN/nytxw_puz.git
```

**Using GitHub Desktop instead?** `crossword` appears in your repo list, but
`nytxw_puz` will not — it belongs to someone else, and the list only shows
your own repos. Clone it with **File → Clone repository → URL tab** and
paste `Q726kbXuN/nytxw_puz`. Keep the default location so both land in
`Documents\GitHub\` as siblings.

> Do **not** clone `crossword-data`. The site writes progress and stats to
> it directly through the GitHub API from the browser; nothing on this PC
> needs a local copy. (`Crosswords`, if you see it, is an unrelated older
> project.)

## 3. Install the two Python packages the downloader needs

```powershell
python -m pip install browser_cookie3 requests
```

If `python` on that PC is the Microsoft Store stub (it prints a Store ad
instead of a version), install real Python from the winget line above, or
point the scripts at a specific interpreter:
`setx XWORD_PYTHON "C:\Path\to\python.exe"` — `update.cmd` honors it.

## 4. Log into NYT in Firefox on that PC

Open Firefox → nytimes.com → sign in → load a crossword once. The updater
reads that Firefox profile's cookies. **Firefox does not need to be running**
when the task fires, but the login must not have expired — see maintenance
below.

## 5. Make `git push` work without prompting

Under Task Scheduler nothing can answer a popup, so cache credentials once:

```powershell
gh auth login          # choose GitHub.com → HTTPS → login with a browser
gh auth setup-git      # makes git use gh's stored token
```

Then confirm it pushes silently — from a **terminal**, not GitHub Desktop.
The scheduled task runs command-line git, which has its own credential
setup; GitHub Desktop being signed in is not enough on its own.

```powershell
cd C:\Crossword\crossword
git pull
git push               # should say "Everything up-to-date" with no prompt
```

## 6. Test the update by hand

```powershell
cd C:\Crossword\crossword
.\daily_update.bat
type logs\update.log
```

The log should end with `----- finished OK`. Run it twice — the second run
should report `Archive is already up to date - nothing to do.`

## 7. Register the scheduled task

NYT publishes the next day's puzzle around 10pm ET (6pm ET on Fri/Sat for
the Sunday). Running late in the evening picks up tomorrow's puzzle; the
updater always fills in anything it missed, so the exact time is not
critical.

Run this as one line, substituting your own path (`/tn` = task name,
`/tr` = what to run, `/sc daily` + `/st` = when, `/f` = overwrite an
existing task of the same name):

```
schtasks /create /tn "Crossword daily update" /tr "C:\Crossword\crossword\daily_update.bat" /sc daily /st 23:30 /f
```

Quote the `/tr` path only if it contains spaces — and if it does, escape
the inner quotes: `/tr "\"C:\My Folder\daily_update.bat\""`.

Then open **Task Scheduler** → find the task → Properties and set:

- **General → Run whether user is logged on or not** (enter the account
  password when prompted). Keep **Do not store password** unchecked.
- **General → Run with highest privileges**: not needed, leave off.
- **Settings → Run task as soon as possible after a scheduled start is
  missed**: on (covers reboots).
- **Settings → If the task fails, restart every**: 1 hour, up to 3 times
  (covers transient network failures).

Test it immediately with `schtasks /run /tn "Crossword daily update"`, wait a
minute, then check `logs\update.log`.

> If "run whether logged on or not" ever fails to read cookies, switch that
> setting to "Run only when user is logged on" and leave the PC signed in —
> Firefox's cookie store is readable either way, but this removes all doubt.
>
> Never set the task to run as `SYSTEM`. That account has no Firefox
> profile, so there is no NYT login for the downloader to find.

## 8. Register the on-demand fetcher

This is what makes clicking an un-downloaded day on the site actually work.
The site queues requests in the data repo; this serves them.

It needs read/write access to the private data repo. Either works:

- **A token** — the same fine-grained token the site uses. Save it as
  `.github_token` in the repo root (gitignored), or set `XWORD_GITHUB_TOKEN`.
  Nothing else to install.
- **The `gh` CLI**, signed in (`gh auth status`). Used automatically if
  there's no token.

If neither is available the fetcher exits with instructions rather than
retrying forever. Note that a scheduled task doesn't inherit your user
PATH, so `gh` can be visible in your prompt yet missing here — the token
route sidesteps that entirely.

**Pick one of the two.** The watcher is faster; the scheduled task is
simpler.

### Option A — watcher (recommended, ~10-20 s per fetch)

Stays running and polls every 5 seconds:

```
schtasks /create /tn "Crossword fetch watcher" /tr "C:\Crossword\crossword\fetch_watch.bat" /sc onlogon /f
```

> **`ERROR: Access is denied.`** — `/sc onlogon` needs an elevated prompt
> (Start → type `cmd` → Ctrl+Shift+Enter). `/sc minute` in Option B does
> not. If you'd rather not use admin at all, skip schtasks entirely: press
> Win+R, run `shell:startup`, and put a shortcut to
> **`fetch_watch_hidden.vbs`** in that folder. The watcher then starts at
> every login with no console window and no elevation — the only
> difference is it needs the machine to stay logged in.

In Task Scheduler, open it and set:

- **General → Run whether user is logged on or not**
- **Settings → If the task fails, restart every** 1 minute (so it comes back
  if it ever dies)
- **Settings → untick "Stop the task if it runs longer than"** — this one is
  meant to run forever

Start it now without rebooting: `schtasks /run /tn "Crossword fetch watcher"`.

### Option B — scheduled task (1-minute floor, ~1-2 min per fetch)

Windows can't schedule anything more often than once a minute, so this is
the fastest a task-based approach gets:

```
schtasks /create /tn "Crossword fetch requests" /tr "C:\Crossword\crossword\fetch_requests.bat" /sc minute /mo 1 /f
```

Same **Run whether user is logged on or not** setting. Each idle run costs
about 0.6 s and one API call, and it only writes to the log when it actually
does something.

### Checking it

Open an old date on the site (say a day in 2003) — the puzzle should arrive
without the page being reloaded. Or run `fetch_requests.bat` by hand with
nothing queued; it prints `No pending requests.` The log is `logs\fetch.log`.

Useful flags (pass them to either .bat): `--interval N` sets the watcher's
poll seconds, `--limit N` caps how many puzzles one pass will fetch
(default 25, so a stuck page can't become a scrape), `--keep-days N`
controls how long served requests linger before cleanup (default 3).

## Maintenance

- **The NYT login expires** every few months. Symptom: the log shows 0 new
  puzzles for days, a JSON/KeyError from the downloader, or on-demand
  fetches that never arrive. Fix: open Firefox on that PC, sign back into
  nytimes.com, done.
- **Watch the log** occasionally: `logs\update.log` (it rotates past ~1 MB).
  It is gitignored, so it never gets committed.
- **Both PCs can push.** The updater runs `git pull --rebase --autostash`
  before downloading, so the two machines won't diverge. On your main PC,
  just `git pull` before making changes.
- **To backfill history** from either machine:
  `.\update.cmd Firefox --start 2026-01-01` (skips existing files; midis are
  slower because they need one request per date).

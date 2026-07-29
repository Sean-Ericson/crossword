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

The updater expects `nytxw_puz` as a sibling of `crossword-site` (override
with `--nytxw PATH` if you put it elsewhere).

```powershell
mkdir C:\Crossword
cd C:\Crossword
git clone https://github.com/Sean-Ericson/crossword.git crossword-site
git clone https://github.com/Q726kbXuN/nytxw_puz.git
```

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

Then confirm it pushes silently:

```powershell
cd C:\Crossword\crossword-site
git pull
git push               # should say "Everything up-to-date" with no prompt
```

## 6. Test the update by hand

```powershell
cd C:\Crossword\crossword-site
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

```powershell
schtasks /create /tn "Crossword daily update" ^
  /tr "\"C:\Crossword\crossword-site\daily_update.bat\"" ^
  /sc daily /st 23:30 /f
```

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

## Maintenance

- **The NYT login expires** every few months. Symptom: the log shows 0 new
  puzzles for days, or a JSON/KeyError from the downloader. Fix: open Firefox
  on that PC, sign back into nytimes.com, done.
- **Watch the log** occasionally: `logs\update.log` (it rotates past ~1 MB).
  It is gitignored, so it never gets committed.
- **Both PCs can push.** The updater runs `git pull --rebase --autostash`
  before downloading, so the two machines won't diverge. On your main PC,
  just `git pull` before making changes.
- **To backfill history** from either machine:
  `.\update.cmd Firefox --start 2026-01-01` (skips existing files; midis are
  slower because they need one request per date).

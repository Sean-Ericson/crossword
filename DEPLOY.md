# Deploying on a home machine

The site runs on an always-on computer at home, either this Windows PC or a
Linux box, and is published through Cloudflare as
**https://cross.ho.house**:

```
browser ──https──▶ Cloudflare ──▶ roommate's tunnel/proxy (LAN) ──http──▶ crossword server :8080 (this machine, fixed LAN IP)
                                                                              │
                                                          SQLite (server/data/crossword.db) + puzzles/
```

Your roommate's setup handles three things:

- the public name and its DNS;
- HTTPS certificates;
- getting traffic into the house, so you don't need to forward any ports
  on the router.

His setup forwards requests as plain HTTP to this machine's fixed LAN IP.
The crossword server only has to listen on the LAN. It also runs the daily
puzzle download and the nightly database backup itself.

## What to tell your roommate

- **Origin:** `http://<this machine's LAN IP>:8080` (plain HTTP).
- **WebSockets** must be allowed. The live co-op sync uses `/ws`. Cloudflare
  and cloudflared allow them by default; if there's an nginx-style proxy
  in between, it needs the `Upgrade`/`Connection` headers passed through.
- **Headers:** keep `Host` as `cross.ho.house` if he can. Either way,
  pass `X-Forwarded-Proto` and `CF-Connecting-IP` through. Cloudflare and
  cloudflared set both.
- **Timeouts:** the server pings every 30 seconds, so Cloudflare's 100-second
  idle timeout is fine.
- Ask for the IP address his tunnel/proxy connects *from*. The firewall
  step below can then accept connections from that machine only.

## 1. Prerequisites

| | Windows | Linux |
|---|---|---|
| Node 22.13+ (`node:sqlite`) | `winget install OpenJS.NodeJS.LTS` | distro package or [nodesource](https://github.com/nodesource/distributions) |
| Python 3.9+ plus nytxw_puz's requirements | miniconda works (auto-detected) | `python3 -m venv` + `pip install -r ../nytxw_puz/requirements.txt` |

Then set up the site:

1. Clone this repo and [nytxw_puz](https://github.com/Q726kbXuN/nytxw_puz)
   next to each other.
2. Run `npm install` in `crossword-site`.

## 2. NYT cookies

The puzzle downloader needs a logged-in nytimes.com session. How it gets
one depends on the machine:

- **Windows PC you browse on:** leave `nytBrowser` at `"Firefox"` (or set
  it to your browser). The downloader reads the browser's cookies directly.
- **Headless Linux server:** set `"nytBrowser": "Cached Cookies"`. Then
  copy the cookie cache that nytxw_puz writes on a machine with a browser:
  `%APPDATA%\nytxw_puz.cookies.json` on Windows goes to
  `~/nytxw_puz.cookies.json` for the user the server runs as. Re-copy it
  whenever NYT logs you out, roughly every few months.

## 3. Configure

Copy the example config. `server/config.json` is gitignored.

```bash
cp server/config.example.json server/config.json
```

The example is already set up for this deployment:

```json
{
  "host": "0.0.0.0",
  "port": 8080,
  "publicUrl": "https://cross.ho.house"
}
```

- `host: "0.0.0.0"` lets the proxy reach the server over the LAN. The
  default, `127.0.0.1`, only accepts connections from this machine.
- `publicUrl` marks sign-in cookies Secure, and it lets WebSocket
  connections from pages on cross.ho.house through even if the proxy
  rewrites `Host`.

Other settings you might change:

| Setting | What it does | Default |
|---|---|---|
| `nytBrowser` | Where the downloader gets NYT cookies | `Firefox` |
| `dailyUpdateAt` | Time of the daily puzzle download (`null` turns it off) | `23:30` |
| `backupAt` | Time of the nightly backup | `04:00` |
| `keepBackups` | How many backups to keep | `14` |
| `dataDir` | Where the database lives | `server/data` |
| `python` | Python to use; set it if auto-detection picks the wrong one | auto-detected |
| `nytxwPath` | Location of the nytxw_puz checkout | `../nytxw_puz` |
| `clientIpHeader` | Header holding the visitor's real IP (used by the sign-in limiter) | `cf-connecting-ip` |

Create the accounts. Each command prints a temporary password to give to
that person.

```bash
node server/admin.mjs add-user sean --admin
node server/admin.mjs add-user devon --display "Devon"
node server/admin.mjs add-user kam
```

### Moving over from the GitHub data repo

To bring over existing progress and stats, run the importer once. It needs
the `gh` CLI signed in with access to the data repo, or a local clone
passed with `--dir`.

```bash
node server/tools/import-github.mjs --dry-run                  # see what it would do
node server/tools/import-github.mjs \
     --coop-profile co-op --coop-members sean,devon,kam        # the shared "co-op" profile becomes co-op solves
```

The importer:

- creates any missing accounts and prints their temporary passwords;
- merges each person's progress into their solo solves, using the same
  rules the old sync used;
- copies the old `stats.json` solve logs into the new stats.

It's safe to run again.

## 4. Run it

### Windows

From an **administrator** PowerShell in the site folder:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -AllowFrom <roommate's proxy IP>
```

The script:

- registers the **Crossword server** task, which starts at logon, restarts
  if the server stops, and logs to `logs\server.log`;
- opens TCP 8080 in Windows Firewall to that one IP. Leave out `-AllowFrom`
  to allow the whole local subnet instead;
- removes the old GitHub-era tasks ("Crossword daily update" and
  "Crossword fetch watcher").

The task starts when you log in, so set the PC to sign in automatically, or
just stay logged in. To remove the task and the firewall rule, run the
script again with `-Uninstall`.

### Linux

1. Create a user for the server, e.g. `sudo useradd -r -m crossword`.
2. Clone both repos to `/opt/crossword`.
3. Run `npm install` in `crossword-site`.
4. Install the service. Edit `User=` and the paths in the unit file first
   if yours differ.

   ```bash
   sudo cp deploy/crossword.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now crossword
   ```

5. If the machine runs a firewall, allow port 8080 from the proxy, e.g.
   `sudo ufw allow from <proxy IP> to any port 8080 proto tcp`.

If the Linux box *is* the roommate's server and cloudflared runs there too,
use `"host": "127.0.0.1"` instead and point the tunnel at
`http://127.0.0.1:8080`. That way the server isn't reachable from the LAN
at all.

## 5. Check it

- On this machine, open `http://127.0.0.1:8080`. You should get the sign-in
  page.
- From a phone **on cellular** (not your home Wi-Fi), open
  `https://cross.ho.house` and sign in.
- Sign in on two devices, start a co-op solve, and type. The letters and
  cursors should show up on the other device immediately, and the header
  should say **● Live**. If it keeps saying *Reconnecting…*, WebSockets
  aren't making it through the proxy.
- Reboot the machine and confirm the site comes back by itself.
- The next day, look for `daily puzzle update` and `backup written` lines
  in the server log. On Linux, use `journalctl -u crossword`.

## Running alongside the old GitHub site (switch-over week)

While both sites are up, the server keeps solo progress and stats in sync
with the old site's data repo (`crossword-data`), in both directions. Only
people with the same name on both sites take part. Co-op solves exist only
on the new site.

### Turn the sync on

Add this to `server/config.json`, then restart the server:

```json
"githubSync": {
  "repo": "Sean-Ericson/crossword-data",
  "branch": "main",
  "token": "github_pat_…",
  "intervalSec": 120
}
```

The token needs Contents read/write on `crossword-data`. The token the old
site uses works. If you leave `token` out, the server tries the
`XWORD_GITHUB_TOKEN` environment variable, then `gh auth token`.

The server log shows `github sync with … every 120s` at startup. After
that, it logs a `github sync: pulled …, pushed …` line whenever something
moved.

### What people will see

- **Progress:** the new site picks up changes from the old site within
  about 2 minutes. The old site picks up changes from the new site the
  next time that puzzle is opened there.
- **Conflicts:** if the same puzzle was played on both sites, the more
  recently edited copy wins. Time spent is never lost. These are the same
  rules the old site used between devices.
- **Open puzzles:** a puzzle someone has open on the new site isn't
  updated from GitHub until they close it.

### Keep new puzzles coming on the old site

The server downloads puzzles for the new site only. The old site gets its
puzzles by pushing them to GitHub, which its own scheduled tasks did. Run
those tasks from a separate checkout of `main` during the overlap:

1. Make the checkout next to `nytxw_puz`, so the old tools can find it:

   ```powershell
   cd <folder that holds crossword-site and nytxw_puz>
   git clone https://github.com/Sean-Ericson/crossword crossword-old
   ```

2. Register the old tasks under new names. `install-windows.ps1` deletes
   the old names, so reusing them would get them removed:

   ```powershell
   schtasks /create /tn "Crossword old-site daily" /tr "\"$PWD\crossword-old\daily_update.bat\"" /sc daily /st 23:35 /rl limited /f
   schtasks /create /tn "Crossword old-site fetcher" /tr "\"$PWD\crossword-old\fetch_watch.bat\"" /sc onlogon /f
   ```

That checkout pushes to GitHub, so it needs git credentials (`gh auth
login`) and the `.github_token` file described in its `SETUP-SCHEDULED.md`.

### When the week is over

1. Remove `githubSync` from `server/config.json` and restart the server.
2. Delete the two old-site tasks:

   ```powershell
   schtasks /delete /tn "Crossword old-site daily" /f
   schtasks /delete /tn "Crossword old-site fetcher" /f
   ```

3. Turn off GitHub Pages: repo → Settings → Pages. Then merge `self-host`
   into `main`.

## Backups and restore

Backups are written nightly to `server/data/backups/crossword-<time>.db`
and are complete SQLite files. To restore one:

1. Stop the server.
2. Copy the backup over `server/data/crossword.db`.
3. Delete any `crossword.db-wal` and `crossword.db-shm` files next to it.
4. Start the server.

Copy the backups folder off the machine now and then.

## Security notes

- Accounts are invite-only. Passwords are hashed with scrypt. Sign-in is
  rate-limited to 10 failures per 15 minutes, counted per visitor IP (from
  `CF-Connecting-IP`) and per name.
- Sessions are HttpOnly, SameSite=Lax cookies that are marked Secure and
  last 30 days. Changing a password signs out the account's other devices.
- The server refuses WebSocket connections from other sites. API calls
  that change anything must be JSON requests.
- Only the pages, `css/`, `js/`, and (for signed-in users) `puzzles/` are
  served. Nothing else in the repo is reachable over HTTP.
- The server speaks plain HTTP on the LAN, so keep the firewall rule
  limited to the proxy. People on the LAN should use the public
  https address too.

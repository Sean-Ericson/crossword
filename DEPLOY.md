# Deploying on a home machine

This guide puts the site on the internet from an always-on computer at
home. It works on Windows or Linux:

```
browser ──https──▶ router :443 ──▶ Caddy (HTTPS, certificates) ──▶ node server :8080 (localhost only)
                                                                      │
                                                  SQLite (server/data/crossword.db) + puzzles/
```

- **Caddy** is the only program exposed to the internet. It gets and renews
  a Let's Encrypt certificate automatically and passes WebSocket
  connections through.
- **DuckDNS** gives your home IP address a free, stable name
  (`yourname.duckdns.org`) and follows the IP when your ISP changes it.
- **The Node server** listens only on `127.0.0.1`. It also runs the nightly
  puzzle download and the nightly database backup, so you don't need to set
  up cron or Task Scheduler for those.

## 1. Prerequisites

| | Windows | Linux |
|---|---|---|
| Node 22.13+ (`node:sqlite`) | `winget install OpenJS.NodeJS.LTS` | distro package or [nodesource](https://github.com/nodesource/distributions) |
| Caddy | `winget install CaddyServer.Caddy` (or put `caddy.exe` in `deploy\`) | `apt install caddy` (official repo) |
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
- **Headless Linux server:** set `"nytBrowser": "Cached Cookies"` in
  `server/config.json`. Then copy the cookie cache that nytxw_puz writes on
  a machine with a browser: `%APPDATA%\nytxw_puz.cookies.json` on Windows
  goes to `~/nytxw_puz.cookies.json` for the user the server runs as.
  Re-copy it whenever NYT logs you out, roughly every few months.

## 3. Configure

Create `server/config.json` from the example. It is gitignored.

```bash
cp server/config.example.json server/config.json
```

The settings you're most likely to change:

| Setting | What it does | Default |
|---|---|---|
| `port` | Port the server listens on | `8080` |
| `nytBrowser` | Where the downloader gets NYT cookies | `Firefox` |
| `dailyUpdateAt` | Time of the daily puzzle download (`null` turns it off) | `23:30` |
| `backupAt` | Time of the nightly backup | `04:00` |
| `keepBackups` | How many backups to keep | `14` |
| `dataDir` | Where the database lives | `server/data` |
| `python` | Python to use; set it if auto-detection picks the wrong one | auto-detected |
| `nytxwPath` | Location of the nytxw_puz checkout | `../nytxw_puz` |

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

## 4. DuckDNS + router

1. Sign in at <https://www.duckdns.org>, create a subdomain, and copy your
   token.
2. Copy `deploy/deploy.env.example` to `deploy/deploy.env` and fill in
   `XWORD_DOMAIN`, `DUCKDNS_SUBDOMAIN`, and `DUCKDNS_TOKEN`.
3. In the router's admin page:
   1. Give the server machine a **fixed LAN IP**. This is usually called a
      DHCP reservation.
   2. **Forward TCP ports 80 and 443** to that LAN IP. Port 80 is only used
      by Let's Encrypt to verify the domain and to redirect to HTTPS.

## 5. Run it

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1
```

The script registers three tasks under your user account:

- **Crossword server** runs at logon and is restarted if it stops. It logs
  to `logs\server.log`.
- **Crossword Caddy** runs at logon and logs to `logs\caddy.log`.
- **Crossword DuckDNS** runs every 5 minutes.

It also removes the old GitHub-era tasks ("Crossword daily update" and
"Crossword fetch watcher"). The tasks start when you log in, so set the PC
to sign in automatically, or just stay logged in. To remove the tasks, run
the script again with `-Uninstall`.

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

5. Add the site to Caddy. Either copy the site block from
   `deploy/Caddyfile` into `/etc/caddy/Caddyfile`, using your domain in
   place of `{$XWORD_DOMAIN}`, or point Caddy at the file directly. Then
   reload it:

   ```bash
   sudo systemctl reload caddy
   ```

6. Keep DuckDNS updated with a crontab entry (`crontab -e` as any user):

   ```
   */5 * * * * /opt/crossword/crossword-site/deploy/duckdns-update.sh
   ```

## 6. Check it

- From a phone **on cellular** (not your home Wi-Fi), open
  `https://yourname.duckdns.org`. You should see the sign-in page with a
  valid padlock.
- Sign in on two devices, start a co-op solve, and type. The letters and
  cursors should show up on the other device immediately, and the header
  should say **● Live**.
- Reboot the machine and confirm the site comes back by itself.
- The next day, look for `daily puzzle update` and `backup written` lines
  in the server log. On Linux, use `journalctl -u crossword`.

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
  rate-limited to 10 failures per 15 minutes, counted per IP address and
  per name.
- Sessions are HttpOnly, SameSite=Lax cookies that are marked Secure over
  HTTPS and last 30 days. Changing a password signs out the account's
  other devices.
- The server refuses WebSocket connections from other sites. API calls
  that change anything must be JSON requests.
- Only the pages, `css/`, `js/`, and (for signed-in users) `puzzles/` are
  served. Nothing else in the repo is reachable over HTTP.
- Keep Windows or Linux and Caddy updated. The router exposes only Caddy's
  ports 80 and 443.

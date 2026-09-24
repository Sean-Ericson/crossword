# Crossword

A self-hosted, NYT-style crossword site with **real-time co-op**. It plays
`.puz` files with the full NYT Games experience: keyboard behavior,
check/reveal/autocheck, pencil mode, rebus entry, a timer with pause, and
clean-solve gold stars. It also has a puzzle archive with a calendar, solve
statistics, and comparisons between users.

Co-op works like Google Docs. Any group of people can open a shared solve of
a puzzle, and each person sees the others' letters as they type, their
cursors and highlighted words in each person's color, and who is currently
there. Solo and co-op solves of the same puzzle don't affect each other. For
example, Sean, Devon, and Kam can each have a solo solve of Monday's
puzzle. At the same time, Sean + Devon, Devon + Kam, and all three can have
their own co-op solves of it.

The browser code is vanilla JS ES modules with no build step and no
framework. The server is a small Node program. Its only dependency is `ws`,
and it stores data in SQLite through the `node:sqlite` module built into
Node. It runs on Windows or Linux.

## Quick start (local)

```bash
npm install
node server/admin.mjs add-user yourname --admin     # prints a temporary password
npm start                                           # http://127.0.0.1:8080
```

Run the tests. They need Node 22.13+ and Python 3.9+.

```bash
npm test
```

To put the site on the internet (home machine behind Cloudflare, published
as https://crossword.ho.house), see
**[DEPLOY.md](DEPLOY.md)**.

## Accounts

Only the admin can create accounts; nobody can sign themselves up. Run
these on the server:

```bash
node server/admin.mjs add-user devon --display "Devon"   # prints a temp password
node server/admin.mjs reset-password devon
node server/admin.mjs list
node server/admin.mjs set-admin devon on|off
node server/admin.mjs delete-user devon
```

Admins can do the same from anywhere on the web: account chip → **Manage
accounts** (`admin.html`) lists everyone, resets passwords (temporary or
chosen; the person is signed out everywhere), and adds accounts. Make
someone an admin with `set-admin` or the checkbox when adding them.

Each person can change their own password from the account chip in the top
right. The same menu can import progress that was saved in that browser
before accounts existed.

## Solo and co-op

- Opening a puzzle (`puzzle.html?id=2026-09-22`) opens **your solo solve**.
  It is saved on the server as you type, so it follows you between devices.
  You can even have it open on two devices at once.
- To start a co-op solve, click **Solo ▾ → New co-op solve…** in the
  toolbar and pick people. Everyone you pick gets the solve in the
  "Co-op solves in progress" strip on their archive page. The same menu
  switches between your solo solve and any co-op solves you're in for that
  puzzle, and it can add more people to a co-op solve.
- The co-op timer is shared. It runs while at least one member is actively
  solving. The pause button pauses everyone. Switching tabs only pauses you.
- Only the server can mark a solve complete, and it checks the grid itself.
  Check and reveal work in co-op exactly as they do solo; if anyone uses
  them, the solve loses its gold star.
- **Stats:** solo solves drive streaks, averages, and best times. Co-op
  solves are listed in their own section of the stats page and never mix
  into the solo numbers.

### How live sync works

The server holds the authoritative copy of each open solve. The last edit
to reach the server wins for each square. That is enough for crosswords
because every square is independent, so no CRDT or OT is needed.

1. Your edits show on your screen immediately and are sent to the server
   over a WebSocket.
2. The server applies edits in the order they arrive and broadcasts the
   result to everyone in the solve.
3. If someone else's edit to a square arrives while your own edit to that
   square is still on its way, your screen ignores theirs. Your edit
   reaches the server later, so it wins there too.
4. If the connection drops, your unsent edits are kept and sent again when
   it comes back.

The protocol is documented in `js/net.js`. The server side is in
`server/rooms.mjs`, and `tests/test_server.mjs` fuzzes three clients making
conflicting edits to check that they always end up with the same grid.

## Adding puzzles

Puzzles are plain Across Lite `.puz` files in `puzzles/`:

- Dated puzzles are named `YYYY-MM-DD.puz`, or with a `mini-`, `midi-`, or
  `bonus-` prefix, and appear in the calendar.
- Files with any other name are listed under "Special".

The server keeps the archive current by itself:

- **Every day at 23:30** it runs `tools/update_puzzles.py --no-git`. This
  needs the companion [nytxw_puz](https://github.com/Q726kbXuN/nytxw_puz)
  checkout next to this folder, and NYT login cookies (see DEPLOY.md).
- **Old puzzles on demand:** the calendar shows every date NYT has
  published. Days that haven't been downloaded yet are dashed and marked ↓.
  Opening one makes the server download it (`tools/fetch_one.py`), which
  usually takes a few seconds.

To add puzzles by hand, drop `.puz` files into `puzzles/` and run
`python tools/build_index.py`.

> **Copyright note:** NYT puzzles are copyrighted. The server only serves
> puzzle files to signed-in users. Keep the site to friends and family.

## Pages

| Page | What it does |
|---|---|
| `index.html` | Archive: co-op solves in progress, the latest-puzzle hero, and a month calendar with each day's status (◐ in progress, ★ solved, gold ★ clean solve, 👥 co-op) |
| `puzzle.html?id=…[&solve=…]` | The player (solo, or a co-op solve) |
| `stats.html` | Solved counts, clean solves, streaks, average and best times by weekday, and multi-user comparison, plus your co-op solves |
| `login.html` | Sign in |
| `admin.html` | Accounts (admins only): reset passwords, add people |

## Player reference

- **Typing** fills the square and advances. Whether it skips filled squares
  is configurable in ⚙.
- **Arrows** move, and an arrow perpendicular to the current direction
  switches direction. **Click** a square twice to switch direction.
  **Tab/Enter** goes to the next clue.
- **Backspace** clears and walks backward. **Space** clears and steps forward.
- **Esc** (or Insert, or the Rebus button) opens multi-letter rebus entry.
- **Check** marks wrong squares with a red slash. **Reveal** fills in
  answers, marks them with a red corner, and locks the square. **Autocheck**
  verifies letters as you type and locks correct ones. Using any of these
  forfeits the gold star.
- **Pencil** mode enters gray "tentative" letters.
- In co-op, other people's cursors appear as colored outlines with name
  tags, and colored dots mark the clues they are on.

## Repo layout

```
index.html puzzle.html stats.html login.html   pages
css/                  base + per-page styles
js/                   browser ES modules: parser, model, engine, views, net
                      (live sync), api client, stats, page controllers
server/               Node server: server.mjs (HTTP + WebSocket), api.mjs,
                      rooms.mjs (live solves), db.mjs (SQLite), auth.mjs,
                      puzzles.mjs, admin.mjs, tools/import-github.mjs
deploy/               Windows task installer, systemd unit
puzzles/              .puz files + generated index.json
tools/                puzzle download/index scripts (Python)
tests/                node test runner + Python cross-check
```

Credits: the `.puz` format handling is modeled on
[puzpy](https://github.com/alexdej/puzpy) (MIT, vendored at `tools/puz.py`),
and puzzles are downloaded with
[nytxw_puz](https://github.com/Q726kbXuN/nytxw_puz). The play experience is
a loving imitation of [NYT Games](https://www.nytimes.com/crosswords).
Subscribe to the real thing; it's worth it.

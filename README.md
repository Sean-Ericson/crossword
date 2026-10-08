# Crossword

A self-hosted, NYT-style crossword site with **real-time co-op**. It plays
`.puz` files with the full NYT Games experience: keyboard behavior,
check/reveal/autocheck, pencil mode, rebus entry, a timer with pause, and
clean-solve gold stars. It also has a puzzle archive with a calendar, and
deep solve statistics: trends, distributions, habits, correlations with
puzzle features, skill ratings, head-to-head tests, replays of every solve
and more, for one person or any group. People can also **make their own
puzzles**, alone or together live, and publish them for everyone (or just
a few people) to solve. On phones and tablets the puzzle
page docks an on-screen keyboard (with the current clue above it) under the
grid, since tapping a square can't raise the system keyboard. There is a
dark mode: it follows the system setting until you flip the ☾/☀ toggle in
the header, which each browser remembers.

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
as https://cross.ho.house), see
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
accounts** (`admin.html`) lists everyone, adds and deletes accounts,
resets passwords (temporary or chosen; the person is signed out
everywhere), and makes people admins or removes them. Admins can't change
or delete their own account there, so there's always at least one admin.

Each person can change their own password from the account chip in the top
right. The same menu can import progress that was saved in that browser
before accounts existed.

## Solo and co-op

- Opening a puzzle (`puzzle.html?id=2026-09-22`) opens **your solo solve**.
  It is saved on the server as you type, so it follows you between devices.
  You can even have it open on two devices at once.
- To start a co-op solve, click **Solo ▾ → New co-op solve…** in the
  toolbar and pick people. Once there are more than eight accounts, the
  picker has a search box and lists the people you solved with recently
  first. Everyone you pick gets the solve in the
  "Co-op solves in progress" strip on their archive page. The same menu
  switches between your solo solve and any co-op solves you're in for that
  puzzle, and it can add more people to a co-op solve. In a co-op solve,
  the colored chips next to it show who is there; click them for everyone
  in the solve. There are only eight user colors, so people who share one
  get different colors inside a solve.
- **Chat.** In a co-op solve, the **Chat** button next to the chips opens
  messages with everyone in the solve. It works before you start and while
  the game is paused too. New messages pop up for a few seconds, and the
  button and the tab title count the ones you haven't read. Type an entry's
  name in a message, like `12A` or `34-Down`, and it becomes a link that
  jumps to that entry. Messages are saved with the solve, so people who
  open it later can read what was said. Enter sends and Shift+Enter starts
  a new line. A message written while the connection is down is sent once
  it comes back.
- The co-op timer is shared. It runs while at least one member is actively
  solving. The pause button pauses everyone. Switching tabs only pauses you.
- Only the server can mark a solve complete, and it checks the grid itself.
  Check and reveal work in co-op exactly as they do solo; if anyone uses
  them, the solve loses its gold star.
- **Stats:** solo solves drive streaks, averages, and best times. Co-op
  solves have their own section of the stats page and never mix into the
  solo numbers.
- **Every solve is recorded move by move** (since the stats update): each
  letter typed or erased and its direction, checks and reveals, which entry
  each person is on, pauses. That drives replays, time per entry, typo and
  fix counts, fill-order heatmaps and co-op credit. Older solves only have
  their time.

### Stats

`stats.html` has a filter bar (date range, weekdays, clean only, and
"relative" times: each solve against that person's usual for the weekday)
over eight sections. **Overview**: headline tiles, records by weekday,
recent solves, a prediction for the newest puzzle. **Trends**: every solve
over time with a rolling median, the improvement rate with its confidence
interval, per-weekday personal-record staircases. **Distributions**:
histograms, box and violin plots, percentiles, consistency. **Habits**: a
calendar, a solving-hour punchcard, how soon after release, sittings,
unfinished puzzles. **Puzzles**: every puzzle with its grid features and
difficulty, constructors (your nemesis and favorite), a correlation matrix.
**Solve style** (from the recordings): pace, first letter, typos, typo
hunts, across vs down, the average progress curve, letter mix-ups,
most-missed answers. **Compare**: skill ratings from a model of everyone's
times, Elo and Bradley–Terry, win and speed matrices with significance
tests, a paired scatter for any two people. **Co-op**: synergy (the team
against its members' predicted solo times), who filled what, who fixed
whose mistakes. Every chart has a Table toggle with the numbers and a CSV
download.

`analysis.html?puzzle=…` breaks one puzzle down: everyone's results against
what the model expected, the race between every recorded solve, a replay on
the real grid with each person's cursor, grid heatmaps and an entry-by-entry
table. If you haven't solved the puzzle yet, letters, answers and clues are
hidden until you click "Show anyway".

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

## Making puzzles

The archive's **Custom** tab lists puzzles people made here. **New puzzle**
picks a size (Mini 5×5 to Sunday 21×21, or anything from 3×3 to 25×25) and
a symmetry, and opens the builder (`builder.html`). **Upload a .puz** turns
a puzzle made in another program (Crossfire, Phil, Crosshare…) into a
draft. The tab marks puzzles you haven't opened yet as new.

- **Building.** Type letters as you would solving. `.` toggles a black square
  (and its symmetric partner); in Blocks mode, clicking does. `*` circles a
  square, Esc or Insert enters a rebus, Enter writes the current entry's
  clue (Tab moves on to the next one), and Ctrl+Z / Ctrl+Shift+Z undo and
  redo your own changes. Everything saves as you go.
- **Building together.** Add co-authors from **More ▾ → Authors…**. Everyone
  in the builder sees each other's letters, black squares, clues and cursors
  live, like a co-op solve. They can message each other with **Chat** in the
  toolbar, which works the same way as in a co-op solve.
- **Check** lists what has to be fixed before publishing (empty squares,
  missing clues, squares in no entry) and what's merely unusual (two-letter
  entries, unchecked squares, repeated answers, broken symmetry, a split
  grid).
- **Fill** suggests words for the current entry, keeping only words that
  leave every crossing something to fit; a click fills the blanks. The words
  come from the site's list (every answer in the archive, published custom
  puzzles, and an optional bigger list: see `wordList` in DEPLOY.md) and
  from your own word lists. Each clue row says how many words fit its
  entry, and blank squares nothing fits get a red dot. The top of the tab
  switches lists on and off. Right-click a suggestion to score it or hide it,
  and a full entry offers **Add … to a word list**.
- **Word lists** (`wordlists.html`, from the Custom tab or the Fill tab) are
  your own: make one, or upload a list file (`WORD;SCORE` per line, the
  format of Spread the Wordlist, Peter Broda's list, Crossfire and XWord Info
  dictionaries; Windows-1252 files work too). Then search it (letters, or a
  pattern like `C?T` or `*ING`), rescore or remove words, add more typed in
  or from another file, download it, or delete it. In the lists you have on,
  a word's score (0 to 100) replaces the site's, and 0 hides the word; you
  can also turn the site's list off and use only yours. Each person's lists
  change only their own suggestions and counts, so co-authors each see their
  own. A person can keep 30 lists and 2,000,000 words in all (1,000,000 in
  one list).
- **Publish** asks who can solve it: everyone, or people you choose. Once it's
  published the black squares stay put (so solves in progress keep fitting),
  but letters and clues can still change: edit them, then **Update**, and
  anyone who has it open is asked to reload.
- **Test solve** (in **More ▾**, or on the puzzle's own page) plays your copy
  in the real player without saving anything. Authors never solve their own
  puzzle for real, so its results stay honest.
- **Download .puz** (in the builder, and in the player's **Solo ▾** menu)
  saves a file Across Lite and other apps open.
- When someone finishes your puzzle they can rate it and leave you a note.
  The puzzle's breakdown page (**Results** on the Custom tab) shows who solved
  it, the replays and what they said. Everyone sees the average rating; only
  the authors and people who finished it see the notes.
- **Delete** removes a draft. A puzzle someone has already opened is
  withdrawn instead: it disappears from the list for everyone else, while
  people keep their solves and stats.

Custom puzzles live in the database, not in `puzzles/`, so the nightly
backups cover them. The stats page has a Custom tab for them.

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
| `index.html` | Archive: co-op solves in progress, the latest-puzzle hero, and a month calendar with each day's status (◐ in progress, ★ solved, gold ★ clean solve, 👥 co-op); `#custom` opens the Custom tab |
| `puzzle.html?id=…[&solve=…]` | The player (solo, or a co-op solve); `&test=1` is an author's test solve |
| `builder.html?id=…` | The puzzle builder, for a custom puzzle's authors |
| `wordlists.html[?list=…]` | Your word lists for the builder's suggestions; `?list=` opens one to edit |
| `stats.html` | Statistics for one person or a group in eight sections (see Stats above), with a filter bar and a CSV of everything |
| `analysis.html?puzzle=…[&solve=…]` | One puzzle broken down: results, the race, a replay, grid heatmaps, entries. Linked from the stats tables and the “Congratulations” dialog |
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
index.html puzzle.html builder.html wordlists.html stats.html analysis.html
login.html admin.html                                                      pages
css/                  base + per-page styles
js/                   browser ES modules: parser, model, engine, views, net
                      (live sync), api client, page controllers; stats:
                      solve-analysis, stats-data/-math/-model, charts,
                      stats/ (one module per stats section); custom puzzles:
                      custom-puzzle (the format), builder-page/-engine,
                      clue-editor, custom-tab, words, word-lists,
                      wordlists-page, puz-write, feedback;
                      chat (messages in co-op solves and builds)
server/               Node server: server.mjs (HTTP + WebSocket), api.mjs,
                      rooms.mjs (live solves), build-rooms.mjs (live
                      building), chat.mjs (their messages), db.mjs
                      (SQLite), auth.mjs, puzzles.mjs,
                      words.mjs (the builder's word list, as each person
                      sees it), admin.mjs,
                      tools/import-github.mjs,
                      tools/seed-demo.mjs (made-up solvers for development)
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

# Crossword site — notes for Claude

NYT-style crossword player with accounts and real-time co-op. It is
self-hosted on Sean's home Windows PC and published by the roommate's
Cloudflare setup at **https://cross.ho.house**. Browser code is vanilla JS
ES modules: no build step, no framework. The server is Node 22.13+; its
only dependency is `ws`, and it uses `node:sqlite`.

README.md covers features and usage. DEPLOY.md covers hosting, config,
and the switch-over. This file covers what you need to change code safely.

## Branches and state

- `self-host`: the current app, meaning the server and the new client.
  Develop here.
- `main`: the **old GitHub Pages site**, still live during the switch-over
  week. It uses a GitHub-API "backend" with a shared PAT, and its
  `crossword-data` repo holds the progress. It only gets puzzle commits and
  the "we're moving" banner (`js/move-banner.js`). When the switch-over is
  done, `self-host` is merged into `main` and Pages is turned off. See
  DEPLOY.md "When the week is over".
- The home PC runs the server from a clone on `self-host`. To deploy:
  `git pull` there, then run
  `Stop-ScheduledTask 'Crossword server'; Start-ScheduledTask 'Crossword server'`.
  The task runs `node.exe` directly at boot under S4U, so it has no window
  and can't use `gh auth` or DPAPI-protected secrets. Its log is
  `logs/server.log`.
  `server/config.json` is gitignored and lives only there; it has
  `host 0.0.0.0` and `publicUrl`, and during the overlap `githubSync` too.

## Map

| Where | What |
|---|---|
| `js/engine.js` | Pure solve logic (no DOM). Emits `cells(indexes, meta)`. `meta.remote` marks server-applied changes so they aren't echoed back. `deferCompletion`: the server decides when a puzzle is solved. |
| `js/net.js` | WebSocket clients: `LiveChannel` (optimistic edits, a pending-op queue, replay on reconnect) with `LiveSolve` (solves) and `LiveBuild` (the builder) on top. **The wire protocol is documented at the top of this file.** |
| `js/player-page.js` | Player controller: wires the engine, views, net, presence, remote cursors, the solo/co-op menu, and the shared timer |
| `js/grid-view.js`, `js/clues-view.js` | DOM rendering. Remote cursors are drawn as child elements (`setRemoteCursor`), kept apart from the local `sel-*` classes |
| `js/theme.js`, `css/base.css` | Light/dark mode. `theme.js` is a classic script in each page's `<head>` (a module would run too late and flash white); it sets `data-theme` on `<html>` from `localStorage['xw:theme']` or the system. Every color is a `--color-*` token in `base.css`, with dark values in `:root[data-theme='dark']`. A new color needs a token with a dark value too, not a hex in page CSS or an inline style |
| `js/touch-keyboard.js` | On-screen keyboard, shown only on touch-first devices (`body.touch`). Keys go through the same `handleKey` in `player-page.js` as physical keys. The clue bar is moved into its dock |
| `js/stats-page.js`, `js/stats/*.js` | The stats page: the shell (selector, filter bar, section tabs, a context object built from `GET /api/stats-all` + `puzzles/index.json`) and one module per section. `js/analysis-page.js` is the one-puzzle breakdown with the replay (it reuses `GridView`) |
| `js/stats-data.js`, `js/stats-math.js`, `js/stats-model.js` | Pure, unit-tested. Data: a row per solve with its puzzle's features and time relative to the person's usual. Math: descriptive stats, regression, correlations, Wilcoxon, bootstrap (checked against scipy). Model: log time = weekday + solver + puzzle (skill and difficulty), Elo, Bradley–Terry, co-op synergy |
| `js/charts.js`, `css/charts.css` | The SVG chart kit: `chartCard` (title, legend, Table toggle with CSV) and the chart types. Colors come only from `--color-chart-*`, `--color-seq-0..6` and `--color-div-0..6` tokens plus people's colors; more than three people on a scatter get one highlighted and the rest gray |
| `js/state.js` | Progress record schema, `mergeProgress` (newest `updated_at` wins, max elapsed), and `mergeStats` (earliest solve wins). Shared by client and server |
| `js/api.js`, `js/profiles.js`, `js/profile-ui.js` | REST client (a 401 redirects to login), the current user (`loadMe()` must run first on every page), and the account menu |
| `js/people.js`, `js/people-picker.js` | Showing people, built for 30+ accounts. `people.js` (shared with the server) holds `USER_PALETTE` (8 colors, so accounts share them), `distinctColors` (colors that differ within one view: a co-op room or a stats comparison; pass `keep` so nobody already shown changes color) and `listNames` ("Devon, Kam and 3 others"). `people-picker.js` is the one dialog for choosing people. Past 8 people it adds search and a "recent partners" group (`last_together` from `GET /api/users`). Any new list of people should reuse these |
| `server/server.mjs` | HTTP: static allowlist (pages, `css/`, `js/`, and `puzzles/` only when signed in), `/ws` upgrade with an origin check, schedulers |
| `server/api.mjs` | REST routes (a table of `[method, regex, handler, {auth}]`), including the admin routes and the custom-puzzle, feedback and word-list routes. Also `clientIp`, `originAllowed`, and `secureCookiesFor` for running behind Cloudflare |
| `server/rooms.mjs` | `Hub`/`Room`: each open solve lives in memory and is authoritative. Per-cell last-writer-wins, shared timer, server-side completion, flush to the DB after ~2 s and when the last person leaves. `Room.log` records every applied change in `solve_events` on the solve's own clock; on completion the log is summarized into `solve_summaries`. The Hub also routes build messages, and `checkCustom` keeps authors out of their own puzzles |
| `server/build-rooms.mjs` | `BuildRoom`: a custom puzzle's authors edit its working copy live, the way a co-op solve works (per-key last-writer-wins, presence, the same flush). Once the puzzle is published, black/white flips bounce back with the real value |
| `js/solve-analysis.js` | Pure: the event log's kinds (documented at the top), `analyzeSolve` (per-square and per-entry times, errors, dwell, co-op credit), and `summarize` (what's stored per solve). Shared by client and server. **Bump `ANALYSIS_VERSION` when `summarize` changes**; the server redoes older summaries at startup |
| `server/db.mjs` | SQLite `Store`. Schema migrations are keyed on `PRAGMA user_version`: bump `SCHEMA_VERSION` and use `CREATE … IF NOT EXISTS`. `solo_solves` is the solo stats log. Co-op stats are derived from `solves`. `solve_events` is append-only (reset logs `r`, it never deletes). `custom_puzzles` (+ `_authors`, `_shares`, `puzzle_feedback`) hold puzzles made on the site; `visibleCustomIds`/`canSeePuzzle`/`puzzleFilter` decide who sees one |
| `server/auth.mjs` | scrypt, sessions (sha256 of the token), `LoginLimiter` (in memory; restarting clears it), `tempPassword` |
| `server/github-sync.mjs` | Two-way sync with the old site's `crossword-data` repo, overlap period only. Solo solves only |
| `server/puzzles.mjs`, `tools/fetch_one.py`, `tools/update_puzzles.py` | Puzzle loading and NYT downloads. Python and `../nytxw_puz` do the fetching. Custom ids load the published copy from the DB, never a file; `forget(id)` drops a cached model on Update |
| `js/custom-puzzle.js` | Custom puzzles' doc format (`grid` like a record's `fill`; clues keyed by direction + first square, `A0`/`D4`, so they survive block edits), `applyChange` (the one validator for edits, on both ends of the build socket), `docToPuz` (the `parsePuz` shape: `new PuzzleModel(docToPuz(doc))` everywhere), `docFromPuz` (uploads), `problems` (publish blockers and warnings), features |
| `builder.html`, `js/builder-page.js`, `js/builder-engine.js`, `js/clue-editor.js` | The builder: `LiveBuild` + `GridView` + `BuildEngine` (a `SolveEngine` whose arrows land on blocks and that never completes), clue rows keyed by entry (focus survives a co-author's block edit), Check and Fill tabs, the publish/share/authors dialogs, undo of your own steps |
| `js/custom-tab.js` | The archive's Custom tab: New puzzle, Upload .puz, your puzzles, everyone else's, "new" counts |
| `js/words.js`, `server/words.mjs` | The builder's word list: per-length bitsets per (position, letter), crossing-aware `suggest`. Built from archive answers, public custom puzzles and `cfg.wordList`; rebuilt after the daily download and on publish |
| `js/puz-write.js`, `js/cp1252.js` | `.puz` writer with all checksums (its header matches puzpy's byte for byte), and cp1252 both ways (some Node 22 releases decode `windows-1252` as Latin-1) |
| `js/local-solve.js`, `js/feedback.js` | An author's test solve (`puzzle.html?id=…&test=1`) runs on `LocalSolve`, a no-network `LiveSolve`. `feedback.js` is the stars-and-note form and the notes list |
| `js/menus.js`, `js/rebus-input.js` | Dropdown menus and the rebus box, shared by the player and the builder |
| `server/admin.mjs`, `admin.html` | Account management from the CLI or the web (admins only) |
| `server/tools/import-github.mjs` | One-time import from `crossword-data` |
| `server/tools/seed-demo.mjs` | Fills a scratch `XWORD_DATA_DIR` with six made-up solvers played through the real `Hub` on a fake clock (logs and summaries included), plus a few custom puzzles with solves, ratings and notes; password `test-pass-1`. The only way to see the stats pages with data locally |

## Invariants — don't break these

- **Every change to a cell goes through the engine**, so its `cells` event
  sends the change to the server. Changes that come from the server go
  through `engine.applyRemoteCells` or `replaceRecord` and are never sent
  back.
- **The server decides when a solve is complete.** Never mark a solve
  complete on the client alone.
- **Solo and co-op are both "solves".** A user has at most one solo solve
  per puzzle. Any number of co-op solves can exist per puzzle, one per
  group of members. Co-op results never go into solo stats.
- **Record schema is 1** (`fill[]`, `marks[]` using the `MARK_*` bits, and
  so on). It's shared with `crossword-data`, so keep it compatible while
  the sync runs.
- **Puzzle ids** are `YYYY-MM-DD`, with an optional `mini-`, `midi-` or
  `bonus-` prefix, or `custom-…` for puzzles made on the site (they live in
  the DB, never in `puzzles/`). Any other name is a "special" puzzle.
- **A custom puzzle has two copies.** `doc` is the working copy, and every
  edit to it goes through the build room (`LiveBuild.sendEdit` →
  `applyChange` on the server; edits from the server are applied with
  `applyChange` and never sent back). `published` is what solvers get, and
  it changes only on Publish/Update.
- **A published puzzle's shape never changes** (size and black squares), so
  every solve record keeps fitting. Letters and clues can change; Update
  swaps the model in open solve rooms and they're told `puzzle-updated`.
- **Authors never solve their own puzzle** on the server (`Hub.checkCustom`,
  `checkCustomSolvers` in api.mjs, no co-authors who already played it).
  Test solves are local.
- **A restricted puzzle's answers stay with its audience.** Every endpoint that
  serves a custom puzzle, its solves, results, logs or stats checks
  `store.canSeePuzzle`/`puzzleFilter`; new ones must too. The GitHub sync
  never carries custom puzzles.
- **Accounts are invite-only.** There is no public sign-up.

## Commands

```bash
npm test                                   # node tests/run_tests.mjs (async-capable, ~140 tests)
XWORD_DATA_DIR=<scratch> XWORD_PORT=8099 node server/server.mjs   # throwaway local server
XWORD_DATA_DIR=<scratch> node server/admin.mjs add-user sean --admin --password test-pass-1
python tools/build_index.py                # rebuild puzzles/index.json
```

```bash
XWORD_DATA_DIR=<scratch> node server/tools/seed-demo.mjs   # demo data for the stats pages
```

**Testing pattern:**
- `tests/test_server.mjs` drives `Hub` with simulated clients: `LiveSolve`
  plus the engine, over a manual network. It includes a 3-client
  conflicting-edit fuzz and a fake GitHub repo for the sync.
- `tests/test_custom_server.mjs` does the same for build rooms with
  `LiveBuild` clients (a 3-author fuzz), and drives the custom-puzzle,
  feedback and word-list REST routes over HTTP.
- For UI changes, run a throwaway server and drive several logged-in
  Playwright contexts. Install Playwright in the session scratchpad, not
  the repo.

## Gotchas

- `nytxw_puz` and `q726kbxun.github.io` next to this folder are third-party
  clones. Read them, never edit or commit to them.
- The running server writes new puzzles into `puzzles/` and `index.json`,
  so the working tree on the home PC will show them as changes.
- On Windows, `node`, `npm` and `python` may not be on PATH in a shell.
  The machine-specific paths are in Claude's memory.
- The Git Bash heredoc + Python-edit route has turned `'\n'` into real
  newlines in JS more than once. Run `node --check` after scripted edits.
- Don't push, or deploy to the live site, without asking. Both `main`
  (live Pages) and the home server serve real people.

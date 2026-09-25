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
  `git pull` there, then restart the "Crossword server" scheduled task.
  `server/config.json` is gitignored and lives only there; it has
  `host 0.0.0.0` and `publicUrl`, and during the overlap `githubSync` too.

## Map

| Where | What |
|---|---|
| `js/engine.js` | Pure solve logic (no DOM). Emits `cells(indexes, meta)`. `meta.remote` marks server-applied changes so they aren't echoed back. `deferCompletion`: the server decides when a puzzle is solved. |
| `js/net.js` | WebSocket client (`LiveSolve`): optimistic edits, a pending-op queue, and replay on reconnect. **The wire protocol is documented at the top of this file.** |
| `js/player-page.js` | Player controller: wires the engine, views, net, presence, remote cursors, the solo/co-op menu, and the shared timer |
| `js/grid-view.js`, `js/clues-view.js` | DOM rendering. Remote cursors are drawn as child elements (`setRemoteCursor`), kept apart from the local `sel-*` classes |
| `js/state.js` | Progress record schema, `mergeProgress` (newest `updated_at` wins, max elapsed), and `mergeStats` (earliest solve wins). Shared by client and server |
| `js/api.js`, `js/profiles.js`, `js/profile-ui.js` | REST client (a 401 redirects to login), the current user (`loadMe()` must run first on every page), and the account menu |
| `server/server.mjs` | HTTP: static allowlist (pages, `css/`, `js/`, and `puzzles/` only when signed in), `/ws` upgrade with an origin check, schedulers |
| `server/api.mjs` | REST routes (a table of `[method, regex, handler, {auth}]`), including the admin routes. Also `clientIp`, `originAllowed`, and `secureCookiesFor` for running behind Cloudflare |
| `server/rooms.mjs` | `Hub`/`Room`: each open solve lives in memory and is authoritative. Per-cell last-writer-wins, shared timer, server-side completion, flush to the DB after ~2 s and when the last person leaves |
| `server/db.mjs` | SQLite `Store`. Schema migrations are keyed on `PRAGMA user_version`: bump `SCHEMA_VERSION` and use `CREATE … IF NOT EXISTS`. `solo_solves` is the solo stats log. Co-op stats are derived from `solves` |
| `server/auth.mjs` | scrypt, sessions (sha256 of the token), `LoginLimiter` (in memory; restarting clears it), `tempPassword` |
| `server/github-sync.mjs` | Two-way sync with the old site's `crossword-data` repo, overlap period only. Solo solves only |
| `server/puzzles.mjs`, `tools/fetch_one.py`, `tools/update_puzzles.py` | Puzzle loading and NYT downloads. Python and `../nytxw_puz` do the fetching |
| `server/admin.mjs`, `admin.html` | Account management from the CLI or the web (admins only) |
| `server/tools/import-github.mjs` | One-time import from `crossword-data` |

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
  `bonus-` prefix. Any other name is a "special" puzzle.
- **Accounts are invite-only.** There is no public sign-up.

## Commands

```bash
npm test                                   # node tests/run_tests.mjs (async-capable, ~80 tests)
XWORD_DATA_DIR=<scratch> XWORD_PORT=8099 node server/server.mjs   # throwaway local server
XWORD_DATA_DIR=<scratch> node server/admin.mjs add-user sean --admin --password test-pass-1
python tools/build_index.py                # rebuild puzzles/index.json
```

**Testing pattern:**
- `tests/test_server.mjs` drives `Hub` with simulated clients: `LiveSolve`
  plus the engine, over a manual network. It includes a 3-client
  conflicting-edit fuzz and a fake GitHub repo for the sync.
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

# Crossword

A self-hosted, NYT-style crossword site for GitHub Pages. Plays `.puz` files
with the full NYT Games experience — keyboard behavior, check/reveal/autocheck,
pencil mode, rebus entry, timer with pause, clean-solve gold stars — plus a
puzzle archive with a calendar, saved progress, solve-time statistics, and
multi-user comparison synced through a private GitHub repo.

Everything is vanilla JS ES modules. **No build step, no framework, no
dependencies.**

## Quick start (local)

```bash
python -m http.server 8000
# open http://localhost:8000
```

(Any static server works; `file://` does not, because the site uses `fetch`.)

Run the test suite (needs Node 18+ and Python 3.9+):

```bash
node tests/run_tests.mjs
```

The parser tests cross-check `js/puz.js` against the vendored Python
reference (`tools/puz.py`) — if you regenerate fixtures, run
`python tests/make_fixture.py` and `python tests/dump_puz.py <file> <out>`.

## Adding puzzles

Puzzles are plain Across Lite `.puz` files in `puzzles/`, named
`YYYY-MM-DD.puz` (dated puzzles appear in the calendar; any other name shows
under "Special puzzles").

1. Download NYT puzzles with the companion
   [nytxw_puz](https://github.com/Q726kbXuN/nytxw_puz) tool, e.g. a range:
   `python get_range.py chrome 2026-01-01 now ../crossword-site/puzzles`
2. Rebuild the archive index:
   `python tools/build_index.py`
3. Commit and push `puzzles/`.

> **Copyright note:** NYT puzzles are copyrighted. A GitHub Pages site is
> public (private-repo Pages needs GitHub Pro), so keep this to personal use
> and don't advertise the URL.

## Deploying to GitHub Pages

1. Create a GitHub repo (say `crossword`) and push this folder to it.
2. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. The site appears at `https://<you>.github.io/crossword/`. All URLs are
   relative, so project pages, user pages, and custom domains all work.

## Progress sync + multi-user setup (optional but recommended)

Without any setup the site is fully functional **per browser**: progress,
stats, and profiles live in localStorage. To sync across devices and compare
stats between people, add the GitHub backend:

1. **Create a private data repo**, e.g. `crossword-data`, with a README so
   the `main` branch exists. (Progress writes stay out of the site repo, so
   saves don't trigger Pages rebuilds.)
2. **Create a fine-grained personal access token**:
   GitHub → Settings → Developer settings → Fine-grained tokens →
   *Generate new token*. Repository access: **only** `crossword-data`.
   Permissions: **Contents → Read and write**. Max expiration is 1 year —
   when it expires, paste a new one.
3. **Configure each device**: on the site, click the sync badge (top right)
   and enter owner / repo / token → *Test connection* → *Save*.
4. **Family/friends**: everyone uses the same data repo. Either share one
   token, or add them as collaborators so they can mint their own. Each
   person picks their own profile name (top-right chip). Fair warning: one
   shared repo means anyone with the token can technically edit anyone's
   files — it's a trust-based model.
5. Optionally set your GitHub username as the default in `js/config.js` so
   others only have to paste the token.

The token lives only in each browser's localStorage — never in the site repo.

### How syncing behaves

- localStorage is always the on-device store (autosaved ~1s after changes).
- GitHub pushes happen on: puzzle completion, pause, tab hide/close, every
  2 minutes while solving, and via *Sync now* in the sync settings.
- Opening a puzzle pulls the remote copy in the background and keeps
  whichever is further along (completed beats in-progress; otherwise newest
  edit wins, and elapsed time is never lost).
- Data layout: `users/<name>/progress/<year>/<id>.json` + `users/<name>/stats.json`.

## Pages

| Page | What it does |
|---|---|
| `index.html` | Archive: latest-puzzle hero, month calendar with per-day status (◐ in progress, ★ solved, gold ★ = clean solve + time), special puzzles |
| `puzzle.html?id=…` | The player (also accepts `?file=<url>` for ad-hoc .puz files) |
| `stats.html` | Solved counts, clean solves, streaks (consecutive puzzle dates), average/best times by weekday; select multiple users for side-by-side bars and head-to-head |

## Player reference

- **Typing** fills and advances (skipping filled squares — configurable in ⚙).
- **Arrows** move; a perpendicular arrow switches direction. **Click** a
  square twice to switch direction. **Tab/Enter** next clue.
- **Backspace** clears/walks backward, **Space** clears/steps forward.
- **Esc** (or Insert, or the Rebus button) opens multi-letter rebus entry.
- **Check/Reveal** menus mark wrong squares (red slash) or reveal answers
  (red corner, square locks). **Autocheck** verifies as you type and locks
  correct letters. Using any of these forfeits the gold star.
- **Pencil** mode enters gray "tentative" letters.
- The timer pauses from the timer button, automatically when the tab hides,
  and shows the NYT-style overlay. Solved puzzles open read-only.

## Repo layout

```
index.html puzzle.html stats.html   the three pages
css/                                base + per-page styles
js/                                 ES modules (parser, model, engine, views,
                                    state, sync, stats, page controllers)
puzzles/                            .puz files + generated index.json
tools/puz.py                        vendored puzpy (MIT) — reference parser
tools/build_index.py                archive index generator
tests/                              node test runner + Python cross-check
```

Credits: `.puz` format handling modeled on [puzpy](https://github.com/alexdej/puzpy)
(MIT, vendored at `tools/puz.py`); puzzle downloads via
[nytxw_puz](https://github.com/Q726kbXuN/nytxw_puz). The play experience is a
loving imitation of [NYT Games](https://www.nytimes.com/crosswords) — subscribe
to the real thing, it's worth it.

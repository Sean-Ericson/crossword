/*
 * stats-page.js — the stats page shell: who's compared, the puzzle type,
 * the filter bar and the section tabs. Each tab lives in js/stats/ and
 * renders from one context object (see makeContext).
 *
 * Data: one GET /api/stats-all (everyone's solo solves, unfinished solves,
 * co-op solves and log summaries) plus puzzles/index.json, joined by
 * js/stats-data.js into a row per solve. Per-entry details come later, per
 * person, from /api/summaries/:user, only for the tabs that need them.
 *
 * Anyone with an account can be compared. With a short account list every
 * person gets a chip to toggle; a longer one shows just the people being
 * compared plus "Compare with…" (the people picker). Each person keeps
 * their account color, kept distinct within a comparison (distinctColors).
 * Co-op results never count toward solo stats; they have their own tab.
 */

import { el, qs, WEEKDAY_NAMES } from './util.js';
import { loadMe } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { api } from './api.js';
import { byDisplayName, distinctColors } from './people.js';
import { pickPeople } from './people-picker.js';
import { buildDataset, applyFilters, RANGES, toCsv } from './stats-data.js';
import { fitAdditive, constructorEffects, elo, bradleyTerry } from './stats-model.js';
import { downloadText, hideTip } from './charts.js';
import { WEEKDAY_ORDER, hasWeekdays } from './stats/common.js';
import * as overview from './stats/overview.js';
import * as trends from './stats/trends.js';
import * as distributions from './stats/distributions.js';
import * as habits from './stats/habits.js';
import * as puzzlesTab from './stats/puzzles.js';
import * as style from './stats/style.js';
import * as compare from './stats/compare.js';
import * as coopTab from './stats/coop.js';

const TYPE_TABS = [
  ['daily', 'Daily'],
  ['mini', 'Mini'],
  ['midi', 'Midi'],
  ['bonus', 'Bonus'],
  ['special', 'Special'],
  ['custom', 'Custom'],
];
const SECTIONS = [
  ['overview', 'Overview', overview],
  ['trends', 'Trends', trends],
  ['distributions', 'Distributions', distributions],
  ['habits', 'Habits', habits],
  ['puzzles', 'Puzzles', puzzlesTab],
  ['style', 'Solve style', style],
  ['compare', 'Compare', compare],
  ['coop', 'Co-op', coopTab],
];
const TYPE_KEY = 'xw:site:stats-type';
const PREFS_KEY = 'xw:site:stats-prefs';
const CHIPS_UP_TO = 8; // more accounts than this: "Compare with…" instead of a chip each
const CHIPS_PICKED = 6; // then chips for the people compared, up to this many

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
};

async function main() {
  const me = await loadMe();
  const activeUser = me.name;
  initProfileChip(qs('#profile-chip'));

  const body = qs('#stats-body');
  body.append(el('div', { class: 'stats-empty' }, 'Loading everyone’s solves…'));
  const [users, payload, index, custom] = await Promise.all([
    api.get('users'),
    api.get('stats-all'),
    fetch('./puzzles/index.json')
      .then((r) => (r.ok ? r.json() : { puzzles: [] }))
      .catch(() => ({ puzzles: [] })),
    // puzzles made on the site: the same facts index.json has for the rest
    api.get('custom-puzzles').catch(() => ({ puzzles: [] })),
  ]);
  const accounts = users.users.sort(byDisplayName);
  const ds = buildDataset(payload, [...(index.puzzles ?? []), ...custom.puzzles.filter((p) => p.status !== 'draft')]);
  const byName = new Map(accounts.map((u) => [u.name, u]));
  const nameOf = (user) => byName.get(user)?.display_name ?? user ?? 'someone';
  const byDisplay = (a, b) => byDisplayName(byName.get(a) ?? { name: a }, byName.get(b) ?? { name: b });

  // In the order people were picked: that decides who keeps their own
  // color when two share one.
  const selected = new Set([activeUser]);
  let colors = new Map();
  const colorOf = (user) => colors.get(user) ?? byName.get(user)?.color ?? 'var(--color-text-subtle)';
  const dot = (user) => el('span', { class: 'dot', style: `background:${colorOf(user)}` });

  let statsType = store.get(TYPE_KEY);
  if (!TYPE_TABS.some(([t]) => t === statsType)) statsType = 'daily';
  const prefs = (() => {
    try {
      return JSON.parse(store.get(PREFS_KEY)) ?? {};
    } catch {
      return {};
    }
  })();
  const filters = {
    range: RANGES.some(([k]) => k === prefs.range) ? prefs.range : 'all',
    weekdays: new Set(),
    cleanOnly: !!prefs.cleanOnly,
    times: prefs.times === 'actual' ? 'actual' : 'relative',
  };
  let section = SECTIONS.some(([k]) => k === location.hash.slice(1))
    ? location.hash.slice(1)
    : SECTIONS.some(([k]) => k === prefs.section)
      ? prefs.section
      : 'overview';
  const savePrefs = () =>
    store.set(PREFS_KEY, JSON.stringify({ range: filters.range, cleanOnly: filters.cleanOnly, times: filters.times, section }));

  // ----- models, cached per puzzle type (all time, everyone) -----
  const modelCache = new Map();
  function models(type) {
    if (!modelCache.has(type)) {
      const rows = ds.solves.filter((r) => r.type === type);
      const fit = fitAdditive(rows);
      modelCache.set(type, {
        fit,
        constructors: fit ? constructorEffects(fit, ds.puzzles) : new Map(),
        elo: elo(rows),
        bt: bradleyTerry(rows),
      });
    }
    return modelCache.get(type);
  }

  const detailCache = new Map();
  const details = (user) => {
    if (!detailCache.has(user)) {
      detailCache.set(
        user,
        api
          .get(`summaries/${encodeURIComponent(user)}`)
          .then((d) => d.solves ?? {})
          .catch(() => ({}))
      );
    }
    return detailCache.get(user);
  };

  function makeContext() {
    const people = [...selected].sort(byDisplay);
    const inType = ds.solves.filter((r) => r.type === statsType);
    const scope = { range: filters.range, weekdays: filters.weekdays, cleanOnly: filters.cleanOnly };
    const all = applyFilters(inType, scope);
    const rows = all.filter((r) => selected.has(r.user));
    const byUser = new Map(people.map((u) => [u, rows.filter((r) => r.user === u)]));
    const coop = applyFilters(
      ds.coop.filter((c) => c.type === statsType && c.members.some((m) => selected.has(m))),
      scope
    );
    const latest =
      [...ds.puzzles.values()].filter((p) => p.type === statsType && p.date).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
    return {
      me: activeUser,
      users: people,
      type: statsType,
      filters,
      ds,
      inType,
      all,
      rows,
      byUser,
      coop,
      unfinished: ds.unfinished.filter((u) => u.puzzle.type === statsType && selected.has(u.user)),
      puzzles: ds.puzzles,
      latest,
      models: () => models(statsType),
      details,
      accounts,
      colorOf,
      nameOf,
      byDisplay,
      dot,
      series: (list = people) => list.map((u) => ({ key: u, label: nameOf(u), color: colorOf(u) })),
      /** The time a chart plots: actual seconds, or relative to the person's usual. */
      timeOf: (r) => (filters.times === 'relative' ? r.relative : r.seconds),
      relative: filters.times === 'relative',
      hasWeekdays: hasWeekdays(statsType),
      typeLabel: TYPE_TABS.find(([t]) => t === statsType)?.[1] ?? statsType,
    };
  }

  // ----- controls -----

  function renderTypeTabs() {
    const host = qs('#type-tabs');
    host.textContent = '';
    for (const [t, label] of TYPE_TABS) {
      host.append(
        el(
          'button',
          {
            class: 'type-tab' + (t === statsType ? ' active' : ''),
            type: 'button',
            onclick: () => {
              statsType = t;
              store.set(TYPE_KEY, t);
              filters.weekdays.clear();
              renderTypeTabs();
              renderFilters();
              render();
            },
          },
          label
        )
      );
    }
  }

  function segmented(options, value, onPick, label, title = null) {
    return el(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': label, title },
      options.map(([key, text]) =>
        el(
          'button',
          { type: 'button', class: key === value ? 'active' : null, 'aria-pressed': String(key === value), onclick: () => onPick(key) },
          text
        )
      )
    );
  }

  function renderFilters() {
    const host = qs('#filter-bar');
    host.textContent = '';
    host.append(
      segmented(RANGES.map(([k, label]) => [k, label]), filters.range, (k) => {
        filters.range = k;
        savePrefs();
        renderFilters();
        render();
      }, 'Solved in')
    );
    if (hasWeekdays(statsType)) {
      host.append(
        el(
          'div',
          { class: 'segmented weekdays', role: 'group', 'aria-label': 'Weekdays (none picked: all)' },
          WEEKDAY_ORDER.map((d) =>
            el(
              'button',
              {
                type: 'button',
                class: filters.weekdays.has(d) ? 'active' : null,
                'aria-pressed': String(filters.weekdays.has(d)),
                'aria-label': WEEKDAY_NAMES[d],
                title: `Only ${WEEKDAY_NAMES[d]}s (pick several, or none for every day)`,
                onclick: () => {
                  if (filters.weekdays.has(d)) filters.weekdays.delete(d);
                  else filters.weekdays.add(d);
                  renderFilters();
                  render();
                },
              },
              WEEKDAY_NAMES[d].slice(0, 2)
            )
          )
        )
      );
    }
    host.append(
      el('label', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          ...(filters.cleanOnly ? { checked: true } : {}),
          onchange: (e) => {
            filters.cleanOnly = e.target.checked;
            savePrefs();
            render();
          },
        }),
        'Clean only',
      ]),
      segmented(
        [
          ['relative', 'Relative'],
          ['actual', 'Actual'],
        ],
        filters.times,
        (k) => {
          filters.times = k;
          savePrefs();
          renderFilters();
          render();
        },
        'Times',
        'Relative: each solve against that person’s usual time for the weekday, so easy and hard days line up. Actual: the clock.'
      )
    );
  }

  function renderSections() {
    const host = qs('#section-tabs');
    host.textContent = '';
    for (const [key, label] of SECTIONS) {
      host.append(
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: 'section-tab' + (key === section ? ' active' : ''),
            'aria-selected': String(key === section),
            onclick: () => {
              section = key;
              history.replaceState(null, '', `#${key}`);
              savePrefs();
              renderSections();
              render();
            },
          },
          label
        )
      );
    }
  }

  function update() {
    // whoever is already on screen keeps their color as people come and go
    colors = distinctColors(
      [...selected].map((name) => ({ name, color: byName.get(name)?.color })),
      { keep: colors }
    );
    renderSelector();
    render();
  }

  // ----- who's compared -----

  function renderSelector() {
    const host = qs('#user-select');
    host.textContent = '';
    if (accounts.length <= CHIPS_UP_TO) {
      for (const u of accounts) host.append(toggleChip(u.name));
      if (accounts.length <= 1) {
        host.append(el('span', { class: 'user-note' }, 'Other solvers show up here once they have accounts.'));
      }
      return;
    }
    const picked = [...selected];
    const shown = picked.length > CHIPS_PICKED ? picked.slice(0, CHIPS_PICKED - 1) : picked;
    for (const user of shown) host.append(pickedChip(user));
    const more = picked.length - shown.length;
    host.append(
      el(
        'button',
        { class: 'user-chip compare-btn', type: 'button', onclick: () => openCompare() },
        more ? `+${more} more · Add or remove…` : selected.size > 1 ? 'Add or remove…' : '+ Compare with…'
      )
    );
  }

  /** Short account list: a chip per person that toggles them. */
  function toggleChip(user) {
    const on = selected.has(user);
    return el('label', { class: 'user-chip' + (on ? ' selected' : '') }, [
      dot(user),
      nameOf(user),
      el('input', {
        type: 'checkbox',
        ...(on ? { checked: true } : {}),
        onchange: (e) => {
          if (e.target.checked) selected.add(user);
          else selected.delete(user);
          if (!selected.size) selected.add(user); // keep at least one
          update();
        },
      }),
    ]);
  }

  /** Long account list: a chip per person being compared, with ×. */
  function pickedChip(user) {
    return el('span', { class: 'user-chip selected' }, [
      dot(user),
      el('span', { class: 'chip-name' }, nameOf(user)),
      selected.size > 1
        ? el(
            'button',
            {
              class: 'chip-x',
              type: 'button',
              title: 'Remove',
              'aria-label': `Stop comparing ${nameOf(user)}`,
              onclick: () => {
                selected.delete(user);
                update();
              },
            },
            '×'
          )
        : null,
    ]);
  }

  async function openCompare() {
    const names = await pickPeople({
      title: 'Compare stats',
      users: accounts,
      selected,
      confirmLabel: 'Compare',
      you: activeUser,
    });
    if (!names?.length) return;
    selected.clear();
    for (const name of names) selected.add(name);
    update();
  }

  // ----- export -----

  qs('#export-btn').addEventListener('click', () => {
    const people = [...selected];
    const rows = ds.solves.filter((r) => people.includes(r.user));
    const secs = (ms) => (ms == null ? '' : (ms / 1000).toFixed(1));
    const csv = toCsv(rows, [
      ['solver', (r) => r.user],
      ['puzzle', (r) => r.puzzleId],
      ['type', (r) => r.type],
      ['puzzle_date', (r) => r.date],
      ['weekday', (r) => (r.weekday == null ? '' : WEEKDAY_NAMES[r.weekday])],
      ['seconds', (r) => r.seconds],
      ['relative_to_usual', (r) => r.relative?.toFixed(3)],
      ['completed_at', (r) => (Number.isFinite(r.completedAt) ? new Date(r.completedAt).toISOString() : '')],
      ['opened_at', (r) => (r.openedAt ? new Date(r.openedAt).toISOString() : '')],
      ['clean', (r) => (r.clean ? 1 : 0)],
      ['used_check', (r) => (r.check ? 1 : 0)],
      ['used_reveal', (r) => (r.reveal ? 1 : 0)],
      ['constructors', (r) => r.puzzle.constructors.join('; ')],
      ['editor', (r) => r.puzzle.editor],
      ['width', (r) => r.puzzle.width],
      ['height', (r) => r.puzzle.height],
      ['words', (r) => r.puzzle.words],
      ['blocks', (r) => r.puzzle.blocks],
      ['avg_word_len', (r) => r.puzzle.avgLen],
      ['rebus_squares', (r) => r.puzzle.rebus],
      ['solve_hour', (r) => r.solveHour],
      ['lag_days', (r) => r.lagDays],
      ['first_letter_s', (r) => secs(r.summary?.first_ms)],
      ['letters_typed', (r) => r.summary?.letters],
      ['wrong_letters', (r) => r.summary?.wrong],
      ['typo_hunt_s', (r) => secs(r.summary?.finish_ms)],
      ['longest_stall_s', (r) => secs(r.summary?.stall_ms)],
      ['sittings', (r) => r.summary?.sittings],
    ]);
    downloadText(`crossword-solves-${people.join('-')}.csv`, csv);
  });

  // ----- the stats -----

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    hideTip();
    const ctx = makeContext();
    const mod = SECTIONS.find(([k]) => k === section)[2];
    const frag = el('div', { class: 'section-body' });
    try {
      await mod.render(frag, ctx);
    } catch (err) {
      console.error(err);
      frag.append(el('div', { class: 'stats-empty' }, 'Something went wrong drawing this section.'));
    }
    if (seq !== renderSeq) return; // a newer render has taken over
    body.textContent = '';
    body.append(el('p', { class: 'stats-scope' }, scopeText(ctx, section)), frag);
  }

  function scopeText(ctx, key) {
    const n = key === 'coop' ? ctx.coop.length : ctx.rows.length;
    const range = RANGES.find(([k]) => k === filters.range)[1].toLowerCase();
    const days = filters.weekdays.size
      ? `, ${WEEKDAY_ORDER.filter((d) => filters.weekdays.has(d)).map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join('/')} only`
      : '';
    const what = `${ctx.typeLabel.toLowerCase()}${key === 'coop' ? ' co-op' : ''} solve${n === 1 ? '' : 's'}`;
    return `${n} ${what} · ${range}${days}${filters.cleanOnly ? ', clean only' : ''}`;
  }

  window.addEventListener('hashchange', () => {
    const key = location.hash.slice(1);
    if (SECTIONS.some(([k]) => k === key) && key !== section) {
      section = key;
      renderSections();
      render();
    }
  });

  renderTypeTabs();
  renderFilters();
  renderSections();
  update();
}

main();

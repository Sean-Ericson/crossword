/*
 * stats/common.js — pieces the stats tabs share: section headings, stat
 * tiles, sortable tables, puzzle labels and links.
 */

import { el, WEEKDAY_NAMES } from '../util.js';
import { fmt, sparkline } from '../charts.js';

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun, NYT style
export const wd = (d) => WEEKDAY_NAMES[d].slice(0, 3);

/** Dated puzzle types have weekdays; the rest don't. */
export const hasWeekdays = (type) => ['daily', 'mini', 'midi'].includes(type);

export const breakdownHref = (puzzleId, solveId = null) =>
  `./analysis.html?puzzle=${encodeURIComponent(puzzleId)}${solveId ? `&solve=${encodeURIComponent(solveId)}` : ''}`;

export const playHref = (puzzleId) => `./puzzle.html?id=${encodeURIComponent(puzzleId)}`;

/** "Fri, Sep 25" (+ year when not this year), or the id for special puzzles. */
export function puzzleName(p) {
  if (!p?.date) return p?.id ?? '';
  const d = new Date(p.date + 'T12:00:00Z');
  const sameYear = d.getUTCFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

export function sectionHead(title, sub = null) {
  return el('div', { class: 'section-head' }, [el('h2', {}, title), sub ? el('p', { class: 'chart-sub' }, sub) : null]);
}

/** A row of charts that sit side by side when there's room. */
export const chartGrid = (...cards) => el('div', { class: 'chart-grid' }, cards.filter(Boolean));

export const note = (text) => el('p', { class: 'stats-note' }, text);

export const empty = (text) => el('div', { class: 'stats-empty' }, text);

/**
 * A stat tile: label, value, optional sub line and sparkline.
 * @param {{label:string, value:string, sub?:string|Node, spark?:number[], sparkColor?:string, title?:string}} t
 */
export function tile({ label, value, sub = null, spark = null, sparkColor, title = null }) {
  return el('div', { class: 'stat-tile', title }, [
    el('div', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, value),
    sub ? el('div', { class: 'tile-sub' }, sub) : null,
    spark ? sparkline(spark, { color: sparkColor }) : null,
  ]);
}

export const tiles = (list) => el('div', { class: 'stat-tiles' }, list.filter(Boolean));

/**
 * A table whose headings sort it.
 * @param {{columns:Array<{key:string, label:string, value:(r)=>any, show?:(v, r)=>string|Node,
 *          num?:boolean, better?:1|-1, title?:string}>, rows:object[], sort?:{key:string, dir:1|-1},
 *          rowClass?:(r)=>string|null, limit?:number, className?:string}} opts
 */
export function sortableTable({ columns, rows, sort = null, rowClass = null, limit = null, className = '' }) {
  let state = sort ?? { key: columns[0].key, dir: 1 };
  const holder = el('div', { class: 'table-scroll' });
  let expanded = false;
  function draw() {
    const col = columns.find((c) => c.key === state.key) ?? columns[0];
    const sorted = [...rows].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * state.dir;
    });
    const shown = limit && !expanded ? sorted.slice(0, limit) : sorted;
    holder.textContent = '';
    holder.append(
      el('table', { class: `h2h-table ${className}`.trim() }, [
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            columns.map((c) => {
              const active = c.key === state.key;
              return el(
                'th',
                { class: c.num ? 'num' : null, title: c.title ?? null, 'aria-sort': active ? (state.dir < 0 ? 'descending' : 'ascending') : null },
                el(
                  'button',
                  {
                    class: 'sort-btn' + (active ? ' active' : ''),
                    type: 'button',
                    onclick: () => {
                      state = active ? { key: c.key, dir: -state.dir } : { key: c.key, dir: c.better ?? 1 };
                      draw();
                    },
                  },
                  [c.label, active ? (state.dir < 0 ? ' ▾' : ' ▴') : '']
                )
              );
            })
          )
        ),
        el(
          'tbody',
          {},
          shown.map((r) =>
            el(
              'tr',
              { class: rowClass?.(r) ?? null },
              columns.map((c) => {
                const v = c.value(r);
                const shownV = v == null ? null : c.show ? c.show(v, r) : v;
                return el('td', { class: (c.num ? 'num' : '') + (v == null ? ' empty' : '') || null }, shownV == null ? '—' : shownV);
              })
            )
          )
        ),
      ])
    );
    if (limit && sorted.length > limit) {
      holder.append(
        el(
          'button',
          {
            class: 'link-btn table-more',
            type: 'button',
            onclick: () => {
              expanded = !expanded;
              draw();
            },
          },
          expanded ? 'Show fewer' : `Show all ${sorted.length}`
        )
      );
    }
  }
  draw();
  return holder;
}

/** Signed seconds: "+1:05" / "−0:32". */
export function signedTime(sec) {
  if (sec == null) return '—';
  return `${sec < 0 ? '−' : '+'}${fmt.time(Math.abs(sec))}`;
}

/** "p = 0.003" with sensible rounding, or an explanation when there's none. */
export function pText(p) {
  if (p == null) return 'too few to test';
  if (p < 0.001) return 'p < 0.001';
  return `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;
}

/** A person's dot + name, for tables. */
export function who(ctx, user) {
  return el('span', { class: 'who' }, [el('span', { class: 'dot', style: `background:${ctx.colorOf(user)}` }), el('span', { class: 'who-name', title: ctx.nameOf(user) }, ctx.nameOf(user))]);
}

export function link(href, text, title = null) {
  return el('a', { href, title }, text);
}

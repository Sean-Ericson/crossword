/*
 * charts.js — the SVG chart kit behind the stats pages. No dependencies.
 *
 * chartCard() is the container every chart lives in: a title, an optional
 * legend, the plot (drawn at the container's width, redrawn when that or
 * the theme changes) and a "Table" toggle with the numbers behind it and a
 * CSV download, so no value is only reachable by hovering.
 *
 * The draw functions take the width to fill and return an <svg>:
 *   xyChart      dots, lines, bands and rules on x/y (time or number axes)
 *   barChart     grouped or stacked bars, horizontal or vertical
 *   histogramChart  one series: bars + density; several: density curves
 *   boxChart     box (or violin) per group and series
 *   heatmap      rows x columns, sequential or diverging
 *   calendarChart  a week-by-weekday calendar
 *   gridHeatmap  shaped like a crossword grid
 *   dotPlot      one dot (or a strip) per row on a shared axis
 *   sparkline    a tiny trend for stat tiles
 *
 * Styling follows the site tokens: chrome is hairline --color-chart-*,
 * magnitudes use --color-seq-0..6, polarities --color-div-0..6 (3 = none).
 * Series colors are people's colors; text never wears them. Mark specs:
 * bars <= 24px thick with a 4px rounded data end, 2px lines, dots r >= 4
 * with a 2px surface ring, a 2px surface gap between touching fills.
 */

import { el, formatTime } from './util.js';
import { niceTicks, timeTicks, histogram, kde, quantileSorted, silverman } from './stats-math.js';
import { toCsv } from './stats-data.js';

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;
const FONT = 11; // tick label size (px)

/** SVG element builder, like util.el. */
export function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

// ---------- formats ----------

export const fmt = {
  time: (sec) => formatTime(sec),
  int: (x) => Math.round(x).toLocaleString('en-US'),
  num: (x, d = 1) => (Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(d)),
  pct: (x) => `${Math.round(x * 100)}%`,
  pct1: (x) => `${(x * 100).toFixed(1)}%`,
  /** 0.8 -> "20% faster", 1.25 -> "25% slower" */
  rel: (r) => (r == null ? '—' : Math.abs(r - 1) < 0.005 ? 'as usual' : r < 1 ? `${Math.round((1 - r) * 100)}% faster` : `${Math.round((r - 1) * 100)}% slower`),
  ratio: (r) => `${r.toFixed(2)}×`,
  date: (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  day: (dateStr) => new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
  hour: (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`,
};

const approxWidth = (text, size = FONT) => String(text).length * size * 0.6;

// ---------- scales and ticks ----------

function linear(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = (x) => r0 + (x - d0) * k;
  f.invert = (y) => (k ? d0 + (y - r0) / k : d0);
  return f;
}

function logScale(d0, d1, r0, r1) {
  const l = linear(Math.log(d0), Math.log(d1), r0, r1);
  const f = (x) => l(Math.log(Math.max(x, 1e-9)));
  f.invert = (y) => Math.exp(l.invert(y));
  return f;
}

const LOG_TIME = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400];

function logTicks(min, max, time) {
  let cands = time ? LOG_TIME : [];
  if (!time) {
    for (let p = Math.floor(Math.log10(min)); p <= Math.ceil(Math.log10(max)); p++) for (const m of [1, 2, 5]) cands.push(m * 10 ** p);
  }
  let t = cands.filter((v) => v >= min && v <= max);
  while (t.length > 7) t = t.filter((_, k) => k % 2 === 0);
  if (t.length < 3) {
    // a narrow range (say 0.6x-1.5x): evenly spaced round values instead
    const lin = (time ? timeTicks : niceTicks)(min, max, 4).filter((v) => v > 0);
    if (lin.length >= 2) return lin;
  }
  return t.length >= 2 ? t : [min, max];
}

/** Round, readable date ticks between two timestamps. */
function dateTicks(min, max, target = 6) {
  const span = max - min;
  const out = [];
  const start = new Date(min);
  start.setHours(0, 0, 0, 0);
  if (span <= 24 * DAY) {
    const step = Math.max(1, Math.ceil(span / DAY / target));
    for (let d = new Date(start); d <= max; d.setDate(d.getDate() + step)) if (d >= min) out.push(d.getTime());
  } else if (span <= 160 * DAY) {
    const step = Math.max(1, Math.ceil(span / (7 * DAY) / target));
    const d = new Date(start);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); // next Monday
    for (; d <= max; d.setDate(d.getDate() + 7 * step)) out.push(d.getTime());
  } else {
    const months = span / (30.4 * DAY);
    const step = [1, 2, 3, 6, 12].find((m) => months / m <= target) ?? 12;
    const d = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    for (; d <= max; d.setMonth(d.getMonth() + step)) out.push(d.getTime());
  }
  return out;
}

function dateTickLabel(ms, span) {
  const d = new Date(ms);
  if (span > 160 * DAY) {
    return d.getMonth() === 0 ? String(d.getFullYear()) : d.toLocaleDateString('en-US', { month: 'short' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Ticks and a padded domain for a value axis. */
function valueAxis(lo, hi, { type = 'linear', ticks = 'number', zero = false, count = 5 } = {}) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (type === 'log') {
    lo = Math.max(lo, 1e-6);
    if (hi <= lo) hi = lo * 2;
    lo /= 1.12;
    hi *= 1.12;
    return { lo, hi, ticks: logTicks(lo, hi, ticks === 'time') };
  }
  if (zero) lo = Math.min(0, lo);
  if (hi === lo) {
    hi = lo + (lo ? Math.abs(lo) * 0.5 : 1);
    if (!zero) lo -= (hi - lo) / 2;
  }
  const make = ticks === 'time' ? timeTicks : niceTicks;
  let t = make(lo, hi, count);
  const step = t.length > 1 ? t[1] - t[0] : 1;
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  if (hi === lo) hi = lo + step;
  t = make(lo, hi, count);
  return { lo, hi, ticks: t };
}

// ---------- colors ----------

export function seqColor(t) {
  if (t == null || !Number.isFinite(t)) return 'var(--color-chart-empty)';
  return `var(--color-seq-${Math.max(0, Math.min(6, Math.floor(t * 7)))})`;
}

/** t in [-1, 1]: -1 blue (faster/better), 0 gray, 1 red. */
export function divColor(t) {
  if (t == null || !Number.isFinite(t)) return 'var(--color-chart-empty)';
  return `var(--color-div-${3 + Math.max(-3, Math.min(3, Math.round(t * 3)))})`;
}

/** Map a value to a fill for a heatmap scale {type:'seq'|'div', min, max, mid?}. */
export function scaleFill(scale, v) {
  if (v == null || !Number.isFinite(v)) return 'var(--color-chart-empty)';
  if (scale.type === 'div') {
    const mid = scale.mid ?? 0;
    const t = v < mid ? -(mid - v) / Math.max(1e-9, mid - scale.min) : (v - mid) / Math.max(1e-9, scale.max - mid);
    return divColor(Math.max(-1, Math.min(1, t)));
  }
  const t = (v - scale.min) / Math.max(1e-9, scale.max - scale.min);
  return seqColor(Math.max(0, Math.min(0.9999, t)));
}

/** Ink (text color) that reads on a fill given as a var(--token). */
function inkOn(fill) {
  const m = /var\((--[\w-]+)\)/.exec(fill);
  const hex = m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : fill;
  const rgb = /^#([0-9a-f]{6})$/i.exec(hex) ? [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) : null;
  if (!rgb) return 'var(--color-text)';
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return lum > 0.3 ? '#121212' : '#ffffff';
}

// ---------- tooltip ----------

let tipNode = null;

/**
 * Show the shared tooltip near a pointer event. Values lead, labels follow;
 * `color` gives a row a short line key. All text goes in as text nodes.
 * @param {{title?:string, rows?:Array<{value:string, label?:string, color?:string}>, note?:string}} content
 */
export function showTip(evt, { title = null, rows = [], note = null }) {
  if (!tipNode) {
    tipNode = el('div', { class: 'chart-tip', role: 'status' });
    document.body.append(tipNode);
  }
  tipNode.textContent = '';
  if (title) tipNode.append(el('div', { class: 'tip-title' }, title));
  for (const r of rows) {
    tipNode.append(
      el('div', { class: 'tip-row' }, [
        r.color ? el('span', { class: 'tip-key', style: `background:${r.color}` }) : null,
        el('strong', {}, r.value ?? ''),
        r.label ? el('span', { class: 'tip-label' }, r.label) : null,
      ])
    );
  }
  if (note) tipNode.append(el('div', { class: 'tip-note' }, note));
  tipNode.hidden = false;
  const pad = 14;
  const box = tipNode.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + box.width > innerWidth - 8) x = evt.clientX - pad - box.width;
  if (y + box.height > innerHeight - 8) y = evt.clientY - pad - box.height;
  tipNode.style.left = `${Math.max(8, x)}px`;
  tipNode.style.top = `${Math.max(8, y)}px`;
}

export function hideTip() {
  if (tipNode) tipNode.hidden = true;
}

addEventListener('scroll', hideTip, { passive: true });

// ---------- container, legend, table ----------

/**
 * @param {{title:string, sub?:string, legend?:Element, table?:{columns:Array<[string, Function]>, rows:object[], name?:string},
 *          draw:(width:number)=>Element|null, className?:string, note?:string}} opts
 */
export function chartCard({ title, sub = null, legend: legendEl = null, table = null, draw, className = '', note = null }) {
  const plot = el('div', { class: 'chart-plot' });
  const tableHost = el('div', { class: 'chart-table', hidden: true });
  let showing = false;
  const toggle = table
    ? el(
        'button',
        {
          class: 'chart-table-btn',
          type: 'button',
          'aria-pressed': 'false',
          title: 'Show the numbers behind this chart',
          onclick: () => {
            showing = !showing;
            toggle.setAttribute('aria-pressed', String(showing));
            toggle.textContent = showing ? 'Chart' : 'Table';
            if (showing && !tableHost.childNodes.length) tableHost.append(...tableView(table, title));
            tableHost.hidden = !showing;
            plot.hidden = showing;
            if (legendEl) legendEl.hidden = showing;
            if (!showing) redraw(true);
          },
        },
        'Table'
      )
    : null;
  const fig = el('figure', { class: `chart ${className}`.trim() }, [
    el('figcaption', { class: 'chart-head' }, [
      el('div', { class: 'chart-titles' }, [el('h3', {}, title), sub ? el('p', { class: 'chart-sub' }, sub) : null]),
      toggle,
    ]),
    legendEl,
    plot,
    tableHost,
    note ? el('p', { class: 'chart-note' }, note) : null,
  ]);
  let lastW = 0;
  let pending = false;
  function redraw(force = false) {
    const w = Math.floor(plot.clientWidth);
    if (!w || plot.hidden || (!force && w === lastW)) return;
    lastW = w;
    plot.textContent = '';
    const node = draw(w);
    if (node) plot.append(node);
  }
  new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      redraw();
    });
  }).observe(plot);
  fig.redraw = () => redraw(true);
  return fig;
}

// redraw on light/dark switches: colors resolved in JS (cell ink) change
new MutationObserver(() => {
  for (const f of document.querySelectorAll('figure.chart')) f.redraw?.();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function tableView({ columns, rows, name = null }, title) {
  const MAX = 400;
  const shown = rows.slice(0, MAX);
  const table = el('table', { class: 'data-table' }, [
    el('thead', {}, el('tr', {}, columns.map(([h]) => el('th', {}, h)))),
    el(
      'tbody',
      {},
      shown.map((r) =>
        el(
          'tr',
          {},
          columns.map(([, get, show]) => {
            const v = get(r);
            return el('td', {}, v == null ? '—' : show ? show(v, r) : String(v));
          })
        )
      )
    ),
  ]);
  const file = (name || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'data';
  return [
    el('div', { class: 'table-scroll' }, table),
    el('div', { class: 'chart-table-foot' }, [
      rows.length > MAX ? el('span', {}, `First ${MAX} of ${rows.length} rows shown. `) : null,
      el('button', { class: 'link-btn', type: 'button', onclick: () => downloadText(`${file}.csv`, toCsv(rows, columns.map(([h, g]) => [h, g]))) }, 'Download CSV'),
    ]),
  ];
}

export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * @param {Array<{key:string, label:string, color:string, kind?:'rect'|'line'|'dot', muted?:boolean}>} items
 * @param {{onPick?:(key:string)=>void, active?:string|null}} opts  onPick makes items buttons
 */
export function legend(items, { onPick = null, active = null } = {}) {
  return el(
    'div',
    { class: 'chart-legend' },
    items.map((it) => {
      const content = [el('span', { class: `lg-key lg-${it.kind ?? 'rect'}`, style: `background:${it.color}` }), el('span', {}, it.label)];
      if (!onPick) return el('span', { class: 'lg-item' + (it.muted ? ' muted' : '') }, content);
      return el(
        'button',
        {
          type: 'button',
          class: 'lg-item' + (active === it.key ? ' active' : '') + (it.muted ? ' muted' : ''),
          'aria-pressed': String(active === it.key),
          onclick: () => onPick(it.key),
        },
        content
      );
    })
  );
}

/** Sequential/diverging key under a heatmap: the steps with end labels. */
export function scaleLegend(scale, { low, high }) {
  const steps = scale.type === 'div' ? [0, 1, 2, 3, 4, 5, 6].map((k) => `var(--color-div-${k})`) : [0, 1, 2, 3, 4, 5, 6].map((k) => `var(--color-seq-${k})`);
  return el('div', { class: 'scale-legend' }, [
    el('span', {}, low),
    el('span', { class: 'scale-steps' }, steps.map((c) => el('span', { style: `background:${c}` }))),
    el('span', {}, high),
  ]);
}

// ---------- shared plot frame ----------

function svgRoot(width, height, label) {
  return s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img', 'aria-label': label || null });
}

/** Horizontal gridlines + y labels, and the x baseline + labels. */
function drawFrame(svg, { X, Y, xTicks, yTicks, xFmt, yFmt, m, width, height, xLabel, yLabel, vertical = false }) {
  const g = s('g', { class: 'ch-frame' });
  if (!vertical) {
    for (const t of yTicks) {
      const y = Y(t);
      g.append(s('line', { x1: m.l, x2: width - m.r, y1: y, y2: y, class: 'ch-grid' }));
      g.append(s('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end', class: 'ch-tick' }, yFmt(t)));
    }
  } else {
    for (const t of xTicks) {
      const x = X(t);
      g.append(s('line', { x1: x, x2: x, y1: m.t, y2: height - m.b, class: 'ch-grid' }));
    }
  }
  g.append(s('line', { x1: m.l, x2: width - m.r, y1: height - m.b, y2: height - m.b, class: 'ch-axis' }));
  let lastRight = -Infinity;
  for (const t of xTicks) {
    const x = X(t);
    const label = xFmt(t);
    const w = approxWidth(label);
    let anchor = 'middle';
    let left = x - w / 2;
    if (x - w / 2 < 2) {
      anchor = 'start';
      left = x;
    } else if (x + w / 2 > width - 2) {
      anchor = 'end';
      left = x - w;
    }
    if (left < lastRight + 6) continue; // would collide
    lastRight = left + w;
    g.append(s('text', { x, y: height - m.b + 16, 'text-anchor': anchor, class: 'ch-tick' }, label));
  }
  if (xLabel) g.append(s('text', { x: (m.l + width - m.r) / 2, y: height - 4, 'text-anchor': 'middle', class: 'ch-axis-label' }, xLabel));
  if (yLabel) {
    g.append(s('text', { x: 0, y: 0, transform: `translate(11 ${(m.t + height - m.b) / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'ch-axis-label' }, yLabel));
  }
  svg.append(g);
}

// ---------- x/y chart ----------

/**
 * Dots, lines, bands and rules on shared axes.
 * @param {number} width
 * @param {{
 *   height?:number, label?:string,
 *   x?:{type?:'time'|'linear'|'log', min?:number, max?:number, fmt?:Function, label?:string, ticks?:'time'|'number'},
 *   y?:{type?:'linear'|'log', min?:number, max?:number, fmt?:Function, ticks?:'time'|'number', zero?:boolean, label?:string, invert?:boolean},
 *   layers:Array<
 *     {type:'dots', key?, label?, color, points:Array<{x, y, tip?, href?}>, r?:number, muted?:boolean} |
 *     {type:'line', key?, label?, color, points:Array<{x, y}>, width?:number, step?:boolean, muted?:boolean, hover?:boolean} |
 *     {type:'band', color?, points:Array<{x, lo, hi}>} |
 *     {type:'rule', y?:number, x?:number, label?:string}>,
 *   hover?:'nearest'|'x'|'none', tipFor?:(x)=>object
 * }} opts
 */
export function xyChart(width, { height = 240, label = '', x = {}, y = {}, layers = [], hover = 'nearest' }) {
  const xs = [];
  const ys = [];
  for (const L of layers) {
    if (L.type === 'rule') {
      if (L.y != null) ys.push(L.y);
      if (L.x != null) xs.push(L.x);
      continue;
    }
    for (const p of L.points) {
      xs.push(p.x);
      if (L.type === 'band') ys.push(p.lo, p.hi);
      else ys.push(p.y);
    }
  }
  if (!xs.length) return null;
  const xType = x.type ?? 'linear';
  let x0 = x.min ?? Math.min(...xs);
  let x1 = x.max ?? Math.max(...xs);
  if (x1 === x0) {
    const pad = xType === 'time' ? DAY : Math.abs(x0) * 0.1 || 1;
    x0 -= pad;
    x1 += pad;
  }
  const ya = valueAxis(y.min ?? Math.min(...ys), y.max ?? Math.max(...ys), { type: y.type, ticks: y.ticks, zero: y.zero });
  if (y.min != null && y.type !== 'log') ya.lo = Math.min(ya.lo, y.min);
  const yFmt = y.fmt ?? ((v) => fmt.num(v));
  const xFmt = x.fmt ?? (xType === 'time' ? (v) => dateTickLabel(v, x1 - x0) : (v) => fmt.num(v));
  const m = {
    l: Math.max(...ya.ticks.map((t) => approxWidth(yFmt(t)))) + 12 + (y.label ? 16 : 0),
    r: 14,
    t: 10,
    b: 24 + (x.label ? 16 : 0),
  };
  const X = xType === 'log' ? logScale(x0, x1, m.l, width - m.r) : linear(x0, x1, m.l, width - m.r);
  const Y = y.type === 'log' ? logScale(ya.lo, ya.hi, height - m.b, m.t) : linear(ya.lo, ya.hi, height - m.b, m.t);
  const Yp = y.invert ? (v) => m.t + height - m.b - Y(v) : Y;
  const plotW = width - m.l - m.r;
  let xTicks;
  if (xType === 'time') xTicks = dateTicks(x0, x1, Math.max(2, Math.floor(plotW / 90)));
  else if (xType === 'log') xTicks = logTicks(x0, x1, x.ticks === 'time');
  else xTicks = (x.ticks === 'time' ? timeTicks : niceTicks)(x0, x1, Math.max(2, Math.floor(plotW / 80)));
  xTicks = xTicks.filter((t) => t >= x0 - 1e-9 && t <= x1 + 1e-9);

  const svg = svgRoot(width, height, label);
  drawFrame(svg, { X, Y: Yp, xTicks, yTicks: ya.ticks, xFmt, yFmt, m, width, height, xLabel: x.label, yLabel: y.label });

  const hoverable = [];
  const lines = [];
  for (const L of layers) {
    const color = L.muted ? 'var(--color-chart-muted)' : L.color;
    if (L.type === 'band') {
      const pts = [...L.points].sort((a, b) => a.x - b.x);
      if (pts.length < 2) continue;
      const d = `M${pts.map((p) => `${X(p.x)},${Yp(p.hi)}`).join('L')}L${[...pts].reverse().map((p) => `${X(p.x)},${Yp(p.lo)}`).join('L')}Z`;
      svg.append(s('path', { d, style: `fill:${L.color ?? 'var(--color-chart-band)'}`, 'fill-opacity': L.color ? 0.12 : 1 }));
    } else if (L.type === 'line') {
      const pts = [...L.points].sort((a, b) => a.x - b.x);
      if (!pts.length) continue;
      let d = '';
      pts.forEach((p, k) => {
        const px = X(p.x);
        const py = Yp(p.y);
        if (!k) d += `M${px},${py}`;
        else if (L.step) d += `H${px}V${py}`;
        else d += `L${px},${py}`;
      });
      if (L.step && L.extend) d += `H${width - m.r}`;
      svg.append(s('path', { d, fill: 'none', style: `stroke:${color}`, 'stroke-width': L.width ?? 2, 'stroke-opacity': L.opacity ?? null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: L.muted ? 'ch-muted' : null }));
      if (L.hover !== false) lines.push({ L, pts });
    } else if (L.type === 'dots') {
      const r = L.r ?? (L.points.length > 250 ? 3 : 4);
      const g = s('g');
      for (const p of L.points) {
        const px = X(p.x);
        const py = Yp(p.y);
        g.append(s('circle', { cx: px, cy: py, r, style: `fill:${color}`, class: 'ch-dot' }));
        hoverable.push({ px, py, p, L, color: L.color });
      }
      svg.append(g);
    } else if (L.type === 'rule') {
      if (L.y != null) {
        const py = Yp(L.y);
        svg.append(s('line', { x1: m.l, x2: width - m.r, y1: py, y2: py, class: 'ch-rule' }));
        if (L.label) svg.append(s('text', { x: width - m.r, y: py - 4, 'text-anchor': 'end', class: 'ch-rule-label' }, L.label));
      } else if (L.x != null) {
        const px = X(L.x);
        svg.append(s('line', { x1: px, x2: px, y1: m.t, y2: height - m.b, class: 'ch-rule' }));
        if (L.label) svg.append(s('text', { x: px + 4, y: m.t + 10, class: 'ch-rule-label' }, L.label));
      }
    }
  }

  if (hover === 'none' || (!hoverable.length && !lines.length)) return svg;
  const ring = s('circle', { r: 7, class: 'ch-hover-ring', visibility: 'hidden' });
  const cross = s('line', { y1: m.t, y2: height - m.b, class: 'ch-cross', visibility: 'hidden' });
  svg.append(cross, ring);
  let current = null;
  const hit = s('rect', { x: m.l, y: m.t, width: plotW, height: height - m.t - m.b, fill: 'transparent', class: 'ch-hit' });
  const move = (evt) => {
    const box = svg.getBoundingClientRect();
    const mx = ((evt.clientX - box.left) * width) / box.width;
    const my = ((evt.clientY - box.top) * height) / box.height;
    if (hover === 'nearest' && hoverable.length) {
      let best = null;
      let bd = 32 * 32;
      for (const h of hoverable) {
        const d = (h.px - mx) ** 2 + (h.py - my) ** 2;
        if (d < bd) {
          bd = d;
          best = h;
        }
      }
      current = best;
      if (!best) {
        ring.setAttribute('visibility', 'hidden');
        hideTip();
        return;
      }
      ring.setAttribute('cx', best.px);
      ring.setAttribute('cy', best.py);
      ring.setAttribute('style', `stroke:${best.color}`);
      ring.setAttribute('visibility', 'visible');
      showTip(evt, best.p.tip ?? { title: xFmt(best.p.x), rows: [{ value: yFmt(best.p.y), label: best.L.label, color: best.color }] });
      hit.style.cursor = best.p.href ? 'pointer' : 'default';
    } else {
      // crosshair: snap to the nearest x any line has, list every line there
      const xv = X.invert(mx);
      let snap = null;
      for (const { pts } of lines) {
        for (const p of pts) if (snap == null || Math.abs(p.x - xv) < Math.abs(snap - xv)) snap = p.x;
      }
      if (snap == null) return;
      cross.setAttribute('x1', X(snap));
      cross.setAttribute('x2', X(snap));
      cross.setAttribute('visibility', 'visible');
      const rows = [];
      for (const { L, pts } of lines) {
        let at = null;
        if (L.step) {
          for (const p of pts) if (p.x <= snap) at = p;
        } else {
          at = pts.reduce((b, p) => (b == null || Math.abs(p.x - snap) < Math.abs(b.x - snap) ? p : b), null);
          if (at && Math.abs(X(at.x) - X(snap)) > 40) at = null;
        }
        if (at) rows.push({ value: yFmt(at.y), label: L.label, color: L.muted ? 'var(--color-chart-muted)' : L.color, y: at.y });
      }
      if (!y.invert) rows.sort((a, b) => b.y - a.y);
      showTip(evt, { title: xType === 'time' ? fmt.date(snap) : xFmt(snap), rows });
    }
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => {
    ring.setAttribute('visibility', 'hidden');
    cross.setAttribute('visibility', 'hidden');
    hideTip();
  });
  hit.addEventListener('click', () => {
    if (current?.p.href) location.href = current.p.href;
  });
  svg.insertBefore(hit, cross);
  return svg;
}

// ---------- bars ----------

/** A bar with a 4px rounded end at the data end, square at the baseline. */
function barPath(x, y, w, h, dir, r = 4) {
  r = Math.max(0, Math.min(r, (dir === 'right' ? h : w) / 2, dir === 'right' ? w : h));
  if (dir === 'right') {
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  // up: baseline at y + h
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * @param {number} width
 * @param {{categories:Array<{key, label}>, series:Array<{key, label, color}>,
 *          value:(catKey, serKey)=>number|null, fmt?:Function, horizontal?:boolean,
 *          stacked?:boolean, height?:number, ticks?:'time'|'number', max?:number,
 *          tip?:(cat, ser, v)=>object, valueLabels?:boolean, href?:(cat)=>string|null, label?:string}} opts
 */
export function barChart(width, { categories, series, value, fmt: f = (v) => fmt.num(v), horizontal = false, stacked = false, height = null, ticks = 'number', max = null, tip = null, valueLabels = true, href = null, label = '' }) {
  const vals = [];
  for (const c of categories) {
    let sum = 0;
    for (const sr of series) {
      const v = value(c.key, sr.key);
      if (v == null) continue;
      if (stacked) sum += v;
      else vals.push(v);
    }
    if (stacked) vals.push(sum);
  }
  if (!vals.length) return null;
  const axis = valueAxis(0, max ?? Math.max(...vals, 0), { ticks, zero: true, count: horizontal ? 4 : 5 });
  const nS = stacked ? 1 : series.length;
  const showTip2 = (evt, c, sr, v) =>
    showTip(evt, tip ? tip(c, sr, v) : { title: c.label, rows: (stacked ? series : [sr]).map((x) => ({ value: value(c.key, x.key) == null ? '—' : f(value(c.key, x.key)), label: x.label, color: x.color })) });

  if (horizontal) {
    const thick = nS === 1 ? 16 : Math.max(8, Math.min(14, 30 / nS));
    const rowH = nS * (thick + 2) + 12;
    const labelW = Math.min(width * 0.4, Math.max(...categories.map((c) => approxWidth(c.label, 12))) + 10);
    const valW = valueLabels ? Math.max(...vals.map((v) => approxWidth(f(v)))) + 8 : 0;
    const m = { l: labelW, r: 10 + valW, t: 4, b: 24 };
    const h = height ?? m.t + m.b + rowH * categories.length;
    const X = linear(axis.lo, axis.hi, m.l, width - m.r);
    const svg = svgRoot(width, h, label);
    drawFrame(svg, { X, Y: null, xTicks: axis.ticks, yTicks: [], xFmt: f, yFmt: f, m, width, height: h, vertical: true });
    categories.forEach((c, ci) => {
      const top = m.t + ci * rowH + 6;
      const link = href?.(c);
      svg.append(s('text', { x: m.l - 8, y: top + (rowH - 12) / 2 + 4, 'text-anchor': 'end', class: 'ch-cat' }, c.label));
      let acc = 0;
      const segs = [];
      series.forEach((sr, si) => {
        const v = value(c.key, sr.key);
        if (v == null) return;
        const y0 = stacked ? top + (rowH - 12 - thick) / 2 : top + si * (thick + 2);
        const xa = X(stacked ? acc : 0);
        const xb = X(stacked ? acc + v : v);
        acc += v;
        segs.push({ sr, v, y0, xa, xb });
      });
      segs.forEach((g, k) => {
        const last = !stacked || k === segs.length - 1;
        const w = Math.max(0, g.xb - g.xa - (stacked && !last ? 2 : 0));
        const bar = s('path', { d: last ? barPath(g.xa, g.y0, w, thick, 'right') : `M${g.xa},${g.y0}h${w}v${thick}h${-w}Z`, style: `fill:${g.sr.color}`, class: 'ch-bar' });
        svg.append(bar);
      });
      if (valueLabels) {
        segs
          .filter((_, k) => !stacked || k === segs.length - 1)
          .forEach((g) => {
            const v = stacked ? acc : g.v;
            svg.append(s('text', { x: (stacked ? X(acc) : g.xb) + 6, y: g.y0 + thick / 2 + 4, class: 'ch-val' }, f(v)));
          });
      }
      const hitR = s('rect', { x: 0, y: top - 6, width, height: rowH, fill: 'transparent', class: 'ch-hit' + (link ? ' link' : '') });
      hitR.addEventListener('pointermove', (evt) => {
        const box = svg.getBoundingClientRect();
        const my = ((evt.clientY - box.top) * h) / box.height;
        const seg = stacked
          ? segs.find((g) => ((evt.clientX - box.left) * width) / box.width <= g.xb) ?? segs.at(-1)
          : segs.reduce((b, g) => (b == null || Math.abs(g.y0 + thick / 2 - my) < Math.abs(b.y0 + thick / 2 - my) ? g : b), null);
        if (seg) showTip2(evt, c, seg.sr, seg.v);
      });
      hitR.addEventListener('pointerleave', hideTip);
      if (link) hitR.addEventListener('click', () => (location.href = link));
      svg.append(hitR);
    });
    return svg;
  }

  // vertical
  const h = height ?? 220;
  const m = { l: Math.max(...axis.ticks.map((t) => approxWidth(f(t)))) + 12, r: 8, t: valueLabels ? 18 : 8, b: 24 };
  const Y = linear(axis.lo, axis.hi, h - m.b, m.t);
  const band = (width - m.l - m.r) / categories.length;
  const thick = Math.max(3, Math.min(24, (band * 0.72 - 2 * (nS - 1)) / nS));
  const svg = svgRoot(width, h, label);
  const catTicks = categories.map((_, k) => k);
  drawFrame(svg, {
    X: (k) => m.l + band * (k + 0.5),
    Y,
    xTicks: catTicks,
    yTicks: axis.ticks,
    xFmt: (k) => categories[k].label,
    yFmt: f,
    m,
    width,
    height: h,
  });
  categories.forEach((c, ci) => {
    const center = m.l + band * (ci + 0.5);
    const groupW = nS * thick + (nS - 1) * 2;
    let acc = 0;
    const segs = [];
    series.forEach((sr, si) => {
      const v = value(c.key, sr.key);
      if (v == null) return;
      const x0 = stacked ? center - thick / 2 : center - groupW / 2 + si * (thick + 2);
      const ya = Y(stacked ? acc : 0);
      const yb = Y(stacked ? acc + v : v);
      acc += v;
      segs.push({ sr, v, x0, ya, yb });
    });
    segs.forEach((g, k) => {
      const last = !stacked || k === segs.length - 1;
      const hh = Math.max(0, g.ya - g.yb - (stacked && !last ? 2 : 0));
      svg.append(s('path', { d: last ? barPath(g.x0, g.ya - hh, thick, hh, 'up') : `M${g.x0},${g.ya - hh}h${thick}v${hh}h${-thick}Z`, style: `fill:${g.sr.color}`, class: 'ch-bar' }));
    });
    if (valueLabels && (stacked || nS === 1) && segs.length) {
      const top = stacked ? Y(acc) : segs[0].yb;
      const text = f(stacked ? acc : segs[0].v);
      if (approxWidth(text) <= band) svg.append(s('text', { x: center, y: top - 5, 'text-anchor': 'middle', class: 'ch-val' }, text));
    }
    const hitR = s('rect', { x: center - band / 2, y: m.t, width: band, height: h - m.t - m.b, fill: 'transparent', class: 'ch-hit' });
    hitR.addEventListener('pointermove', (evt) => showTip(evt, tip ? tip(c, null, null) : { title: c.label, rows: series.map((x) => ({ value: value(c.key, x.key) == null ? '—' : f(value(c.key, x.key)), label: x.label, color: x.color })) }));
    hitR.addEventListener('pointerleave', hideTip);
    svg.append(hitR);
  });
  return svg;
}

// ---------- distributions ----------

/**
 * One series: a histogram with its density curve. Several: overlaid
 * density curves with a light wash each (share of solves per bin width).
 * @param {{series:Array<{key, label, color, values:number[]}>, fmt?:Function, ticks?:'time'|'number', log?:boolean, height?:number, label?:string}} opts
 */
export function histogramChart(width, { series, fmt: f = fmt.time, ticks = 'time', log = false, height = 200, label = '' }) {
  const all = series.flatMap((sr) => sr.values).filter((v) => Number.isFinite(v) && (!log || v > 0));
  if (all.length < 2) return null;
  const tf = log ? Math.log : (v) => v;
  const inv = log ? Math.exp : (v) => v;
  const bins = histogram(all.map(tf), { maxBins: 30 });
  const binW = bins[0].x1 - bins[0].x0;
  const lo = bins[0].x0;
  const hi = bins.at(-1).x1;
  const grid = Array.from({ length: 80 }, (_, k) => lo + ((hi - lo) * k) / 79);
  if (series.length === 1) {
    const sr = series[0];
    const vals = sr.values.map(tf);
    const counts = histogram(vals, { width: binW }).reduce((m, b) => m.set(Math.round((b.x0 - lo) / binW), b.count), new Map());
    const maxC = Math.max(...counts.values());
    const ya = valueAxis(0, maxC, { zero: true, count: 4 });
    const xLabels = ticks === 'time' ? timeTicks(inv(lo), inv(hi), 5) : niceTicks(inv(lo), inv(hi), 5);
    const m = { l: Math.max(...ya.ticks.map((t) => approxWidth(fmt.int(t)))) + 12, r: 10, t: 10, b: 24 };
    const X = linear(lo, hi, m.l, width - m.r);
    const Y = linear(ya.lo, ya.hi, height - m.b, m.t);
    const svg = svgRoot(width, height, label);
    drawFrame(svg, { X: (v) => X(tf(v)), Y, xTicks: xLabels.filter((v) => tf(v) >= lo && tf(v) <= hi), yTicks: ya.ticks, xFmt: f, yFmt: fmt.int, m, width, height });
    const bw = X(lo + binW) - X(lo);
    for (const [k, c] of counts) {
      const x0 = X(lo + k * binW) + 1;
      const hh = Y(0) - Y(c);
      const bar = s('path', { d: barPath(x0, Y(c), Math.max(1, bw - 2), hh, 'up', Math.min(4, (bw - 2) / 2)), style: `fill:${sr.color}`, 'fill-opacity': 0.55, class: 'ch-bar' });
      const a = inv(lo + k * binW);
      const b = inv(lo + (k + 1) * binW);
      bar.addEventListener('pointermove', (evt) => showTip(evt, { title: `${f(a)} – ${f(b)}`, rows: [{ value: `${c} solve${c === 1 ? '' : 's'}`, label: `${Math.round((c * 100) / vals.length)}%` }] }));
      bar.addEventListener('pointerleave', hideTip);
      svg.append(bar);
    }
    if (vals.length >= 5) {
      const dens = kde(vals, grid, silverman(vals));
      const scale = vals.length * binW;
      svg.append(s('path', { d: `M${grid.map((g, k) => `${X(g)},${Y(dens[k] * scale)}`).join('L')}`, fill: 'none', class: 'ch-density' }));
    }
    return svg;
  }
  // several: density per series as % per bin
  const layers = [];
  for (const sr of series) {
    const vals = sr.values.map(tf).filter(Number.isFinite);
    if (vals.length < 3) continue;
    const dens = kde(vals, grid, silverman(vals));
    const pts = grid.map((g, k) => ({ x: inv(g), y: dens[k] * binW * 100 }));
    layers.push({ type: 'band', color: sr.color, points: pts.map((p) => ({ x: p.x, lo: 0, hi: p.y })) });
    layers.push({ type: 'line', key: sr.key, label: sr.label, color: sr.color, points: pts });
  }
  if (!layers.length) return null;
  return xyChart(width, {
    height,
    label,
    x: { type: log ? 'log' : 'linear', fmt: f, ticks },
    y: { zero: true, fmt: (v) => `${Math.round(v)}%` },
    layers,
    hover: 'x',
  });
}

/**
 * Horizontal box plots (or violins): one lane per series inside each group.
 * @param {{groups:Array<{key, label}>, series:Array<{key, label, color}>, values:(g, s)=>number[],
 *          fmt?:Function, ticks?:'time'|'number', log?:boolean, violin?:boolean, label?:string}} opts
 */
export function boxChart(width, { groups, series, values, fmt: f = fmt.time, ticks = 'time', log = false, violin = false, label = '' }) {
  const data = groups.map((g) => series.map((sr) => [...(values(g.key, sr.key) ?? [])].filter((v) => Number.isFinite(v) && (!log || v > 0)).sort((a, b) => a - b)));
  const all = data.flat(2);
  if (!all.length) return null;
  const lane = violin ? 24 : 14;
  const groupH = series.length * (lane + 2) + 12;
  const labelW = Math.max(...groups.map((g) => approxWidth(g.label, 12))) + 12;
  const m = { l: labelW, r: 14, t: 6, b: 24 };
  const height = m.t + m.b + groupH * groups.length;
  const xa = valueAxis(Math.min(...all), Math.max(...all), { type: log ? 'log' : 'linear', ticks, count: 5 });
  const X = log ? logScale(xa.lo, xa.hi, m.l, width - m.r) : linear(xa.lo, xa.hi, m.l, width - m.r);
  const svg = svgRoot(width, height, label);
  drawFrame(svg, { X, Y: null, xTicks: xa.ticks, yTicks: [], xFmt: f, yFmt: f, m, width, height, vertical: true });
  groups.forEach((g, gi) => {
    const top = m.t + gi * groupH + 6;
    svg.append(s('text', { x: m.l - 8, y: top + (series.length * (lane + 2)) / 2 + 3, 'text-anchor': 'end', class: 'ch-cat' }, g.label));
    series.forEach((sr, si) => {
      const v = data[gi][si];
      if (!v.length) return;
      const cy = top + si * (lane + 2) + lane / 2;
      const q = (p) => quantileSorted(v, p);
      const [q1, med, q3] = [q(0.25), q(0.5), q(0.75)];
      const iqr = q3 - q1;
      const loW = v.find((x) => x >= q1 - 1.5 * iqr);
      const hiW = [...v].reverse().find((x) => x <= q3 + 1.5 * iqr);
      const grp = s('g', { class: 'ch-box' });
      if (v.length < 5) {
        for (const x of v) grp.append(s('circle', { cx: X(x), cy, r: 4, style: `fill:${sr.color}`, class: 'ch-dot' }));
      } else if (violin) {
        const tf = log ? Math.log : (x) => x;
        const tv = v.map(tf);
        const gridPts = Array.from({ length: 40 }, (_, k) => tv[0] + ((tv.at(-1) - tv[0]) * k) / 39);
        const dens = kde(tv, gridPts, silverman(tv));
        const peak = Math.max(...dens) || 1;
        const inv = log ? Math.exp : (x) => x;
        const half = lane / 2;
        const upper = gridPts.map((gp, k) => `${X(inv(gp))},${cy - (dens[k] / peak) * half}`);
        const lower = gridPts.map((gp, k) => `${X(inv(gp))},${cy + (dens[k] / peak) * half}`).reverse();
        grp.append(s('path', { d: `M${upper.join('L')}L${lower.join('L')}Z`, style: `fill:${sr.color}`, 'fill-opacity': 0.3 }));
        grp.append(s('line', { x1: X(q1), x2: X(q3), y1: cy, y2: cy, style: `stroke:${sr.color}`, 'stroke-width': 3, 'stroke-linecap': 'round' }));
        grp.append(s('circle', { cx: X(med), cy, r: 4, style: `fill:${sr.color}`, class: 'ch-dot' }));
      } else {
        grp.append(s('line', { x1: X(loW), x2: X(q1), y1: cy, y2: cy, style: `stroke:${sr.color}`, class: 'ch-whisker' }));
        grp.append(s('line', { x1: X(q3), x2: X(hiW), y1: cy, y2: cy, style: `stroke:${sr.color}`, class: 'ch-whisker' }));
        grp.append(s('rect', { x: X(q1), y: cy - lane / 2 + 1, width: Math.max(2, X(q3) - X(q1)), height: lane - 2, rx: 2, style: `fill:${sr.color}`, 'fill-opacity': 0.28 }));
        grp.append(s('line', { x1: X(med), x2: X(med), y1: cy - lane / 2 + 1, y2: cy + lane / 2 - 1, style: `stroke:${sr.color}`, 'stroke-width': 2.5 }));
        for (const x of v) if (x < loW || x > hiW) grp.append(s('circle', { cx: X(x), cy, r: 2.5, style: `fill:${sr.color}` }));
      }
      const hit = s('rect', { x: m.l, y: cy - lane / 2 - 1, width: width - m.l - m.r, height: lane + 2, fill: 'transparent', class: 'ch-hit' });
      hit.addEventListener('pointermove', (evt) =>
        showTip(evt, {
          title: series.length > 1 ? `${g.label} · ${sr.label}` : g.label,
          rows: [
            { value: f(med), label: 'median', color: sr.color },
            { value: `${f(q1)} – ${f(q3)}`, label: 'middle half' },
            { value: `${f(v[0])} – ${f(v.at(-1))}`, label: 'range' },
            { value: String(v.length), label: v.length === 1 ? 'solve' : 'solves' },
          ],
        })
      );
      hit.addEventListener('pointerleave', hideTip);
      grp.append(hit);
      svg.append(grp);
    });
  });
  return svg;
}

// ---------- heatmaps ----------

/**
 * @param {{rows:Array<{key, label}>, cols:Array<{key, label}>,
 *          cell:(rowKey, colKey)=>({value:number|null, text?:string, tip?:object, href?:string})|null,
 *          scale:{type:'seq'|'div', min:number, max:number, mid?:number},
 *          showValues?:boolean, cellMax?:number, label?:string, colLabelMax?:number}} opts
 */
export function heatmap(width, { rows, cols, cell, scale, showValues = false, cellMax = 44, label = '', colLabelMax = null }) {
  const labelW = Math.min(width * 0.35, Math.max(...rows.map((r) => approxWidth(r.label, 12))) + 10);
  const size = Math.max(8, Math.min(cellMax, Math.floor((width - labelW - 4) / cols.length)));
  const longest = Math.max(...cols.map((c) => approxWidth(c.label)));
  const rotate = longest > size - 2;
  const headH = rotate ? Math.min(colLabelMax ?? 90, longest * 0.72 + 12) : 18;
  const w = labelW + size * cols.length + 4;
  const h = headH + size * rows.length + 2;
  const svg = svgRoot(Math.min(width, w), h, label);
  svg.setAttribute('viewBox', `0 0 ${Math.min(width, w)} ${h}`);
  cols.forEach((c, k) => {
    const cx = labelW + k * size + size / 2;
    svg.append(
      rotate
        ? s('text', { x: 0, y: 0, transform: `translate(${cx + 3} ${headH - 4}) rotate(-45)`, class: 'ch-tick' }, c.label)
        : s('text', { x: cx, y: headH - 5, 'text-anchor': 'middle', class: 'ch-tick' }, c.label)
    );
  });
  rows.forEach((r, ri) => {
    const y = headH + ri * size;
    svg.append(s('text', { x: labelW - 6, y: y + size / 2 + 4, 'text-anchor': 'end', class: 'ch-cat' }, r.label));
    cols.forEach((c, ci) => {
      const d = cell(r.key, c.key);
      const x = labelW + ci * size;
      const fill = d ? scaleFill(scale, d.value) : 'var(--color-chart-empty)';
      const rect = s('rect', { x: x + 1, y: y + 1, width: size - 2, height: size - 2, rx: 2, style: `fill:${fill}`, class: 'ch-cell' + (d?.href ? ' link' : '') });
      svg.append(rect);
      if (showValues && d?.text && size >= 24 && approxWidth(d.text, 10) < size - 4) {
        svg.append(s('text', { x: x + size / 2, y: y + size / 2 + 4, 'text-anchor': 'middle', class: 'ch-cell-text', style: `fill:${inkOn(fill)}` }, d.text));
      }
      if (d) {
        rect.addEventListener('pointermove', (evt) => showTip(evt, d.tip ?? { title: `${r.label} · ${c.label}`, rows: [{ value: d.text ?? String(d.value) }] }));
        rect.addEventListener('pointerleave', hideTip);
        if (d.href) rect.addEventListener('click', () => (location.href = d.href));
      }
    });
  });
  return svg;
}

/** Monday on or before a YYYY-MM-DD date, as a UTC timestamp. */
const mondayOf = (ms) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * A calendar: a column per week (Monday first), a row per weekday.
 * @param {{from:string, to:string, day:(date:string)=>({value:number|null, tip?:object, href?:string})|null,
 *          scale:object, label?:string}} opts
 */
export function calendarChart(width, { from, to, day, scale, label = '' }) {
  const start = mondayOf(Date.parse(from + 'T00:00:00Z'));
  const end = Date.parse(to + 'T00:00:00Z');
  const weeks = Math.floor((end - start) / (7 * DAY)) + 1;
  const left = 30;
  const top = 16;
  const size = Math.max(7, Math.min(18, Math.floor((width - left) / weeks)));
  const w = left + weeks * size;
  const h = top + 7 * size + 2;
  const svg = svgRoot(Math.min(width, w), h, label);
  ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((d, k) => {
    if (d) svg.append(s('text', { x: left - 6, y: top + k * size + size / 2 + 4, 'text-anchor': 'end', class: 'ch-tick' }, d));
  });
  let lastMonthX = -Infinity;
  for (let wk = 0; wk < weeks; wk++) {
    for (let d = 0; d < 7; d++) {
      const ms = start + (wk * 7 + d) * DAY;
      if (ms > end) break;
      const date = isoDay(ms);
      if (date.endsWith('-01') || (wk === 0 && d === 0)) {
        const x = left + wk * size;
        if (x - lastMonthX > 28) {
          svg.append(s('text', { x, y: 11, class: 'ch-tick' }, new Date(ms).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })));
          lastMonthX = x;
        }
      }
      const info = day(date);
      const fill = info ? scaleFill(scale, info.value) : 'var(--color-chart-empty)';
      const rect = s('rect', { x: left + wk * size + 1, y: top + d * size + 1, width: size - 2, height: size - 2, rx: 2, style: `fill:${fill}`, class: 'ch-cell' + (info?.href ? ' link' : '') });
      rect.addEventListener('pointermove', (evt) => showTip(evt, info?.tip ?? { title: fmt.day(date), rows: [{ value: 'nothing solved' }] }));
      rect.addEventListener('pointerleave', hideTip);
      if (info?.href) rect.addEventListener('click', () => (location.href = info.href));
      svg.append(rect);
    }
  }
  return svg;
}

/**
 * A heatmap shaped like the puzzle.
 * @param {{model:{width:number, height:number, cells:Array<{isBlack:boolean, number:number}>},
 *          value:(i)=>number|null, scale:object, text?:(i)=>string|null, tip?:(i)=>object|null,
 *          maxCell?:number, label?:string}} opts
 */
export function gridHeatmap(width, { model, value, scale, text = null, tip = null, maxCell = 34, label = '' }) {
  const size = Math.max(6, Math.min(maxCell, Math.floor((width - 2) / model.width)));
  const w = size * model.width + 2;
  const h = size * model.height + 2;
  const svg = svgRoot(w, h, label);
  svg.classList.add('ch-grid-svg');
  svg.append(s('rect', { x: 0.5, y: 0.5, width: w - 1, height: h - 1, class: 'ch-grid-frame' }));
  model.cells.forEach((c, i) => {
    const x = 1 + (i % model.width) * size;
    const y = 1 + Math.floor(i / model.width) * size;
    if (c.isBlack) {
      svg.append(s('rect', { x, y, width: size, height: size, class: 'ch-black' }));
      return;
    }
    const v = value(i);
    const fill = scaleFill(scale, v);
    const rect = s('rect', { x, y, width: size, height: size, style: `fill:${fill}`, class: 'ch-square' });
    svg.append(rect);
    if (c.number && size >= 18) svg.append(s('text', { x: x + 2, y: y + 8, class: 'ch-num', style: `fill:${inkOn(fill)}` }, c.number));
    const t = text?.(i);
    if (t && size >= 14) {
      svg.append(s('text', { x: x + size / 2, y: y + size * 0.72, 'text-anchor': 'middle', class: 'ch-letter', style: `fill:${inkOn(fill)};font-size:${Math.round(size * (t.length > 1 ? 0.32 : 0.5))}px` }, t));
    }
    const info = tip?.(i);
    if (info) {
      rect.addEventListener('pointermove', (evt) => showTip(evt, info));
      rect.addEventListener('pointerleave', hideTip);
    }
  });
  return svg;
}

// ---------- dot plot ----------

/**
 * A row per item with its value as a dot on a shared axis (plus optional
 * lighter dots for `values`, e.g. every solve behind a median).
 * @param {{rows:Array<{key, label, color, value:number|null, values?:number[], range?:[number, number], tip?:object, href?:string}>,
 *          fmt?:Function, ticks?:'time'|'number', log?:boolean, label?:string, zero?:boolean}} opts
 */
export function dotPlot(width, { rows, fmt: f = fmt.time, ticks = 'time', log = false, label = '', zero = false }) {
  const all = rows.flatMap((r) => [r.value, ...(r.values ?? []), ...(r.range ?? [])]).filter((v) => Number.isFinite(v) && (!log || v > 0));
  if (!all.length) return null;
  const rowH = 26;
  const labelW = Math.min(width * 0.38, Math.max(...rows.map((r) => approxWidth(r.label, 12))) + 12);
  const m = { l: labelW, r: 16, t: 4, b: 24 };
  const height = m.t + m.b + rows.length * rowH;
  const xa = valueAxis(Math.min(...all), Math.max(...all), { type: log ? 'log' : 'linear', ticks, zero, count: 5 });
  const X = log ? logScale(xa.lo, xa.hi, m.l, width - m.r) : linear(xa.lo, xa.hi, m.l, width - m.r);
  const svg = svgRoot(width, height, label);
  drawFrame(svg, { X, Y: null, xTicks: xa.ticks, yTicks: [], xFmt: f, yFmt: f, m, width, height, vertical: true });
  rows.forEach((r, k) => {
    const cy = m.t + k * rowH + rowH / 2;
    svg.append(s('text', { x: m.l - 8, y: cy + 4, 'text-anchor': 'end', class: 'ch-cat' + (r.strong ? ' strong' : '') }, r.label));
    if (r.range) svg.append(s('line', { x1: X(r.range[0]), x2: X(r.range[1]), y1: cy, y2: cy, style: `stroke:${r.color}`, 'stroke-width': 2, 'stroke-opacity': 0.45, 'stroke-linecap': 'round' }));
    for (const v of r.values ?? []) svg.append(s('circle', { cx: X(v), cy, r: 3, style: `fill:${r.color}`, 'fill-opacity': 0.35 }));
    if (r.value != null) svg.append(s('circle', { cx: X(r.value), cy, r: 5, style: `fill:${r.color}`, class: 'ch-dot' }));
    const hit = s('rect', { x: 0, y: cy - rowH / 2, width, height: rowH, fill: 'transparent', class: 'ch-hit' + (r.href ? ' link' : '') });
    hit.addEventListener('pointermove', (evt) => showTip(evt, r.tip ?? { title: r.label, rows: [{ value: r.value == null ? '—' : f(r.value), color: r.color }] }));
    hit.addEventListener('pointerleave', hideTip);
    if (r.href) hit.addEventListener('click', () => (location.href = r.href));
    svg.append(hit);
  });
  return svg;
}

// ---------- sparkline ----------

/** A tiny trend line with its last point marked. Decorative: values live in the tile. */
export function sparkline(values, { color = 'var(--color-text-muted)', width = 96, height = 24 } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const X = linear(0, v.length - 1, 2, width - 4);
  const Y = linear(lo, hi === lo ? lo + 1 : hi, height - 3, 3);
  const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'sparkline', 'aria-hidden': 'true' });
  svg.append(s('path', { d: `M${v.map((y, k) => `${X(k)},${Y(y)}`).join('L')}`, fill: 'none', style: `stroke:${color}`, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  svg.append(s('circle', { cx: X(v.length - 1), cy: Y(v.at(-1)), r: 2.5, style: `fill:${color}` }));
  return svg;
}

/*
 * stats-math.js — the statistics behind the stats pages. Pure, no DOM,
 * no dependencies. Functions skip nothing: callers pass finite numbers.
 * Where a result needs more data than it has, it returns null rather than
 * a misleading number.
 */

export const sum = (xs) => xs.reduce((s, x) => s + x, 0);

export const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);

const asc = (a, b) => a - b;

/** Linear-interpolated quantile of *sorted* values (R type 7, numpy's default). */
export function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const quantile = (xs, q) => quantileSorted([...xs].sort(asc), q);

export const median = (xs) => quantile(xs, 0.5);

/** Sample variance (n - 1). */
export function variance(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}

export const sd = (xs) => {
  const v = variance(xs);
  return v == null ? null : Math.sqrt(v);
};

export function geometricMean(xs) {
  if (!xs.length || xs.some((x) => x <= 0)) return null;
  return Math.exp(mean(xs.map(Math.log)));
}

/** The usual summary: count, spread, percentiles. */
export function describe(xs) {
  const s = [...xs].sort(asc);
  const n = s.length;
  if (!n) return { n: 0 };
  const q = (p) => quantileSorted(s, p);
  const m = mean(s);
  const dev = sd(s);
  const med = q(0.5);
  return {
    n,
    min: s[0],
    p10: q(0.1),
    p25: q(0.25),
    median: med,
    p75: q(0.75),
    p90: q(0.9),
    max: s[n - 1],
    mean: m,
    sd: dev,
    iqr: q(0.75) - q(0.25),
    mad: median(s.map((x) => Math.abs(x - med))),
    cv: dev != null && m ? dev / m : null,
  };
}

/** Values outside 1.5 IQR of the quartiles (Tukey's fences). */
export function tukeyFences(xs) {
  const s = [...xs].sort(asc);
  const q1 = quantileSorted(s, 0.25);
  const q3 = quantileSorted(s, 0.75);
  const k = 1.5 * (q3 - q1);
  return { lo: q1 - k, hi: q3 + k };
}

// ---------- scales and bins ----------

/** A 1, 2 or 5 times a power of ten close to `x`. */
export function niceStep(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

/** Round ticks spanning [min, max], about `count` of them. */
export function niceTicks(min, max, count = 5, step = null) {
  if (!(max > min)) return [min];
  step ??= niceStep((max - min) / Math.max(1, count));
  const start = Math.ceil(min / step - 1e-9) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

/** Ticks for durations in seconds: whole 5/10/15/30 s, 1/2/5/10/15/30 min, hours. */
export function timeTicks(min, max, count = 5) {
  const span = (max - min) / Math.max(1, count);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find((s) => s >= span) ?? niceStep(span / 3600) * 3600;
  return niceTicks(min, max, count, step);
}

/**
 * Histogram bins by the Freedman–Diaconis rule (falls back to Sturges when
 * the IQR is 0), snapped to a round width.
 * @returns {Array<{x0:number, x1:number, count:number}>}
 */
export function histogram(xs, { width = null, maxBins = 40 } = {}) {
  if (!xs.length) return [];
  const s = [...xs].sort(asc);
  const lo = s[0];
  const hi = s[s.length - 1];
  if (hi === lo) return [{ x0: lo, x1: lo + 1, count: s.length }];
  if (width == null) {
    const iqr = quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
    const fd = 2 * iqr * s.length ** (-1 / 3);
    const raw = fd > 0 ? fd : (hi - lo) / (Math.ceil(Math.log2(s.length)) + 1);
    width = niceStep(Math.max(raw, (hi - lo) / maxBins));
  }
  const start = Math.floor(lo / width) * width;
  const nb = Math.max(1, Math.ceil((hi - start) / width + 1e-9));
  const bins = Array.from({ length: nb }, (_, k) => ({ x0: start + k * width, x1: start + (k + 1) * width, count: 0 }));
  for (const x of s) bins[Math.min(nb - 1, Math.floor((x - start) / width))].count++;
  return bins;
}

/** Silverman's rule-of-thumb bandwidth. */
export function silverman(xs) {
  const d = describe(xs);
  if (d.n < 2) return 1;
  const spread = Math.min(d.sd, d.iqr / 1.34) || d.sd || 1;
  return 0.9 * spread * d.n ** (-1 / 5);
}

/** Gaussian kernel density at each point of `grid`. */
export function kde(xs, grid, bandwidth = silverman(xs)) {
  const h = bandwidth || 1;
  const c = 1 / (xs.length * h * Math.sqrt(2 * Math.PI));
  return grid.map((g) => c * sum(xs.map((x) => Math.exp(-0.5 * ((g - x) / h) ** 2))));
}

// ---------- relationships ----------

/** Ordinary least squares y = a + b·x, with R² and the slope's standard error. */
export function ols(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const sse = syy - slope * sxy;
  const r2 = syy ? 1 - sse / syy : 0;
  const se = n > 2 ? Math.sqrt(Math.max(0, sse) / (n - 2) / sxx) : null;
  return { slope, intercept, r2, se, n };
}

/** Theil–Sen: the median of pairwise slopes, robust to outliers. */
export function theilSen(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const slopes = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  return { slope, intercept: median(ys.map((y, i) => y - slope * xs[i])), n };
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** 1-based ranks, ties getting the average of their ranks. */
export function ranks(xs) {
  const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  for (let k = 0; k < order.length; ) {
    let j = k;
    while (j + 1 < order.length && order[j + 1][0] === order[k][0]) j++;
    const r = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) out[order[m][1]] = r;
    k = j + 1;
  }
  return out;
}

export const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

/** Two-sided p-value for a correlation r over n points (t distribution, approximated). */
export function correlationP(r, n) {
  if (r == null || n < 4) return null;
  if (Math.abs(r) >= 1) return 0;
  const t = (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r);
  return 2 * (1 - studentTCdf(Math.abs(t), n - 2));
}

// ---------- smoothing ----------

/** Median of the last `window` values at each point (fewer at the start). */
export function rollingMedian(values, window = 10) {
  return values.map((_, i) => median(values.slice(Math.max(0, i - window + 1), i + 1)));
}

export function rollingMean(values, window = 10) {
  return values.map((_, i) => mean(values.slice(Math.max(0, i - window + 1), i + 1)));
}

/** Exponentially weighted moving average. */
export function ewma(values, alpha = 0.2) {
  const out = [];
  let s = null;
  for (const v of values) {
    s = s == null ? v : alpha * v + (1 - alpha) * s;
    out.push(s);
  }
  return out;
}

// ---------- probability ----------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 for erf; error < 1.5e-7). */
export function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function logGamma(x) {
  // Lanczos approximation (g = 7)
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized incomplete beta I_x(a, b), by continued fraction. */
function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
  // Lentz's algorithm
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = i >> 1;
    let num;
    if (i === 0) num = 1;
    else if (i % 2 === 0) num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  return (front * (f - 1)) / a;
}

/** Student's t CDF. */
export function studentTCdf(t, df) {
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Wilson score interval for a proportion k/n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Wilcoxon signed-rank test on paired differences (zeros dropped), with
 * the normal approximation (tie- and continuity-corrected). Two-sided.
 * Below 6 non-zero pairs there's no meaningful p: `p` is null.
 */
export function wilcoxonSignedRank(diffs) {
  const d = diffs.filter((x) => x !== 0);
  const n = d.length;
  const r = ranks(d.map(Math.abs));
  let wPlus = 0;
  for (let i = 0; i < n; i++) if (d[i] > 0) wPlus += r[i];
  const wMinus = (n * (n + 1)) / 2 - wPlus;
  if (n < 6) return { n, wPlus, wMinus, z: null, p: null };
  const counts = new Map();
  for (const x of r) counts.set(x, (counts.get(x) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) tie += t ** 3 - t;
  const mu = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tie / 48);
  const z = sigma ? (wPlus - mu - Math.sign(wPlus - mu) * 0.5) / sigma : 0;
  return { n, wPlus, wMinus, z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

/** Exact two-sided binomial sign test: is `wins` of `wins + losses` far from half? */
export function signTest(wins, losses) {
  const n = wins + losses;
  if (!n) return { n, p: null };
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { n, p: Math.min(1, 2 * tail) };
}

function logChoose(n, k) {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

// ---------- resampling ----------

/** Deterministic PRNG, so a chart's intervals don't wobble between renders. */
export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap: `stat(indexes)` is recomputed on resampled row
 * indexes. Returns the (alpha/2, 1 - alpha/2) interval, or null if too few.
 */
export function bootstrap(n, stat, { reps = 1000, alpha = 0.05, seed = 7 } = {}) {
  if (n < 3) return null;
  const rand = mulberry32(seed);
  const out = [];
  const idx = new Array(n);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rand() * n);
    const v = stat(idx);
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  if (out.length < reps / 2) return null;
  out.sort(asc);
  return { lo: quantileSorted(out, alpha / 2), hi: quantileSorted(out, 1 - alpha / 2) };
}

/** Percent of `sorted` below x (ties count half). */
export function percentileRank(sorted, x) {
  if (!sorted.length) return null;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return ((below + equal / 2) / sorted.length) * 100;
}

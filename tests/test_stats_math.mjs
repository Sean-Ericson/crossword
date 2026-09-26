/* Unit tests for js/stats-math.js. Expected values come from numpy/scipy. */
import assert from 'node:assert/strict';
import {
  describe, quantile, sd, histogram, kde, ols, theilSen, pearson, spearman, ranks, correlationP,
  rollingMedian, ewma, normalCdf, studentTCdf, wilson, wilcoxonSignedRank, signTest, bootstrap,
  percentileRank, niceTicks, timeTicks, geometricMean, tukeyFences,
} from '../js/stats-math.js';

const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);

const X = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4];
const Y = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8, 4, 5, 9, 0, 4, 5, 2, 3, 5, 3];

test('math: quantiles and spread match numpy', () => {
  const d = describe(X);
  close(d.p10, 1.9);
  close(d.p25, 3);
  close(d.median, 4.5);
  close(d.p75, 7.25);
  close(d.p90, 9);
  close(d.sd, 2.7003898354048617);
  close(sd(X), d.sd);
  assert.equal(d.n, 20);
  assert.equal(describe([]).n, 0);
  close(quantile([5], 0.9), 5);
  close(geometricMean([1, 100]), 10);
  assert.deepEqual(tukeyFences([1, 2, 3, 4]), { lo: 1.75 - 1.5 * 1.5, hi: 3.25 + 1.5 * 1.5 });
});

test('math: correlation and regression match scipy', () => {
  close(pearson(X, Y), 0.18036990753894183);
  close(spearman(X, Y), 0.19073187020980284);
  close(correlationP(0.18036990753894183, 20), 0.44667269853994174, 1e-4);
  const fit = ols(X, Y);
  close(fit.slope, 0.18801876578852403);
  close(fit.intercept, 3.438108985925658);
  close(fit.r2, 0.03253330354560645);
  close(fit.se, 0.2416678477397098);
  close(theilSen(X, Y).slope, 0.2);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null, 'no variance, no correlation');
  assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
});

test('math: distributions and tests match scipy', () => {
  close(normalCdf(1.96), 0.9750021048517795, 2e-7);
  close(normalCdf(-0.5), 0.3085375387259869, 2e-7);
  close(studentTCdf(2.228, 10), 0.9749941140914443, 1e-6);
  close(studentTCdf(-1.5, 3), 0.11529193262241147, 1e-6);
  close(studentTCdf(0.7, 40), 0.7560106106196991, 1e-6);
  const w = wilcoxonSignedRank([1.5, -0.5, 2.1, 3.3, -1.2, 0.8, 2.2, 1.1, -0.3, 1.9]);
  assert.equal(w.wMinus, 8);
  close(w.p, 0.052787000632224565, 1e-5);
  assert.equal(wilcoxonSignedRank([1, 2, -1]).p, null, 'too few pairs');
  close(signTest(8, 2).p, 0.109375, 1e-9);
  close(signTest(2, 10).p, 0.03857421875, 1e-9);
  const ci = wilson(5, 10);
  close(ci.p, 0.5);
  assert.ok(ci.lo > 0.2 && ci.hi < 0.8);
});

test('math: histogram, density, smoothing, ticks', () => {
  const bins = histogram(X);
  assert.equal(bins.reduce((s, b) => s + b.count, 0), X.length);
  assert.ok(bins[0].x0 <= 1 && bins.at(-1).x1 > 9);
  const dens = kde([0], [-1, 0, 1], 1);
  close(dens[1], 1 / Math.sqrt(2 * Math.PI));
  close(dens[0], dens[2]);
  assert.deepEqual(rollingMedian([5, 1, 3, 10], 3), [5, 3, 3, 3]);
  assert.deepEqual(ewma([10, 0], 0.5), [10, 5]);
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(timeTicks(0, 600, 4), [0, 300, 600]);
  close(percentileRank([1, 2, 3, 4], 3), 62.5);
});

test('math: bootstrap is reproducible and brackets the estimate', () => {
  const xs = X.map((x, i) => x + i / 10);
  const stat = (idx) => idx.reduce((s, i) => s + xs[i], 0) / idx.length;
  const a = bootstrap(xs.length, stat, { seed: 3 });
  const b = bootstrap(xs.length, stat, { seed: 3 });
  assert.deepEqual(a, b);
  const m = stat(xs.map((_, i) => i));
  assert.ok(a.lo < m && m < a.hi);
  assert.equal(bootstrap(2, stat), null);
});

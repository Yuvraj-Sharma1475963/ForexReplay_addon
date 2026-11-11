// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanLiquidity, LiquidityEngine } from "../js/liquidity.js";

const HOUR = 3600;
// Monday 6 July 2026 on the server clock starts at 17:00 New York on Sunday = 21:00 UTC (summer time).
const MONDAY = Date.UTC(2026, 6, 5, 21) / 1000;
const OPTS = { barSeconds: HOUR, pipPoints: 10 };

/** Hourly candles from [high, low] pairs (open and close in the middle), with full-size arrays. */
function bars(pairs, start = MONDAY) {
  const n = pairs.length;
  const c = { open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), time: new Float64Array(n), length: n };
  pairs.forEach(([h, l], i) => {
    c.high[i] = h; c.low[i] = l; c.open[i] = c.close[i] = Math.round((h + l) / 2); c.time[i] = start + i * HOUR;
  });
  return c;
}

/** Random-walk hourly candles over several weeks. */
function walk(n, seed = 7) {
  let x = seed;
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const pairs = [];
  let p = 116000;
  for (let i = 0; i < n; i++) {
    const move = Math.round((rnd() - 0.5) * 60);
    pairs.push([Math.max(p, p + move) + Math.round(rnd() * 20), Math.min(p, p + move) - Math.round(rnd() * 20)]);
    p += move;
  }
  return bars(pairs);
}

const all = cleanLiquidity({ day: { on: true }, week: { on: true }, asia: { on: true }, equal: { on: true, pips: 1.5, length: 3 } });
const prefix = (c, n) => ({ ...c, length: n });
const find = (levels, kind) => levels.filter((l) => l.kind === kind);

test("a replay step by step equals working everything out again", () => {
  const full = walk(2000);
  const view = prefix(full, 100);
  const engine = new LiquidityEngine();
  engine.compute(view, all, OPTS);
  for (let n = 101; n <= 2000; n++) {
    view.length = n;
    const step = engine.compute(view, all, OPTS, n - 2);
    if (n % 50 === 0) assert.deepEqual(step, new LiquidityEngine().compute(prefix(full, n), all, OPTS), `after ${n} candles`);
  }
  view.length = 1500; // back
  assert.deepEqual(engine.compute(view, all, OPTS, 1499), new LiquidityEngine().compute(prefix(full, 1500), all, OPTS));
});

test("no look-ahead: hidden candles change nothing", () => {
  const a = walk(1500, 7), b = walk(1500, 99);
  for (const k of ["open", "high", "low", "close"]) b[k].set(a[k].subarray(0, 900));
  assert.deepEqual(new LiquidityEngine().compute(prefix(a, 900), all, OPTS), new LiquidityEngine().compute(prefix(b, 900), all, OPTS));
});

test("yesterday's high and low become today's levels; a wick through the high sweeps it", () => {
  const day1 = Array.from({ length: 24 }, (_, i) => (i === 5 ? [110150, 110000] : i === 9 ? [110100, 109950] : [110100, 110000]));
  const day2 = Array.from({ length: 10 }, (_, i) => (i === 6 ? [110160, 110040] : [110080, 110040]));
  const levels = new LiquidityEngine().compute(bars([...day1, ...day2]), cleanLiquidity({ day: { on: true } }), OPTS);
  const [pdh] = find(levels, "pdh"), [pdl] = find(levels, "pdl");
  assert.deepEqual({ price: pdh.price, from: pdh.from, to: pdh.to, swept: pdh.swept }, { price: 110150, from: 24, to: 30, swept: true });
  assert.deepEqual({ price: pdl.price, from: pdl.from, to: pdl.to, swept: pdl.swept }, { price: 109950, from: 24, to: null, swept: false });
});

test("a day level that is not swept ends with its day", () => {
  const flat = (n) => Array.from({ length: n }, () => [110100, 110000]);
  const levels = new LiquidityEngine().compute(bars([...flat(24), ...flat(24), ...flat(3)]), cleanLiquidity({ day: { on: true } }), OPTS);
  const highs = find(levels, "pdh");
  assert.equal(highs.length, 2);
  assert.deepEqual([highs[0].from, highs[0].to, highs[0].swept], [24, 47, false]); // equal is not through
  assert.deepEqual([highs[1].from, highs[1].to], [48, null]);
});

test("the Asia range is put up when the session closes, and not on H4", () => {
  // Candle 3 is 00:00 UTC (Tokyo 09:00); candles 3..11 are the session, candle 12 (09:00 UTC) the first after it.
  const pairs = Array.from({ length: 20 }, (_, i) => (i === 4 ? [110200, 110050] : i === 10 ? [110100, 109900] : [110100, 110050]));
  const levels = new LiquidityEngine().compute(bars(pairs), cleanLiquidity({ asia: { on: true } }), OPTS);
  assert.deepEqual(find(levels, "asiah").map((l) => [l.price, l.from]), [[110200, 12]]);
  assert.deepEqual(find(levels, "asial").map((l) => [l.price, l.from]), [[109900, 12]]);
  assert.deepEqual(new LiquidityEngine().compute(bars(pairs), cleanLiquidity({ asia: { on: true } }), { barSeconds: 4 * HOUR, pipPoints: 10 }), []);
});

test("two swing highs within the tolerance make an equal high, known only after the second is confirmed", () => {
  const up = (a, b, k) => Array.from({ length: k }, (_, i) => { const m = a + ((b - a) * (i + 1)) / k; return [Math.round(m) + 5, Math.round(m) - 5]; });
  const pairs = [...up(110000, 110100, 4), ...up(110100, 110020, 4), ...up(110020, 110108, 4), ...up(110108, 110000, 4)];
  // swing highs at candle 3 (110105) and candle 11 (110113): 0.8 pip apart, nothing above them in between
  const settings = cleanLiquidity({ equal: { on: true, pips: 1.5, length: 3 } });
  const engine = new LiquidityEngine();
  const c = bars(pairs);
  assert.deepEqual(find(engine.compute(prefix(c, 14), settings, OPTS), "eqh"), []); // candle 11 is not a swing high yet
  const [eqh] = find(engine.compute(prefix(c, 15), settings, OPTS, 13), "eqh");
  assert.deepEqual({ price: eqh.price, from: eqh.from, to: eqh.to, count: eqh.count }, { price: 110113, from: 3, to: null, count: 2 });
  const tight = cleanLiquidity({ equal: { on: true, pips: 0.5, length: 3 } });
  assert.deepEqual(find(new LiquidityEngine().compute(c, tight, OPTS), "eqh"), []);
});

test("damaged settings fall back to the defaults", () => {
  assert.deepEqual(cleanLiquidity("nonsense"), cleanLiquidity(null));
  const s = cleanLiquidity({ day: { on: "yes" }, equal: { on: true, pips: -3, length: 1.5 } });
  assert.equal(s.day.on, false);
  assert.deepEqual(s.equal, { on: true, pips: 1.5, length: 5 });
});

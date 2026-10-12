// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { BEARISH, BULLISH, cleanSmc, SmcEngine } from "../js/smc.js";

/** Random-walk candles in whole points, with full-size arrays like a replay's candle list. */
function candles(n, seed = 7) {
  let x = seed;
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const c = { open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), time: new Float64Array(n), length: n };
  let p = 116000;
  for (let i = 0; i < n; i++) {
    const move = Math.round((rnd() - 0.5) * 60 + (rnd() < 0.02 ? (rnd() - 0.5) * 400 : 0));
    c.open[i] = p; c.close[i] = p + move;
    c.high[i] = Math.max(p, p + move) + Math.round(rnd() * 20);
    c.low[i] = Math.min(p, p + move) - Math.round(rnd() * 20);
    c.time[i] = 1.7e9 + i * 900;
    p += move;
  }
  return c;
}
const all = cleanSmc({ internalOb: { on: true, count: 20 }, swingOb: { on: true, count: 20 }, fvg: { on: true } });
const prefix = (c, n) => ({ ...c, length: n });
const grow = (a, v) => { const b = new Float64Array(a.length + 1); b.set(a); b[a.length] = v; return b; };

test("a replay step by step equals working everything out again", () => {
  const full = candles(3000);
  const view = prefix(full, 300);
  const engine = new SmcEngine();
  engine.compute(view, all);
  for (let n = 301; n <= 3000; n++) {
    view.length = n;
    const step = engine.compute(view, all, n - 2);
    if (n % 50 === 0) assert.deepEqual(step, new SmcEngine().compute(prefix(full, n), all), `after ${n} candles`);
  }
  view.length = 2000; // back
  assert.deepEqual(engine.compute(view, all, 1999), new SmcEngine().compute(prefix(full, 2000), all));
});

test("no look-ahead: hidden candles change nothing", () => {
  const a = candles(4000, 7), b = candles(4000, 99);
  for (const k of ["open", "high", "low", "close"]) b[k].set(a[k].subarray(0, 2500));
  assert.deepEqual(new SmcEngine().compute(prefix(a, 2500), all), new SmcEngine().compute(prefix(b, 2500), all));
});

test("order blocks come from breaks of structure, newest first, and only as many as asked for", () => {
  const c = candles(6000);
  const r = new SmcEngine().compute(c, all);
  assert.ok(r.internalObs.length > 0 && r.swingObs.length > 0);
  for (const list of [r.internalObs, r.swingObs]) {
    for (let k = 1; k < list.length; k++) assert.ok(list[k - 1].index >= list[k].index, "newest first");
    for (const ob of list) assert.ok([BULLISH, BEARISH].includes(ob.bias) && ob.index >= 0 && ob.index < c.length);
  }
  assert.equal(new SmcEngine().compute(c, cleanSmc({ internalOb: { on: true, count: 3 } })).internalObs.length, 3);
});

test("a fair value gap: candle 3's low above candle 1's high, and filled by a later low", () => {
  const n = 12;
  const c = { open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), time: new Float64Array(n), length: n };
  const bar = (i, o, h, l, cl) => { c.open[i] = o; c.high[i] = h; c.low[i] = l; c.close[i] = cl; c.time[i] = i * 300; };
  for (let i = 0; i < 9; i++) bar(i, 1000, 1002, 998, 1000);
  bar(9, 1000, 1003, 999, 1001);
  bar(10, 1001, 1060, 1000, 1058); // a big up candle
  bar(11, 1058, 1070, 1030, 1065); // its low (1030) is above candle 9's high (1003)
  const set = cleanSmc({ fvg: { on: true, auto: false, extend: 1 } });
  const r = new SmcEngine().compute(c, set);
  assert.deepEqual(r.fvgs, [{ top: 1030, bottom: 1003, left: 10, right: 12, bias: BULLISH }]);
  const filled = { ...c, length: 13, open: grow(c.open, 1065), high: grow(c.high, 1066), low: grow(c.low, 1000), close: grow(c.close, 1006), time: grow(c.time, 3900) };
  assert.deepEqual(new SmcEngine().compute(filled, set).fvgs, []);
});

test("settings: damaged values fall back to the defaults", () => {
  const s = cleanSmc({ internalOb: { on: "yes", count: 99 }, swingOb: { on: true, length: 3 }, fvg: { extend: -1 }, mitigation: "x" });
  assert.equal(s.internalOb.on, false);
  assert.equal(s.internalOb.count, 5);
  assert.equal(s.swingOb.on, true);
  assert.equal(s.swingOb.length, 50);
  assert.equal(s.fvg.extend, 1);
  assert.equal(s.mitigation, "highlow");
});

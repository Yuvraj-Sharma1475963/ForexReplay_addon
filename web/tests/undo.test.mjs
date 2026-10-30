// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { actionsWithout, BacktestError, rebuild, snapshot, UNDO_LIMIT, undoLastTrade } from "../js/backtest.js";
import { Outcome } from "../js/challenge.js";
import { Candles } from "../js/data.js";
import { DrawingStore } from "../js/drawings.js";
import { ReplayClock } from "../js/replay.js";
import { Side, Status, Trading } from "../js/trading.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const ENV = { pipPoints: 10, pointValue: 1 };
// $10,000, 1.00 lot, no commission: one point is one dollar.
const SETTINGS = { startingBalance: 10000, commissionPerLot: 0, sizeMode: "lots", fixedLots: 1 };

/** Flat candles at 110000; `moves` = { index: [o, h, l, c] }. */
function market(n, moves = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [o, h, l, c] = moves[i] || [110000, 110000, 110000, 110000];
    rows.push([utc("2025-08-04T07:00") + i * 300, o, h, l, c, 10, 0]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

function setup(m5, challenge = null) {
  const clock = new ReplayClock(m5.length);
  const trading = new Trading({ m5, clock, ...ENV, settings: SETTINGS, challenge });
  clock.start(5);
  trading.reset();
  return { clock, trading, startTime: m5.time[4] };
}
const buy = (t, stop, target) => t.place({ side: Side.BUY, type: "market", stopLoss: t.ask - stop, takeProfit: t.ask + target });
const undo = (s, m5) => undoLastTrade(s.trading, { m5, ...ENV, startTime: s.startTime });

test("the action log without one trade: its order and every action about it", () => {
  const actions = [
    { kind: "place", at: 1 }, { kind: "place", at: 2 }, { kind: "modify", id: 2, at: 3 }, { kind: "settings", at: 3 },
    { kind: "close", id: 1, at: 4 }, { kind: "partial", id: 2, at: 5 }, { kind: "closeAll", at: 6 },
  ];
  assert.deepEqual(actionsWithout(actions, 2).map((a) => `${a.kind}@${a.at}`), ["place@1", "settings@3", "close@4", "closeAll@6"]);
  assert.equal(UNDO_LIMIT, 1);
});

test("undo takes back the last trade as if it was never placed; the earlier one is untouched; once only", () => {
  const m5 = market(40, { 8: [110000, 110300, 110000, 110200], 14: [110200, 110200, 109900, 110000] });
  const s = setup(m5);
  buy(s.trading, 500, 300); // #1: wins $300 at candle 8
  s.clock.advance(5);
  buy(s.trading, 100, 1000); // #2, the mistake: stopped out at candle 14 for -$100
  s.trading.modifyTrade(2, { takeProfit: s.trading.ask + 900 });
  s.clock.advance(8);
  assert.equal(s.trading.balance, 10200);

  const { trading: again, removed, problems } = undo(s, m5);
  assert.deepEqual(problems, []);
  assert.deepEqual([removed.id, removed.side, removed.status, removed.resultR], [2, "BUY", Status.CLOSED, -1]);
  s.trading.adopt(again);
  assert.equal(s.trading.balance, 10300); // as if #2 never was
  assert.deepEqual(s.trading.broker.trades.map((t) => [t.id, t.status, t.resultR]), [[1, Status.CLOSED, 0.6]]);
  assert.equal(s.trading.actions.length, 1);
  assert.equal(s.clock.position, 18, "nothing is rewound");

  buy(s.trading, 100, 100); // the run carries on: the next trade takes the free id
  assert.equal(s.trading.broker.trades.at(-1).id, 2);
  assert.throws(() => undo(s, m5), (err) => err instanceof BacktestError && /used its 1 undo/.test(err.message));
});

test("a saved run keeps its undo through a rebuild, so it cannot be used again", () => {
  const m5 = market(30);
  const s = setup(m5);
  buy(s.trading, 100, 100);
  s.clock.advance(2);
  s.trading.adopt(undo(s, m5).trading);
  buy(s.trading, 100, 100);
  s.clock.advance(2);
  const meta = { id: "bt-undo", name: "undo", journal: "test_journal", created: "now", startTime: s.startTime };
  const saved = JSON.parse(JSON.stringify(snapshot(meta, { trading: s.trading, drawings: new DrawingStore(), m5, clock: s.clock, manifest: { symbol: "EURUSD", digits: 5, pip_points: 10 }, timeframe: "M15" })));
  assert.equal(saved.result.undos, 1);
  assert.equal(saved.undos[0].id, 1);
  const { trading: again, problems } = rebuild(saved, { m5, ...ENV });
  assert.deepEqual(problems, []);
  assert.equal(again.undos.length, 1);
  assert.equal(again.broker.trades.length, 1);
});

test("a challenge failed by the mistaken trade is running again after the undo", () => {
  const m5 = market(30, { 10: [110000, 110000, 109300, 109500] }); // -$700 at the low: over a 5% ($500) daily limit
  const s = setup(m5, { enabled: true, targetPercent: 8, dailyPercent: 5, maxPercent: 10 });
  buy(s.trading, 1000, 1000);
  s.clock.advance(8);
  assert.equal(s.trading.challenge.outcome, Outcome.FAILED);
  assert.ok(s.trading.blockedReason);
  s.trading.adopt(undo(s, m5).trading);
  assert.equal(s.trading.challenge.outcome, Outcome.RUNNING);
  assert.equal(s.trading.blockedReason, null);
  assert.equal(s.trading.balance, 10000);
});

test("nothing to undo before the first trade", () => {
  const m5 = market(10);
  const s = setup(m5);
  assert.throws(() => undo(s, m5), /no trade to undo/);
});

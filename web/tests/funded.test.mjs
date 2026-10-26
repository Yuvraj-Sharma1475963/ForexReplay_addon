// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { rebuild, snapshot } from "../js/backtest.js";
import { cleanRules, Outcome, PRESETS } from "../js/challenge.js";
import { Candles } from "../js/data.js";
import { DrawingStore } from "../js/drawings.js";
import { cleanFundedRules, DEFAULT_FUNDED } from "../js/funded.js";
import { ReplayClock } from "../js/replay.js";
import { InvalidOrder, Side, Trading } from "../js/trading.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const DAY = 288; // M5 candles in a day
// $5,000, 1.00 lot and no commission, so one point is exactly one dollar.
const SETTINGS = { startingBalance: 5000, commissionPerLot: 0, sizeMode: "lots", fixedLots: 1 };
const FUNDED = { ...DEFAULT_FUNDED }; // daily 3% ($150), max 6% (floor $4,700), 90% split, 14 days, 5 trading days, 1:30

/** Flat candles at 110000 for `days` days, with a candle reaching 110100 (a +$100 target) at each index in `ups`. */
function market(days, ups = [], downs = {}) {
  const rows = [];
  for (let i = 0; i < days * DAY; i++) {
    let [o, h, l, c] = [110000, 110000, 110000, 110000];
    if (ups.includes(i)) h = 110100;
    if (downs[i]) l = downs[i];
    rows.push([utc("2025-08-04T00:00") + i * 300, o, h, l, c, 10, 0]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

function setup(m5, rules = FUNDED, settings = SETTINGS) {
  const clock = new ReplayClock(m5.length);
  const trading = new Trading({ m5, clock, settings, challenge: rules });
  clock.start(6);
  trading.reset(); // what the app does when a replay starts
  return { clock, trading };
}

/** Go to candle `i` (revealed and live). */
const goTo = (clock, i) => clock.advance(i + 1 - clock.position);
const buyForHundred = (trading) =>
  trading.place({ side: Side.BUY, type: "market", stopLoss: trading.ask - 100, takeProfit: trading.ask + 100 });

/** Win $100 on each of `days` (a buy at candle 10 of the day, its target reached at candle 11). */
function winOn(trading, clock, days) {
  for (const d of days) {
    goTo(clock, d * DAY + 10);
    buyForHundred(trading);
    goTo(clock, d * DAY + 12);
  }
}

test("the funded rules: defaults, and damaged values replaced", () => {
  const r = cleanFundedRules({ dailyPercent: "x", splitPercent: 80, cycleDays: 7.4, leverage: -3 });
  assert.deepEqual([r.dailyPercent, r.maxPercent, r.splitPercent, r.cycleDays, r.minTradingDays, r.leverage], [3, 6, 80, 7, 5, 30]);
  assert.equal(r.kind, "funded");
  const p = PRESETS.oneStep5k; // the Phase 1 the trader asked for
  assert.deepEqual([p.targetPercent, p.dailyPercent, p.maxPercent, p.fee, p.leverage, p.startingBalance], [10, 3, 6, 59, 30, 5000]);
  assert.equal(5000 * p.maxPercent / 100, 300); // the $300 max loss
  assert.deepEqual([cleanRules({ fee: 59, leverage: 30 }).fee, cleanRules({}).leverage], [59, 0]);
});

test("a payout only when the cycle, the trading days, a flat account and a profit allow it", () => {
  const ups = [0, 1, 2, 3, 4, 5, 15].map((d) => d * DAY + 11);
  const m5 = market(31, ups);
  const { clock, trading } = setup(m5);
  const f = trading.funded;
  assert.equal(f.floor, 4700);
  winOn(trading, clock, [0, 1, 2, 3, 4, 5]); // six winning days: $5,600
  assert.equal(trading.balance, 5600);

  goTo(clock, 7 * DAY);
  assert.throws(() => trading.requestPayout(), /7 more days/);

  goTo(clock, 14 * DAY + 20);
  trading.place({ side: Side.BUY, type: "market", stopLoss: trading.ask - 50, takeProfit: trading.ask + 500 });
  assert.throws(() => trading.requestPayout(), /Close your open trades and cancel waiting orders/); // waiting to fill
  goTo(clock, 14 * DAY + 21);
  assert.throws(() => trading.requestPayout(), /Close your open trades/); // filled: open
  trading.closeTrade(7); // flat (the trade made nothing: the price has not moved)

  const p = trading.requestPayout();
  assert.deepEqual(p, { time: m5.time[14 * DAY + 21], amount: 600, toYou: 540, toFirm: 60 });
  assert.equal(trading.balance, 5000); // back to the start; the floor stays at $4,700
  goTo(clock, 14 * DAY + 40);
  assert.equal(f.outcome, Outcome.RUNNING, "taking $600 out is not a $600 daily loss");
  assert.deepEqual(f.totals(), { payouts: 1, withdrawn: 600, toYou: 540, toFirm: 60 });

  // The next cycle: 14 more days, but only one winning day in it.
  winOn(trading, clock, [15]);
  goTo(clock, 28 * DAY + 30);
  assert.throws(() => trading.requestPayout(), /4 more trading days/);
  assert.equal(trading.actions.filter((a) => a.kind === "payout").length, 1);
});

test("an account lost after a payout says how much it paid", () => {
  const ups = [0, 1, 2, 3, 4].map((d) => d * DAY + 11);
  const crash = 15 * DAY + 11;
  const m5 = market(17, ups, { [crash]: 109800 }); // a $200 drop: over the $150 daily limit
  const { clock, trading } = setup(m5);
  winOn(trading, clock, [0, 1, 2, 3, 4]);
  goTo(clock, 14 * DAY + 5);
  trading.requestPayout(); // $500, $450 to you
  goTo(clock, crash - 1);
  trading.place({ side: Side.BUY, type: "market", stopLoss: trading.ask - 1000, takeProfit: trading.ask + 1000 });
  goTo(clock, crash);
  assert.equal(trading.funded.outcome, Outcome.FAILED);
  assert.match(trading.blockedReason, /Funded account lost: daily loss limit \(3%\) broken, after 1 payout \(\$450\.00 to you\)/);
  assert.throws(() => trading.requestPayout(), InvalidOrder);
});

test("leverage 1:30: an order needing more margin than is free is refused", () => {
  const m5 = market(2);
  const { trading } = setup(m5, FUNDED, { ...SETTINGS, fixedLots: 1.4 }); // 1.4 lots at 1.10000 need $5,133.33
  assert.throws(() => buyForHundred(trading), /Not enough margin at 1:30: this order needs \$5,133\.33, free margin is \$5,000\.00/);
  trading.updateSettings({ fixedLots: 1 }); // $3,666.67
  buyForHundred(trading);
  trading.updateSettings({ fixedLots: 0.5 }); // $1,833.33 more, but only $1,333.33 is free
  assert.throws(() => buyForHundred(trading), /free margin is \$1,333\.33/);
  const noLimit = setup(market(2), { ...FUNDED, leverage: 0 }, { ...SETTINGS, fixedLots: 5 }).trading;
  buyForHundred(noLimit); // leverage 0: no check
});

test("a funded run saved and rebuilt pays out on the same candle, for the same amount", () => {
  const ups = [0, 1, 2, 3, 4, 5].map((d) => d * DAY + 11);
  const m5 = market(16, ups);
  const { clock, trading } = setup(m5);
  winOn(trading, clock, [0, 1, 2, 3, 4, 5]);
  goTo(clock, 14 * DAY + 9);
  trading.requestPayout();
  goTo(clock, 15 * DAY);
  const meta = { id: "bt-funded", name: "funded", journal: "test_journal", created: "now", startTime: m5.time[5], stage: "funded" };
  const saved = JSON.parse(JSON.stringify(snapshot(meta, { trading, drawings: new DrawingStore(), m5, clock, manifest: { symbol: "EURUSD", digits: 5, pip_points: 10 }, timeframe: "M15" })));
  assert.deepEqual(saved.result.funded, { payouts: 1, withdrawn: 600, toYou: 540, toFirm: 60 });
  assert.equal(saved.result.stage, "funded");
  assert.equal(saved.challenge.kind, "funded");
  const { trading: again, problems } = rebuild(saved, { m5, pipPoints: 10, pointValue: 1 });
  assert.deepEqual(problems, []);
  assert.equal(again.balance, 5000);
  assert.deepEqual(again.funded.totals(), saved.result.funded);
});

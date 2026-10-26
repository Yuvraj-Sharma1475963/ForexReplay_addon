// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { Challenge, cleanRules, Outcome, serverDay } from "../js/challenge.js";
import { Candles } from "../js/data.js";
import { ReplayClock } from "../js/replay.js";
import { InvalidOrder, Side, Status, Trading } from "../js/trading.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
// 1.00 lot and no commission, so one point is exactly one dollar.
const SETTINGS = { startingBalance: 10000, commissionPerLot: 0, sizeMode: "lots", fixedLots: 1 };
const RULES = { enabled: true, targetPercent: 8, dailyPercent: 5, maxPercent: 10 };

/** Flat candles at 110000 from `start`, then whatever `overrides` say: { index: [o, h, l, c, spread] }. */
function market(n, overrides = {}, start = "2025-08-04T07:00") {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [o, h, l, c, spread = 0] = overrides[i] || [110000, 110000, 110000, 110000];
    rows.push([utc(start) + i * 300, o, h, l, c, 10, spread]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

function setup(m5, { rules = RULES, startAt = 5 } = {}) {
  const clock = new ReplayClock(m5.length);
  const trading = new Trading({ m5, clock, settings: SETTINGS, challenge: rules });
  clock.start(startAt);
  trading.reset(); // what the app does when a replay starts
  return { clock, trading };
}

const buy = (trading, stopBelow, targetAbove) =>
  trading.place({ side: Side.BUY, type: "market", stopLoss: trading.ask - stopBelow, takeProfit: trading.ask + targetAbove });

test("a wick through the daily limit fails the challenge even if the candle closes back up", () => {
  const m5 = market(20, { 7: [110000, 110000, 109400, 109990] }); // $600 under water at the low, $10 at the close
  const { clock, trading } = setup(m5);
  const trade = buy(trading, 1000, 2000);
  trading.place({ side: Side.BUY, type: "pending", price: 109000, stopLoss: 108000, takeProfit: 112000 });
  clock.advance(5);
  const c = trading.challenge;
  assert.equal(c.outcome, Outcome.FAILED);
  assert.match(c.reason, /daily loss/);
  assert.equal(c.endTime, m5.time[7]);
  assert.equal(trade.status, Status.CLOSED); // closed at that candle's close
  assert.equal(trade.exitPrice, 109990);
  assert.equal(trade.exitReason, "CHALLENGE_STOP");
  assert.equal(trading.broker.pendingOrders.length, 0);
  assert.match(trading.blockedReason, /Challenge failed/);
  assert.throws(() => buy(trading, 100, 100), InvalidOrder);
});

test("touching the daily limit exactly is not a breach", () => {
  const m5 = market(20, { 7: [110000, 110000, 109500, 110000] }); // exactly $500 down at the low
  const { clock, trading } = setup(m5);
  buy(trading, 1000, 2000);
  clock.advance(5);
  assert.equal(trading.challenge.outcome, Outcome.RUNNING);
  assert.equal(trading.challenge.worstToday, 500);
});

test("a sell is measured at the candle's high plus the spread", () => {
  const m5 = market(20, { 7: [110000, 110480, 110000, 110000, 30] }); // high + 3 pips spread = $510 against
  const { clock, trading } = setup(m5);
  trading.place({ side: Side.SELL, type: "market", stopLoss: 111000, takeProfit: 108000 });
  clock.advance(5);
  assert.equal(trading.challenge.outcome, Outcome.FAILED);
});

test("the daily limit starts again at the broker's midnight (17:00 New York)", () => {
  // 20:00 UTC on 4 Aug 2025 is 16:00 in New York; the new server day starts at 21:00 UTC, candle 12.
  const start = "2025-08-04T20:00";
  assert.notEqual(serverDay(utc("2025-08-04T20:55")), serverDay(utc("2025-08-04T21:00")));
  const m5 = market(40, { 3: [110000, 110000, 109600, 109600], 15: [110000, 110000, 109550, 110000] }, start);
  const { clock, trading } = setup(m5, { startAt: 2 });
  buy(trading, 400, 2000); // stopped out on candle 3: -$400 on day 1
  clock.advance(10); // to candle 11, still day 1
  assert.equal(trading.balance, 9600);
  clock.advance(2); // into day 2
  buy(trading, 1000, 2000);
  clock.advance(4); // candle 15: $450 down from the day's start of $9,600, $850 down overall
  const c = trading.challenge;
  assert.equal(c.outcome, Outcome.RUNNING);
  assert.equal(c.dayStartBalance, 9600);
  assert.equal(c.worstToday, 450);
  assert.equal(c.worstDay, 450);
});

test("the maximum loss is a fixed floor under the starting balance", () => {
  const m5 = market(20, { 7: [110000, 110000, 108999, 109000] }); // $1,001 down at the low
  const { clock, trading } = setup(m5, { rules: { ...RULES, dailyPercent: 50 } });
  buy(trading, 2000, 2000);
  clock.advance(5);
  assert.equal(trading.challenge.outcome, Outcome.FAILED);
  assert.match(trading.challenge.reason, /maximum loss/);
  assert.equal(trading.challenge.lowestEquity, 8999);
});

test("the target passes only when it is banked with nothing left open", () => {
  const m5 = market(30, { 7: [110000, 110800, 110000, 110000] });
  const { clock, trading } = setup(m5);
  const a = buy(trading, 500, 800);
  const b = buy(trading, 500, 2000);
  trading.place({ side: Side.BUY, type: "pending", price: 109000, stopLoss: 108000, takeProfit: 112000 });
  clock.advance(5);
  assert.equal(a.status, Status.CLOSED);
  assert.equal(trading.balance, 10800);
  assert.equal(trading.challenge.outcome, Outcome.RUNNING); // b is still open
  trading.closeTrade(b.id); // flat at 110000: the balance stays at the target
  assert.equal(trading.challenge.outcome, Outcome.PASSED);
  assert.equal(trading.broker.pendingOrders.length, 0);
  assert.match(trading.blockedReason, /Challenge passed/);
});

test("the starting balance is locked during a challenge, and nothing is checked without one", () => {
  const m5 = market(20);
  const { trading } = setup(m5);
  assert.throws(() => trading.updateSettings({ startingBalance: 20000 }), /cannot change during a challenge/);
  trading.updateSettings({ riskPercent: 2 }); // other settings may change
  const free = setup(m5, { rules: { ...RULES, enabled: false } }).trading;
  assert.equal(free.challenge, null);
  free.updateSettings({ startingBalance: 20000 });
  assert.equal(free.balance, 20000);
});

test("damaged rules fall back to defaults; trading days are counted per server day", () => {
  assert.deepEqual(cleanRules({ enabled: "yes", targetPercent: -3, dailyPercent: "4", maxPercent: 1e9 }),
    { enabled: false, targetPercent: 8, dailyPercent: 4, maxPercent: 10, fee: 0, leverage: 0 }); // fee and leverage: off unless set
  const c = new Challenge(RULES, 10000);
  c.traded(utc("2025-08-04T10:00"));
  c.traded(utc("2025-08-04T20:59"));
  c.traded(utc("2025-08-04T21:00")); // the next server day
  assert.equal(c.summary().tradingDays, 2);
  assert.equal(c.target, 10800);
  assert.equal(c.floor, 9000);
});

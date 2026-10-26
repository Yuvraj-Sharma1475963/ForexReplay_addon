// A funded prop-firm account: what comes after a passed challenge (challenge.js).
//
// The rules (the trader's firm; every number can be changed for a run):
//  * No profit target. The same daily loss limit and fixed maximum loss as a challenge, measured
//    the same way (equity at each M5 candle's worst prices; a day starts at 17:00 New York).
//    Breaking either loses the account, and the run is over.
//  * Payouts are requested by the trader (Trading.requestPayout), only when all of these hold:
//      - `cycleDays` days have passed since the account started or since the last payout,
//      - trades were placed on at least `minTradingDays` days in that time,
//      - the balance is above the starting balance,
//      - no trade is open and no order is waiting (firms pay out a flat account).
//    A payout withdraws everything above the starting balance: `splitPercent` of it is the
//    trader's, the rest the firm's. The balance is back at the start; the floor does not move.
//  * The payout comes out of the balance the day started with as well, so taking profit is never
//    counted as a loss for the daily limit.
//
// A request is an action like an order: it is saved with the time it was made and repeated when
// the run is rebuilt, so a resumed account pays out on the same candles.

import { Outcome, serverDay } from "./challenge.js";

export const DEFAULT_FUNDED = Object.freeze({
  kind: "funded", enabled: true, dailyPercent: 3, maxPercent: 6, splitPercent: 90, cycleDays: 14, minTradingDays: 5, leverage: 30,
});

const LIMITS = {
  dailyPercent: [0.1, 100], maxPercent: [0.1, 100], splitPercent: [1, 100], cycleDays: [1, 365], minTradingDays: [0, 365], leverage: [0, 1000],
};

/** Fill gaps and replace nonsense with defaults, so a damaged saved value can never break the app. */
export function cleanFundedRules(raw) {
  const out = { ...DEFAULT_FUNDED };
  if (!raw || typeof raw !== "object") return out;
  for (const [key, [low, high]] of Object.entries(LIMITS)) {
    const value = Number(raw[key]);
    if (raw[key] !== null && raw[key] !== "" && Number.isFinite(value) && value >= low && value <= high) out[key] = value;
  }
  for (const key of ["cycleDays", "minTradingDays", "leverage"]) out[key] = Math.round(out[key]);
  return out;
}

export class FundedAccount {
  /**
   * @param {object} rules  see DEFAULT_FUNDED
   * @param {number} startingBalance  dollars
   * @param {number} startTime  UTC time of the candle the account starts on
   */
  constructor(rules, startingBalance, startTime) {
    this.kind = "funded";
    this.rules = cleanFundedRules(rules);
    this.start = startingBalance;
    this.dailyLimit = startingBalance * this.rules.dailyPercent / 100;
    this.floor = startingBalance * (1 - this.rules.maxPercent / 100);
    this.target = Infinity; // no profit target
    this.outcome = Outcome.RUNNING;
    this.reason = null;
    this.endTime = null;
    this.startTime = startTime;
    this.day = null;
    this.dayStartBalance = startingBalance;
    this.worstToday = 0;
    this.worstDay = 0;
    this.lowestEquity = startingBalance;
    this.tradingDays = new Set(); // every server day with a trade placed
    this.cycleStart = startTime; // the account's start, then each payout
    this.cycleDays = new Set(); // server days with a trade placed since cycleStart
    this.payouts = []; // [{ time, amount, toYou, toFirm }]
  }

  get running() { return this.outcome === Outcome.RUNNING; }

  beginCandle(time, balance) {
    const day = serverDay(time);
    if (day === this.day) return;
    this.day = day;
    this.dayStartBalance = balance;
    this.worstToday = 0;
  }

  traded(time) {
    const day = serverDay(time);
    this.tradingDays.add(day);
    this.cycleDays.add(day);
  }

  /** The same loss checks as a challenge, without a target. Returns "FAILED" or null. */
  check(time, { equityLow }) {
    if (!this.running) return null;
    const loss = this.dayStartBalance - equityLow;
    this.worstToday = Math.max(this.worstToday, loss);
    this.worstDay = Math.max(this.worstDay, loss);
    this.lowestEquity = Math.min(this.lowestEquity, equityLow);
    if (loss > this.dailyLimit + 1e-9) return this.end(time, Outcome.FAILED, `daily loss limit (${this.rules.dailyPercent}%) broken`);
    if (equityLow < this.floor - 1e-9) return this.end(time, Outcome.FAILED, `maximum loss (${this.rules.maxPercent}%) broken`);
    return null;
  }

  end(time, outcome, reason) {
    this.outcome = outcome;
    this.reason = reason;
    this.endTime = time;
    return outcome;
  }

  /** Days since the account started or the last payout, on the server clock. */
  daysInCycle(time) { return serverDay(time) - serverDay(this.cycleStart); }

  /** The UTC time from which the next payout can be requested (the start of that server day is close enough to show). */
  nextPayoutDay() { return serverDay(this.cycleStart) + this.rules.cycleDays; }

  /** Why a payout cannot be requested at `time`, in words, or null when it can. */
  payoutBlocked(time, { balance, open }) {
    if (!this.running) return "This account is lost, so it cannot pay out.";
    const waited = this.daysInCycle(time);
    if (waited < this.rules.cycleDays) {
      const left = this.rules.cycleDays - waited;
      return `A payout can be requested ${this.rules.cycleDays} days after the ${this.payouts.length ? "last payout" : "account started"}: ${left} more day${left === 1 ? "" : "s"}.`;
    }
    if (this.cycleDays.size < this.rules.minTradingDays) {
      const left = this.rules.minTradingDays - this.cycleDays.size;
      return `A payout needs trades on ${this.rules.minTradingDays} days since the ${this.payouts.length ? "last payout" : "start"}: ${left} more trading day${left === 1 ? "" : "s"}.`;
    }
    if (open > 0) return "Close your open trades and cancel waiting orders first: firms pay out a flat account.";
    if (!(balance > this.start + 0.005)) return "There is no profit to pay out: the balance is not above the starting balance.";
    return null;
  }

  /** Pay out everything above the starting balance. Returns { time, amount, toYou, toFirm }. Check payoutBlocked first. */
  payout(time, balance) {
    const amount = Math.round((balance - this.start) * 100) / 100;
    const toYou = Math.round(amount * this.rules.splitPercent) / 100;
    const p = { time, amount, toYou, toFirm: Math.round((amount - toYou) * 100) / 100 };
    this.payouts.push(p);
    this.dayStartBalance -= amount; // taking profit is not a loss for the daily limit
    this.cycleStart = time;
    this.cycleDays = new Set();
    return p;
  }

  /** Totals for the backtest list, the analytics page and tests. */
  totals() {
    const sum = (key) => Math.round(this.payouts.reduce((s, p) => s + p[key], 0) * 100) / 100;
    return { payouts: this.payouts.length, withdrawn: sum("amount"), toYou: sum("toYou"), toFirm: sum("toFirm") };
  }

  summary() {
    return {
      kind: this.kind, outcome: this.outcome, reason: this.reason, endTime: this.endTime,
      rules: { ...this.rules }, start: this.start, dailyLimit: this.dailyLimit, floor: this.floor,
      dayStartBalance: this.dayStartBalance, worstToday: this.worstToday, worstDay: this.worstDay,
      lowestEquity: this.lowestEquity, tradingDays: this.tradingDays.size, cycleTradingDays: this.cycleDays.size,
      ...this.totals(),
    };
  }
}

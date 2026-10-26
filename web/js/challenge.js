// Prop-firm challenge mode: a profit target, a daily loss limit and a maximum loss.
//
// The rules (the common two-step challenge model):
//  * Profit target: PASSED when the balance (closed results) reaches the starting
//    balance + target %, with no trade still open.
//  * Daily loss: FAILED when equity falls more than daily % of the STARTING balance
//    below the balance the day started with.
//  * Maximum loss: FAILED when equity falls below the starting balance - max %.
//    The floor is fixed (static); it does not trail the highest balance.
//  * A day starts at the broker server's midnight (17:00 New York), the same
//    boundary as the D1 candle and as MT5-based prop firms.
//
// How it is measured, honestly at M5 detail:
//  * After the engine has processed each M5 candle, equity is worked out at the
//    worst price of that candle for every open trade (the low for a buy, the high
//    plus spread for a sell), as if all of them were at their worst at once. The
//    order of prices inside a candle is unknown, so this is the conservative
//    assumption, like "stop loss first" in the engine.
//  * "Below" means strictly below: touching the limit exactly is not a breach.
//  * On a breach, every open trade is closed at that candle's close and pending
//    orders are cancelled; on a pass, pending orders are cancelled. Either way no
//    more trading in that run. A real firm closes at the moment of the breach,
//    which an M5 candle cannot pin down; the close of the candle is used instead.
//
// This file knows dollars only through numbers it is given; trading.js feeds it.

import { serverDate } from "./timeframes.js";

export const STORAGE_KEY = "forexreplay.challenge";

// fee: what the challenge costs, in dollars (only for the results: journey net = payouts - fee).
// leverage: 1:N; orders needing more margin than the free margin are refused (0 = no check).
export const DEFAULT_RULES = Object.freeze({ enabled: false, targetPercent: 8, dailyPercent: 5, maxPercent: 10, fee: 0, leverage: 0 });

export const PRESETS = Object.freeze({
  oneStep5k: { label: "Phase 1 · 5K", targetPercent: 10, dailyPercent: 3, maxPercent: 6, fee: 59, leverage: 30, startingBalance: 5000,
    title: "$5,000 account: 10% target ($500), 3% daily loss ($150), $300 max loss (6%), $59 fee, leverage 1:30" },
  phase1: { label: "8% target", targetPercent: 8, dailyPercent: 5, maxPercent: 10 },
  phase1Ten: { label: "10% target", targetPercent: 10, dailyPercent: 5, maxPercent: 10 },
  phase2: { label: "Phase 2: 5% target", targetPercent: 5, dailyPercent: 5, maxPercent: 10 },
});

const LIMITS = { targetPercent: [0.1, 100], dailyPercent: [0.1, 100], maxPercent: [0.1, 100], fee: [0, 100000], leverage: [0, 1000] };

/** Fill gaps and replace nonsense with defaults, so a damaged saved value can never break the app. */
export function cleanRules(raw) {
  const out = { ...DEFAULT_RULES };
  if (!raw || typeof raw !== "object") return out;
  for (const [key, [low, high]] of Object.entries(LIMITS)) {
    const value = Number(raw[key]);
    if (raw[key] !== null && raw[key] !== "" && Number.isFinite(value) && value >= low && value <= high) out[key] = value;
  }
  out.enabled = raw.enabled === true;
  out.leverage = Math.round(out.leverage);
  return out;
}

export function loadRules() {
  try { return cleanRules(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); } catch { return cleanRules(null); }
}

export function saveRules(rules) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rules)); } catch { /* private mode: not saved */ }
}

/** The broker-server day a UTC time belongs to (a day number on the server clock). */
export const serverDay = (utcSeconds) => serverDate(utcSeconds);

/** Exit reason written on trades closed because the challenge failed (a label only; no engine rule uses it). */
export const CHALLENGE_EXIT = "CHALLENGE_STOP";

export const Outcome = Object.freeze({ RUNNING: "RUNNING", PASSED: "PASSED", FAILED: "FAILED" });

export class Challenge {
  /**
   * @param {object} rules  { targetPercent, dailyPercent, maxPercent }
   * @param {number} startingBalance  dollars
   */
  constructor(rules, startingBalance) {
    this.kind = "challenge";
    this.rules = cleanRules({ ...rules, enabled: true });
    this.start = startingBalance;
    this.target = startingBalance * (1 + this.rules.targetPercent / 100);
    this.dailyLimit = startingBalance * this.rules.dailyPercent / 100;
    this.floor = startingBalance * (1 - this.rules.maxPercent / 100);
    this.outcome = Outcome.RUNNING;
    this.reason = null; // why it ended, in words
    this.endTime = null; // UTC time of the candle it ended on
    this.day = null; // current server day
    this.dayStartBalance = startingBalance;
    this.worstToday = 0; // largest loss from the day's start so far today, in dollars
    this.worstDay = 0; // largest daily loss on any day
    this.lowestEquity = startingBalance;
    this.tradingDays = new Set(); // server days on which a trade was placed
  }

  get running() { return this.outcome === Outcome.RUNNING; }

  /** Called before a candle is processed: a new server day takes the balance as it stands. */
  beginCandle(time, balance) {
    const day = serverDay(time);
    if (day === this.day) return;
    this.day = day;
    this.dayStartBalance = balance;
    this.worstToday = 0;
  }

  /** Remember the day a trade was placed on (for the count of trading days). */
  traded(time) {
    this.tradingDays.add(serverDay(time));
  }

  /**
   * Check the rules after a candle, or after an action at the live candle.
   * `equityLow` is equity at the worst price seen; `open` is how many trades are still open.
   * Returns "FAILED", "PASSED" or null when nothing changed.
   */
  check(time, { balance, equityLow, open }) {
    if (!this.running) return null;
    const loss = this.dayStartBalance - equityLow;
    this.worstToday = Math.max(this.worstToday, loss);
    this.worstDay = Math.max(this.worstDay, loss);
    this.lowestEquity = Math.min(this.lowestEquity, equityLow);
    if (loss > this.dailyLimit + 1e-9) return this.end(time, Outcome.FAILED, `daily loss limit (${this.rules.dailyPercent}%) broken`);
    if (equityLow < this.floor - 1e-9) return this.end(time, Outcome.FAILED, `maximum loss (${this.rules.maxPercent}%) broken`);
    if (balance >= this.target - 1e-9 && open === 0) return this.end(time, Outcome.PASSED, `profit target (${this.rules.targetPercent}%) reached`);
    return null;
  }

  end(time, outcome, reason) {
    this.outcome = outcome;
    this.reason = reason;
    this.endTime = time;
    return outcome;
  }

  /** Plain numbers for the panel, the backtest list and tests. */
  summary() {
    return {
      outcome: this.outcome, reason: this.reason, endTime: this.endTime,
      rules: { ...this.rules }, start: this.start, target: this.target, dailyLimit: this.dailyLimit, floor: this.floor,
      dayStartBalance: this.dayStartBalance, worstToday: this.worstToday, worstDay: this.worstDay,
      lowestEquity: this.lowestEquity, tradingDays: this.tradingDays.size,
    };
  }
}

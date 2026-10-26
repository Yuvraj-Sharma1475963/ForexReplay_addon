// Backtests: saving a replay run and rebuilding it later.
//
// A saved backtest is a recipe, not a photograph of the engine:
//   * where the replay started (the time of the last candle shown),
//   * the account settings it started with,
//   * every action taken, with the time of the live candle when it was taken,
//   * how far the replay got, and the drawings,
//   * the challenge rules, if the run was a prop-firm challenge (challenge.js),
//   * what you wrote about each trade (tradenotes.js): notes are not actions and are not rebuilt.
// Rebuilding feeds the same M5 candles to a fresh engine and repeats each action
// at its candle. The engine is deterministic, so the result is the same run.
//
// The save also carries a copy of every trade as it stood (`trades`). After a
// rebuild the two are compared field by field: if the engine's rules changed
// since the save, the difference is reported instead of passing silently. The
// same copy is what the server writes to the journal.
//
// Times are stored, not candle numbers, so a save still fits after the data is
// rebuilt with more candles.

import { LOT_UNITS } from "./account.js";
import { InvalidOrder, Status, Trading } from "./trading.js";

export const FORMAT_VERSION = 1;
const NAME = /^[A-Za-z0-9_-]{1,48}$/;

export class BacktestError extends Error {}

/** A journal or backtest id the server will accept: letters, digits, - and _. */
export const validName = (text) => typeof text === "string" && NAME.test(text);

/** Index of the M5 candle that opens at `time`, or -1. Candle times are sorted. */
export function indexOfTime(m5, time) {
  let lo = 0, hi = m5.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = m5.time[mid];
    if (t === time) return mid;
    if (t < time) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** "bt-20261003-142501-k3x9": when it was made (UTC, wall clock) plus a few random letters. */
export function newId(now = new Date(), random = Math.random) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `bt-${stamp}-${random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

/**
 * Drawings that may come along into a new replay: only those whose every point is
 * before the replay's "now", so nothing drawn on future candles leaks into the run.
 * (A line drawn at a price seen in the future but anchored in the past cannot be detected.)
 */
export function drawingsBefore(list, nowTime) {
  return list.filter((d) => d.points.every((p) => p.time < nowTime));
}

/** A closed or active trade as plain data: UTC times, prices in points, R and dollars. */
export function tradeRecord(trade, m5, account) {
  const at = (index) => (index === null ? null : m5.time[index]);
  const closed = trade.status === Status.CLOSED;
  return {
    id: trade.id, status: trade.status, side: trade.side, orderType: trade.orderType,
    placedTime: at(trade.placedTime), entryTime: at(trade.entryTime), exitTime: at(trade.exitTime),
    orderPrice: trade.orderPrice, plannedEntry: trade.plannedEntry, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
    stopLoss: trade.stopLoss, initialStop: trade.initialStop, takeProfit: trade.takeProfit,
    plannedRisk: trade.plannedRisk, remaining: trade.remaining, partials: trade.partials.length,
    pnl: trade.pnl, resultR: trade.resultR, plannedRewardR: trade.plannedRewardR, mfeR: trade.mfeR, maeR: trade.maeR,
    exitReason: trade.exitReason,
    lots: account.units(trade) / LOT_UNITS,
    commission: account.commission(trade),
    money: closed ? account.realized(trade) : null,
  };
}

// Fields that must agree between a save and its rebuild. Numbers are compared to 6 places.
const CHECKED = ["status", "side", "orderType", "entryTime", "exitTime", "entryPrice", "exitPrice",
  "stopLoss", "takeProfit", "remaining", "resultR", "lots"];
const same = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);

/** Plain-language differences between the saved trades and the rebuilt ones (empty when they agree). */
export function compareTrades(saved, rebuilt) {
  const problems = [];
  const byId = new Map(rebuilt.map((t) => [t.id, t]));
  for (const s of saved) {
    const r = byId.get(s.id);
    if (!r) { problems.push(`Trade #${s.id} was not rebuilt.`); continue; }
    const fields = CHECKED.filter((key) => !same(s[key], r[key]));
    if (fields.length) {
      problems.push(`Trade #${s.id} differs in ${fields.map((key) => `${key} (saved ${s[key]}, now ${r[key]})`).join(", ")}.`);
    }
    byId.delete(s.id);
  }
  for (const id of byId.keys()) problems.push(`Trade #${id} appeared that was not in the save.`);
  return problems;
}

/** Totals shown in the list of saved backtests. */
export function resultOf(trading) {
  const s = trading.summary();
  const c = trading.challenge;
  return {
    challenge: c ? c.outcome : null,
    stage: c ? c.kind : null, // "challenge" or "funded"
    fee: c && c.kind === "challenge" ? c.rules.fee : 0,
    funded: trading.funded ? trading.funded.totals() : null, // { payouts, withdrawn, toYou, toFirm }
    closed: s.closed, open: s.open, pending: s.pending, wins: s.wins, losses: s.losses,
    totalR: Math.round(s.totalR * 100) / 100,
    money: Math.round(s.totalMoney * 100) / 100,
    balance: Math.round(trading.balance * 100) / 100,
  };
}

/**
 * Everything needed to save the run that is on screen.
 * `meta` = { id, name, journal, created, startTime }; `clock` must still be in the replay.
 */
export function snapshot(meta, { trading, drawings, notes = null, m5, clock, manifest, timeframe }) {
  return {
    version: FORMAT_VERSION,
    ...meta,
    symbol: manifest.symbol, digits: manifest.digits, pipPoints: manifest.pip_points,
    saved: new Date().toISOString(),
    furthestTime: m5.time[clock.furthest - 1],
    timeframe,
    settings: { ...trading.startSettings },
    challenge: trading.challenge ? { ...trading.challenge.rules } : null,
    challengeEnd: trading.challenge ? { outcome: trading.challenge.outcome, endTime: trading.challenge.endTime } : null,
    actions: trading.actions.map((a) => structuredClone(a)),
    drawings: drawings.toJSON(),
    notes: notes ? notes.toJSON() : {},
    // Each trade carries its note, tags and screenshot names too, for the journal CSV.
    trades: trading.broker.trades.map((t) => ({ ...tradeRecord(t, m5, trading.account), ...(notes ? notes.get(t.id) : {}) })),
    result: resultOf(trading),
  };
}

/** A stand-in for the replay clock that only moves forward, for rebuilding without a chart. */
class StepClock {
  constructor(total, position) {
    this.total = total;
    this.active = true;
    this.position = this.furthest = position;
    this.revealListener = () => {};
  }

  get live() { return true; }
  get finished() { return this.position >= this.total; }
  onReveal(listener) { this.revealListener = listener; }

  moveTo(position) {
    if (position <= this.position) return;
    const from = this.position;
    this.position = this.furthest = position;
    this.revealListener(from, position);
  }
}

/**
 * Rebuild a saved backtest. Returns { trading, position, problems }:
 *   trading   a Trading whose broker, account and action log can be adopted by the app
 *   position  M5 candles revealed (where the replay clock resumes, live)
 *   problems  plain-language list of anything that did not repeat or does not match the save
 * Throws BacktestError when the save cannot be used at all (wrong format, or the candles are not in the data).
 */
export function rebuild(saved, { m5, pipPoints, pointValue }) {
  if (!saved || saved.version !== FORMAT_VERSION) throw new BacktestError("This backtest was saved in a format this app does not know.");
  for (const key of ["actions", "drawings", "trades"]) {
    if (!Array.isArray(saved[key])) throw new BacktestError(`This backtest file is damaged: '${key}' is missing.`);
  }
  const indexOf = (time, what) => {
    const i = indexOfTime(m5, time);
    if (i < 0) throw new BacktestError(`The ${what} of this backtest is not in the market data any more.`);
    return i;
  };
  const start = indexOf(saved.startTime, "start");
  const furthest = indexOf(saved.furthestTime, "last candle reached");

  const clock = new StepClock(m5.length, start + 1);
  const trading = new Trading({ m5, clock, pipPoints, pointValue, settings: saved.settings, challenge: saved.challenge || null });
  const problems = [];
  saved.actions.forEach((action, n) => {
    const at = indexOfTime(m5, action.at);
    if (at < 0 || at + 1 < clock.position) {
      problems.push(`Action ${n + 1} (${action.kind}) is out of order or not in the data, so it was skipped.`);
      return;
    }
    clock.moveTo(at + 1);
    try {
      trading.apply(action);
    } catch (err) {
      if (!(err instanceof InvalidOrder)) throw err;
      problems.push(`Action ${n + 1} (${action.kind}) could not be repeated: ${err.message}`);
    }
  });
  clock.moveTo(furthest + 1);

  const rebuilt = trading.broker.trades.map((t) => tradeRecord(t, m5, trading.account));
  problems.push(...compareTrades(saved.trades, rebuilt));
  const c = trading.challenge;
  const end = c ? { outcome: c.outcome, endTime: c.endTime } : null;
  if (JSON.stringify(end) !== JSON.stringify(saved.challengeEnd ?? null)) {
    problems.push(`The challenge ended differently: saved ${JSON.stringify(saved.challengeEnd)}, now ${JSON.stringify(end)}.`);
  }
  const paid = trading.funded ? trading.funded.totals() : null;
  if (saved.result && saved.result.funded && JSON.stringify(paid) !== JSON.stringify(saved.result.funded)) {
    problems.push(`The payouts came out differently: saved ${JSON.stringify(saved.result.funded)}, now ${JSON.stringify(paid)}.`);
  }
  return { trading, position: clock.position, problems };
}

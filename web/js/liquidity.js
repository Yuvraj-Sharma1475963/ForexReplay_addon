// Liquidity levels: the prices where stop orders tend to rest, and whether price has swept them yet.
//
//   Previous day high/low (PDH, PDL)   the last completed trading day (17:00 New York to 17:00), shown through the next day
//   Previous week high/low (PWH, PWL)  the last completed trading week, shown through the next week
//   Asia high/low                      the Tokyo session, 09:00-18:00 Tokyo (00:00-09:00 UTC; Tokyo has no
//                                      daylight saving), shown from its close until the next one opens
//   Equal highs/lows (EQH, EQL)        two or more swing highs (lows) within a few pips of each other, with
//                                      nothing more than that beyond them in between: stops of both sides sit just past them
//
// A level is swept when a candle's wick trades through it (high above a high level, low below a low level).
// Its line then stops at that candle and stays on the chart as swept; a level that is not swept runs on
// until its period ends (day, week, next Asia session) or, for equal highs and lows, until it is swept.
//
// No look-ahead: it reads only the chart's candles, which during a replay are the revealed ones. A swing
// high or low is known `length` candles after it formed (nothing higher/lower on either side), so an equal
// level appears that many candles after its second point. The forming candle is worked out on a copy of
// the state, so a sweep by a forming candle shows at once and stays if the candle closes that way.
//
// Prices are whole points, candle positions are indexes into the chart's candles.

import { serverDate } from "./timeframes.js";

export const STORAGE_KEY = "forexreplay.liquidity";

export const DEFAULT_LIQUIDITY = Object.freeze({
  day: { on: false },
  week: { on: false },
  asia: { on: false },
  equal: { on: false, pips: 1.5, length: 5 }, // pips: how close two points must be; length: candles each side of a swing point
});

export const LABELS = { pdh: "PDH", pdl: "PDL", pwh: "PWH", pwl: "PWL", asiah: "Asia H", asial: "Asia L", eqh: "EQH", eql: "EQL" };

const HOUR = 3600;
const DAY = 86400;
const ASIA_END = 9 * HOUR; // Tokyo 09:00-18:00 is 00:00-09:00 UTC
const MAX_PIVOTS = 200; // unswept swing points remembered per side

/** Fill gaps and replace nonsense with defaults, so a damaged saved value can never break the app. */
export function cleanLiquidity(raw) {
  const out = structuredClone(DEFAULT_LIQUIDITY);
  if (!raw || typeof raw !== "object") return out;
  for (const key of ["day", "week", "asia", "equal"]) {
    if (raw[key] && typeof raw[key] === "object") out[key].on = raw[key].on === true;
  }
  if (raw.equal && typeof raw.equal === "object") {
    const pips = Number(raw.equal.pips);
    if (Number.isFinite(pips) && pips >= 0.1 && pips <= 50) out.equal.pips = Math.round(pips * 10) / 10;
    const length = Number(raw.equal.length);
    if (Number.isInteger(length) && length >= 2 && length <= 50) out.equal.length = length;
  }
  return out;
}

export const liquidityActive = (s) => s.day.on || s.week.on || s.asia.on || s.equal.on;

/** Trading week number: server days run Monday to Friday, so weeks are counted from a Monday. */
const weekOf = (date) => Math.floor((date + 3) / 7); // day 0 (1 Jan 1970) was a Thursday

function freshState() {
  return {
    nextId: 1,
    day: null, dayHigh: -Infinity, dayLow: Infinity,
    week: null, weekHigh: -Infinity, weekLow: Infinity,
    asia: null, // { day (UTC day number), high, low, done }
    highs: [], lows: [], // unswept swing points { price, index, level (id or 0) }, oldest first
    active: [], // levels still running, oldest first
    done: [], // levels that ended or were swept
  };
}

function cloneState(s) {
  return {
    ...s,
    asia: s.asia && { ...s.asia },
    highs: s.highs.slice(), lows: s.lows.slice(),
    active: s.active.map((l) => ({ ...l })),
    done: s.done.slice(),
  };
}

/**
 * Liquidity levels, worked out only where the candles changed (like SmcEngine: the state after every
 * closed candle is kept; a step back, other candles or other settings start again from the first candle).
 */
export class LiquidityEngine {
  constructor() {
    this.candles = null;
    this.key = null;
    this.committed = 0;
    this.state = freshState();
  }

  /**
   * Levels for `candles`: [{ id, kind, side (1 high, -1 low), price, from, to, swept, count }], `to` null
   * while the level is still running (draw it to the right edge). `from` is the first candle that may have
   * changed since the last call (null: all). `barSeconds` is the chart's timeframe, `pipPoints` points to a pip.
   */
  compute(candles, settings, { barSeconds, pipPoints }, from = null) {
    const n = candles.length;
    const key = JSON.stringify([settings, barSeconds, pipPoints]);
    if (from === null || candles !== this.candles || key !== this.key || from < this.committed || n - 1 < this.committed) {
      this.state = freshState();
      this.committed = 0;
    }
    this.candles = candles;
    this.key = key;
    const opts = {
      ...settings,
      asiaOn: settings.asia.on && barSeconds <= HOUR, // a 4-hour candle cannot show a 9-hour session's range
      tolerance: Math.round(settings.equal.pips * pipPoints),
    };
    for (let i = this.committed; i < n - 1; i++) this.step(this.state, candles, i, opts);
    this.committed = Math.max(this.committed, n - 1);
    if (n === 0) return [];
    const live = cloneState(this.state); // the last candle may still be forming
    this.step(live, candles, n - 1, opts);
    return live.done.concat(live.active);
  }

  step(s, c, i, o) {
    const t = c.time[i], H = c.high[i], L = c.low[i];
    const open = (kind, side, price, start) => {
      const level = { id: s.nextId++, kind, side, price, from: start, to: null, swept: false, count: 1 };
      s.active.push(level);
      return level;
    };
    const end = (pred, to) => {
      for (let k = 0; k < s.active.length; k++) {
        if (pred(s.active[k])) { s.done.push({ ...s.active[k], to }); s.active.splice(k--, 1); }
      }
    };

    // A new trading day (or week): yesterday's (last week's) range becomes today's levels.
    const date = serverDate(t);
    if (date !== s.day) {
      if (s.day !== null) {
        end((l) => l.kind === "pdh" || l.kind === "pdl", i - 1);
        if (o.day.on) { open("pdh", 1, s.dayHigh, i); open("pdl", -1, s.dayLow, i); }
      }
      s.day = date; s.dayHigh = -Infinity; s.dayLow = Infinity;
      const week = weekOf(date);
      if (week !== s.week) {
        if (s.week !== null) {
          end((l) => l.kind === "pwh" || l.kind === "pwl", i - 1);
          if (o.week.on) { open("pwh", 1, s.weekHigh, i); open("pwl", -1, s.weekLow, i); }
        }
        s.week = week; s.weekHigh = -Infinity; s.weekLow = Infinity;
      }
    }

    // Asia: build the range while the session is open, then put it up as two levels.
    if (o.asiaOn) {
      const utcDay = Math.floor(t / DAY);
      if (t - utcDay * DAY < ASIA_END) {
        if (!s.asia || s.asia.day !== utcDay) {
          end((l) => l.kind === "asiah" || l.kind === "asial", i - 1);
          s.asia = { day: utcDay, high: -Infinity, low: Infinity, done: false };
        }
        s.asia.high = Math.max(s.asia.high, H);
        s.asia.low = Math.min(s.asia.low, L);
      } else if (s.asia && !s.asia.done) {
        s.asia.done = true;
        open("asiah", 1, s.asia.high, i);
        open("asial", -1, s.asia.low, i);
      }
    }

    // Sweeps: a wick through a level ends it on this candle.
    for (let k = 0; k < s.active.length; k++) {
      const l = s.active[k];
      if (l.side === 1 ? H > l.price : L < l.price) {
        s.done.push({ ...l, to: i, swept: true });
        s.active.splice(k--, 1);
      }
    }

    if (o.equal.on) this.equals(s, c, i, o, open);

    s.dayHigh = Math.max(s.dayHigh, H); s.dayLow = Math.min(s.dayLow, L);
    s.weekHigh = Math.max(s.weekHigh, H); s.weekLow = Math.min(s.weekLow, L);
  }

  /** Swing points `length` candles back, and equal highs/lows between them and earlier unswept ones. */
  equals(s, c, i, o, open) {
    const H = c.high, L = c.low, size = o.equal.length;
    // A swing point traded through by more than the tolerance can no longer pair (within it, the
    // candle may be the second of an equal pair: a slightly higher high still counts as equal).
    if (s.highs.length) s.highs = s.highs.filter((p) => H[i] <= p.price + o.tolerance);
    if (s.lows.length) s.lows = s.lows.filter((p) => L[i] >= p.price - o.tolerance);
    const j = i - size;
    if (j - size < 0) return;
    let isHigh = true, isLow = true;
    for (let k = j - size; k <= i; k++) {
      if (k === j) continue;
      if (k < j ? H[k] > H[j] : H[k] >= H[j]) isHigh = false; // ties go to the earlier candle
      if (k < j ? L[k] < L[j] : L[k] <= L[j]) isLow = false;
    }
    const pair = (list, price, side, kind) => {
      for (let k = list.length - 1; k >= 0; k--) { // the nearest earlier point within the tolerance
        const p = list[k];
        if (Math.abs(p.price - price) > o.tolerance) continue;
        let level = p.level ? s.active.find((l) => l.id === p.level) : null;
        if (level) {
          level.price = side === 1 ? Math.max(level.price, price) : Math.min(level.price, price);
          level.count += 1;
        } else {
          level = open(kind, side, side === 1 ? Math.max(p.price, price) : Math.min(p.price, price), p.index);
          level.count = 2;
          list[k] = { ...p, level: level.id };
        }
        return level.id;
      }
      return 0;
    };
    if (isHigh) {
      const level = pair(s.highs, H[j], 1, "eqh");
      s.highs.push({ price: H[j], index: j, level });
      if (s.highs.length > MAX_PIVOTS) s.highs.shift();
    }
    if (isLow) {
      const level = pair(s.lows, L[j], -1, "eql");
      s.lows.push({ price: L[j], index: j, level });
      if (s.lows.length > MAX_PIVOTS) s.lows.shift();
    }
  }
}

// Smart Money Concepts: order blocks and fair value gaps.
//
// Ported from "Smart Money Concepts [LuxAlgo]" (TradingView, Pine Script v5), © LuxAlgo:
// https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-SMC-LuxAlgo/
// This file is a derivative of that script and, like it, is licensed under
// Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (CC BY-NC-SA 4.0):
// https://creativecommons.org/licenses/by-nc-sa/4.0/
// It may be shared and changed with credit to LuxAlgo, not for commercial use, and only under
// the same licence. That licence covers this file only, not the rest of the app.
//
// What is ported: the swing and internal legs and pivots, the breaks of structure that store an
// order block, order block mitigation, and fair value gaps on the chart's own timeframe. They run
// on each candle in the order the script runs them. Only order blocks and fair value gaps are drawn;
// the structure is worked out because the order blocks come from it.
//
// No look-ahead, as with every indicator here: it reads only the chart's candles, which during a
// replay are those the clock has revealed. A pivot is known `length` candles after it formed and an
// order block appears on the candle that breaks structure, exactly when TradingView would draw them.
// The forming candle is worked out on a copy of the state, as TradingView recalculates its live bar.
//
// Prices are whole points, as everywhere in the app. Candle positions are indexes into the chart's
// candles (the script uses bar times; on the chart's own candles the two say the same thing).

export const BULLISH = 1;
export const BEARISH = -1;

export const DEFAULT_SMC = Object.freeze({
  internalOb: { on: false, count: 5 }, // order blocks from the internal structure (5-candle pivots)
  swingOb: { on: false, count: 5, length: 50 }, // order blocks from the swing structure
  fvg: { on: false, auto: true, extend: 1 },
  mitigation: "highlow", // "highlow": a wick through the block removes it; "close": only a close does
  filter: "atr", // volatile candles are skipped as order blocks: "atr" (ATR 200) or "range" (cumulative mean range)
});
export const STORAGE_KEY = "forexreplay.smc";

const INTERNAL_LENGTH = 5; // fixed in the script
const ATR_LENGTH = 200;
const MAX_STORED = 100; // order blocks kept per kind, newest first

/** Fill gaps and replace nonsense with defaults, so a damaged saved value can never break the app. */
export function cleanSmc(raw) {
  const out = structuredClone(DEFAULT_SMC);
  if (!raw || typeof raw !== "object") return out;
  const int = (v, lo, hi, fallback) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback; };
  for (const key of ["internalOb", "swingOb", "fvg"]) {
    const r = raw[key];
    if (!r || typeof r !== "object") continue;
    out[key].on = r.on === true;
  }
  if (raw.internalOb) out.internalOb.count = int(raw.internalOb.count, 1, 20, out.internalOb.count);
  if (raw.swingOb) {
    out.swingOb.count = int(raw.swingOb.count, 1, 20, out.swingOb.count);
    out.swingOb.length = int(raw.swingOb.length, 10, 500, out.swingOb.length);
  }
  if (raw.fvg) {
    if (typeof raw.fvg.auto === "boolean") out.fvg.auto = raw.fvg.auto;
    out.fvg.extend = int(raw.fvg.extend, 0, 500, out.fvg.extend);
  }
  if (raw.mitigation === "close" || raw.mitigation === "highlow") out.mitigation = raw.mitigation;
  if (raw.filter === "atr" || raw.filter === "range") out.filter = raw.filter;
  return out;
}

export const smcActive = (s) => s.internalOb.on || s.swingOb.on || s.fvg.on;

const pivot = () => ({ current: NaN, last: NaN, crossed: false, index: -1 });

function freshState() {
  return {
    swingLeg: 0, internalLeg: 0, // the script's leg(): 0 bearish, 1 bullish, kept between candles
    swingHigh: pivot(), swingLow: pivot(), internalHigh: pivot(), internalLow: pivot(),
    // each crossover's level as it stood on the previous candle (the script's level[1])
    prev: { internalHigh: NaN, internalLow: NaN, swingHigh: NaN, swingLow: NaN },
    swingTrend: 0, internalTrend: 0,
    internalObs: [], swingObs: [], fvgs: [], // newest first
  };
}

function cloneState(s) {
  return {
    ...s,
    swingHigh: { ...s.swingHigh }, swingLow: { ...s.swingLow },
    internalHigh: { ...s.internalHigh }, internalLow: { ...s.internalLow },
    prev: { ...s.prev },
    internalObs: s.internalObs.slice(), swingObs: s.swingObs.slice(), fvgs: s.fvgs.slice(),
  };
}

/** a != b in Pine, where a comparison with na is false. */
const differ = (a, b) => Number.isFinite(a) && Number.isFinite(b) && a !== b;

/**
 * Remove the items `gone` picks, the way the script's `for [i, x] in array ... array.remove(i)` does:
 * the item after a removed one moves into its place and is not looked at until the next candle.
 */
function removeWhere(list, gone) {
  for (let k = 0; k < list.length; k++) if (gone(list[k])) list.splice(k, 1);
}

/**
 * Order blocks and fair value gaps, worked out only where the candles changed.
 *
 * The state after every closed candle is kept, so a replay step going forward works out one or two
 * candles. A step back, other candles or other settings start again from the first candle
 * (about as long as a replay step with every other indicator on, on a chart of 21,000 candles).
 */
export class SmcEngine {
  constructor() {
    this.candles = null;
    this.key = null;
    this.committed = 0; // candles 0..committed-1 are in this.state
    this.state = freshState();
    this.capacity = 0;
  }

  grow(capacity) {
    if (capacity <= this.capacity) return;
    for (const name of ["parsedHigh", "parsedLow", "atr", "trSum", "trCum", "deltaCum"]) {
      const a = new Float64Array(capacity).fill(NaN);
      if (this[name]) a.set(this[name].subarray(0, this.committed));
      this[name] = a;
    }
    this.capacity = capacity;
  }

  /**
   * What to draw for `candles` under `settings`: { internalObs, swingObs, fvgs }, each newest first.
   * An order block is { high, low, index, bias } (on a volatile candle the script swaps high and low,
   * so draw between the two); a gap is { top, bottom, left, right, bias }.
   * `from` is the first candle that may have changed since the last call; null means all.
   */
  compute(candles, settings, from = null) {
    const n = candles.length;
    const key = JSON.stringify(settings);
    if (from === null || candles !== this.candles || key !== this.key || from < this.committed || n - 1 < this.committed) {
      this.state = freshState();
      this.committed = 0;
    }
    this.candles = candles;
    this.key = key;
    this.grow(Math.max(n, candles.close.length));
    for (let i = this.committed; i < n - 1; i++) this.step(this.state, candles, i, settings);
    this.committed = Math.max(this.committed, n - 1);
    if (n === 0) return { internalObs: [], swingObs: [], fvgs: [] };
    const live = cloneState(this.state); // the last candle may still be forming
    this.step(live, candles, n - 1, settings);
    return {
      internalObs: settings.internalOb.on ? live.internalObs.slice(0, settings.internalOb.count) : [],
      swingObs: settings.swingOb.on ? live.swingObs.slice(0, settings.swingOb.count) : [],
      fvgs: settings.fvg.on ? live.fvgs : [],
    };
  }

  /** One candle, in the script's order. */
  step(s, c, i, set) {
    const H = c.high, L = c.low, C = c.close, O = c.open;

    // Volatility. ta.atr(200) is Wilder's average of ta.tr(true) (the first candle's range counts);
    // the "range" filter is ta.cum(ta.tr) / bar_index, where ta.tr is na on the first candle.
    const tr = i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    this.trSum[i] = (i ? this.trSum[i - 1] : 0) + tr;
    this.trCum[i] = (i ? this.trCum[i - 1] : 0) + (i ? tr : 0);
    this.atr[i] = i < ATR_LENGTH - 1 ? NaN
      : i === ATR_LENGTH - 1 ? this.trSum[i] / ATR_LENGTH
        : (this.atr[i - 1] * (ATR_LENGTH - 1) + tr) / ATR_LENGTH;
    const volatility = set.filter === "atr" ? this.atr[i] : this.trCum[i] / i;
    const highVolatility = H[i] - L[i] >= 2 * volatility; // false while it is not known yet
    // A very volatile candle is turned inside out, so it is never picked as an order block's extreme.
    this.parsedHigh[i] = highVolatility ? L[i] : H[i];
    this.parsedLow[i] = highVolatility ? H[i] : L[i];

    // Fair value gaps price has filled go first.
    if (set.fvg.on) removeWhere(s.fvgs, (g) => (g.bias === BULLISH && L[i] < g.bottom) || (g.bias === BEARISH && H[i] > g.top));

    this.structure(s, c, i, set.swingOb.length, false);
    this.structure(s, c, i, INTERNAL_LENGTH, true);
    this.breaks(s, c, i, true, set);
    this.breaks(s, c, i, false, set);

    const bearSource = set.mitigation === "close" ? C[i] : H[i];
    const bullSource = set.mitigation === "close" ? C[i] : L[i];
    const mitigated = (ob) => (ob.bias === BEARISH && bearSource > ob.high) || (ob.bias === BULLISH && bullSource < ob.low);
    if (set.internalOb.on) removeWhere(s.internalObs, mitigated);
    if (set.swingOb.on) removeWhere(s.swingObs, mitigated);

    // ta.cum(|bar delta %|) runs on every candle; the delta of the first candle is na (counted as 0).
    const delta = i === 0 ? NaN : (C[i - 1] - O[i - 1]) / (O[i - 1] * 100);
    this.deltaCum[i] = (i ? this.deltaCum[i - 1] : 0) + (Number.isFinite(delta) ? Math.abs(delta) : 0);
    if (set.fvg.on && i >= 2) {
      const threshold = set.fvg.auto ? (this.deltaCum[i] / i) * 2 : 0;
      const right = i + set.fvg.extend; // the script extends the box `extend` candles past the third
      if (L[i] > H[i - 2] && C[i - 1] > H[i - 2] && delta > threshold) {
        s.fvgs.unshift({ top: L[i], bottom: H[i - 2], left: i - 1, right, bias: BULLISH });
      }
      if (H[i] < L[i - 2] && C[i - 1] < L[i - 2] && -delta > threshold) {
        s.fvgs.unshift({ top: H[i], bottom: L[i - 2], left: i - 1, right, bias: BEARISH });
      }
    }
  }

  /** getCurrentStructure: a new leg confirms the candle `size` back as a pivot high or low. */
  structure(s, c, i, size, internal) {
    const legKey = internal ? "internalLeg" : "swingLeg";
    const before = s[legKey];
    let leg = before;
    if (i >= size) {
      const j = i - size;
      let highest = -Infinity, lowest = Infinity;
      for (let k = j + 1; k <= i; k++) {
        if (c.high[k] > highest) highest = c.high[k];
        if (c.low[k] < lowest) lowest = c.low[k];
      }
      if (c.high[j] > highest) leg = 0; // the candle `size` back is higher than everything since: a bearish leg starts
      else if (c.low[j] < lowest) leg = 1;
    }
    s[legKey] = leg;
    if (leg === before) return;
    const j = i - size;
    const p = leg === 1
      ? (internal ? s.internalLow : s.swingLow) // a bullish leg starts from a pivot low
      : (internal ? s.internalHigh : s.swingHigh);
    p.last = p.current;
    p.current = leg === 1 ? c.low[j] : c.high[j];
    p.crossed = false;
    p.index = j;
  }

  /** displayStructure: a close through the last pivot is a break of structure, and stores an order block. */
  breaks(s, c, i, internal, set) {
    const C = c.close;
    const high = internal ? s.internalHigh : s.swingHigh;
    const low = internal ? s.internalLow : s.swingLow;
    const keyHigh = internal ? "internalHigh" : "swingHigh";
    const keyLow = internal ? "internalLow" : "swingLow";
    const trendKey = internal ? "internalTrend" : "swingTrend";
    const store = internal ? set.internalOb.on : set.swingOb.on;

    // ta.crossover(close, level): above it now, at or below it on the previous candle.
    const crossUp = i > 0 && C[i] > high.current && C[i - 1] <= s.prev[keyHigh];
    s.prev[keyHigh] = high.current;
    // Internal breaks of the level the swing structure also uses are left to the swing structure.
    const bullOk = internal ? differ(s.internalHigh.current, s.swingHigh.current) : true;
    if (crossUp && !high.crossed && bullOk) {
      high.crossed = true;
      s[trendKey] = BULLISH;
      if (store) this.storeOrderBlock(s, high, internal, BULLISH, i);
    }

    const crossDown = i > 0 && C[i] < low.current && C[i - 1] >= s.prev[keyLow];
    s.prev[keyLow] = low.current;
    const bearOk = internal ? differ(s.internalLow.current, s.swingLow.current) : true;
    if (crossDown && !low.crossed && bearOk) {
      low.crossed = true;
      s[trendKey] = BEARISH;
      if (store) this.storeOrderBlock(s, low, internal, BEARISH, i);
    }
  }

  /**
   * The order block of a break: between the broken pivot and this candle, the candle with the lowest
   * (bullish) or highest (bearish) parsed price; the first one if several share it.
   */
  storeOrderBlock(s, p, internal, bias, i) {
    let best = p.index;
    for (let k = p.index + 1; k < i; k++) {
      if (bias === BEARISH ? this.parsedHigh[k] > this.parsedHigh[best] : this.parsedLow[k] < this.parsedLow[best]) best = k;
    }
    const list = internal ? s.internalObs : s.swingObs;
    if (list.length >= MAX_STORED) list.pop();
    list.unshift({ high: this.parsedHigh[best], low: this.parsedLow[best], index: best, bias });
  }
}

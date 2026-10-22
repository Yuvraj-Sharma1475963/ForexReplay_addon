// Drawings: what they are, where they sit, and how the mouse finds them.
//
// A drawing is plain data anchored in TIME (UTC seconds) and PRICE (points), never
// in pixels or candle numbers. That is why a line drawn on M5 is still in the right
// place on H1, after scrolling, and after reloading the page.
//
// This file has no chart code in it. Given a projection (time -> x, price -> y) it
// works out what to draw (`layout`) and what is under the mouse (`hit`), so both can
// be tested without a browser. drawinglayer.js does the actual painting and mouse work.

import { indexAtOrBefore } from "./timeframes.js";

export const STORAGE_PREFIX = "forexreplay.drawings.";

/**
 * Fibonacci retracement levels, as each new drawing starts. 0.618 to 0.79 is the "optimal trade entry"
 * (OTE) zone, with 0.705 in the middle. Each drawing can carry its own `levels` (and `ote: false` to hide
 * the zone); below 0 and above 1 are extensions (for example -0.27 or 1.618).
 */
export const FIB_LEVELS = [0, 0.382, 0.5, 0.618, 0.705, 0.79, 1];
export const OTE = [0.618, 0.79];
export const FIB_LIMITS = { min: -5, max: 10, count: 24 };

/** A list of Fibonacci levels made safe: numbers between -5 and 10, 4 decimals, no repeats, sorted, at most 24. Null if none is left. */
export function cleanFibLevels(raw) {
  if (!Array.isArray(raw)) return null;
  const levels = [...new Set(raw.map(Number)
    .filter((v) => Number.isFinite(v) && v >= FIB_LIMITS.min && v <= FIB_LIMITS.max)
    .map((v) => Math.round(v * 10000) / 10000))].sort((a, b) => a - b).slice(0, FIB_LIMITS.count);
  return levels.length ? levels : null;
}

/** The levels a Fibonacci drawing shows: its own, or the standard set. */
export const fibLevelsOf = (d) => d.levels || FIB_LEVELS;

/**
 * How many clicks each tool needs, its name in the app, and whether it takes a colour and
 * line style. Fibonacci and the position tools keep their own colours, which carry meaning
 * (OTE zone, profit and loss).
 */
export const TOOLS = Object.freeze({
  trend: { clicks: 2, label: "Trendline", styled: true },
  ray: { clicks: 2, label: "Ray", styled: true },
  hline: { clicks: 1, label: "Horizontal line", styled: true },
  hray: { clicks: 1, label: "Horizontal ray", styled: true },
  vline: { clicks: 1, label: "Vertical line", styled: true },
  rect: { clicks: 2, label: "Rectangle", styled: true },
  fib: { clicks: 2, label: "Fibonacci retracement", styled: false },
  long: { clicks: 1, label: "Long position", styled: false },
  short: { clicks: 1, label: "Short position", styled: false },
  text: { clicks: 1, label: "Text", styled: true },
  measure: { clicks: 2, label: "Measure", styled: false, temporary: true }, // a ruler on screen only, never saved
});

/** Colours a drawing may have (the first is the default), and its line styles. */
export const PALETTE = ["#2962ff", "#26a69a", "#ef5350", "#f5a623", "#ab47bc", "#00bcd4", "#d1d4dc", "#ffeb3b"];
export const LINE_STYLES = ["solid", "dashed", "dotted"];
export const MAX_TEXT = 200;

const ONE_POINT = new Set(["hline", "hray", "vline", "text"]);
const isPosition = (type) => type === "long" || type === "short";
const whole = (value) => Number.isInteger(value);

/**
 * Magnet: the price of the open, high, low or close nearest to `price`, on the candle at
 * chart position `logical`, if it is within `maxDistance` points (the layer passes the points
 * that 12 pixels cover at the current zoom). Further away, or outside the candles, the price
 * is left as it is. Only candles on the chart can be snapped to, so during a replay nothing
 * hidden is ever used.
 *
 * Until v2.0.2 the magnet always snapped, however far away the nearest price was. Nudging a
 * long's stop handle over candles that were all above the entry then threw the stop up to one
 * point under the entry, and the red zone vanished (reported by Jeevesh).
 */
export function snapPrice(candles, logical, price, maxDistance = Infinity) {
  const i = Math.round(logical);
  if (!candles || i < 0 || i >= candles.length) return price;
  let best = price, distance = Infinity;
  for (const value of [candles.open[i], candles.high[i], candles.low[i], candles.close[i]]) {
    if (Math.abs(value - price) < distance) { best = value; distance = Math.abs(value - price); }
  }
  return distance <= maxDistance ? best : price;
}

/**
 * For a position's stop or target handle: the snapped price if it is still on the right side
 * of the entry, otherwise the price under the mouse. A magnet must never fold a stop or target
 * onto the entry.
 */
export function positionLevel(d, key, snapped, raw) {
  if (!isPosition(d.type) || (key !== "stop" && key !== "target")) return snapped;
  const direction = d.type === "long" ? 1 : -1;
  const entry = d.points[0].price;
  const ok = key === "stop" ? (entry - snapped) * direction > 0 : (snapped - entry) * direction > 0;
  return ok ? snapped : raw;
}

// ----- time <-> position on the chart -----------------------------------------
// The chart library places candles by index ("logical" position), not by time, so
// weekends take no space. A time inside the data maps to its candle. A time past the
// last candle (the empty space on the right, or the future during a replay) is
// placed as if candles continued at the timeframe's spacing.

export function timeToLogical(candles, tfSeconds, time) {
  const n = candles.length;
  if (n === 0) return 0;
  const first = candles.time[0], last = candles.time[n - 1];
  if (time > last) return n - 1 + (time - last) / tfSeconds;
  if (time < first) return (time - first) / tfSeconds;
  return indexAtOrBefore(candles, time);
}

export function logicalToTime(candles, tfSeconds, logical) {
  const n = candles.length;
  const i = Math.round(logical);
  if (n === 0) return 0;
  if (i > n - 1) return candles.time[n - 1] + (i - (n - 1)) * tfSeconds;
  if (i < 0) return candles.time[0] + i * tfSeconds;
  return candles.time[i];
}

// ----- creating and changing --------------------------------------------------
/**
 * A new drawing from the first click. Two-click tools start with both points on the click;
 * the second point then follows the mouse. `defaults` = { pipPoints, barsAhead(time, bars) -> time }.
 */
export function createDrawing(type, point, defaults) {
  const p = { time: point.time, price: point.price };
  if (type === "text") return { type, points: [p], text: "" };
  if (ONE_POINT.has(type)) return { type, points: [p] };
  if (isPosition(type)) {
    const direction = type === "long" ? 1 : -1;
    const pip = defaults.pipPoints;
    return {
      type,
      points: [p, { time: defaults.barsAhead(p.time, 24), price: p.price }], // entry, right edge
      stop: p.price - direction * 10 * pip,
      target: p.price + direction * 20 * pip,
    };
  }
  return { type, points: [p, { ...p }] };
}

/** The points you can grab: [{ key, time, price }]. */
export function handles(d) {
  if (ONE_POINT.has(d.type)) return [{ key: "p0", time: d.points[0].time, price: d.points[0].price }];
  if (isPosition(d.type)) {
    const [entry, end] = d.points;
    return [
      { key: "entry", time: entry.time, price: entry.price },
      { key: "end", time: end.time, price: entry.price },
      { key: "stop", time: entry.time, price: d.stop },
      { key: "target", time: entry.time, price: d.target },
    ];
  }
  if (d.type === "rect") { // all four corners
    const [a, b] = d.points;
    return [
      { key: "p0", time: a.time, price: a.price }, { key: "p1", time: b.time, price: b.price },
      { key: "p0t-p1p", time: a.time, price: b.price }, { key: "p1t-p0p", time: b.time, price: a.price },
    ];
  }
  return d.points.map((p, i) => ({ key: `p${i}`, time: p.time, price: p.price }));
}

/** A copy of the drawing with one handle moved to { time, price }. */
export function moveHandle(d, key, to) {
  const next = structuredClone(d);
  if (isPosition(d.type)) {
    const direction = d.type === "long" ? 1 : -1;
    const [entry, end] = next.points;
    // Keep stop < entry < target for a long (the reverse for a short), at least one point apart.
    const between = (value, low, high) => Math.max(Math.min(low, high) + 1, Math.min(Math.max(low, high) - 1, value));
    if (key === "entry") {
      entry.price = end.price = between(to.price, d.stop, d.target);
      entry.time = Math.min(to.time, end.time);
    } else if (key === "end") {
      end.time = Math.max(to.time, entry.time);
    } else if (key === "stop") {
      next.stop = direction === 1 ? Math.min(to.price, entry.price - 1) : Math.max(to.price, entry.price + 1);
    } else if (key === "target") {
      next.target = direction === 1 ? Math.max(to.price, entry.price + 1) : Math.min(to.price, entry.price - 1);
    }
    return next;
  }
  if (key === "p0t-p1p") { next.points[0].time = to.time; next.points[1].price = to.price; return next; }
  if (key === "p1t-p0p") { next.points[1].time = to.time; next.points[0].price = to.price; return next; }
  const point = next.points[Number(key.slice(1))];
  point.time = to.time;
  point.price = to.price;
  return next;
}

/** A copy of the drawing moved as a whole. shiftTime(time) -> time moves a time by however many candles the mouse moved. */
export function moveAll(d, shiftTime, priceChange) {
  const next = structuredClone(d);
  for (const p of next.points) {
    p.time = shiftTime(p.time);
    p.price += priceChange;
  }
  if (isPosition(d.type)) {
    next.stop += priceChange;
    next.target += priceChange;
  }
  return next;
}

/** Price of a Fibonacci level: 0 is the second click (where the move ended), 1 the first (where it started). */
export function fibPrice(d, level) {
  const [start, end] = d.points;
  return Math.round(end.price + (start.price - end.price) * level);
}

/** Risk, reward and their ratio for a long/short position drawing, in points. */
export function positionStats(d) {
  const entry = d.points[0].price;
  const risk = Math.abs(entry - d.stop);
  const reward = Math.abs(d.target - entry);
  return { entry, risk, reward, ratio: reward / risk };
}

// ----- what to draw -----------------------------------------------------------
/**
 * Pixel geometry of a drawing.
 * proj = { x(time), y(price), width, height, formatPrice(points), formatTime(time), pips(points) -> number,
 *          textWidth(text) -> pixels, note?(drawing) -> string }
 * Returns { lines: [{x1,y1,x2,y2,role}], boxes: [{x,y,w,h,role}], labels: [{x,y,text,align,role}], handles: [{key,x,y}] }.
 * Colours are not decided here: painting uses the drawing's own colour for the roles "line", "fill" and "text".
 */
export function layout(d, proj) {
  const out = { lines: [], boxes: [], labels: [], handles: [] };
  const X = (time) => proj.x(time), Y = (price) => proj.y(price);
  const box = (xa, ya, xb, yb, role) => out.boxes.push({
    x: Math.min(xa, xb), y: Math.min(ya, yb), w: Math.abs(xb - xa), h: Math.abs(yb - ya), role });

  if (d.type === "hline" || d.type === "hray") {
    const x = X(d.points[0].time), y = Y(d.points[0].price);
    out.lines.push({ x1: d.type === "hray" ? x : 0, y1: y, x2: Math.max(proj.width, x), y2: y, role: "line" });
    out.labels.push({ x: proj.width - 6, y: y - 5, text: proj.formatPrice(d.points[0].price), align: "right", role: "text" });
    out.handles.push({ key: "p0", x, y });
    return out;
  }

  if (d.type === "vline") {
    const x = X(d.points[0].time), y = Y(d.points[0].price);
    out.lines.push({ x1: x, y1: 0, x2: x, y2: proj.height, role: "line" });
    out.labels.push({ x: x + 4, y: proj.height - 6, text: proj.formatTime(d.points[0].time), align: "left", role: "text" });
    out.handles.push({ key: "p0", x, y });
    return out;
  }

  if (d.type === "text") {
    const x = X(d.points[0].time), y = Y(d.points[0].price);
    const w = proj.textWidth(d.text) + 8;
    out.boxes.push({ x: x - 2, y: y - 15, w, h: 20, role: "textbox" }); // invisible: makes the whole text clickable
    out.labels.push({ x: x + 2, y, text: d.text, align: "left", role: "note" });
    out.handles.push({ key: "p0", x: x - 2, y: y + 5 });
    return out;
  }

  if (d.type === "ray") {
    const [a, b] = d.points;
    const xa = X(a.time), ya = Y(a.price), xb = X(b.time), yb = Y(b.price);
    const length = Math.hypot(xb - xa, yb - ya);
    // Carried on through the second point to well past the edge of the chart.
    const k = length === 0 ? 0 : (proj.width + proj.height + 1000) / length;
    out.lines.push({ x1: xa, y1: ya, x2: xa + (xb - xa) * k, y2: ya + (yb - ya) * k, role: "line" });
    out.labels.push({ x: Math.max(xa, xb) + 8, y: yb, text: `${proj.pips(Math.abs(b.price - a.price)).toFixed(1)} pips`, align: "left", role: "measure" });
    for (const h of handles(d)) out.handles.push({ key: h.key, x: X(h.time), y: Y(h.price) });
    return out;
  }

  if (d.type === "trend" || d.type === "rect") {
    const [a, b] = d.points;
    const xa = X(a.time), ya = Y(a.price), xb = X(b.time), yb = Y(b.price);
    if (d.type === "trend") {
      out.lines.push({ x1: xa, y1: ya, x2: xb, y2: yb, role: "line" });
    } else {
      box(xa, ya, xb, yb, "fill");
      for (const [x1, y1, x2, y2] of [[xa, ya, xb, ya], [xb, ya, xb, yb], [xb, yb, xa, yb], [xa, yb, xa, ya]]) {
        out.lines.push({ x1, y1, x2, y2, role: "line" });
      }
    }
    const pips = proj.pips(Math.abs(b.price - a.price)).toFixed(1);
    out.labels.push({ x: Math.max(xa, xb) + 8, y: yb, text: `${pips} pips`, align: "left", role: "measure" });
  } else if (d.type === "fib") {
    const [a, b] = d.points;
    const left = Math.min(X(a.time), X(b.time));
    const right = Math.max(proj.width, left); // levels run to the right edge of the chart
    out.lines.push({ x1: X(a.time), y1: Y(a.price), x2: X(b.time), y2: Y(b.price), role: "guide" });
    const ote = d.ote !== false;
    if (ote) box(left, Y(fibPrice(d, OTE[0])), right, Y(fibPrice(d, OTE[1])), "ote");
    for (const level of fibLevelsOf(d)) {
      const price = fibPrice(d, level);
      const y = Y(price);
      out.lines.push({ x1: left, y1: y, x2: right, y2: y, role: ote && OTE[0] <= level && level <= OTE[1] ? "ote" : "level" });
      out.labels.push({ x: left + 4, y: y - 4, text: `${level} (${proj.formatPrice(price)})`, align: "left", role: "level" });
    }
  } else if (isPosition(d.type)) {
    const [entry, end] = d.points;
    const x0 = X(entry.time), x1 = Math.max(X(end.time), x0 + 1);
    const yEntry = Y(entry.price), yStop = Y(d.stop), yTarget = Y(d.target);
    const stats = positionStats(d);
    box(x0, yEntry, x1, yTarget, "profit");
    box(x0, yEntry, x1, yStop, "loss");
    out.lines.push({ x1: x0, y1: yEntry, x2: x1, y2: yEntry, role: "entry" });
    // A position placed at the newest candle runs into the empty space on the right and often past
    // the edge of the chart. Its handles and labels go in the middle of the part you can SEE, or
    // the stop and target handles would sit off screen where they cannot be grabbed.
    const right = Math.max(x0 + 1, Math.min(x1, proj.width - 10));
    const middle = (x0 + right) / 2;
    const above = (y, other) => (y < other ? y - 5 : y + 14); // put the text outside the box
    out.labels.push({ x: middle, y: above(yTarget, yEntry), align: "center", role: "profit",
      text: `Target ${proj.formatPrice(d.target)} · ${proj.pips(stats.reward).toFixed(1)} pips · ${stats.ratio.toFixed(2)}R` });
    out.labels.push({ x: middle, y: above(yStop, yEntry), align: "center", role: "loss",
      text: `Stop ${proj.formatPrice(d.stop)} · ${proj.pips(stats.risk).toFixed(1)} pips` });
    const note = proj.note ? proj.note(d) : "";
    out.labels.push({ x: middle, y: yEntry - 5, align: "center", role: "entry",
      text: `${d.type === "long" ? "Long" : "Short"} ${proj.formatPrice(entry.price)}${note ? ` · ${note}` : ""}` });
    // The stop and target handles sit in the middle of their edges, away from the entry handle.
    // Labels are centred on the visible part, but never run past the right edge into the price scale.
    if (proj.textWidth) {
      for (const label of out.labels.slice(-3)) {
        const half = proj.textWidth(label.text) / 2;
        label.x = Math.min(Math.max(x0 + half, label.x), proj.width - 4 - half); // the right edge wins over the box's left edge
      }
    }
    out.handles.push({ key: "entry", x: x0, y: yEntry }, { key: "end", x: right, y: yEntry },
      { key: "stop", x: middle, y: yStop }, { key: "target", x: middle, y: yTarget });
    return out;
  }

  for (const h of handles(d)) out.handles.push({ key: h.key, x: X(h.time), y: Y(h.price) });
  return out;
}

// ----- what is under the mouse ------------------------------------------------
export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * What part of a laid-out drawing is at (x, y)?
 * Returns { part: "handle", key } (only when `withHandles`), { part: "body" } or null.
 */
export function hit(shape, x, y, { tolerance = 5, withHandles = false } = {}) {
  if (withHandles) { // the nearest handle wins, so handles close together (a small position) can all be grabbed
    let best = null;
    for (const h of shape.handles) {
      const distance = Math.hypot(x - h.x, y - h.y);
      if (distance <= tolerance + 3 && (!best || distance < best.distance)) best = { key: h.key, distance };
    }
    if (best) return { part: "handle", key: best.key };
  }
  for (const l of shape.lines) {
    if (distanceToSegment(x, y, l.x1, l.y1, l.x2, l.y2) <= tolerance) return { part: "body" };
  }
  for (const b of shape.boxes) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { part: "body" };
  }
  return null;
}

// ----- the measure tool ------------------------------------------------------------
/** "1d 4h 30m", "45m", "0m": a time span in seconds, largest units first, zeros left out. */
export function spanText(seconds) {
  let s = Math.round(Math.abs(seconds) / 60) * 60;
  const parts = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]]) {
    const n = Math.floor(s / size);
    if (n) parts.push(`${n}${unit}`);
    s -= n * size;
  }
  return parts.join(" ") || "0m";
}

/**
 * What the measure tool says between two points { price (points), logical, time }, as TradingView does:
 * the price change, its percent and pips, then the bars and the time between them.
 * `digits` and `pipPoints` describe the symbol (EURUSD: 5 and 10).
 */
export function measureLines(a, b, { digits, pipPoints }) {
  const change = b.price - a.price;
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  const percent = a.price ? (Math.abs(change) / a.price) * 100 : 0;
  const bars = Math.round(Math.abs(b.logical - a.logical));
  return [
    `${sign}${(Math.abs(change) / 10 ** digits).toFixed(digits)} (${sign}${percent.toFixed(2)}%) ${sign}${(Math.abs(change) / pipPoints).toFixed(1)} pips`,
    `${bars} bar${bars === 1 ? "" : "s"}, ${spanText(b.time - a.time)}`,
  ];
}

// ----- keeping them -----------------------------------------------------------
/** A drawing read from storage, or null if it is damaged. Nothing unchecked ever reaches the chart. */
export function cleanDrawing(raw) {
  if (!raw || typeof raw !== "object" || !TOOLS[raw.type] || TOOLS[raw.type].temporary || !Array.isArray(raw.points)) return null;
  const count = ONE_POINT.has(raw.type) ? 1 : 2;
  if (raw.points.length !== count) return null;
  const points = [];
  for (const p of raw.points) {
    if (!p || !whole(p.time) || !whole(p.price) || p.price <= 0) return null;
    points.push({ time: p.time, price: p.price });
  }
  const d = { type: raw.type, points };
  if (raw.type === "text") {
    if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > MAX_TEXT) return null;
    d.text = raw.text;
  }
  if (TOOLS[raw.type].styled) { // an unknown colour or style is dropped, not the drawing
    if (PALETTE.includes(raw.color)) d.color = raw.color;
    if (LINE_STYLES.includes(raw.style) && raw.type !== "text") d.style = raw.style;
  }
  if (raw.type === "fib") { // its own levels and OTE choice, if it has them; anything odd falls back to the standard set
    const levels = cleanFibLevels(raw.levels);
    if (levels) d.levels = levels;
    if (raw.ote === false) d.ote = false;
  }
  if (isPosition(raw.type)) {
    const direction = raw.type === "long" ? 1 : -1;
    const entry = points[0].price;
    if (!whole(raw.stop) || !whole(raw.target)) return null;
    if (!((entry - raw.stop) * direction > 0 && (raw.target - entry) * direction > 0)) return null;
    d.stop = raw.stop;
    d.target = raw.target;
  }
  return d;
}

/**
 * The drawings on the chart, with undo and redo.
 * Every change (add, move, restyle, delete, clear) keeps a copy of the list before it, up to
 * UNDO_LIMIT steps. Loading a list (a new replay, a resumed backtest) starts a fresh history,
 * so undo never reaches into another run. Undo covers drawings only, never trades.
 */
export const UNDO_LIMIT = 100;

export class DrawingStore {
  /** @param {object} options { onChange() } called after every change */
  constructor({ onChange = () => {} } = {}) {
    this.items = []; // in drawing order: later ones are on top
    this.nextId = 1;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
  }

  get(id) { return this.items.find((d) => d.id === id) || null; }

  snapshot() { return { items: structuredClone(this.items), nextId: this.nextId }; }

  /** Remember the list as it is, before a change. */
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() { return this.step(this.undoStack, this.redoStack); }
  redo() { return this.step(this.redoStack, this.undoStack); }

  step(from, to) {
    if (from.length === 0) return false;
    to.push(this.snapshot());
    const { items, nextId } = from.pop();
    this.items = items;
    this.nextId = nextId;
    this.onChange();
    return true;
  }

  add(drawing) {
    this.checkpoint();
    const d = { ...drawing, id: this.nextId++ };
    this.items.push(d);
    this.onChange();
    return d;
  }

  /** Replace a drawing's contents (after a move or a restyle), keeping its id and place in the order. */
  update(id, drawing) {
    const i = this.items.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const next = { ...drawing, id };
    if (JSON.stringify(next) === JSON.stringify(this.items[i])) return this.items[i]; // nothing changed: no undo step
    this.checkpoint();
    this.items[i] = next;
    this.onChange();
    return this.items[i];
  }

  remove(id) {
    if (!this.get(id)) return;
    this.checkpoint();
    this.items = this.items.filter((d) => d.id !== id);
    this.onChange();
  }

  clear() {
    if (this.items.length === 0) return;
    this.checkpoint();
    this.items = [];
    this.onChange();
  }

  toJSON() { return this.items.map(({ id, ...rest }) => rest); }

  /** Load a saved list, skipping anything damaged. Returns how many were kept. */
  load(list) {
    this.items = [];
    this.nextId = 1;
    this.undoStack = [];
    this.redoStack = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const d = cleanDrawing(raw);
      if (d) this.items.push({ ...d, id: this.nextId++ });
    }
    return this.items.length;
  }
}

export function loadSaved(symbol) {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + symbol) || "[]"); } catch { return []; }
}

export function save(symbol, store) {
  try { localStorage.setItem(STORAGE_PREFIX + symbol, JSON.stringify(store.toJSON())); } catch { /* private mode: not saved */ }
}

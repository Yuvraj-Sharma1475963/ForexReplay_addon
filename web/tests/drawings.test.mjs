// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { Candles } from "../js/data.js";
import {
  cleanDrawing, cleanFibLevels, createDrawing, distanceToSegment, DrawingStore, FIB_LEVELS, fibPrice, handles, hit, layout,
  logicalToTime, MAX_TEXT, measureLines, moveAll, moveHandle, PALETTE, positionLevel, positionStats, snapPrice, spanText, timeToLogical, TOOLS,
  UNDO_LIMIT,
} from "../js/drawings.js";
import { SHORTCUTS, shortcutFor } from "../js/shortcuts.js";
import { aggregate, TimeframeView } from "../js/timeframes.js";

const utc = (text) => Date.parse(text + "Z") / 1000;
const T0 = utc("2025-08-04T07:00"); // a Monday, on an hour boundary of the broker clock

/** n M5 candles from T0; `skipAfter` leaves a gap (like a weekend) after that index. */
function candles(n, skipAfter = null, gapSeconds = 0) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const time = T0 + i * 300 + (skipAfter !== null && i > skipAfter ? gapSeconds : 0);
    rows.push([time, 110000, 110020, 109980, 110005, 10, 0]);
  }
  return Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
}

/** A simple screen: 10 pixels per candle, 1 pixel per point, price 110000 at y = 500. */
function screen(c, tfSeconds = 300) {
  return {
    x: (time) => timeToLogical(c, tfSeconds, time) * 10,
    y: (price) => 500 - (price - 110000),
    width: 800,
    height: 600,
    formatPrice: (points) => (points / 1e5).toFixed(5),
    formatTime: (time) => `t${time}`,
    pips: (points) => points / 10,
    textWidth: (text) => text.length * 7,
    note: () => "1.00 lots",
  };
}
const defaults = (c) => ({ pipPoints: 10, barsAhead: (time, bars) => logicalToTime(c, 300, timeToLogical(c, 300, time) + bars) });

test("a time inside the data maps to its candle; a weekend takes no space", () => {
  const c = candles(20, 9, 2 * 86400); // a two-day gap after candle 9
  assert.equal(timeToLogical(c, 300, c.time[4]), 4);
  assert.equal(timeToLogical(c, 300, c.time[4] + 120), 4);           // inside candle 4
  assert.equal(timeToLogical(c, 300, c.time[9] + 86400), 9);         // in the gap: the last candle before it
  assert.equal(timeToLogical(c, 300, c.time[10]), 10);               // first candle after the gap is the next slot
  for (let i = 0; i < 20; i++) assert.equal(logicalToTime(c, 300, i), c.time[i]);
});

test("the empty space to the right of the last candle continues at the timeframe's spacing", () => {
  const c = candles(20);
  const last = c.time[19];
  assert.equal(logicalToTime(c, 300, 24), last + 5 * 300);
  assert.equal(timeToLogical(c, 300, last + 5 * 300), 24);
  assert.equal(logicalToTime(c, 300, 23.6), last + 5 * 300);          // the nearest slot
  assert.equal(logicalToTime(c, 300, -2), c.time[0] - 600);
  assert.equal(timeToLogical(c, 300, c.time[0] - 600), -2);
});

test("a point drawn on M5 lands on the H1 candle that contains it", () => {
  const m5 = candles(48);
  const h1 = aggregate(m5, "H1").candles;
  const anchor = m5.time[17];                                         // 08:25, inside the second hour
  assert.equal(timeToLogical(h1, 3600, anchor), 1);
  assert.equal(h1.time[1], T0 + 3600);
});

test("every tool starts from one click", () => {
  const c = candles(40);
  const at = { time: c.time[10], price: 110000 };
  assert.deepEqual(createDrawing("hline", at, defaults(c)), { type: "hline", points: [at] });
  assert.deepEqual(createDrawing("trend", at, defaults(c)).points, [at, at]);
  const long = createDrawing("long", at, defaults(c));
  assert.deepEqual([long.stop, long.target], [109900, 110200]);       // 10 pips of risk, 20 of reward
  assert.equal(long.points[1].time, c.time[34]);                      // 24 candles wide
  const short = createDrawing("short", at, defaults(c));
  assert.deepEqual([short.stop, short.target], [110100, 109800]);
  assert.deepEqual(positionStats(short), { entry: 110000, risk: 100, reward: 200, ratio: 2 });
  // Two-click tools are empty until the second click; text is empty until it is typed.
  for (const type of Object.keys(TOOLS)) assert.ok(cleanDrawing(createDrawing(type, at, defaults(c))) || TOOLS[type].clicks === 2 || type === "text");
});

test("Fibonacci levels run from the end of the move (0) back to its start (1), with OTE at 0.618 to 0.79", () => {
  const fib = { type: "fib", points: [{ time: T0, price: 110000 }, { time: T0 + 3000, price: 111000 }] }; // an up move of 100 pips
  assert.equal(fibPrice(fib, 0), 111000);
  assert.equal(fibPrice(fib, 1), 110000);
  assert.equal(fibPrice(fib, 0.5), 110500);
  assert.equal(fibPrice(fib, 0.618), 110382);                         // a 61.8% pullback from the high
  assert.equal(fibPrice(fib, 0.705), 110295);
  assert.equal(fibPrice(fib, 0.79), 110210);
  const shape = layout(fib, screen(candles(40)));
  assert.equal(shape.lines.filter((l) => l.role === "ote").length, 3); // 0.618, 0.705, 0.79
  assert.equal(shape.lines.filter((l) => l.role === "level").length, FIB_LEVELS.length - 3);
  assert.equal(shape.boxes.filter((b) => b.role === "ote").length, 1);
  assert.ok(shape.labels.some((t) => t.text === "0.705 (1.10295)"));
});

test("moving a handle reshapes; moving the body shifts every point by the same candles and price", () => {
  const c = candles(40);
  const trend = { type: "trend", points: [{ time: c.time[5], price: 110000 }, { time: c.time[15], price: 110100 }] };
  const reshaped = moveHandle(trend, "p1", { time: c.time[20], price: 110050 });
  assert.deepEqual(reshaped.points, [{ time: c.time[5], price: 110000 }, { time: c.time[20], price: 110050 }]);
  assert.deepEqual(trend.points[1], { time: c.time[15], price: 110100 }); // the original is untouched
  const shift = (time) => logicalToTime(c, 300, timeToLogical(c, 300, time) + 3);
  const moved = moveAll(trend, shift, -40);
  assert.deepEqual(moved.points, [{ time: c.time[8], price: 109960 }, { time: c.time[18], price: 110060 }]);
});

test("a rectangle can be reshaped from any of its four corners", () => {
  const rect = { type: "rect", points: [{ time: 100, price: 110000 }, { time: 200, price: 110100 }] };
  assert.equal(handles(rect).length, 4);
  const moved = moveHandle(rect, "p0t-p1p", { time: 50, price: 110300 }); // the corner at p0's time and p1's price
  assert.deepEqual(moved.points, [{ time: 50, price: 110000 }, { time: 200, price: 110300 }]);
});

test("a position tool keeps stop, entry and target in order however its handles are dragged", () => {
  const c = candles(40);
  const long = createDrawing("long", { time: c.time[10], price: 110000 }, defaults(c));
  assert.equal(moveHandle(long, "stop", { time: 0, price: 110500 }).stop, 109999);     // cannot cross the entry
  assert.equal(moveHandle(long, "target", { time: 0, price: 109000 }).target, 110001);
  assert.equal(moveHandle(long, "entry", { time: c.time[10], price: 120000 }).points[0].price, 110199); // stays below the target
  assert.equal(moveHandle(long, "end", { time: c.time[2], price: 0 }).points[1].time, c.time[10]);     // never left of the entry
  const moved = moveAll(long, (t) => t, 50);
  assert.deepEqual([moved.points[0].price, moved.stop, moved.target], [110050, 109950, 110250]);
  assert.ok(cleanDrawing(moved));
});

test("layout of a long position: green above, red below, with pips, R and the size note", () => {
  const c = candles(40);
  const long = createDrawing("long", { time: c.time[10], price: 110000 }, defaults(c));
  const shape = layout(long, screen(c));
  const profit = shape.boxes.find((b) => b.role === "profit"), loss = shape.boxes.find((b) => b.role === "loss");
  assert.deepEqual(profit, { x: 100, y: 300, w: 240, h: 200, role: "profit" });
  assert.deepEqual(loss, { x: 100, y: 500, w: 240, h: 100, role: "loss" });
  assert.deepEqual(shape.labels.map((t) => t.text), [
    "Target 1.10200 · 20.0 pips · 2.00R", "Stop 1.09900 · 10.0 pips", "Long 1.10000 · 1.00 lots"]);
  assert.deepEqual(shape.handles.map((h) => h.key), ["entry", "end", "stop", "target"]);
});

test("the mouse finds a line within a few pixels, a box anywhere inside, and handles only when selected", () => {
  assert.equal(distanceToSegment(5, 5, 0, 0, 10, 0), 5);
  assert.equal(distanceToSegment(-3, 4, 0, 0, 10, 0), 5); // past the end: distance to the end point
  const c = candles(40);
  const trend = layout({ type: "trend", points: [{ time: c.time[5], price: 110000 }, { time: c.time[15], price: 110100 }] }, screen(c));
  assert.deepEqual(hit(trend, 100, 453), { part: "body" });      // the line passes through (100, 450)
  assert.equal(hit(trend, 100, 470), null);
  assert.deepEqual(hit(trend, 52, 498, { withHandles: true }), { part: "handle", key: "p0" });
  assert.deepEqual(hit(trend, 52, 498), { part: "body" });       // not selected: the same spot is just the line
  const rect = layout({ type: "rect", points: [{ time: c.time[5], price: 110000 }, { time: c.time[15], price: 110100 }] }, screen(c));
  assert.deepEqual(hit(rect, 100, 450), { part: "body" });       // inside
  assert.equal(hit(rect, 200, 450), null);
  const hline = layout({ type: "hline", points: [{ time: c.time[5], price: 110050 }] }, screen(c));
  assert.deepEqual(hit(hline, 700, 452), { part: "body" });      // anywhere along the chart
});

test("the store keeps order, survives save and load, and drops damaged drawings", () => {
  let changes = 0;
  const store = new DrawingStore({ onChange: () => { changes++; } });
  const a = store.add({ type: "hline", points: [{ time: T0, price: 110000 }] });
  const b = store.add({ type: "trend", points: [{ time: T0, price: 110000 }, { time: T0 + 300, price: 110100 }] });
  store.update(a.id, { type: "hline", points: [{ time: T0, price: 110500 }] });
  assert.equal(store.get(a.id).points[0].price, 110500);
  assert.deepEqual(store.items.map((d) => d.id), [a.id, b.id]);
  const saved = JSON.parse(JSON.stringify(store));
  assert.ok(saved.every((d) => !("id" in d)));
  store.remove(b.id);
  assert.equal(changes, 4);

  const loaded = new DrawingStore();
  const kept = loaded.load([...saved, { type: "circle", points: [] }, { type: "hline", points: [{ time: "x", price: 1 }] },
    { type: "long", points: saved[0].points.concat(saved[0].points), stop: 120000, target: 130000 }, null, "junk"]);
  assert.equal(kept, 2);
  assert.deepEqual(loaded.toJSON(), saved);
  assert.equal(loaded.load("not a list"), 0);
});

test("a ray carries on through its second point past the edge; a horizontal ray starts at its candle", () => {
  const c = candles(40);
  const ray = layout({ type: "ray", points: [{ time: c.time[5], price: 110000 }, { time: c.time[10], price: 110050 }] }, screen(c));
  const [line] = ray.lines;
  assert.ok(line.x2 > 800 && line.y2 < 0);                          // well past the right or top edge
  assert.ok(Math.abs((line.y2 - line.y1) / (line.x2 - line.x1) - (-50 / 50)) < 1e-9); // the same slope as its two points
  assert.deepEqual(hit(ray, 300, 250), { part: "body" });          // far beyond the second point, on the line
  assert.equal(hit(ray, 20, 520), null);                           // but not behind the first point

  const hray = layout({ type: "hray", points: [{ time: c.time[30], price: 110050 }] }, screen(c));
  assert.deepEqual(hray.lines[0], { x1: 300, y1: 450, x2: 800, y2: 450, role: "line" });
  assert.equal(hit(hray, 100, 450), null);                         // nothing to the left of its candle
  const hline = layout({ type: "hline", points: [{ time: c.time[30], price: 110050 }] }, screen(c));
  assert.equal(hline.lines[0].x1, 0);

  const vline = layout({ type: "vline", points: [{ time: c.time[12], price: 110000 }] }, screen(c));
  assert.deepEqual(vline.lines[0], { x1: 120, y1: 0, x2: 120, y2: 600, role: "line" });
  assert.equal(vline.labels[0].text, `t${c.time[12]}`);
});

test("a text note is clickable over its whole width, and must have some text", () => {
  const c = candles(40);
  const at = { time: c.time[10], price: 110000 };
  const note = { type: "text", points: [at], text: "London sweep" };
  const shape = layout(note, screen(c));
  assert.equal(shape.labels[0].text, "London sweep");
  assert.deepEqual(hit(shape, 100 + 12 * 7, 495), { part: "body" }); // near the end of the text
  assert.equal(hit(shape, 100 + 12 * 7 + 20, 495), null);
  assert.deepEqual(createDrawing("text", at, defaults(c)), { type: "text", points: [at], text: "" });
  assert.equal(cleanDrawing({ ...note, text: "   " }), null);
  assert.equal(cleanDrawing({ ...note, text: "x".repeat(MAX_TEXT + 1) }), null);
  assert.deepEqual(cleanDrawing(note), note);
});

test("colours and line styles are kept only where they belong", () => {
  const p = [{ time: T0, price: 110000 }, { time: T0 + 300, price: 110100 }];
  assert.deepEqual(cleanDrawing({ type: "trend", points: p, color: PALETTE[2], style: "dashed" }),
    { type: "trend", points: p, color: PALETTE[2], style: "dashed" });
  assert.deepEqual(cleanDrawing({ type: "trend", points: p, color: "red; drop table", style: "wavy" }), { type: "trend", points: p });
  assert.deepEqual(cleanDrawing({ type: "fib", points: p, color: PALETTE[2] }), { type: "fib", points: p }); // fib keeps its OTE colours
  assert.deepEqual(cleanDrawing({ type: "text", points: [p[0]], text: "a", color: PALETTE[1], style: "dotted" }),
    { type: "text", points: [p[0]], text: "a", color: PALETTE[1] });
});

test("the magnet snaps to the nearest open, high, low or close, and never to a hidden candle", () => {
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push([T0 + i * 300, 110000, 110000 + 10 * (i + 1), 109990, 110005, 10, 0]); // highs keep rising
  const m5 = Candles.fromBuffer(new Int32Array(rows.flat()).buffer);
  assert.equal(snapPrice(m5, 3, 110030), 110040);                  // high of candle 3
  assert.equal(snapPrice(m5, 3, 109992), 109990);                  // its low
  assert.equal(snapPrice(m5, 3.4, 110003), 110005);                // the close; the position rounds to candle 3
  assert.equal(snapPrice(m5, 30, 110003), 110003);                 // past the candles: left alone
  // In a replay, an H1 candle with only 6 of its 12 M5 candles revealed offers the high of those 6 only.
  const view = new TimeframeView(m5, "H1");
  view.setPosition(6);
  assert.equal(snapPrice(view.display, 0, 120000), 110060);        // not 110120, the high of the whole hour
});

test("undo and redo step back and forth through every change, and a new change clears redo", () => {
  const store = new DrawingStore();
  const line = (price) => ({ type: "hline", points: [{ time: T0, price }] });
  const a = store.add(line(110000));
  store.update(a.id, line(110100));
  store.update(a.id, line(110100)); // no change: no undo step
  const b = store.add(line(110200));
  store.remove(a.id);
  store.clear();
  const prices = () => store.items.map((d) => d.points[0].price);
  assert.deepEqual(prices(), []);
  assert.ok(store.undo()); assert.deepEqual(prices(), [110200]);
  assert.ok(store.undo()); assert.deepEqual(prices(), [110100, 110200]);
  assert.ok(store.undo()); assert.deepEqual(prices(), [110100]);
  assert.ok(store.redo()); assert.deepEqual(prices(), [110100, 110200]);
  assert.equal(store.get(b.id).points[0].price, 110200);         // ids come back too
  store.add(line(110300));
  assert.equal(store.canRedo, false);
  assert.ok(store.undo()); assert.ok(store.undo()); assert.ok(store.undo()); assert.ok(store.undo());
  assert.deepEqual(prices(), []);
  assert.equal(store.undo(), false);
  for (let i = 0; i < UNDO_LIMIT + 20; i++) store.add(line(110000 + i));
  assert.equal(store.undoStack.length, UNDO_LIMIT);
  store.load([]);                                                 // a new run starts a fresh history
  assert.equal(store.canUndo, false);
});

test("shortcuts: modifiers must match exactly, Cmd counts as Ctrl, and no two shortcuts share a key", () => {
  const key = (code, mods = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(shortcutFor(key("KeyT", { altKey: true })), "tool:trend");
  assert.equal(shortcutFor(key("KeyT")), null);
  assert.equal(shortcutFor(key("KeyZ", { ctrlKey: true })), "undo");
  assert.equal(shortcutFor(key("KeyZ", { metaKey: true })), "undo");
  assert.equal(shortcutFor(key("KeyZ", { ctrlKey: true, shiftKey: true })), "redo");
  assert.equal(shortcutFor(key("KeyZ", { ctrlKey: true, altKey: true })), null);
  const combos = SHORTCUTS.map((s) => `${s.code}:${!!s.ctrl}:${!!s.alt}:${!!s.shift}`);
  assert.equal(new Set(combos).size, combos.length);
  for (const s of SHORTCUTS) {
    if (s.action.startsWith("tool:")) assert.ok(TOOLS[s.action.slice(5)], s.action);
  }
  for (const tool of Object.keys(TOOLS)) assert.ok(SHORTCUTS.some((s) => s.action === `tool:${tool}`), `no shortcut for ${tool}`);
});

test("a position running off the right edge keeps its stop and target handles on screen", () => {
  // Placed at the newest candle: 24 candles wide, but only a few candles of room before the edge.
  const c = candles(40);
  const long = createDrawing("long", { time: c.time[36], price: 110000 }, defaults(c));
  const proj = { ...screen(c), width: 420 };                 // the chart ends at x = 420 (candle 42)
  const shape = layout(long, proj);
  const handle = (key) => shape.handles.find((h) => h.key === key);
  for (const key of ["stop", "target", "end"]) assert.ok(handle(key).x < proj.width, `${key} handle at x ${handle(key).x}`);
  assert.equal(handle("stop").x, (360 + 410) / 2);           // the middle of the visible part, not of the whole box
  assert.deepEqual(hit(shape, handle("stop").x, handle("stop").y, { withHandles: true }), { part: "handle", key: "stop" });
  const dragged = moveHandle(long, "stop", { time: c.time[36], price: 109850 });
  assert.equal(dragged.stop, 109850);
});

test("on a small position the handle nearest the mouse is grabbed, not the first one listed", () => {
  const c = candles(40);
  const long = { ...createDrawing("long", { time: c.time[10], price: 110000 }, defaults(c)), stop: 109996, target: 110004 };
  const shape = layout(long, screen(c));
  const target = shape.handles.find((h) => h.key === "target");
  assert.deepEqual(hit(shape, target.x, target.y - 2, { withHandles: true }), { part: "handle", key: "target" });
});

test("position labels stay inside the chart when the box runs past its right edge", () => {
  const c = candles(40);
  const long = createDrawing("long", { time: c.time[36], price: 110000 }, defaults(c));
  const proj = { ...screen(c), width: 420 };                  // textWidth: 7 px per character
  for (const label of layout(long, proj).labels) {
    assert.ok(label.x + (label.text.length * 7) / 2 <= proj.width - 4 + 1e-9, `"${label.text}" runs past the edge`);
  }
});

test("the magnet only pulls a price that is already close to a candle price", () => {
  const c = candles(10); // every candle: open 110000, high 110020, low 109980, close 110005
  assert.equal(snapPrice(c, 3, 110017, 5), 110020);   // 3 points from the high: snaps
  assert.equal(snapPrice(c, 3, 109900, 5), 109900);   // 80 points from anything: stays where the mouse is
  assert.equal(snapPrice(c, 3, 109900), 109980);      // no limit given: the old, always-snapping behaviour
});

test("a magnet never folds a position's stop or target onto its entry", () => {
  const c = candles(40);
  const long = createDrawing("long", { time: c.time[10], price: 109970 }, defaults(c)); // entry below every candle price
  // Dragging the stop with the magnet: the nearest candle price (109980) is ABOVE the entry, so it is ignored.
  assert.equal(positionLevel(long, "stop", 109980, 109940), 109940);
  assert.equal(moveHandle(long, "stop", { time: c.time[10], price: positionLevel(long, "stop", 109980, 109940) }).stop, 109940);
  assert.equal(positionLevel(long, "stop", 109950, 109952), 109950);  // a snap on the right side is kept
  const short = createDrawing("short", { time: c.time[10], price: 110030 }, defaults(c)); // entry above every candle price
  assert.equal(positionLevel(short, "target", 110040, 110000), 110000); // the target cannot snap above a short's entry
  assert.equal(positionLevel(short, "target", 110020, 110000), 110020); // below the entry is fine
  assert.equal(positionLevel(long, "entry", 109980, 109940), 109980);   // other handles snap as usual
});

test("a Fibonacci can have its own levels, extensions included, and hide the OTE zone", () => {
  const c = candles(40);
  const p = [{ time: c.time[5], price: 110000 }, { time: c.time[15], price: 110100 }]; // move up: 1 at 110000, 0 at 110100
  const fib = { type: "fib", points: p, levels: [-0.27, 0, 0.5, 1, 1.618] };
  const shape = layout(fib, screen(c));
  const texts = shape.labels.map((l) => l.text.split(" ")[0]);
  assert.deepEqual(texts, ["-0.27", "0", "0.5", "1", "1.618"]);
  assert.equal(fibPrice(fib, -0.27), 110127);                // beyond the end of the move
  assert.equal(fibPrice(fib, 1.618), 109938);                // beyond its start
  assert.ok(shape.boxes.some((b) => b.role === "ote"));      // the zone is shaded by default
  const plain = layout({ ...fib, ote: false }, screen(c));
  assert.ok(!plain.boxes.some((b) => b.role === "ote"));
  assert.ok(plain.lines.every((l) => l.role !== "ote"));
  // A Fibonacci without its own levels shows the standard set (drawings saved before this change).
  assert.equal(layout({ type: "fib", points: p }, screen(c)).labels.length, FIB_LEVELS.length);
});

test("Fibonacci levels from a save are made safe; damaged ones fall back to the standard set", () => {
  assert.deepEqual(cleanFibLevels([1.618, "0.5", 0.5, 99, -7, NaN, 0.70500001, 0]), [0, 0.5, 0.705, 1.618]);
  assert.equal(cleanFibLevels([]), null);
  assert.equal(cleanFibLevels("0.5"), null);
  assert.equal(cleanFibLevels(Array.from({ length: 40 }, (_, i) => i / 10)).length, 24);
  const p = [{ time: T0, price: 110000 }, { time: T0 + 300, price: 110100 }];
  assert.deepEqual(cleanDrawing({ type: "fib", points: p, levels: [0.5, 1.272], ote: false }), { type: "fib", points: p, levels: [0.5, 1.272], ote: false });
  assert.deepEqual(cleanDrawing({ type: "fib", points: p, levels: ["x"], ote: "no" }), { type: "fib", points: p });
});

test("the measure tool: price change, %, pips, bars and time, and it is never saved", () => {
  const a = { price: 108500, logical: 100, time: 1772701200 };
  const up = measureLines(a, { price: 108623, logical: 118, time: 1772701200 + 18 * 900 }, { digits: 5, pipPoints: 10 });
  assert.deepEqual(up, ["+0.00123 (+0.11%) +12.3 pips", "18 bars, 4h 30m"]);
  const down = measureLines(a, { price: 108450, logical: 99, time: 1772701200 - 900 }, { digits: 5, pipPoints: 10 });
  assert.deepEqual(down, ["−0.00050 (−0.05%) −5.0 pips", "1 bar, 15m"]);
  assert.equal(spanText(0), "0m");
  assert.equal(spanText(86400 + 4 * 3600 + 30 * 60), "1d 4h 30m");
  assert.equal(spanText(2 * 86400), "2d");
  assert.equal(TOOLS.measure.temporary, true);
  assert.equal(cleanDrawing({ type: "measure", points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] }), null);
});

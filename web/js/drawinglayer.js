// Drawings on the chart: painting them, and creating, selecting, moving and deleting them with the mouse.
//
// What a drawing is and where its lines go is decided in drawings.js (pure, tested without a
// browser). This file is the thin part that needs a real chart: it converts between pixels and
// time/price, paints with the chart library's "primitive" hook, and listens to the mouse.
//
// Mouse rules, the same as TradingView:
//  * Pick a tool, click once (horizontal line, long, short) or twice (trendline, rectangle,
//    Fibonacci). Press-drag-release also works for the two-click tools. The tool then switches off.
//  * Click a drawing to select it. Drag a handle to reshape it, drag its body to move it.
//  * Delete removes the selected drawing. Esc cancels whatever is in progress.
//  * Text: click where the note goes, type, press Enter. Double-click a note to change it.
//  * Magnet: new points and dragged handles jump to the nearest open, high, low or close of
//    the candle under the mouse. Holding Ctrl turns it the other way for that move.
//  * Measure (the ruler, or Shift + click anywhere): click a start, move, click to freeze. It shows
//    the price change, %, pips, bars and time, and is never saved. The next click or Esc removes it.

import {
  createDrawing, hit, layout, logicalToTime, MAX_TEXT, measureLines, moveAll, moveHandle, PALETTE, positionLevel, snapPrice, timeToLogical, TOOLS,
} from "./drawings.js";
import { formatDateTime } from "./time.js";
import { timeframe as timeframeInfo } from "./timeframes.js";

const BLUE = PALETTE[0];
const MAGNET_PIXELS = 12; // the magnet only pulls a point this close to a candle price
const DASHES = { solid: [], dashed: [6, 4], dotted: [1.5, 3] };
const STYLE = {
  line: { stroke: BLUE, width: 1.5 },
  text: { text: BLUE },
  note: { text: "#dbdbdb" },
  textbox: { fill: "rgba(0, 0, 0, 0)" },
  guide: { stroke: "rgba(120, 123, 134, 0.8)", width: 1, dash: [4, 4] },
  level: { stroke: "rgba(120, 123, 134, 0.9)", width: 1 },
  ote: { stroke: "#f5a623", width: 1, fill: "rgba(245, 166, 35, 0.10)" },
  fill: { fill: "rgba(41, 98, 255, 0.12)" },
  profit: { fill: "rgba(8, 153, 129, 0.22)", text: "#089981" },
  loss: { fill: "rgba(242, 54, 69, 0.22)", text: "#f23645" },
  entry: { stroke: "#dbdbdb", width: 1, text: "#dbdbdb" },
  measure: { text: "#b2b5be" },
};
const FONT = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
const NOTE_FONT = '13px -apple-system, "Segoe UI", Roboto, sans-serif';

/** "#2962ff" with an alpha, for a rectangle's fill in the drawing's own colour. */
const withAlpha = (hex, alpha) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})`;

/** How a role is painted for this drawing: the drawing's colour and line style where it has them. */
function styleFor(role, d) {
  const base = STYLE[role];
  if (!d.color && !d.style) return base;
  if (role === "line") return { ...base, stroke: d.color || base.stroke, dash: DASHES[d.style || "solid"] };
  if (role === "fill") return { fill: withAlpha(d.color || BLUE, 0.12) };
  if (role === "text" || role === "note") return { text: d.color || base.text };
  return base;
}

export class DrawingLayer {
  /**
   * @param {ChartView} view
   * @param {object} options { store: DrawingStore, pipPoints, note(drawing) -> text for position tools,
   *   onSelect(drawing | null), onToolChange(tool | null), editor: <input> for text notes,
   *   styleDefaults: { tool: { color, style } } for new drawings, onStyleDefaults(map) when they change }
   */
  constructor(view, { store, pipPoints, note, onSelect, onToolChange, editor, styleDefaults = {}, onStyleDefaults }) {
    this.view = view;
    this.store = store;
    this.pipPoints = pipPoints;
    this.note = note || (() => "");
    this.onSelect = onSelect || (() => {});
    this.onToolChange = onToolChange || (() => {});
    this.tool = null; // the drawing tool waiting for clicks, or null
    this.draft = null; // a drawing being created (after its first click)
    this.selectedId = null;
    this.drag = null; // { id, hit, start, original, current, moved } while a drawing is being moved
    this.paneWidth = 0;
    this.paneHeight = 0;
    this.magnet = false;
    this.styleDefaults = styleDefaults;
    this.fibDefaults = null; // { levels, ote } that new Fibonacci drawings start with (null: the standard set)
    this.onStyleDefaults = onStyleDefaults || (() => {});
    this.editor = editor;
    this.editing = null; // { id } or { draft } while a text note is being typed
    this.ruler = null; // { a, b, live } while measuring: points { time, price, logical }; live until the second click
    this.measure = document.createElement("canvas").getContext("2d");
    this.measure.font = NOTE_FONT;

    const draw = (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize));
    const paneView = { zOrder: () => "top", renderer: () => ({ draw }) };
    this.primitive = {
      attached: ({ requestUpdate }) => { this.requestUpdate = requestUpdate; },
      detached: () => { this.requestUpdate = null; },
      updateAllViews: () => {},
      paneViews: () => [paneView],
    };
    view.series.attachPrimitive(this.primitive);

    const el = view.container;
    el.addEventListener("mousedown", (event) => this.handleDown(event), true); // capture: before the chart pans
    el.addEventListener("mousemove", (event) => this.handleHover(event));
    el.addEventListener("dblclick", (event) => this.handleDoubleClick(event));
    this.dragMove = (event) => this.handleDragMove(event);
    this.release = (event) => this.handleUp(event);
    if (editor) {
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); this.finishText(true); }
        if (event.key === "Escape") { event.preventDefault(); this.finishText(false); }
      });
      editor.addEventListener("blur", () => this.finishText(true));
    }
  }

  redraw() {
    if (this.requestUpdate) this.requestUpdate();
  }

  // ----- pixels <-> time and price ----------------------------------------------
  get tfSeconds() { return timeframeInfo(this.view.timeframe).seconds; }

  projection() {
    const v = this.view;
    const scale = v.chart.timeScale();
    const unit = 10 ** v.digits;
    return {
      x: (time) => scale.logicalToCoordinate(timeToLogical(v.candles, this.tfSeconds, time)) ?? 0,
      y: (price) => v.series.priceToCoordinate(price / unit) ?? 0,
      width: this.paneWidth,
      height: this.paneHeight,
      formatPrice: (points) => (points / unit).toFixed(v.digits),
      formatTime: (time) => formatDateTime(time).split(", ").join(" "),
      pips: (points) => points / this.pipPoints,
      textWidth: (text) => this.measure.measureText(text).width,
      note: this.note,
    };
  }

  /**
   * Where the mouse is: { x, y, logical, time, price }. `anywhere` also accepts positions outside the price pane.
   * `snap`: apply the magnet (Ctrl held turns it the other way).
   */
  pointAt(event, anywhere = false, snap = false) {
    const v = this.view;
    if (!v.candles) return null;
    let point = v.panePoint(event);
    if (!point) {
      if (!anywhere) return null;
      const box = v.container.getBoundingClientRect();
      point = { x: event.clientX - box.left, y: event.clientY - box.top };
    }
    const logical = v.chart.timeScale().coordinateToLogical(point.x);
    const price = v.series.coordinateToPrice(point.y);
    if (logical === null || price === null) return null;
    const raw = Math.round(price * 10 ** v.digits);
    let points = raw;
    if (snap && this.magnet !== !!event.ctrlKey) {
      const near = v.series.coordinateToPrice(point.y + MAGNET_PIXELS); // how many points 12 pixels cover right now
      const reach = near === null ? 0 : Math.abs(raw - Math.round(near * 10 ** v.digits));
      points = snapPrice(v.candles, logical, raw, reach);
    }
    return { ...point, logical, time: logicalToTime(v.candles, this.tfSeconds, logical), price: points, rawPrice: raw };
  }

  setMagnet(on) {
    this.magnet = !!on;
  }

  /** Change the colour or line style of the selected drawing; new drawings of that tool get it too. */
  restyle(changes) {
    const d = this.selected;
    if (!d || !TOOLS[d.type].styled) return false;
    const { id, ...rest } = d;
    this.store.update(id, { ...rest, ...changes });
    this.styleDefaults = { ...this.styleDefaults, [d.type]: { ...this.styleDefaults[d.type], ...changes } };
    this.onStyleDefaults(this.styleDefaults);
    this.onSelect(this.selected);
    return true;
  }

  // ----- text notes ----------------------------------------------------------------------
  /** Open the text box over the chart for a new note (`draft`) or an existing one (`id`). */
  editText({ id = null, draft = null }) {
    if (!this.editor) return;
    const d = draft || this.store.get(id);
    if (!d) return;
    this.editing = { id, draft };
    const proj = this.projection();
    const chartBox = this.view.container.getBoundingClientRect();
    const parentBox = this.editor.offsetParent ? this.editor.offsetParent.getBoundingClientRect() : chartBox;
    this.editor.hidden = false;
    this.editor.maxLength = MAX_TEXT;
    this.editor.value = d.text || "";
    this.editor.style.left = `${chartBox.left - parentBox.left + proj.x(d.points[0].time) - 4}px`;
    this.editor.style.top = `${chartBox.top - parentBox.top + proj.y(d.points[0].price) - 18}px`;
    this.editor.style.color = d.color || STYLE.note.text;
    this.editor.focus();
    this.editor.select();
    this.redraw();
  }

  /** Enter or clicking away keeps the text; Esc or an empty box keeps nothing (an existing note is left as it was). */
  finishText(keep) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    this.editor.hidden = true;
    const text = this.editor.value.trim().slice(0, MAX_TEXT);
    if (keep && text) {
      if (editing.draft) {
        const added = this.store.add({ ...editing.draft, text });
        this.select(added.id);
      } else {
        const { id, ...rest } = this.store.get(editing.id) || {};
        if (id !== undefined) this.store.update(id, { ...rest, text });
        this.onSelect(this.selected);
      }
    }
    this.redraw();
  }

  handleDoubleClick(event) {
    const at = this.pointAt(event);
    if (!at || this.tool) return;
    const found = this.find(at.x, at.y);
    if (found && this.store.get(found.id).type === "text") this.editText({ id: found.id });
  }

  // ----- tools and selection --------------------------------------------------------
  setTool(tool) {
    this.tool = tool && TOOLS[tool] ? tool : null;
    this.draft = null;
    // Picking a tool clears a finished measurement; switching tools off (Esc) drops one still following the mouse.
    if (this.ruler && (this.tool || this.ruler.live)) this.ruler = null;
    this.view.toolActive = !!this.tool; // trade lines are not draggable while a tool is waiting for clicks
    if (this.tool) this.select(null);
    this.view.container.classList.toggle("tool-active", !!this.tool);
    this.onToolChange(this.tool);
    this.redraw();
  }

  select(id) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.onSelect(id === null ? null : this.store.get(id));
    this.redraw();
  }

  get selected() { return this.selectedId === null ? null : this.store.get(this.selectedId); }

  deleteSelected() {
    if (this.selectedId === null) return false;
    const id = this.selectedId;
    this.select(null);
    this.store.remove(id);
    return true;
  }

  /** Esc: drop the drawing in progress, then the tool, then the selection. Returns true if there was anything to cancel. */
  cancel() {
    if (this.ruler) { this.ruler = null; if (this.tool === "measure") this.setTool(null); this.redraw(); return true; }
    if (this.editing) { this.finishText(false); return true; }
    if (this.drag) { this.finishDrag(true); return true; }
    if (this.tool) { this.setTool(null); return true; }
    if (this.selectedId !== null) { this.select(null); return true; }
    return false;
  }

  /** The store changed from outside (cleared, loaded): drop a selection that no longer exists. */
  storeChanged() {
    if (this.selectedId !== null && !this.store.get(this.selectedId)) this.select(null);
    this.redraw();
  }

  /** The drawing under (x, y), topmost first; the selected one also offers its handles. */
  find(x, y) {
    const proj = this.projection();
    const selected = this.selected;
    if (selected) {
      const found = hit(layout(selected, proj), x, y, { withHandles: true });
      if (found && found.part === "handle") return { id: selected.id, hit: found };
    }
    for (let i = this.store.items.length - 1; i >= 0; i--) {
      const d = this.store.items[i];
      const found = hit(layout(d, proj), x, y);
      if (found) return { id: d.id, hit: found };
    }
    return null;
  }

  // ----- mouse ------------------------------------------------------------------------
  handleDown(event) {
    if (event.target.closest && event.target.closest(".chart-nav")) return; // the zoom and scroll buttons
    if (event.button !== 0 || this.view.drag) return; // a trade line is being dragged
    if (this.editing) return; // the click that closes the text box (it keeps the text on blur)
    const at = this.pointAt(event, false, !!this.tool || event.shiftKey);
    if (!at) return;

    // The measure tool: a ruler on screen only. Shift + click starts one without picking the tool.
    if (this.tool === "measure" || (event.shiftKey && !this.tool) || (this.ruler && this.ruler.live)) {
      event.preventDefault();
      event.stopPropagation();
      const point = { time: at.time, price: at.price, logical: at.logical };
      if (this.ruler && this.ruler.live) { // second click: freeze it
        this.ruler = { ...this.ruler, b: point, live: false };
        if (this.tool === "measure") this.setTool(null);
      } else {
        this.ruler = { a: point, b: point, live: true };
      }
      this.redraw();
      return;
    }
    if (this.ruler) { this.ruler = null; this.redraw(); } // any other click puts a finished measurement away

    if (this.tool) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.draft) {
        const v = this.view;
        this.draft = {
          ...createDrawing(this.tool, at, {
            pipPoints: this.pipPoints,
            barsAhead: (time, bars) => logicalToTime(v.candles, this.tfSeconds, timeToLogical(v.candles, this.tfSeconds, time) + bars),
          }),
          ...(TOOLS[this.tool].styled ? this.styleDefaults[this.tool] : {}),
          ...(this.tool === "fib" && this.fibDefaults ? structuredClone(this.fibDefaults) : {}),
        };
        if (this.tool === "text") {
          const draft = this.draft;
          this.draft = null;
          this.setTool(null);
          this.editText({ draft });
          return;
        }
        if (TOOLS[this.tool].clicks === 1) { this.commit(); return; }
        this.pressed = { x: event.clientX, y: event.clientY }; // press-drag-release also finishes a two-click drawing
        window.addEventListener("mouseup", this.release, true);
      } else {
        this.draft = moveHandle(this.draft, "p1", at);
        this.commit();
      }
      this.redraw();
      return;
    }

    const found = this.find(at.x, at.y);
    if (!found) {
      this.select(null); // a click on empty chart deselects, and the chart pans as usual
      return;
    }
    event.preventDefault();
    event.stopPropagation(); // the chart must not pan while a drawing is being moved
    this.select(found.id);
    const original = this.store.get(found.id);
    this.drag = { id: found.id, hit: found.hit, start: at, original, current: original, moved: false };
    this.view.chart.applyOptions({ handleScroll: false, handleScale: false });
    this.view.container.classList.add("draw-drag");
    window.addEventListener("mousemove", this.dragMove, true);
    window.addEventListener("mouseup", this.release, true);
  }

  handleHover(event) {
    if (this.drag) return;
    if (this.ruler && this.ruler.live) {
      const at = this.pointAt(event, true, true);
      if (at) { this.ruler = { ...this.ruler, b: { time: at.time, price: at.price, logical: at.logical } }; this.redraw(); }
      return;
    }
    const at = this.pointAt(event, false, !!this.draft);
    if (this.draft) {
      if (at) {
        this.draft = moveHandle(this.draft, "p1", at);
        this.redraw();
      }
      return;
    }
    const over = !this.tool && at && !this.view.drag ? this.find(at.x, at.y) : null;
    this.view.container.classList.toggle("draw-hover", !!over);
  }

  handleDragMove(event) {
    const drag = this.drag;
    const at = this.pointAt(event, true, drag && drag.hit.part === "handle"); // the magnet moves points, not whole drawings
    if (!drag || !at) return;
    if (!drag.moved && Math.hypot(at.x - drag.start.x, at.y - drag.start.y) < 3) return; // a click, not a drag (yet)
    drag.moved = true;
    if (drag.hit.part === "handle") {
      const price = positionLevel(drag.original, drag.hit.key, at.price, at.rawPrice);
      drag.current = moveHandle(drag.original, drag.hit.key, { ...at, price });
    } else {
      const v = this.view;
      const bars = Math.round(at.logical - drag.start.logical);
      const shift = (time) => logicalToTime(v.candles, this.tfSeconds, timeToLogical(v.candles, this.tfSeconds, time) + bars);
      drag.current = moveAll(drag.original, shift, at.price - drag.start.price);
    }
    this.onSelect({ ...drag.current, id: drag.id }); // keep the toolbar's numbers live
    this.redraw();
  }

  handleUp(event) {
    window.removeEventListener("mouseup", this.release, true);
    if (this.drag) { this.finishDrag(false); return; }
    // Press-drag-release with a two-click tool: finish the drawing where the mouse was let go.
    if (this.draft && this.pressed && Math.hypot(event.clientX - this.pressed.x, event.clientY - this.pressed.y) > 5) {
      const at = this.pointAt(event, true, true);
      if (at) {
        this.draft = moveHandle(this.draft, "p1", at);
        this.commit();
      }
    }
    this.pressed = null;
  }

  finishDrag(cancelled) {
    const drag = this.drag;
    this.drag = null;
    window.removeEventListener("mousemove", this.dragMove, true);
    window.removeEventListener("mouseup", this.release, true);
    this.view.chart.applyOptions({ handleScroll: true, handleScale: true });
    this.view.container.classList.remove("draw-drag");
    if (drag.moved && !cancelled) this.store.update(drag.id, drag.current);
    this.onSelect(this.selected);
    this.redraw();
  }

  /** Keep the finished drawing, select it, and switch the tool off. */
  commit() {
    const draft = this.draft;
    this.draft = null;
    this.pressed = null;
    const [a, b] = draft.points;
    const empty = TOOLS[draft.type].clicks === 2 && a.time === b.time && a.price === b.price;
    const added = empty ? null : this.store.add(draft);
    this.setTool(null);
    if (added) this.select(added.id);
  }

  // ----- painting ------------------------------------------------------------------------
  paint(ctx, size) {
    this.paneWidth = size.width;
    this.paneHeight = size.height;
    if (!this.view.candles || this.view.candles.length === 0) return;
    const proj = this.projection();
    const shown = this.store.items
      .filter((d) => !(this.editing && this.editing.id === d.id)) // the text box stands in for a note being edited
      .map((d) => (this.drag && this.drag.id === d.id ? { ...this.drag.current, id: d.id } : d));
    if (this.draft) shown.push({ ...this.draft, id: "draft" });

    ctx.save();
    ctx.font = FONT;
    ctx.textBaseline = "alphabetic";
    for (const d of shown) {
      const active = d.id === this.selectedId || d.id === "draft";
      const shape = layout(d, proj);
      for (const b of shape.boxes) {
        ctx.fillStyle = styleFor(b.role, d).fill;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      if (d.type === "text" && active) { // a selected note gets a faint frame so you can see what is selected
        const b = shape.boxes[0];
        ctx.strokeStyle = "rgba(41, 98, 255, 0.6)";
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
      }
      for (const l of shape.lines) {
        const style = styleFor(l.role, d);
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.width + (active && l.role === "line" ? 0.5 : 0);
        ctx.setLineDash(style.dash || []);
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      let lastLevelY = null;
      for (const t of shape.labels) {
        if (t.role === "measure" && !active) continue; // sizes are shown only for the drawing you are working on
        if (t.role === "level") { // on a small Fibonacci the level names would print over each other
          if (lastLevelY !== null && Math.abs(t.y - lastLevelY) < 12) continue;
          lastLevelY = t.y;
        }
        const style = styleFor(t.role, d);
        ctx.fillStyle = style.text || style.stroke;
        ctx.textAlign = t.align;
        ctx.font = t.role === "note" ? NOTE_FONT : FONT;
        ctx.fillText(t.text, t.x, t.y);
      }
      if (d.id === this.selectedId) {
        for (const h of shape.handles) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = "#0f0f0f";
          ctx.fill();
          ctx.strokeStyle = BLUE;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
    if (this.ruler) this.paintRuler(ctx, proj);
    ctx.restore();
  }

  /** The measurement: a box from start to end, arrows across and up or down it, and the numbers under it. */
  paintRuler(ctx, proj) {
    const { a, b } = this.ruler;
    const v = this.view;
    const scale = v.chart.timeScale();
    const xa = scale.logicalToCoordinate(a.logical), xb = scale.logicalToCoordinate(b.logical);
    const ya = proj.y(a.price), yb = proj.y(b.price);
    if (xa === null || xb === null) return;
    const up = b.price >= a.price;
    const rgb = up ? "41, 98, 255" : "242, 54, 69"; // blue up, red down, as on TradingView
    const left = Math.min(xa, xb), right = Math.max(xa, xb), top = Math.min(ya, yb), bottom = Math.max(ya, yb);
    ctx.fillStyle = `rgba(${rgb}, 0.18)`;
    ctx.fillRect(left, top, right - left, bottom - top);
    const arrow = (x1, y1, x2, y2) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 2) return;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len, s = Math.min(6, len / 2);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - ux * s - uy * s * 0.6, y2 - uy * s + ux * s * 0.6);
      ctx.lineTo(x2 - ux * s + uy * s * 0.6, y2 - uy * s - ux * s * 0.6);
      ctx.closePath();
      ctx.fill();
    };
    ctx.strokeStyle = ctx.fillStyle = `rgb(${rgb})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    const midX = (left + right) / 2, midY = (top + bottom) / 2;
    arrow(midX, ya, midX, yb); // up or down: the price change
    arrow(xa, midY, xb, midY); // left to right: the time
    const lines = measureLines(a, b, { digits: v.digits, pipPoints: this.pipPoints });
    ctx.font = FONT;
    const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16, h = 36;
    let x = midX - w / 2, y = up ? top - h - 6 : bottom + 6; // beyond the end it points to
    if (y < 2) y = bottom + 6;
    if (y + h > this.paneHeight - 2) y = Math.max(2, top - h - 6);
    x = Math.max(2, Math.min(x, this.paneWidth - w - 2));
    ctx.fillStyle = `rgba(${rgb}, 0.92)`;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(lines[0], x + w / 2, y + 15);
    ctx.fillText(lines[1], x + w / 2, y + 29);
  }
}

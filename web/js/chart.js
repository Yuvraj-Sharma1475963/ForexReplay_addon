// The trading chart: a thin wrapper around TradingView Lightweight Charts.
//
// The library draws times as UTC. We want India time on the axis, so every
// timestamp handed to it is shifted by +5:30 (toChartTime) and shifted back
// when the library gives one to us (fromChartTime). Nothing else in the app
// ever sees shifted times.

import { cleanIndicators, IndicatorEngine } from "./indicators.js";
import { BEARISH, cleanSmc, smcActive, SmcEngine } from "./smc.js";
import { rgb, sessionsBetween } from "./sessions.js";
import { formatDate, formatDateTime, IST_OFFSET_SECONDS } from "./time.js";
import { indexAtOrBefore, timeframe as timeframeInfo } from "./timeframes.js";

const COLOURS = {
  background: "#131722",
  text: "#b2b5be",
  grid: "#1f2330",
  border: "#2a2e39",
  up: "#26a69a",
  down: "#ef5350",
  upVolume: "rgba(38, 166, 154, 0.35)",
  downVolume: "rgba(239, 83, 80, 0.35)",
  crosshair: "#758696",
};

// Indicator colours: checked for colour-blind separation and contrast on the chart background (day 13).
export const INDICATOR_COLOURS = {
  sma: "#00a7b8", ema: "#9c4fd6", vwap: "#c27c0e", rsi: "#2962ff",
  atr: "#00a7b8", adr: "#868993", adrHigh: "#868993", adrLow: "#868993", // ATR has a panel to itself; ADR levels are quiet grey
};
const SUB_PANES = ["rsi", "atr"]; // panels under the chart, in this order

const DEFAULT_VISIBLE_BARS = 160;
const GRAB_PIXELS = 5; // how close the mouse must be to a line to drag it
const RIGHT_GAP_BARS = 8;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis labels. chartTime is already shifted to India time, so UTC getters read India time. */
function tickLabel(chartTime, tickType) {
  const d = new Date(chartTime * 1000);
  if (tickType === 0) return String(d.getUTCFullYear()); // year
  if (tickType === 1) return MONTHS[d.getUTCMonth()]; // month
  if (tickType === 2) return String(d.getUTCDate()); // day of month
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export const toChartTime = (utcSeconds) => utcSeconds + IST_OFFSET_SECONDS;
export const fromChartTime = (chartSeconds) => chartSeconds - IST_OFFSET_SECONDS;

/**
 * Background bands for the Asia, London and New York sessions, drawn with the
 * library's "primitive" hook (custom drawing behind the candles).
 */
class SessionBands {
  constructor(view) {
    this.view = view;
    this.enabled = true;
    const draw = (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize));
    this.views = [{ zOrder: () => "bottom", renderer: () => ({ draw }) }];
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.requestUpdate) this.requestUpdate();
  }

  paint(ctx, size) {
    const candles = this.view.candles;
    const tf = this.view.timeframe;
    if (!this.enabled || !candles || candles.length === 0 || timeframeInfo(tf).seconds > 3600) return;

    const scale = this.view.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const first = Math.max(0, Math.floor(range.from));
    const last = Math.min(candles.length - 1, Math.ceil(range.to));
    if (first > last) return;
    const half = scale.options().barSpacing / 2;

    for (const { session, start, end } of sessionsBetween(candles.time[first], candles.time[last])) {
      const i0 = Math.max(first, indexAtOrBefore(candles, start - 1) + 1); // first candle at or after the open
      const i1 = Math.min(last, indexAtOrBefore(candles, end - 1));         // last candle before the close
      if (i0 > i1) continue; // weekend or holiday
      const x0 = scale.logicalToCoordinate(i0) - half;
      const x1 = scale.logicalToCoordinate(i1) + half;
      ctx.fillStyle = `rgba(${rgb(session.colour)}, 0.07)`; // the colour key is in the status bar
      ctx.fillRect(x0, 0, x1 - x0, size.height);
    }
  }
}

/**
 * Entry, partial and exit markers, drawn with the primitive hook like the session bands.
 *
 * The library's own markers plugin was measured on day 13: with it attached, updating the
 * forming candle took about 16 ms on a chart of 21,000 candles, against 0.8 ms without it,
 * because it re-indexes every candle on every update. Drawing them here costs nothing
 * per update; they are worked out only when the chart is painted, and only for candles on screen.
 */
class TradeMarkers {
  constructor(view) {
    this.view = view;
    this.markers = []; // [{ time, above, colour, shape, text }], sorted by time
    const draw = (target) => target.useMediaCoordinateSpace(({ context }) => this.paint(context));
    this.views = [{ zOrder: () => "top", renderer: () => ({ draw }) }];
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }

  set(markers) {
    this.markers = markers;
    if (this.requestUpdate) this.requestUpdate();
  }

  paint(ctx) {
    const { candles, chart, series } = this.view;
    if (!candles || candles.length === 0 || this.markers.length === 0) return;
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const stacked = new Map(); // markers on the same candle and side sit one above the other
    ctx.save();
    ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "center";
    for (const m of this.markers) {
      const i = indexAtOrBefore(candles, m.time);
      if (i < 0 || i < range.from - 1 || i > range.to + 1) continue;
      const x = scale.logicalToCoordinate(i);
      const edge = series.priceToCoordinate(candles.price(m.above ? candles.high[i] : candles.low[i]));
      if (x === null || edge === null) continue;
      const key = `${i}:${m.above}`;
      const n = stacked.get(key) || 0;
      stacked.set(key, n + 1);
      const dir = m.above ? -1 : 1; // away from the candle
      const y = edge + dir * (10 + n * 26);
      ctx.fillStyle = m.colour;
      ctx.beginPath();
      if (m.shape === "arrowUp" || m.shape === "arrowDown") {
        const up = m.shape === "arrowUp";
        ctx.moveTo(x, y + (up ? -5 : 5));
        ctx.lineTo(x - 5, y + (up ? 3 : -3));
        ctx.lineTo(x + 5, y + (up ? 3 : -3));
        ctx.closePath();
      } else {
        ctx.arc(x, y, 4, 0, Math.PI * 2);
      }
      ctx.fill();
      if (m.text) ctx.fillText(m.text, x, y + dir * 13 + (dir > 0 ? 4 : 0));
    }
    ctx.restore();
  }
}

/** A dashed vertical line where "Go to" landed, so the start of the day is easy to find. */
class JumpMark {
  constructor(view) {
    this.view = view;
    this.time = null; // UTC seconds, or null for none
    const draw = (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize));
    this.views = [{ zOrder: () => "top", renderer: () => ({ draw }) }];
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }

  set(time) {
    this.time = time;
    if (this.requestUpdate) this.requestUpdate();
  }

  paint(ctx, size) {
    const candles = this.view.candles;
    if (this.time === null || !candles || candles.length === 0) return;
    const i = indexAtOrBefore(candles, this.time);
    if (i < 0) return;
    const scale = this.view.chart.timeScale();
    const x = scale.logicalToCoordinate(i);
    if (x === null) return;
    const left = Math.round(x - scale.options().barSpacing / 2) + 0.5; // the candle's left edge: where the day starts
    ctx.save();
    ctx.strokeStyle = "rgba(41, 98, 255, 0.8)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(left, 0);
    ctx.lineTo(left, size.height);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Order blocks and fair value gaps (smc.js), drawn behind the candles with the primitive hook.
 * Colours are those of LuxAlgo's script: internal order blocks without a border, swing ones with one,
 * an order block reaching to the right edge until price mitigates it, a gap split at its middle.
 */
const SMC_COLOURS = {
  internalBull: "rgba(49, 121, 245, 0.2)", internalBear: "rgba(247, 124, 128, 0.2)",
  swingBull: "rgba(24, 72, 204, 0.2)", swingBear: "rgba(178, 40, 51, 0.2)",
  fvgBull: "rgba(0, 255, 104, 0.3)", fvgBear: "rgba(255, 0, 8, 0.3)",
};

class SmcLayer {
  constructor(view) {
    this.view = view;
    this.result = null; // { internalObs, swingObs, fvgs } from SmcEngine
    const draw = (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize));
    this.views = [{ zOrder: () => "bottom", renderer: () => ({ draw }) }];
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }

  set(result) {
    this.result = result;
    if (this.requestUpdate) this.requestUpdate();
  }

  paint(ctx, size) {
    const { candles, chart, series } = this.view;
    const r = this.result;
    if (!r || !candles || candles.length === 0) return;
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const half = scale.options().barSpacing / 2;
    const y = (points) => series.priceToCoordinate(candles.price(points));
    const box = (left, right, a, b, fill, stroke) => {
      if (right < range.from - 1 || left > range.to + 1) return;
      const x0 = scale.logicalToCoordinate(left), ya = y(a), yb = y(b);
      if (x0 === null || ya === null || yb === null) return;
      const x1 = right === Infinity ? size.width : scale.logicalToCoordinate(right) + half;
      const top = Math.min(ya, yb), height = Math.max(1, Math.abs(ya - yb));
      ctx.fillStyle = fill;
      ctx.fillRect(x0 - half, top, x1 - (x0 - half), height);
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(x0 - half + 0.5, top + 0.5, x1 - (x0 - half) - 1, height - 1); }
    };
    ctx.save();
    for (const g of r.fvgs) {
      const colour = g.bias === BEARISH ? SMC_COLOURS.fvgBear : SMC_COLOURS.fvgBull;
      const mid = (g.top + g.bottom) / 2;
      box(g.left, g.right, g.top, mid, colour, colour); // two boxes, as the script draws them
      box(g.left, g.right, mid, g.bottom, colour, colour);
    }
    for (const ob of r.internalObs) {
      box(ob.index, Infinity, ob.high, ob.low, ob.bias === BEARISH ? SMC_COLOURS.internalBear : SMC_COLOURS.internalBull, null);
    }
    for (const ob of r.swingObs) {
      const colour = ob.bias === BEARISH ? SMC_COLOURS.swingBear : SMC_COLOURS.swingBull;
      box(ob.index, Infinity, ob.high, ob.low, colour, colour);
    }
    ctx.restore();
  }
}

export class ChartView {
  /**
   * @param {HTMLElement} container  element the chart fills
   * @param {object} options  { lib, symbol, digits, onHover(barInfo | null), onClick(index, points),
   *   onLineDrag(id, points) while a trade line is being dragged, onLineDrop(id, points | null) when it is let go
   *   (null = cancelled), onCrosshairTime(utc | null) when the mouse moves over this chart (for the other chart) }
   */
  constructor(container, { lib, symbol, digits, onHover, onClick, onLineDrag, onLineDrop, onCrosshairTime }) {
    this.container = container;
    this.onLineDrag = onLineDrag || (() => {});
    this.onLineDrop = onLineDrop || (() => {});
    this.lib = lib;
    this.symbol = symbol;
    this.digits = digits;
    this.onHover = onHover || (() => {});
    this.onClick = onClick || (() => {});
    this.onCrosshairTime = onCrosshairTime || (() => {});
    this.mouseInside = false; // only the chart under the mouse tells the other where its crosshair is
    this.candles = null; // Candles of the timeframe on screen
    this.timeframe = null;

    const minMove = 1 / 10 ** digits;
    this.chart = lib.createChart(container, {
      autoSize: true,
      layout: {
        background: { color: COLOURS.background },
        textColor: COLOURS.text,
        fontSize: 12,
        attributionLogo: true, // required credit for TradingView Lightweight Charts
      },
      grid: { vertLines: { color: COLOURS.grid }, horzLines: { color: COLOURS.grid } },
      crosshair: {
        mode: lib.CrosshairMode.Normal, // free crosshair like TradingView, not snapped to the close
        vertLine: { color: COLOURS.crosshair, labelBackgroundColor: "#363a45" },
        horzLine: { color: COLOURS.crosshair, labelBackgroundColor: "#363a45" },
      },
      rightPriceScale: { borderColor: COLOURS.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: {
        borderColor: COLOURS.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_GAP_BARS,
        barSpacing: 8,
        minBarSpacing: 0.5,
        tickMarkFormatter: (chartTime, tickType) => tickLabel(chartTime, tickType),
      },
      localization: {
        locale: "en-IN", // fixed, so number formatting never depends on the computer's language setting
        // Crosshair label at the bottom: full India-time date for the hovered candle.
        timeFormatter: (chartTime) => this.formatTime(fromChartTime(chartTime)),
      },
    });

    this.series = this.chart.addSeries(lib.CandlestickSeries, {
      upColor: COLOURS.up,
      downColor: COLOURS.down,
      wickUpColor: COLOURS.up,
      wickDownColor: COLOURS.down,
      borderVisible: false,
      priceFormat: { type: "price", precision: digits, minMove },
    });

    this.volume = this.chart.addSeries(lib.HistogramSeries, {
      priceScaleId: "volume", // its own invisible scale so it never squashes the candles
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    // Keep the lines of active trades on screen: the price scale stretches to include them, unless a line
    // is so far away (more than 1.5x the height of the candles on screen) that the candles would be squashed.
    this.series.applyOptions({
      autoscaleInfoProvider: (original) => {
        const info = original();
        if (!info || !info.priceRange || !this.lineSpecs || this.lineSpecs.length === 0) return info;
        let { minValue, maxValue } = info.priceRange;
        const reach = (maxValue - minValue) * 1.5;
        const low = minValue - reach, high = maxValue + reach;
        for (const spec of this.lineSpecs) {
          const price = spec.price / 10 ** this.digits;
          if (price < low || price > high) continue;
          minValue = Math.min(minValue, price);
          maxValue = Math.max(maxValue, price);
        }
        return { ...info, priceRange: { minValue, maxValue } };
      },
    });

    this.sessions = new SessionBands(this);
    this.series.attachPrimitive(this.sessions);
    this.smcSettings = cleanSmc(null);
    this.smcEngine = new SmcEngine(); // works out only what a replay step changed
    this.smc = new SmcLayer(this); // over the session bands, behind the candles
    this.series.attachPrimitive(this.smc);
    this.jumpMark = new JumpMark(this);
    this.series.attachPrimitive(this.jumpMark);

    this.chart.subscribeCrosshairMove((param) => this.handleCrosshair(param));
    this.chart.subscribeClick((param) => {
      if (this.justDragged) return; // the click that ends a drag is not a click on the chart
      if (!this.candles || !param.point) return;
      const index = param.time === undefined ? null : indexAtOrBefore(this.candles, fromChartTime(param.time));
      const price = this.series.coordinateToPrice(param.point.y); // price under the mouse
      this.onClick(index, price === null ? null : Math.round(price * 10 ** this.digits));
    });

    this.indicatorSettings = cleanIndicators(null);
    this.indicatorSeries = new Map(); // indicator id -> line series
    this.indicatorEngine = new IndicatorEngine(); // works out only what a replay step changed
    this.indicatorLines = []; // the last computed lines, for the legend
    this.priceLines = [];
    this.lineSpecs = [];
    this.drag = null; // { spec, line, startY, points, moved } while a line is being dragged
    this.deferredLines = null;
    this.justDragged = false;
    this.toolActive = false; // set by the drawing layer
    this.markers = new TradeMarkers(this);
    this.series.attachPrimitive(this.markers);

    // Dragging trade lines. The library has no draggable lines, so the mouse is watched here.
    // Listening in the capture phase lets a drag start before the library begins to pan the chart.
    container.addEventListener("mousedown", (event) => this.startDrag(event), true);
    container.addEventListener("mousemove", (event) => {
      if (!this.drag) container.classList.toggle("line-hover", !!this.lineAt(event));
    });
    container.addEventListener("mouseleave", () => {
      if (!this.drag) container.classList.remove("line-hover");
      this.mouseInside = false;
      this.onCrosshairTime(null);
    });
    container.addEventListener("mouseenter", () => { this.mouseInside = true; });
    this.moveDrag = (event) => this.continueDrag(event);
    this.endDrag = (event) => this.finishDrag(event);
  }

  // ----- dragging trade lines ------------------------------------------------
  /** Mouse position inside the price pane, or null when it is over an axis. */
  panePoint(event) {
    const box = this.container.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const paneWidth = box.width - this.chart.priceScale("right").width();
    const paneHeight = box.height - this.chart.timeScale().height();
    return x >= 0 && x <= paneWidth && y >= 0 && y <= paneHeight ? { x, y } : null;
  }

  /** The draggable line under the mouse (the nearest within a few pixels), or null. */
  lineAt(event) {
    const point = this.panePoint(event);
    if (!point) return null;
    let best = null;
    this.lineSpecs.forEach((spec, i) => {
      if (!spec.draggable) return;
      const y = this.series.priceToCoordinate(spec.price / 10 ** this.digits);
      if (y === null) return;
      const distance = Math.abs(y - point.y);
      if (distance <= GRAB_PIXELS && (!best || distance < best.distance)) best = { spec, line: this.priceLines[i], distance };
    });
    return best;
  }

  startDrag(event) {
    if (event.button !== 0 || this.drag || this.toolActive) return; // a drawing tool is waiting for its clicks
    const hit = this.lineAt(event);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation(); // the chart must not start panning
    this.drag = { spec: hit.spec, line: hit.line, startY: event.clientY, points: hit.spec.price, moved: false };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    window.addEventListener("mousemove", this.moveDrag, true);
    window.addEventListener("mouseup", this.endDrag, true);
  }

  continueDrag(event) {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 3) return; // a click, not a drag (yet)
    drag.moved = true;
    const y = event.clientY - this.container.getBoundingClientRect().top;
    const price = this.series.coordinateToPrice(y);
    if (price === null) return;
    drag.points = Math.round(price * 10 ** this.digits);
    drag.line.applyOptions({ price: drag.points / 10 ** this.digits });
    this.onLineDrag(drag.spec.id, drag.points);
  }

  finishDrag(event, cancelled = false) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    window.removeEventListener("mousemove", this.moveDrag, true);
    window.removeEventListener("mouseup", this.endDrag, true);
    this.chart.applyOptions({ handleScroll: true, handleScale: true });
    this.container.classList.remove("line-hover");
    if (drag.moved) {
      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 0);
    }
    const lines = this.deferredLines || this.lineSpecs; // put every line back where the trades say it is
    this.deferredLines = null;
    this.setTradeLines(lines);
    this.onLineDrop(drag.spec.id, drag.moved && !cancelled ? drag.points : null);
  }

  /** Abandon a drag in progress (Esc). Returns true if there was one. */
  cancelDrag() {
    if (!this.drag) return false;
    this.finishDrag(null, true);
    return true;
  }

  /**
   * Horizontal lines for active trades.
   * lines = [{ id, price (points), colour, dashed, title, draggable }]
   */
  setTradeLines(lines) {
    if (this.drag) { // do not pull the line out from under the mouse; redraw when the drag ends
      this.deferredLines = lines;
      return;
    }
    this.lineSpecs = lines;
    for (const line of this.priceLines) this.series.removePriceLine(line);
    this.priceLines = lines.map((line) => this.series.createPriceLine({
      price: line.price / 10 ** this.digits,
      color: line.colour,
      lineWidth: 1,
      lineStyle: line.dashed ? this.lib.LineStyle.Dashed : this.lib.LineStyle.Solid,
      axisLabelVisible: true,
      title: line.title,
    }));
  }

  /**
   * Entry and exit markers. markers = [{ time (UTC s of a candle on screen), above, colour, shape, text }]
   */
  setTradeMarkers(markers) {
    this.markers.set(markers.slice().sort((a, b) => a.time - b.time));
  }

  candlePoint(i) {
    const c = this.candles;
    return {
      time: toChartTime(c.time[i]),
      open: c.price(c.open[i]), high: c.price(c.high[i]), low: c.price(c.low[i]), close: c.price(c.close[i]),
    };
  }

  volumePoint(i) {
    const c = this.candles;
    return {
      time: toChartTime(c.time[i]),
      value: c.volume[i],
      color: c.close[i] >= c.open[i] ? COLOURS.upVolume : COLOURS.downVolume,
    };
  }

  /**
   * Fast path for replay: candles `from`..`to` changed or were added at the end.
   * The library can update its last candle or append newer ones, which is all replay needs going forward.
   */
  updateBars(from, to) {
    for (let i = Math.max(0, from); i <= to; i++) {
      this.series.update(this.candlePoint(i));
      this.volume.update(this.volumePoint(i));
    }
    this.drawIndicators(Math.max(0, from), to);
    this.onHover(this.barInfo(this.candles.length - 1));
  }

  // ----- indicators -----------------------------------------------------------
  /** Which indicators to show (see indicators.js). Redraws them on the candles on screen. */
  setIndicators(settings) {
    this.indicatorSettings = cleanIndicators(settings);
    if (!this.candles) return;
    this.drawIndicators();
    this.onHover(this.barInfo(this.candles.length - 1)); // the legend shows the new set straight away
  }

  /** Which Smart Money Concepts parts to show (see smc.js). */
  setSmc(settings) {
    this.smcSettings = cleanSmc(settings);
    if (this.candles) this.drawSmc();
  }

  /** Order blocks and gaps from the candles on screen; with `from`, only from that candle on is worked out again. */
  drawSmc(from = null) {
    if (!smcActive(this.smcSettings)) { this.smc.set(null); return; }
    this.smc.set(this.smcEngine.compute(this.candles, this.smcSettings, from));
  }

  get pipPoints() { return 10 ** (this.digits - 4); } // EURUSD: 10 points to a pip

  indicatorPoint(line, i) {
    const v = line.values[i];
    const time = toChartTime(this.candles.time[i]);
    if (!Number.isFinite(v)) return { time }; // not worked out yet: a gap in the line
    if (line.pane === "rsi") return { time, value: v };
    if (line.pane === "atr") return { time, value: v / this.pipPoints }; // ATR is shown in pips
    return { time, value: v / 10 ** this.digits };
  }

  /**
   * Work the indicators out again from the candles on screen. With `from`, only points from..to
   * are sent to the chart (a replay step); otherwise every point (new candles or new settings).
   */
  drawIndicators(from = null, to = null) {
    this.drawSmc(from);
    let lines = this.indicatorEngine.compute(this.candles, this.indicatorSettings, from);
    // ADR levels are for intraday charts: on D1 a day is one candle, so they say nothing (lines and legend alike).
    if (this.timeframe === "D1") lines = lines.filter((l) => l.id !== "adrHigh" && l.id !== "adrLow");
    this.indicatorLines = lines; // the legend shows every value, ADR included
    lines = lines.filter((l) => l.pane !== "legend"); // ADR itself is a number in the legend, not a line
    // Panels under the chart are numbered in order. When the set changes (RSI switched off while ATR stays),
    // the panel lines are made again so each lands in the right panel.
    const panes = SUB_PANES.filter((p) => lines.some((l) => l.pane === p));
    const paneKey = panes.join(",");
    const wanted = new Set(lines.map((l) => l.id));
    for (const [id, series] of this.indicatorSeries) {
      const inPanel = SUB_PANES.includes(id);
      if (!wanted.has(id) || (inPanel && paneKey !== this.paneKey)) { this.chart.removeSeries(series); this.indicatorSeries.delete(id); }
    }
    this.paneKey = paneKey;
    for (const line of lines) {
      let series = this.indicatorSeries.get(line.id);
      const fresh = !series;
      if (fresh) {
        const panel = SUB_PANES.includes(line.pane);
        const level = line.id === "adrHigh" || line.id === "adrLow";
        series = this.chart.addSeries(this.lib.LineSeries, {
          color: INDICATOR_COLOURS[line.id], lineWidth: panel ? 2 : 1, priceLineVisible: false,
          lineStyle: level ? this.lib.LineStyle.Dashed : this.lib.LineStyle.Solid,
          crosshairMarkerVisible: false, lastValueVisible: true, title: line.label,
          priceFormat: panel ? { type: "price", precision: 1, minMove: 0.1 } : { type: "price", precision: this.digits, minMove: 1 / 10 ** this.digits },
          autoscaleInfoProvider: line.pane === "rsi" ? () => ({ priceRange: { minValue: 0, maxValue: 100 } }) : undefined,
        }, panel ? panes.indexOf(line.pane) + 1 : 0);
        if (line.pane === "rsi") {
          for (const value of [70, 30]) {
            series.createPriceLine({ price: value, color: "#4a4e5a", lineWidth: 1, lineStyle: this.lib.LineStyle.Dashed, axisLabelVisible: true, title: "" });
          }
        }
        if (panel) {
          const pane = this.chart.panes()[panes.indexOf(line.pane) + 1];
          if (pane) pane.setHeight(110);
        }
        this.indicatorSeries.set(line.id, series);
      }
      if (series.options().title !== line.label) series.applyOptions({ title: line.label }); // changing options redoes the chart's layout
      if (fresh || from === null) {
        series.setData(Array.from(line.values, (_, i) => this.indicatorPoint(line, i)));
      } else {
        for (let i = from; i <= to; i++) series.update(this.indicatorPoint(line, i));
      }
    }
  }

  /** The indicators' values at candle i, for the legend: [{ id, label, value text, colour }]. */
  indicatorValues(i) {
    return this.indicatorLines.map((l) => ({
      id: l.id, label: l.label, colour: INDICATOR_COLOURS[l.id],
      text: !Number.isFinite(l.values[i]) ? "–" : l.pane === "rsi" ? l.values[i].toFixed(1)
        : l.id === "atr" || l.id === "adr" ? `${(l.values[i] / this.pipPoints).toFixed(1)} pips`
          : (l.values[i] / 10 ** this.digits).toFixed(this.digits),
    }));
  }

  /** Is the newest candle on screen? (Then the chart follows the replay.) */
  latestVisible() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    return !!range && !!this.candles && range.to >= this.candles.length - 1;
  }

  formatTime(utcSeconds) {
    return this.timeframe === "D1" ? formatDate(utcSeconds) : formatDateTime(utcSeconds);
  }

  /** Everything the legend needs for candle i of the current timeframe. */
  barInfo(i) {
    const c = this.candles;
    if (!c || i < 0 || i >= c.length) return null;
    const previousClose = i > 0 ? c.close[i - 1] : c.open[i];
    return {
      index: i,
      time: c.time[i],
      timeText: this.formatTime(c.time[i]),
      open: c.price(c.open[i]),
      high: c.price(c.high[i]),
      low: c.price(c.low[i]),
      close: c.price(c.close[i]),
      volume: c.volume[i],
      indicators: this.indicatorValues(i),
      change: c.price(c.close[i] - previousClose),
      changePercent: ((c.close[i] - previousClose) / previousClose) * 100,
      rising: c.close[i] >= c.open[i],
    };
  }

  handleCrosshair(param) {
    if (!this.candles || param.time === undefined) {
      this.onHover(this.barInfo(this.candles ? this.candles.length - 1 : -1)); // fall back to the latest candle
      if (this.mouseInside) this.onCrosshairTime(null);
      return;
    }
    this.onHover(this.barInfo(indexAtOrBefore(this.candles, fromChartTime(param.time))));
    if (this.mouseInside) this.onCrosshairTime(fromChartTime(param.time));
  }

  /**
   * Put the crosshair on the candle containing `utcSeconds` (the other chart is hovering that moment).
   * On a higher timeframe that is the candle the moment falls in; past the last candle, the last one.
   */
  showCrosshairAt(utcSeconds) {
    if (!this.candles || this.candles.length === 0 || this.mouseInside) return;
    const i = indexAtOrBefore(this.candles, utcSeconds);
    if (i < 0) { this.hideCrosshair(); return; }
    this.chart.setCrosshairPosition(this.candles.price(this.candles.close[i]), toChartTime(this.candles.time[i]), this.series);
    this.onHover(this.barInfo(i)); // the library sends no hover event for a crosshair placed by code
  }

  hideCrosshair() {
    if (this.mouseInside || !this.candles) return;
    this.chart.clearCrosshairPosition();
    this.onHover(this.barInfo(this.candles.length - 1)); // back to the newest candle, as when the mouse leaves
  }

  /** UTC time of the candle at the right edge of the screen (used to keep your place). */
  rightEdgeTime() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (!range || !this.candles || this.candles.length === 0) return null;
    const i = Math.max(0, Math.min(this.candles.length - 1, Math.floor(range.to) - RIGHT_GAP_BARS));
    return this.candles.time[i];
  }

  visibleBarCount() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    return range ? Math.max(20, Math.round(range.to - range.from)) : DEFAULT_VISIBLE_BARS;
  }

  /**
   * Show candles of a timeframe. keepTime (UTC seconds) puts that moment at the
   * right edge, so switching timeframe keeps you at the same place in history.
   */
  setCandles(timeframeId, candles, { keepTime = null, bars = null, preserveView = false } = {}) {
    this.timeframe = timeframeId;
    this.candles = candles;

    const n = candles.length;
    const candleData = new Array(n);
    const volumeData = new Array(n);
    for (let i = 0; i < n; i++) {
      candleData[i] = this.candlePoint(i);
      volumeData[i] = this.volumePoint(i);
    }
    const range = preserveView ? this.chart.timeScale().getVisibleLogicalRange() : null;
    this.series.setData(candleData);
    this.volume.setData(volumeData);
    this.drawIndicators();

    if (range) {
      this.chart.timeScale().setVisibleLogicalRange(range); // same candles stay under the same pixels
    } else {
      const last = keepTime === null ? n - 1 : Math.max(0, indexAtOrBefore(candles, keepTime));
      this.showEndingAt(last, bars || DEFAULT_VISIBLE_BARS);
    }
    this.onHover(this.barInfo(n - 1));
  }

  setSessionsVisible(visible) {
    this.sessions.setEnabled(visible);
  }

  /** Redraw the session bands after the session settings changed. */
  refreshSessions() {
    this.sessions.setEnabled(this.sessions.enabled);
  }

  /** Put candle index `last` at the right edge with `bars` candles on screen. */
  showEndingAt(last, bars) {
    this.chart.timeScale().setVisibleLogicalRange({ from: last - bars + RIGHT_GAP_BARS, to: last + RIGHT_GAP_BARS });
  }

  /** Centre the chart on a moment in time (UTC seconds). */
  goTo(utcSeconds) {
    if (!this.candles) return null;
    const i = Math.max(0, indexAtOrBefore(this.candles, utcSeconds));
    const bars = this.visibleBarCount();
    const half = Math.floor(bars / 2);
    this.chart.timeScale().setVisibleLogicalRange({ from: i - half, to: i + half });
    return this.candles.time[i];
  }

  /**
   * Show the candle at a moment (UTC seconds), or the candle that contains it, a little in from the
   * left edge, keeping the zoom: the day or hour that starts there reads from left to right.
   */
  showFrom(utcSeconds) {
    if (!this.candles) return;
    this.jumpMark.set(utcSeconds);
    const i = Math.max(0, indexAtOrBefore(this.candles, utcSeconds));
    const bars = this.visibleBarCount();
    const lead = Math.round(bars * 0.12);
    this.chart.timeScale().setVisibleLogicalRange({ from: i - lead, to: i - lead + bars });
  }

  goToLatest() {
    this.jumpMark.set(null);
    if (this.candles) this.showEndingAt(this.candles.length - 1, this.visibleBarCount());
  }
}

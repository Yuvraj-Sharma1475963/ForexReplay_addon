// App start-up: load data, build the chart, wire the top bar and the replay.

import { formatLots, formatMoney, formatSignedMoney, loadSettings, pointValuePerLot } from "./account.js";
import { drawingsBefore, rebuild } from "./backtest.js";
import { loadRules as loadChallengeRules } from "./challenge.js";
import { AdrPanel } from "./adrpanel.js";
import { AnalyticsView } from "./analyticsview.js";
import { Backtests } from "./backtestpanel.js";
import { JournalPanel } from "./journalpanel.js";
import { capture as captureChart } from "./screenshots.js";
import { openStore } from "./store.js";
import { TradeNotes } from "./tradenotes.js";
import { ChartView } from "./chart.js";
import { DrawingLayer } from "./drawinglayer.js";
import { cleanIndicators, STORAGE_KEY as KEY_INDICATORS } from "./indicators.js";
import { cleanSmc, smcActive, STORAGE_KEY as KEY_SMC } from "./smc.js";
import { LayerGroup } from "./layergroup.js";
import {
  cleanFibLevels, DrawingStore, FIB_LEVELS, fibLevelsOf, LINE_STYLES, loadSaved as loadSavedDrawings, moveHandle, PALETTE,
  positionStats, save as saveDrawings, TOOLS,
} from "./drawings.js";
import { OTHER_KEYS, SHORTCUTS, shortcutFor } from "./shortcuts.js";
import { loadJSON, loadSymbol } from "./data.js";
import { renderDataView } from "./dataview.js";
import { OrderType } from "./broker.js";
import { ReplayClock, SPEEDS } from "./replay.js";
import { loadSavedSessions, renderSessionKey, setupSessionSettings } from "./sessionsettings.js";
import { formatDateTime, IST_OFFSET_SECONDS } from "./time.js";
import { serverDate, TIMEFRAMES, TimeframeView } from "./timeframes.js";
import { InvalidOrder, Side, Status, Trading } from "./trading.js";
import { TradingPanel } from "./tradingpanel.js";

const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString("en-IN");
const KEY_TIMEFRAME = "forexreplay.timeframe";
const KEY_SESSIONS = "forexreplay.sessions";
const KEY_MAGNET = "forexreplay.magnet";
const KEY_LAYOUT = "forexreplay.layout";
const KEY_SIDE_TF = "forexreplay.sidetimeframe";
const KEY_DRAW_STYLES = "forexreplay.drawstyles";
const KEY_FIB_DEFAULTS = "forexreplay.fibdefaults";

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
}
function recall(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function showError(message) {
  const box = $("error");
  box.hidden = false;
  box.textContent = message;
}

/** Legend in the chart's top-left corner, like TradingView's O H L C line. */
function renderLegend(el, symbol, timeframeId, digits, info, forming) {
  if (!info) {
    el.textContent = `${symbol} · ${timeframeId}`;
    return;
  }
  const tone = info.rising ? "up" : "down";
  const p = (v) => v.toFixed(digits);
  const sign = info.change >= 0 ? "+" : "";
  el.innerHTML =
    `<span class="legend-title">${symbol} · ${timeframeId}</span>` +
    `<span class="legend-time">${info.timeText}${forming ? " · forming" : ""}</span>` +
    `<span class="${tone}">O <b>${p(info.open)}</b> H <b>${p(info.high)}</b> ` +
    `L <b>${p(info.low)}</b> C <b>${p(info.close)}</b> ` +
    `${sign}${p(info.change)} (${sign}${info.changePercent.toFixed(2)}%)</span>` +
    `<span class="legend-volume">Vol ${number(info.volume)}</span>` +
    (info.indicators || []).map((ind) => `<span class="legend-ind"><i style="background:${ind.colour}"></i>${ind.label} <b>${ind.text}</b></span>`).join("");
}

/** "2026-03-05T13:30" typed in India time -> UTC seconds. */
function parseIndiaInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 1000 - IST_OFFSET_SECONDS;
}

/** A trading day number (days since 1970 on the broker clock) as "2026-09-10", and back. */
const dayToInput = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
function inputToDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000 : null;
}

async function boot() {
  const store = await openStore(); // files on disk with the local server, or this browser on the website
  const health = await store.health();
  if (store.kind === "browser") $("status-version").textContent = "online · backtests are saved in this browser";
  else if (health) $("status-version").textContent = `app v${health.version}`;

  const lib = window.LightweightCharts;
  $("status-lib").innerHTML = lib
    ? `<span class="ok">Chart library v${lib.version()} ready</span>`
    : '<span class="bad">Chart library missing</span>';

  let loaded, quality;
  try {
    [loaded, quality] = await Promise.all([loadSymbol("EURUSD"), loadJSON("data/EURUSD/quality.json")]);
  } catch (err) {
    console.error(err);
    showError(`Could not load the market data.\n${err.message}\n\n` +
      "Fix: close this tab, then run  python -m forex_replay app --rebuild");
    return;
  }
  const { manifest, candles: m5 } = loaded;

  $("status-data").textContent =
    `${manifest.symbol} · ${number(manifest.bars)} M5 candles · ` +
    `${formatDateTime(manifest.first)} → ${formatDateTime(manifest.last)} IST`;

  const redrawData = renderDataView($("data-view"), { manifest, quality, candles: m5 });

  if (!lib) {
    showError("TradingView Lightweight Charts is not downloaded yet.\n" +
      "Restart the app with an internet connection, or attach the file in the chat.");
    return;
  }

  // ------------------------------------------------------------ timeframes
  // One TimeframeView per timeframe, built on first use. Each shows only what
  // the replay clock has revealed.
  const clock = new ReplayClock(m5.length);
  const views = new Map();
  const viewFor = (tf) => {
    if (!views.has(tf)) views.set(tf, new TimeframeView(m5, tf));
    return views.get(tf);
  };

  let current = recall(KEY_TIMEFRAME, "M15");
  if (!TIMEFRAMES.some((t) => t.id === current)) current = "M15";
  let view = viewFor(current);
  let picking = false; // waiting for a click on the candle to start the replay from
  let panel = null; // trading panel (created below, once the chart exists)
  loadSavedSessions();

  const hint = $("hint");
  const setHint = (text) => {
    hint.hidden = !text;
    hint.textContent = text || "";
  };

  // Each chart on screen is a "pane": its chart, its timeframe and its view of the one replay clock.
  // The main pane is the one the timeframe buttons, the replay steps and the backtest's timeframe follow.
  // The side pane (two charts side by side) has its own timeframe and its own TimeframeView, even when
  // both show the same timeframe, so each chart is told about every candle the clock reveals.
  let layoutTwo = recall(KEY_LAYOUT, "one") === "two";
  const mainPane = { id: "main", legend: $("legend"), get tf() { return current; }, get view() { return view; }, chart: null, layer: null };
  const sideTf = recall(KEY_SIDE_TF, "H4");
  const sidePane = { id: "side", legend: $("legend-side"), tf: TIMEFRAMES.some((t) => t.id === sideTf) ? sideTf : "H4", view: null, chart: null, layer: null };
  const panes = () => (layoutTwo && sidePane.chart ? [mainPane, sidePane] : [mainPane]);

  const chartOptions = (pane) => ({
    lib,
    symbol: manifest.symbol,
    digits: manifest.digits,
    onHover: (info) => renderLegend(pane.legend, manifest.symbol, pane.tf, manifest.digits, info,
      info && info.index === pane.view.display.length - 1 && pane.view.isForming()),
    onCrosshairTime: (time) => { // the other chart puts its crosshair on the same moment
      const other = pane === mainPane ? sidePane : mainPane;
      if (!layoutTwo || !other.chart) return;
      if (time === null) other.chart.hideCrosshair(); else other.chart.showCrosshairAt(time);
    },
    onClick: (index, price) => {
      if (picking) {
        if (index === null) return;
        setPicking(false);
        clock.start(pane.view.endOf(index)); // the clicked candle is the last one shown, on whichever chart
      } else if (panel && price !== null) {
        panel.receivePrice(price); // filling in a price field from the chart
      }
    },
    onLineDrag: (id, price) => setHint(describeMove(id, price)),
    onLineDrop: (id, price) => {
      setHint(null);
      if (price === null) return;
      const [kind, tradeId] = id.split(":");
      try {
        trading.modifyTrade(Number(tradeId), { [LINE_FIELD[kind]]: price });
        panel.say(`${LINE_NAME[kind]} of #${tradeId} moved to ${(price / 10 ** manifest.digits).toFixed(manifest.digits)}.`, "ok");
      } catch (err) {
        if (!(err instanceof InvalidOrder)) throw err;
        panel.say(err.message, "bad"); // the line has already snapped back
      }
    },
  });
  let indicators = cleanIndicators((() => { try { return JSON.parse(recall(KEY_INDICATORS, "null")); } catch { return null; } })());
  let smc = cleanSmc((() => { try { return JSON.parse(recall(KEY_SMC, "null")); } catch { return null; } })());
  const chart = new ChartView($("chart"), chartOptions(mainPane));
  chart.setSmc(smc);
  chart.setIndicators(indicators);
  mainPane.chart = chart;

  // ------------------------------------------------------------ trading
  const UP = "#26a69a", DOWN = "#ef5350", PENDING = "#ffb74d", ENTRY = "#d1d4dc";
  const trading = new Trading({
    m5, clock, pipPoints: manifest.pip_points, pointValue: pointValuePerLot(manifest.digits),
    settings: loadSettings(), challenge: loadChallengeRules(), onChange: () => refreshTrading(),
  });
  const formatR = (r) => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
  const LINE_FIELD = { sl: "stopLoss", tp: "takeProfit", entry: "price" };
  const LINE_NAME = { sl: "Stop loss", tp: "Take profit", entry: "Entry" };

  /** Shown while a line is being dragged: where it is now, and what that means in pips, R and dollars. */
  function describeMove(id, price) {
    const [kind, tradeId] = id.split(":");
    const t = trading.broker.trades.find((trade) => trade.id === Number(tradeId));
    if (!t) return null;
    const text = `${LINE_NAME[kind]} #${t.id} → ${(price / 10 ** manifest.digits).toFixed(manifest.digits)}`;
    if (kind === "entry") return `${text} · let go to move the order, Esc to cancel`;
    const entry = t.entryPrice ?? t.plannedEntry;
    const points = (price - entry) * (t.side === Side.BUY ? 1 : -1);
    const money = t.status === Status.OPEN
      ? ` · ${formatSignedMoney(trading.account.money(trading.account.openUnits(t), points))} on what is open` : "";
    return `${text} · ${(points / manifest.pip_points).toFixed(1)} pips from entry (${formatR(points / t.plannedRisk)})${money}`;
  }

  /** Lines for active trades on every chart, and entry/exit markers on each chart's own candles. */
  function drawTrades() {
    const lines = [];
    const draggable = !trading.blockedReason; // lines can be moved only when orders can be placed
    for (const t of trading.broker.trades) {
      if (t.status === Status.CANCELLED) continue;
      if (t.isActive) {
        const pending = t.status === Status.PENDING;
        if (!(pending && t.orderType === OrderType.MARKET)) {
          lines.push({
            id: `entry:${t.id}`, draggable: draggable && pending,
            price: pending ? t.orderPrice : t.entryPrice, colour: pending ? PENDING : ENTRY, dashed: pending,
            title: `#${t.id} ${t.side}${pending ? ` ${t.orderType}` : ""} ${formatLots(trading.account.openUnits(t))}`,
          });
        }
        lines.push({ id: `sl:${t.id}`, draggable, price: t.stopLoss, colour: DOWN, dashed: true, title: `SL #${t.id}` });
        lines.push({ id: `tp:${t.id}`, draggable, price: t.takeProfit, colour: UP, dashed: true, title: `TP #${t.id}` });
      }
    }
    // Only when something changed: re-creating the lines and markers on every candle was measurable work.
    const linesKey = JSON.stringify(lines);
    for (const p of panes()) {
      const markers = markersFor(p.view);
      const markersKey = JSON.stringify(markers);
      if (p.chart !== p.drawnOn || linesKey !== p.linesKey) p.chart.setTradeLines(lines);
      if (p.chart !== p.drawnOn || markersKey !== p.markersKey) p.chart.setTradeMarkers(markers);
      Object.assign(p, { drawnOn: p.chart, linesKey, markersKey });
    }
  }

  /** Entry, partial-close and exit markers, placed on the candles of `view`'s timeframe. */
  function markersFor(view) {
    const markers = [];
    const shown = view.display.length;
    for (const t of trading.broker.trades) {
      if (t.status === Status.CANCELLED) continue;
      const buy = t.side === Side.BUY;
      if (t.entryTime !== null && view.bucketOf[t.entryTime] < shown) {
        markers.push({
          time: view.full.time[view.bucketOf[t.entryTime]], above: !buy, colour: buy ? UP : DOWN,
          shape: buy ? "arrowUp" : "arrowDown", text: `#${t.id}`,
        });
      }
      for (const part of t.partials) { // a small dot where part of the trade was closed
        if (view.bucketOf[part.time] >= shown) continue;
        const gain = (part.price - t.entryPrice) * (buy ? 1 : -1);
        markers.push({
          time: view.full.time[view.bucketOf[part.time]], above: buy, colour: gain >= 0 ? UP : DOWN,
          shape: "circle", text: `#${t.id} part`,
        });
      }
      if (t.exitTime !== null && view.bucketOf[t.exitTime] < shown) {
        markers.push({
          time: view.full.time[view.bucketOf[t.exitTime]], above: buy, colour: t.resultR >= 0 ? UP : DOWN,
          shape: "circle", text: formatR(t.resultR),
        });
      }
    }
    return markers;
  }

  let adrPanel = null; // the ADR plan card (created with the panel, below)
  let challengeOutcome = null; // to notice the moment a challenge passes or fails
  let refreshQueued = false;
  /**
   * Redraw the panel, lines and markers once the current step is over. A replay tick used to
   * redraw twice (once for the engine, once for the clock); now everything that happens in one
   * tick is drawn once, right after it (a microtask: before the browser paints).
   */
  function refreshTrading() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; refreshNow(); });
  }

  function refreshNow() {
    const c = clock.active ? trading.challenge : null;
    if (panel && c && c.outcome !== "RUNNING" && challengeOutcome === "RUNNING") {
      clock.pause(); // stop the replay where the challenge ended
      panel.say(`Challenge ${c.outcome === "PASSED" ? "passed" : "failed"}: ${c.reason}.`, c.outcome === "PASSED" ? "ok" : "bad");
    }
    challengeOutcome = c ? c.outcome : null;
    if (adrPanel) adrPanel.render();
    if (panel) panel.render();
    drawTrades();
    if (clock.active && backtests) backtests.changed(); // saved shortly after (see backtestpanel.js)
    autoScreenshots();
  }

  // ------------------------------------------------------------ journal: notes, tags, screenshots
  let journalBox = null; // the journal box (created with the panel, below)
  const notes = new TradeNotes({
    onChange: () => {
      if (panel) panel.render();
      if (journalBox) journalBox.refresh();
      if (clock.active && backtests) backtests.changed();
    },
  });
  const shotsTaken = new Set(); // "3:entry", "3:exit": automatic screenshots already taken in this run
  let shotQueue = Promise.resolve(); // uploads go one after another; leaving a replay waits for them

  /** Picture of the chart for trade `id`, saved to the backtest's journal folder and listed on the trade. */
  function takeScreenshot(id, kind) {
    const bt = backtests && backtests.current;
    const t = trading.broker.trades.find((trade) => trade.id === id);
    if (!bt || !t || !store.screenshots) return;
    const now = m5.time[clock.position - 1] + manifest.bar_seconds;
    const tfs = panes().map((p) => p.tf).join(" + ");
    const caption = `${manifest.symbol} ${tfs} · #${id} ${t.side} · ${kind} · ${formatDateTime(now)} IST · ${bt.name}`;
    const name = `${bt.id}-t${id}-${kind}${kind === "added" ? `-${Date.now().toString(36)}` : ""}.png`;
    let picture;
    try {
      picture = captureChart(panes().map((p) => p.chart.chart), caption); // taken now; only the upload waits
    } catch (err) {
      panel.say(`Screenshot not taken: ${err.message}`, "bad");
      return;
    }
    shotQueue = shotQueue
      .then(async () => {
        await store.putScreenshot(bt.journal, name, await picture);
        if (backtests.current && backtests.current.id === bt.id) notes.addScreenshot(id, name);
      })
      .catch((err) => panel.say(`Screenshot not saved: ${err.message}`, "bad"));
  }

  /**
   * At entry (when the order is placed) and at exit, unless switched off in the journal box.
   * The engine hears about a new candle before the chart draws it, so the pictures are taken a
   * moment later (a microtask: after the chart update, before the next replay tick), or the exit
   * picture would miss the candle that hit the stop.
   */
  let pendingShots = [];
  function autoScreenshots() {
    if (!clock.active || resuming || !journalBox || !journalBox.autoScreenshots || !backtests || !backtests.current) return;
    for (const t of trading.broker.trades) {
      if (t.status === Status.CANCELLED) continue;
      if (!shotsTaken.has(`${t.id}:entry`)) { shotsTaken.add(`${t.id}:entry`); pendingShots.push([t.id, "entry"]); }
      if (t.status === Status.CLOSED && !shotsTaken.has(`${t.id}:exit`)) { shotsTaken.add(`${t.id}:exit`); pendingShots.push([t.id, "exit"]); }
    }
    if (pendingShots.length) {
      queueMicrotask(() => {
        const shots = pendingShots;
        pendingShots = [];
        for (const [id, kind] of shots) takeScreenshot(id, kind);
      });
    }
  }

  /** Trades that already exist when a run is opened get no automatic pictures (they had their moment). */
  function markShotsTaken(trades) {
    shotsTaken.clear();
    for (const t of trades) {
      shotsTaken.add(`${t.id}:entry`);
      if (t.status === Status.CLOSED || t.status === Status.CANCELLED) shotsTaken.add(`${t.id}:exit`);
    }
  }

  // ------------------------------------------------------------ backtests
  // Each replay is a backtest, saved as you go. Outside a replay the chart keeps its
  // own drawings in the browser; a replay has its own, saved with the backtest.
  let backtests = null; // created below, once the panel exists
  let resuming = false; // a saved backtest is being opened: the clock's "start" must not wipe it
  const useChartDrawings = () => {
    drawings.load(loadSavedDrawings(manifest.symbol));
    layer.select(null);
    layer.storeChanged();
  };

  // ------------------------------------------------------------ drawings
  const drawings = new DrawingStore({
    onChange: () => {
      if (clock.active) backtests.drawingsChanged(); // a replay's drawings belong to its backtest
      else saveDrawings(manifest.symbol, drawings);
      layer.storeChanged();
      renderUndo();
    },
  });
  const undoButton = $("undo"), redoButton = $("redo");
  const renderUndo = () => {
    undoButton.disabled = !drawings.canUndo;
    redoButton.disabled = !drawings.canRedo;
  };
  const toolButtons = [...$("tools").querySelectorAll("[data-tool]")];
  const drawBar = {
    box: $("draw-bar"), text: $("draw-bar-text"), ticket: $("draw-to-ticket"), remove: $("draw-delete"),
    colours: $("draw-colours"), styles: $("draw-styles"), editText: $("draw-edit-text"),
    levels: $("draw-levels"), stop: $("draw-stop"), target: $("draw-target"), fibLevels: $("draw-fib-levels"),
  };
  drawBar.colours.innerHTML = PALETTE.map((c) => `<button data-colour="${c}" style="background:${c}" title="Colour"></button>`).join("");
  let styleDefaults = {};
  try { styleDefaults = JSON.parse(recall(KEY_DRAW_STYLES, "{}")) || {}; } catch { /* damaged: start plain */ }
  // Only known colours and styles are kept from storage.
  styleDefaults = Object.fromEntries(Object.entries(styleDefaults).filter(([tool]) => TOOLS[tool] && TOOLS[tool].styled)
    .map(([tool, s]) => [tool, {
      ...(PALETTE.includes(s && s.color) ? { color: s.color } : {}), ...(LINE_STYLES.includes(s && s.style) ? { style: s.style } : {}),
    }]));
  const clearButton = $("drawings-clear");
  let clearArmed = false;
  const disarmClear = () => {
    if (!clearArmed) return;
    clearArmed = false;
    clearButton.classList.remove("armed");
    setHint(null);
  };
  const priceText = (points) => (points / 10 ** manifest.digits).toFixed(manifest.digits);

  /** Lots and dollars at risk for a long/short drawing, from the account's size settings. */
  function positionNote(d) {
    const sized = trading.account.size(positionStats(d).risk, trading.balance);
    return sized.error ? "" : `${formatLots(sized.units)} lots · risk ${formatMoney(sized.riskMoney)}`;
  }

  // One drawing layer per chart, all on the same drawings, acting as one (see layergroup.js).
  const addLayer = (paneChart) => {
    const cb = layer.callbacks();
    const l = new DrawingLayer(paneChart, {
      store: drawings, pipPoints: manifest.pip_points, note: positionNote, editor: $("text-editor"),
      styleDefaults, onStyleDefaults: (map) => remember(KEY_DRAW_STYLES, JSON.stringify(map)),
      onSelect: cb.onSelect, onToolChange: cb.onToolChange,
    });
    cb.bind(l);
    return layer.add(l);
  };
  const layer = new LayerGroup({
    onToolChange: (tool) => {
      toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === (tool || "")));
      const how = tool === "text" ? "click where the note goes, then type and press Enter"
        : TOOLS[tool]?.clicks === 2 ? "click the first point, then the second" : "click the chart at the price you want";
      setHint(!tool ? null : `${TOOLS[tool].label}: ${how}. Esc cancels.${layer && layer.magnet ? " Magnet on." : ""}`);
      if (tool && picking) setPicking(false);
      if (tool && panel && panel.pickTarget) panel.setPick(null);
    },
    onSelect: (d) => {
      drawBar.box.hidden = !d;
      if (!d) return;
      const position = d.type === "long" || d.type === "short";
      drawBar.ticket.hidden = !position;
      drawBar.levels.hidden = !position;
      if (position) { // keep the typed levels in step with dragging, but never under the cursor of someone typing
        if (document.activeElement !== drawBar.stop) drawBar.stop.value = priceText(d.stop);
        if (document.activeElement !== drawBar.target) drawBar.target.value = priceText(d.target);
      }
      drawBar.text.textContent = position
        ? `${TOOLS[d.type].label} · ${positionStats(d).ratio.toFixed(2)}R`
        : d.type === "hline" || d.type === "hray" ? `${TOOLS[d.type].label} · ${priceText(d.points[0].price)}` : TOOLS[d.type].label;
      const styled = TOOLS[d.type].styled;
      drawBar.colours.hidden = !styled;
      drawBar.styles.hidden = !styled || d.type === "text";
      drawBar.editText.hidden = d.type !== "text";
      drawBar.fibLevels.hidden = d.type !== "fib";
      drawBar.colours.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.colour === (d.color || PALETTE[0])));
      drawBar.styles.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.lineStyle === (d.style || "solid")));
    },
  });
  mainPane.layer = addLayer(chart);
  drawings.load(loadSavedDrawings(manifest.symbol));
  layer.redraw();
  renderUndo();

  drawBar.colours.addEventListener("click", (event) => {
    const b = event.target.closest("[data-colour]");
    if (b) layer.restyle({ color: b.dataset.colour });
  });
  drawBar.styles.addEventListener("click", (event) => {
    const b = event.target.closest("[data-line-style]");
    if (b) layer.restyle({ style: b.dataset.lineStyle });
  });
  drawBar.editText.addEventListener("click", () => { if (layer.selected) layer.editText({ id: layer.selected.id }); });
  // ------------------------------------------------------------ Fibonacci levels
  // Each Fibonacci drawing carries its own levels; "Save as default" sets what new ones start with.
  const FIB_PRESETS = {
    standard: FIB_LEVELS,
    classic: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
    extensions: [-2, -1, -0.618, -0.27, ...FIB_LEVELS, 1.272, 1.618],
  };
  const fibDialog = $("fib-dialog");
  let fibDraft = null; // { id, rows: [{ level, on }], ote } while the dialog is open
  const loadFibDefaults = () => {
    try {
      const raw = JSON.parse(recall(KEY_FIB_DEFAULTS, "null"));
      const levels = raw && cleanFibLevels(raw.levels);
      return levels ? { levels, ote: raw.ote !== false } : null;
    } catch { return null; }
  };
  layer.setFibDefaults(loadFibDefaults());

  function renderFibRows() {
    $("fib-rows").innerHTML = fibDraft.rows.map((r, i) => `<tr data-row="${i}">
      <td><input type="checkbox" data-fib-on${r.on ? " checked" : ""}></td>
      <td><input type="number" step="any" data-fib-level value="${r.level}"></td>
      <td><button type="button" class="plain small" data-fib-remove title="Remove this level">&times;</button></td></tr>`).join("");
    $("fib-ote").checked = fibDraft.ote;
  }
  /** The levels as typed and ticked, made safe; null (with a message) when nothing usable is left. */
  function fibLevelsFromDraft() {
    const levels = cleanFibLevels(fibDraft.rows.filter((r) => r.on).map((r) => r.level));
    $("fib-message").textContent = levels ? "" : "Keep at least one level, between -5 and 10.";
    return levels;
  }
  drawBar.fibLevels.addEventListener("click", () => {
    const d = layer.selected;
    if (!d || d.type !== "fib") return;
    fibDraft = { id: d.id, rows: fibLevelsOf(d).map((level) => ({ level, on: true })), ote: d.ote !== false };
    $("fib-message").textContent = "";
    renderFibRows();
    fibDialog.showModal();
  });
  fibDialog.addEventListener("input", (event) => {
    const row = event.target.closest("[data-row]");
    if (!row || !fibDraft) return;
    const r = fibDraft.rows[Number(row.dataset.row)];
    if (event.target.matches("[data-fib-on]")) r.on = event.target.checked;
    if (event.target.matches("[data-fib-level]")) r.level = Number(event.target.value);
  });
  fibDialog.addEventListener("click", (event) => {
    if (!fibDraft) return;
    const remove = event.target.closest("[data-fib-remove]");
    if (remove) { fibDraft.rows.splice(Number(remove.closest("[data-row]").dataset.row), 1); renderFibRows(); }
    const preset = event.target.closest("[data-fib-preset]");
    if (preset) { fibDraft.rows = FIB_PRESETS[preset.dataset.fibPreset].map((level) => ({ level, on: true })); renderFibRows(); }
  });
  $("fib-ote").addEventListener("change", (event) => { if (fibDraft) fibDraft.ote = event.target.checked; });
  $("fib-add").addEventListener("click", () => {
    const input = $("fib-new");
    const value = Number(input.value);
    if (input.value.trim() === "" || !cleanFibLevels([value])) { $("fib-message").textContent = "Type a level between -5 and 10, for example 1.272."; return; }
    fibDraft.rows.push({ level: value, on: true });
    fibDraft.rows.sort((a, b) => a.level - b.level);
    input.value = "";
    $("fib-message").textContent = "";
    renderFibRows();
  });
  $("fib-new").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("fib-add").click(); } });
  $("fib-cancel").addEventListener("click", () => { fibDraft = null; fibDialog.close(); });
  $("fib-apply").addEventListener("click", () => {
    const levels = fibLevelsFromDraft();
    const d = fibDraft && drawings.get(fibDraft.id);
    if (!levels || !d) return;
    const { id, ote, ...rest } = d;
    drawings.update(id, { ...rest, levels, ...(fibDraft.ote ? {} : { ote: false }) }); // one undo step
    layer.select(id);
    fibDraft = null;
    fibDialog.close();
  });
  $("fib-default").addEventListener("click", () => {
    const levels = fibLevelsFromDraft();
    if (!levels) return;
    const defaults = { levels, ote: fibDraft.ote };
    remember(KEY_FIB_DEFAULTS, JSON.stringify(defaults));
    layer.setFibDefaults(defaults);
    $("fib-message").textContent = "";
    setHint("New Fibonacci drawings will start with these levels.");
    setTimeout(() => setHint(null), 1800);
  });

  // Typed stop and target for a long/short position. They go through the same rules as dragging
  // (stop below entry below target for a long), so a price on the wrong side stops one point short.
  for (const [input, key] of [[drawBar.stop, "stop"], [drawBar.target, "target"]]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { input.blur(); return; }
      if (event.key !== "Enter") return;
      const d = layer.selected;
      const price = Math.round(Number(input.value) * 10 ** manifest.digits);
      if (!d || !(d.type === "long" || d.type === "short") || !Number.isFinite(price) || price <= 0) {
        setHint("Type a price like 1.08500.");
        setTimeout(() => setHint(null), 1800);
        return;
      }
      const { id, ...rest } = moveHandle(d, key, { time: d.points[0].time, price });
      drawings.update(id, rest);
      layer.select(id); // still selected, so the bar shows the new numbers
      input.blur();
    });
  }

  const magnetButton = $("magnet");
  const setMagnet = (on) => {
    layer.setMagnet(on);
    magnetButton.classList.toggle("active", layer.magnet);
    remember(KEY_MAGNET, layer.magnet ? "on" : "off");
  };
  setMagnet(recall(KEY_MAGNET, "off") === "on");
  magnetButton.addEventListener("click", () => setMagnet(!layer.magnet));
  const undoDrawing = () => { layer.cancel(); if (drawings.undo()) layer.select(null); };
  const redoDrawing = () => { layer.cancel(); if (drawings.redo()) layer.select(null); };
  undoButton.addEventListener("click", undoDrawing);
  redoButton.addEventListener("click", redoDrawing);

  // The shortcut list is built from the same table that handles the keys, so it cannot go out of date.
  const kbd = (keys) => keys.split(" + ").map((k) => `<kbd>${k}</kbd>`).join(" + ");
  $("shortcut-rows").innerHTML = [...SHORTCUTS, ...OTHER_KEYS]
    .map((s) => `<tr><td>${kbd(s.keys)}</td><td>${s.label}</td></tr>`).join("");
  const shortcutsDialog = $("shortcuts-dialog");
  $("shortcuts-open").addEventListener("click", () => shortcutsDialog.showModal());
  $("shortcuts-close").addEventListener("click", () => shortcutsDialog.close());

  toolButtons.forEach((b) => b.addEventListener("click", () => {
    disarmClear();
    layer.setTool(layer.tool === b.dataset.tool ? null : b.dataset.tool || null);
  }));
  drawBar.remove.addEventListener("click", () => layer.deleteSelected());
  drawBar.ticket.addEventListener("click", () => {
    const d = layer.selected;
    if (!d) return;
    panel.loadOrder({
      side: d.type === "long" ? Side.BUY : Side.SELL, price: d.points[0].price, stopLoss: d.stop, takeProfit: d.target,
    });
  });
  clearButton.addEventListener("click", () => {
    if (drawings.items.length === 0) return;
    if (!clearArmed) { // removing everything cannot be undone, so it takes a second click
      clearArmed = true;
      clearButton.classList.add("armed");
      setHint(`Remove all ${drawings.items.length} drawings? Click the bin again to confirm, or press Esc. (Ctrl + Z brings them back.)`);
      return;
    }
    disarmClear();
    drawings.clear();
  });

  const tfButtons = [...$("timeframes").querySelectorAll("button")];
  function setTimeframe(tf, { keepPlace = true } = {}) {
    // Stay at the same place in history, unless you were at the newest candle: then stay at the newest.
    const keepTime = keepPlace && !chart.latestVisible() ? chart.rightEdgeTime() : null;
    current = tf;
    view = viewFor(tf);
    view.setPosition(clock.position);
    remember(KEY_TIMEFRAME, tf);
    tfButtons.forEach((b) => b.classList.toggle("active", b.dataset.tf === tf));
    chart.setCandles(tf, view.display, { keepTime });
    drawTrades();
  }
  tfButtons.forEach((b) => {
    b.disabled = false;
    b.addEventListener("click", () => setTimeframe(b.dataset.tf));
  });
  setTimeframe(current, { keepPlace: false });

  // ------------------------------------------------------------ second chart
  const layoutButton = $("layout-toggle");
  const sideSelect = $("side-tf");
  sideSelect.innerHTML = TIMEFRAMES.map((t) => `<option value="${t.id}">${t.id}</option>`).join("");

  /** The side chart's timeframe. It starts at the same moment as the main chart's right edge. */
  function setSideTimeframe(tf) {
    sidePane.tf = tf;
    sidePane.view = new TimeframeView(m5, tf);
    sidePane.view.setPosition(clock.position);
    sideSelect.value = tf;
    remember(KEY_SIDE_TF, tf);
    const keepTime = chart.latestVisible() ? null : chart.rightEdgeTime();
    sidePane.chart.setCandles(tf, sidePane.view.display, { keepTime });
    drawTrades();
    layer.redraw();
  }
  sideSelect.addEventListener("change", () => setSideTimeframe(sideSelect.value));

  /** One chart, or two side by side. The second chart is made the first time it is wanted. */
  function setLayout(two) {
    layoutTwo = two;
    remember(KEY_LAYOUT, two ? "two" : "one");
    layoutButton.classList.toggle("active", two);
    $("chart-view").classList.toggle("split", two);
    $("pane-side").hidden = !two;
    if (two) {
      if (!sidePane.chart) {
        sidePane.chart = new ChartView($("chart2"), chartOptions(sidePane));
        sidePane.chart.setSessionsVisible(sessionsOn);
        sidePane.chart.setSmc(smc);
        sidePane.chart.setIndicators(indicators);
      }
      if (!sidePane.layer) sidePane.layer = addLayer(sidePane.chart);
      setSideTimeframe(sidePane.tf);
    } else if (sidePane.layer) {
      sidePane.layer.select(null);
      layer.remove(sidePane.layer); // a hidden chart takes no part in drawing
      sidePane.layer.setTool(null);
      sidePane.layer = null;
    }
  }
  layoutButton.addEventListener("click", () => setLayout(!layoutTwo));

  // ------------------------------------------------------------ indicators
  const indicatorsDialog = $("indicators-dialog");
  const indicatorsButton = $("indicators-open");
  function renderIndicatorForm() {
    for (const [key, s] of Object.entries(indicators)) {
      indicatorsDialog.querySelector(`[data-ind="${key}"]`).checked = s.on;
      const period = indicatorsDialog.querySelector(`[data-period="${key}"]`);
      if (period) period.value = s.period;
      const levels = indicatorsDialog.querySelector(`[data-levels="${key}"]`);
      if (levels) levels.checked = s.levels;
    }
    const q = (selector) => indicatorsDialog.querySelector(selector);
    for (const key of ["internalOb", "swingOb", "fvg"]) q(`[data-smc="${key}"]`).checked = smc[key].on;
    q('[data-smc-count="internalOb"]').value = smc.internalOb.count;
    q('[data-smc-count="swingOb"]').value = smc.swingOb.count;
    q("[data-smc-length]").value = smc.swingOb.length;
    q("[data-smc-extend]").value = smc.fvg.extend;
    q("[data-smc-auto]").checked = smc.fvg.auto;
    q("[data-smc-mitigation]").value = smc.mitigation;
    q("[data-smc-filter]").value = smc.filter;
    indicatorsButton.classList.toggle("active", Object.values(indicators).some((s) => s.on) || smcActive(smc));
  }
  function applyIndicators() {
    const raw = {};
    for (const key of Object.keys(indicators)) {
      const period = indicatorsDialog.querySelector(`[data-period="${key}"]`);
      const levels = indicatorsDialog.querySelector(`[data-levels="${key}"]`);
      raw[key] = {
        on: indicatorsDialog.querySelector(`[data-ind="${key}"]`).checked,
        ...(period ? { period: period.value } : {}), ...(levels ? { levels: levels.checked } : {}),
      };
    }
    indicators = cleanIndicators(raw);
    remember(KEY_INDICATORS, JSON.stringify(indicators));
    for (const c of [chart, sidePane.chart]) if (c) c.setIndicators(indicators);
    renderIndicatorForm(); // a refused period snaps back to what is used
  }
  function applySmc() {
    const q = (selector) => indicatorsDialog.querySelector(selector);
    smc = cleanSmc({
      internalOb: { on: q('[data-smc="internalOb"]').checked, count: q('[data-smc-count="internalOb"]').value },
      swingOb: { on: q('[data-smc="swingOb"]').checked, count: q('[data-smc-count="swingOb"]').value, length: q("[data-smc-length]").value },
      fvg: { on: q('[data-smc="fvg"]').checked, auto: q("[data-smc-auto]").checked, extend: q("[data-smc-extend]").value },
      mitigation: q("[data-smc-mitigation]").value,
      filter: q("[data-smc-filter]").value,
    });
    remember(KEY_SMC, JSON.stringify(smc));
    for (const c of [chart, sidePane.chart]) if (c) c.setSmc(smc);
  }
  indicatorsDialog.addEventListener("change", (event) => {
    if (event.target.closest("[data-smc], [data-smc-count], [data-smc-length], [data-smc-extend], [data-smc-auto], [data-smc-mitigation], [data-smc-filter]")) {
      applySmc();
      renderIndicatorForm(); // a refused number snaps back to what is used
    } else {
      applyIndicators();
    }
  });
  indicatorsButton.addEventListener("click", () => { renderIndicatorForm(); indicatorsDialog.showModal(); });
  $("indicators-close").addEventListener("click", () => indicatorsDialog.close());
  renderIndicatorForm();

  // ------------------------------------------------------------ replay
  const ui = {
    toggle: $("replay-toggle"), controls: $("replay-controls"), back: $("replay-back"),
    play: $("replay-play"), forward: $("replay-forward"), speed: $("replay-speed"),
    live: $("replay-live"), exit: $("replay-exit"), clock: $("clock"),
  };
  let exitArmed = false; // ✕ was clicked once and the save failed
  ui.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}x</option>`).join("");

  function setPicking(on) {
    if (on) layer.setTool(null);
    picking = on;
    setHint(on ? "Click the candle you want the replay to start from. Press Esc to cancel." : null);
    ui.toggle.classList.toggle("active", on);
    $("chart-view").classList.toggle("picking", on);
  }

  function renderReplayUi() {
    ui.toggle.hidden = clock.active;
    ui.controls.hidden = !clock.active;
    document.body.classList.toggle("replaying", clock.active);
    if (!clock.active) {
      ui.clock.textContent = "";
      return;
    }
    ui.play.innerHTML = clock.playing ? "&#10074;&#10074;" : "&#9654;";
    ui.play.title = clock.playing ? "Pause (Space)" : "Play (Space)";
    ui.forward.disabled = clock.finished;
    ui.live.hidden = clock.live;
    const now = m5.time[clock.position - 1] + manifest.bar_seconds; // close of the last revealed candle
    const behind = clock.furthest - clock.position;
    ui.clock.textContent = `Replay · ${formatDateTime(now)} IST` +
      (behind > 0 ? ` · viewing history (${number(behind)} M5 back)` : "");
    ui.clock.classList.toggle("history", behind > 0);
  }

  clock.onChange((_, reason) => {
    if (reason === "start" && !resuming) { // a new replay is a new run: no trades carried over
      trading.reset();
      shotsTaken.clear();
      notes.load({});
      const startTime = m5.time[clock.position - 1];
      backtests.begin(startTime, manifest.symbol);
      // Drawings come along only if they sit wholly before the replay's "now" (no look-ahead).
      drawings.load(drawingsBefore(drawings.toJSON(), startTime + manifest.bar_seconds));
      layer.select(null);
      layer.storeChanged();
    }
    if (exitArmed && reason !== "stop") { exitArmed = false; setHint(null); }
    for (const p of panes()) updatePane(p, reason);
    renderReplayUi();
    refreshTrading();
  });

  /** Bring one chart up to the replay clock: only what changed, or everything after a start, stop or jump. */
  function updatePane(p, reason) {
    const c = p.chart, v = p.view;
    const follow = c.latestVisible();
    const change = v.setPosition(clock.position);
    if (reason === "start") {
      c.setCandles(p.tf, v.display, { bars: c.visibleBarCount() }); // replay edge at the right
    } else if (reason === "stop") {
      c.setCandles(p.tf, v.display, { keepTime: c.rightEdgeTime(), bars: c.visibleBarCount() });
    } else if (change.reset) {
      c.setCandles(p.tf, v.display, { preserveView: true });
      if (follow) c.goToLatest();
    } else if (change.to >= change.from) {
      c.updateBars(change.from, change.to);
    }
  }
  const allToLatest = () => { for (const p of panes()) p.chart.goToLatest(); };

  ui.toggle.addEventListener("click", () => setPicking(!picking));
  ui.play.addEventListener("click", () => clock.toggle());
  ui.forward.addEventListener("click", () => clock.stepForward(view));
  ui.back.addEventListener("click", () => clock.stepBack(view));
  ui.live.addEventListener("click", () => { clock.backToLive(); allToLatest(); });
  // Leaving saves the backtest; open trades and orders stay open in it, ready to resume.
  ui.exit.addEventListener("click", async () => {
    clock.pause();
    await shotQueue; // screenshots still uploading belong in this save
    const wasSaved = backtests.worthSaving;
    if (exitArmed) {
      backtests.abandon(); // second click after a failed save: leave without saving
    } else if (!(await backtests.end())) {
      exitArmed = true;
      setHint("This backtest could not be saved (see the bottom bar). Click ✕ again to leave without saving it.");
      return;
    }
    exitArmed = false;
    setHint(null);
    leaveReplay();
    panel.say(wasSaved ? "Backtest saved. Open Backtests to carry on with it later." : "", "ok");
  });

  function leaveReplay() {
    clock.stop();
    trading.challengeRules = loadChallengeRules(); // likewise its challenge rules
    trading.reset();
    trading.updateSettings(loadSettings()); // a resumed backtest brought its own settings; go back to yours
    panel.renderSettings();
    useChartDrawings();
    notes.load({});
    journalBox.pick(null);
  }

  /** Rebuild a saved backtest and open it at the point it had reached. Returns the rebuild's problems. */
  async function resumeBacktest(journal, id) {
    const saved = await store.getBacktest(journal, id);
    const result = rebuild(saved, { m5, pipPoints: manifest.pip_points, pointValue: pointValuePerLot(manifest.digits) });
    await shotQueue;
    if (clock.active && !(await backtests.end())) {
      throw new Error("the replay on screen could not be saved, so it was left open.");
    }
    markShotsTaken(result.trading.broker.trades);
    clock.pause();
    layer.setTool(null);
    setPicking(false);
    resuming = true;
    try { clock.start(result.position); } finally { resuming = false; }
    notes.load(saved.notes || {});
    trading.adopt(result.trading);
    backtests.continueWith(saved);
    journalBox.pick(null);
    drawings.load(saved.drawings);
    layer.select(null);
    layer.storeChanged();
    if (TIMEFRAMES.some((t) => t.id === saved.timeframe)) setTimeframe(saved.timeframe, { keepPlace: false });
    panel.renderSettings();
    refreshTrading();
    panel.say(result.problems.length
      ? `Resumed "${saved.name}", but the rebuild does not match the save (see Backtests).`
      : `Resumed "${saved.name}": ${saved.actions.length} action(s) repeated; every trade matches the save.`,
    result.problems.length ? "bad" : "ok");
    return result.problems;
  }
  ui.speed.addEventListener("change", () => clock.setSpeed(Number(ui.speed.value)));

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement) return; // typing, not a shortcut
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Escape" && panes().some((p) => p.chart.cancelDrag())) return;
    if (event.key === "Escape" && clearArmed) { disarmClear(); return; }
    if (event.key === "Escape" && layer.cancel()) return;
    if ((event.key === "Delete" || event.key === "Backspace") && layer.deleteSelected()) { event.preventDefault(); return; }
    const action = shortcutFor(event);
    if (action) {
      event.preventDefault(); // Alt + F would otherwise open the browser's menu
      disarmClear();
      if (action.startsWith("tool:")) {
        const tool = action.slice(5);
        layer.setTool(layer.tool === tool ? null : tool);
      } else if (action === "magnet") {
        setMagnet(!layer.magnet);
        setHint(`Magnet ${layer.magnet ? "on: a point near a candle's open, high, low or close jumps onto it" : "off"}.`);
        setTimeout(() => setHint(null), 1800);
      } else if (action === "undo") undoDrawing();
      else if (action === "redo") redoDrawing();
      else if (action === "help") shortcutsDialog.showModal();
      return;
    }
    if (event.key === "Escape" && picking) { setPicking(false); return; }
    if (event.key === "Escape" && panel.pickTarget) { panel.setPick(null); return; }
    if (!clock.active) return;
    if (event.key === " ") { event.preventDefault(); clock.toggle(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); event.shiftKey ? clock.advance(1) : clock.stepForward(view); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); clock.stepBack(view); }
    else if (event.key === "End") { clock.backToLive(); allToLatest(); }
  });
  panel = new TradingPanel($("trading-panel"), {
    trading, m5, digits: manifest.digits,
    onPickChange: (label) => setHint(label ? `Click the chart at the price for your ${label}. Press Esc to cancel.` : null),
    notes,
    onPickTrade: (id) => journalBox.pick(journalBox.id === id ? null : id),
    planCheck: (order) => (adrPanel ? adrPanel.check(order) : []),
  });
  // The ADR plan: today's ADR and the plan's thresholds, for the replay's day (or the newest day outside a replay).
  adrPanel = new AdrPanel($("adr-plan"), { m5, nowIndex: () => clock.position - 1, pipPoints: manifest.pip_points });
  journalBox = new JournalPanel($("journal-box"), {
    store,
    notes,
    describe: (id) => {
      const t = clock.active ? trading.broker.trades.find((trade) => trade.id === id) : null;
      if (!t) return null;
      const state = t.status === Status.CLOSED ? formatR(t.resultR) : t.status.toLowerCase();
      return `#${t.id} ${t.side} · ${state}`;
    },
    journal: () => backtests && backtests.current ? backtests.current.journal : null,
    onScreenshot: (id) => takeScreenshot(id, "added"),
    onRemoveScreenshot: (id, name) => {
      const bt = backtests.current;
      if (bt) store.deleteScreenshot(bt.journal, name);
      notes.removeScreenshot(id, name);
    },
    onPick: (id) => { panel.pickedTrade = id; panel.render(); },
  });
  backtests = new Backtests({
    store,
    dialog: $("backtests-dialog"),
    status: $("status-backtest"),
    collect: () => ({ trading, drawings, notes, m5, clock, manifest, timeframe: current }),
    onResume: resumeBacktest,
  });
  $("backtests-open").addEventListener("click", () => { clock.pause(); backtests.open(); });
  window.addEventListener("pagehide", () => backtests.saveOnUnload());
  renderReplayUi();
  refreshTrading();

  // ------------------------------------------------------------ sessions
  const sessionsButton = $("sessions-toggle");
  let sessionsOn = recall(KEY_SESSIONS, "on") === "on";
  const applySessions = () => {
    for (const c of [chart, sidePane.chart]) if (c) c.setSessionsVisible(sessionsOn);
    sessionsButton.classList.toggle("active", sessionsOn);
    $("session-key").hidden = !sessionsOn;
  };
  sessionsButton.addEventListener("click", () => {
    sessionsOn = !sessionsOn;
    remember(KEY_SESSIONS, sessionsOn ? "on" : "off");
    applySessions();
  });
  applySessions();
  renderSessionKey($("session-key"));
  const openSessionSettings = setupSessionSettings($("sessions-dialog"), {
    // India-time preview for the date you are looking at: the replay time, or the newest candle.
    referenceTime: () => m5.time[clock.position - 1],
    onSaved: () => {
      for (const c of [chart, sidePane.chart]) if (c) c.refreshSessions();
      renderSessionKey($("session-key"));
    },
  });
  $("sessions-settings").addEventListener("click", openSessionSettings);

  // ------------------------------------------------------------ go to date / latest
  // A day on its own means the start of that trading day: its first candle after 17:00 New York
  // (the broker's midnight, about 02:30 or 03:30 in India), the same days the ADR, the challenge and
  // the P&L calendar use. With a time it is that moment in India time. The ‹ › buttons step a trading day.
  const gotoDate = $("goto-date"), gotoTime = $("goto-time");
  gotoDate.min = dayToInput(serverDate(manifest.first));
  gotoDate.max = dayToInput(serverDate(manifest.last));
  /** The index of the first M5 candle on or after trading day `day` (m5.length if none). */
  const firstCandleOfDay = (day) => {
    let lo = 0, hi = m5.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (serverDate(m5.time[mid]) < day) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const lastRevealed = () => m5.time[Math.max(1, clock.furthest) - 1]; // during a replay, nothing after it
  let shown = { date: "", time: "" }; // what the boxes said at the last jump that worked
  function jumpTo(utc) {
    if (utc > lastRevealed()) {
      gotoDate.value = shown.date; // the boxes go back to what is on screen
      gotoTime.value = shown.time;
      panel.say(clock.active
        ? `That is after where this replay has got to (${formatDateTime(lastRevealed())}). Play on to reach it, or leave the replay.`
        : "That is after the last candle in the data.", "bad");
      return false;
    }
    for (const p of panes()) p.chart.showFrom(Math.max(utc, manifest.first));
    shown = { date: gotoDate.value, time: gotoTime.value };
    return true;
  }
  function goToDay(day) {
    const i = firstCandleOfDay(day);
    if (i >= m5.length) { panel.say("There are no candles on or after that day.", "bad"); return; }
    const found = serverDate(m5.time[i]);
    if (!jumpTo(m5.time[i])) return;
    gotoDate.value = dayToInput(found);
    shown.date = gotoDate.value;
    panel.say(found === day ? `Start of ${formatDateTime(m5.time[i])} IST (the trading day opens at 17:00 New York).`
      : `No candles on ${dayToInput(day)} (weekend or holiday): showing the next trading day, from ${formatDateTime(m5.time[i])} IST.`, "ok");
  }
  function go() {
    const day = inputToDay(gotoDate.value);
    if (day === null) return;
    if (!gotoTime.value) { goToDay(day); return; }
    const when = parseIndiaInput(`${gotoDate.value}T${gotoTime.value}`);
    if (when !== null && jumpTo(when)) panel.say(`${formatDateTime(when)} IST.`, "ok");
  }
  /** The next (+1) or previous (-1) trading day that has candles, from the day in the box or the last revealed candle. */
  function stepDay(dir) {
    const from = inputToDay(gotoDate.value) ?? serverDate(lastRevealed());
    gotoTime.value = "";
    if (dir > 0) { // the next day with candles, so a Friday steps to Monday without a weekend message
      const i = firstCandleOfDay(from + 1);
      if (i >= m5.length) { panel.say("That is the last day in the data.", "bad"); return; }
      goToDay(serverDate(m5.time[i]));
      return;
    }
    const i = firstCandleOfDay(from) - 1; // the last candle before that day
    if (i < 0) { panel.say("That is the first day in the data.", "bad"); return; }
    goToDay(serverDate(m5.time[i]));
  }
  gotoDate.addEventListener("change", go);
  gotoTime.addEventListener("change", go);
  for (const input of [gotoDate, gotoTime]) input.addEventListener("keydown", (event) => { if (event.key === "Enter") go(); });
  $("goto-prev").addEventListener("click", () => stepDay(-1));
  $("goto-next").addEventListener("click", () => stepDay(1));
  $("latest").addEventListener("click", allToLatest);
  setLayout(layoutTwo); // after the sessions are set up: the side chart copies their visibility

  // ------------------------------------------------------------ tabs
  const tabViews = { chart: $("chart-view"), analytics: $("analytics-view"), data: $("data-view") };
  const analytics = new AnalyticsView($("analytics-view"), store);
  document.querySelectorAll("[data-view]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.view;
      Object.entries(tabViews).forEach(([key, el]) => { el.hidden = key !== name; });
      document.querySelectorAll("[data-view]").forEach((t) => t.classList.toggle("active", t === tab));
      if (name === "data") redrawData();
      if (name === "analytics") {
        clock.pause();
        // Save the replay on screen first, so its latest trades are in the journal being read.
        (backtests.current ? backtests.save() : Promise.resolve()).then(() => analytics.open());
      }
    });
  });

  // Handy in the browser console and for automated checks.
  window.forexReplay = {
    manifest, quality, m5, chart, clock, trading, panel, viewFor, setTimeframe, drawings, layer, backtests, notes, journalBox,
    sidePane, setLayout, setSideTimeframe,
    get timeframe() { return current; },
    get view() { return view; },
  };
}

boot().catch((err) => {
  console.error(err);
  showError(`Something went wrong while starting the app.\n${err.message}`);
});

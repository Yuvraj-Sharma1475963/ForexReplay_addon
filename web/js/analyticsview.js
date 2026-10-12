// The Analytics tab: statistics, an equity curve, a histogram of results and breakdowns,
// for one journal, filtered by run, side, session or tag.
//
// The numbers come from analytics.js (held to stats.py by a recorded test). This file only
// fetches the journal, draws, and handles the filters. Everything drawn from the journal is
// escaped first: notes and tags are typed by hand and must never become page markup.

import {
  applyFilters, balanceCurve, breakdown, computeStats, dailyPnl, equityCurve, filterChoices, gaveBack, histogram, money, monthWeeks,
  parseRows, propCheck,
} from "./analytics.js";

const UP = "#26a69a", DOWN = "#ef5350", LINE = "#2962ff", GRID = "#2a2e39", MUTED = "#868993";
const KEY_JOURNAL = "forexreplay.analytics.journal";
const KEY_RISK = "forexreplay.analytics.risk";

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const r2 = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}R` : "–");
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "–");
const ratio = (v) => (v === Infinity ? "∞" : Number.isFinite(v) ? v.toFixed(2) : "–");
const usd = (v) => `${v < -0.004 ? "-" : v >= 0.005 ? "+" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shortDay = (day) => `${day.slice(8, 10)} ${MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3)}`;
const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
/** Whole number, halves to even, the way Python's report prints it (32.5 -> 32), so both show the same figure. */
const roundEven = (v) => { const f = Math.floor(v); const d = v - f; return d > 0.5 + 1e-9 || (Math.abs(d - 0.5) <= 1e-9 && f % 2 !== 0) ? f + 1 : f; };

function recall(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

export class AnalyticsView {
  /** @param {HTMLElement} root  the analytics section */
  /** @param {HTMLElement} root  the analytics section; @param {object} store  where journals are kept (store.js) */
  constructor(root, store) {
    this.store = store;
    this.root = root;
    this.el = (id) => root.querySelector(`#${id}`);
    this.trades = [];
    this.filters = { run: "", side: "", session: "", tag: "" };
    this.backtests = [];
    this.pendingRun = null; // a backtest to show on its own once its journal is loaded (focusRun)
    this.onShowTrade = null; // (journal, runId, tradeId) => void: set by main.js to draw a trade on the chart
    this.el("an-trades").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-show-trade]");
      if (button && this.onShowTrade) this.onShowTrade(this.journal, button.dataset.run, button.dataset.showTrade);
    });
    this.el("an-journal").addEventListener("change", (event) => {
      remember(KEY_JOURNAL, event.target.value);
      this.loadJournal(event.target.value);
    });
    for (const key of Object.keys(this.filters)) {
      this.el(`an-${key}`).addEventListener("change", (event) => { this.filters[key] = event.target.value; this.render(); });
    }
    this.el("an-risk").value = recall(KEY_RISK, "1");
    this.el("an-risk").addEventListener("change", () => { remember(KEY_RISK, this.el("an-risk").value); this.render(); });
    this.month = ""; // "YYYY-MM" shown in the P&L calendar
    this.el("an-month").addEventListener("change", (event) => { this.month = event.target.value; this.render(); });
    for (const [id, step] of [["an-month-prev", 1], ["an-month-next", -1]]) {
      this.el(id).addEventListener("click", () => {
        const select = this.el("an-month"); // months are listed newest first
        const i = select.selectedIndex + step;
        if (i >= 0 && i < select.options.length) { this.month = select.options[i].value; this.render(); }
      });
    }
    this.el("an-clear").addEventListener("click", () => {
      for (const key of Object.keys(this.filters)) { this.filters[key] = ""; this.el(`an-${key}`).value = ""; }
      this.render();
    });
  }

  /** Open next on one backtest alone: its journal, that run, no other filter. Call before open(). */
  focusRun(journal, runId) {
    remember(KEY_JOURNAL, journal);
    this.pendingRun = runId;
  }

  /** Called when the tab opens: refresh the list of journals and the chosen journal. */
  async open() {
    let journals = [], backtests = [];
    try {
      [journals, backtests] = await Promise.all([
        this.store.listJournals(),
        this.store.listBacktests(),
      ]);
    } catch (err) {
      this.message(`Could not reach the app's server: ${err.message}`);
      return;
    }
    this.backtests = backtests;
    const select = this.el("an-journal");
    if (journals.length === 0) {
      select.innerHTML = "";
      this.trades = [];
      this.message("No journal yet. Trades appear here once a backtest with a closed trade has been saved.");
      return;
    }
    const wanted = recall(KEY_JOURNAL, "");
    const chosen = journals.some((j) => j.name === wanted) ? wanted : journals[0].name;
    select.innerHTML = journals.map((j) => `<option value="${escapeHtml(j.name)}"${j.name === chosen ? " selected" : ""}>` +
      `${escapeHtml(j.name)} (${j.trades})</option>`).join("");
    await this.loadJournal(chosen);
  }

  async loadJournal(name) {
    this.journal = name;
    try {
      this.trades = parseRows(await this.store.journalRows(name));
    } catch (err) {
      this.message(`Could not read the journal: ${err.message}`);
      return;
    }
    // Keep a filter only if its value still exists in this journal.
    const choices = filterChoices(this.trades);
    const focus = this.pendingRun;
    this.pendingRun = null;
    if (focus !== null) for (const key of Object.keys(this.filters)) this.filters[key] = key === "run" ? focus : "";
    for (const key of Object.keys(this.filters)) {
      if (!choices[key].includes(this.filters[key])) this.filters[key] = "";
      const label = { run: "All backtests", side: "Both sides", session: "All sessions", tag: "All tags" }[key];
      const names = key === "run" ? this.runNames() : {};
      this.el(`an-${key}`).innerHTML = `<option value="">${label}</option>` + choices[key]
        .map((v) => `<option value="${escapeHtml(v)}"${v === this.filters[key] ? " selected" : ""}>${escapeHtml(names[v] || v)}</option>`).join("");
    }
    if (focus !== null && this.filters.run !== focus) {
      const b = this.backtests.find((x) => x.id === focus);
      this.message(`"${b ? b.name : focus}" has no closed trades yet, so there is nothing to analyse. Pick another backtest above.`);
      return;
    }
    this.render();
  }

  /** Backtest names for run ids, so the filter says "EURUSD from Thu 13 Aug…" rather than "bt-2026…". */
  runNames() {
    return Object.fromEntries(this.backtests.filter((b) => b.name).map((b) => [b.id, b.name]));
  }

  message(text) {
    this.el("an-message").textContent = text;
    this.el("an-message").hidden = !text;
    this.el("an-body").hidden = !!text;
  }

  render() {
    const trades = applyFilters(this.trades, this.filters);
    const stats = computeStats(trades);
    if (!stats) {
      this.message(this.trades.length ? "No trades match these filters." : "This journal has no closed trades yet.");
      return;
    }
    this.message("");
    const filtered = trades.length !== this.trades.length;
    this.el("an-count").textContent = filtered ? `${trades.length} of ${this.trades.length} trades` : `${trades.length} trades`;
    this.renderTiles(stats, trades);
    this.renderBalance(trades);
    this.renderCalendar(trades);
    this.renderEquity(trades);
    this.renderHistogram(trades);
    this.renderInsights(stats, trades);
    this.renderBreakdowns(trades);
    this.renderTrades(trades);
  }

  renderTiles(s, trades) {
    const m = money(trades);
    const tiles = [
      ["Trades", `${s.trades}`, `${s.wins} won · ${s.losses} lost · ${s.breakevens} breakeven`],
      ["Win rate", pct(s.win_rate), `breakeven = within ±0.05R`],
      ["Expectancy", r2(s.expectancy_r), "average result per trade", tone(s.expectancy_r)],
      ["Total", r2(s.total_r), m.trades ? `${usd(m.net)} on ${m.trades} trade${m.trades === 1 ? "" : "s"} with $` : "no $ recorded", tone(s.total_r)],
      ["Profit factor", ratio(s.profit_factor), "won R ÷ lost R"],
      ["Payoff", ratio(s.payoff_ratio), `avg win ${r2(s.avg_win_r)} · avg loss ${r2(s.avg_loss_r)}`],
      ["Max drawdown", Number.isFinite(s.max_drawdown_r) ? `${s.max_drawdown_r.toFixed(2)}R` : "–", "largest fall from a peak"],
      ["Streaks", `${s.longest_win_streak} / ${s.longest_loss_streak}`, "longest wins / losses in a row"],
      ["Average MFE", Number.isFinite(s.avg_mfe_r) ? `${s.avg_mfe_r.toFixed(2)}R` : "–", mfeNote(trades)],
      ["Worst day", r2(s.worst_day_r), "results summed per run and day", tone(s.worst_day_r)],
      ["Average duration", Number.isFinite(s.avg_duration_min) ? `${roundEven(s.avg_duration_min)} min` : "–", "entry to exit"],
      ["Commission", m.trades ? usd(-m.commission) : "–", m.trades ? "included in the $ total" : "no $ recorded"],
    ];
    this.el("an-tiles").innerHTML = tiles.map(([label, value, note, t = ""]) =>
      `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value ${t}">${escapeHtml(value)}</div>` +
      `<div class="tile-note">${escapeHtml(note)}</div></div>`).join("");
  }

  /**
   * Dollars over time. With one run picked and no other filter, the run is one account: its starting
   * balance, and the challenge's max-loss floor and profit target. Otherwise the trades belong to
   * several accounts (or only part of one), so only the cumulative $ is honest.
   */
  renderBalance(trades) {
    const f = this.filters;
    const run = f.run && !f.side && !f.session && !f.tag
      ? this.backtests.find((b) => b.id === f.run && b.journal === this.journal) : null;
    const start = run && run.settings && Number(run.settings.startingBalance) > 0 ? Number(run.settings.startingBalance) : null;
    const account = start !== null;
    const curve = balanceCurve(trades, account ? start : 0);
    const svg = this.el("an-balance"), tip = this.el("an-balance-tip");
    this.el("an-balance-title").textContent = account ? "Account balance" : "Cumulative P&L";
    const skipped = trades.length - curve.length;
    this.el("an-balance-note").textContent = (account
      ? "Closed balance after each trade of this run, one step per trade; open trades are not in the journal."
      : "Total $ won or lost, one step per trade. Pick a single run (and no other filter) to see it as an account with its starting balance and loss limit.") +
      (skipped ? ` ${skipped} trade${skipped === 1 ? " has" : "s have"} no $ recorded and ${skipped === 1 ? "is" : "are"} left out.` : "");
    tip.hidden = true;
    if (curve.length === 0) {
      this.el("an-balance-figures").innerHTML = "";
      svg.setAttribute("viewBox", "0 0 760 110");
      svg.innerHTML = `<text x="380" y="60" text-anchor="middle" class="axis">No trades with $ recorded.</text>`;
      svg.onpointermove = svg.onpointerleave = null;
      return;
    }
    const end = curve[curve.length - 1].balance;
    const rules = account && run.challenge ? run.challenge : null;
    const floor = rules && Number(rules.maxPercent) > 0 ? start * (1 - Number(rules.maxPercent) / 100) : null;
    const target = rules && Number(rules.targetPercent) > 0 ? start * (1 + Number(rules.targetPercent) / 100) : null;
    const figure = (label, value, t = "") => `<div><div class="figure-label">${label}</div><div class="figure-value ${t}">${escapeHtml(value)}</div></div>`;
    const plain = (v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    this.el("an-balance-figures").innerHTML = account
      ? figure("P&amp;L", usd(end - start), tone(end - start)) + figure("Starting balance", plain(start)) + figure("Closed balance", plain(end)) +
        (floor !== null ? figure("Max loss floor", plain(floor), "down") : "") + (target !== null ? figure("Profit target", plain(target), "up") : "")
      : figure("P&amp;L", usd(end), tone(end)) + figure("Trades with $", `${curve.length}`);

    const W = 760, H = 260, L = 64, R = 16, T = 14, B = 26;
    const base = account ? start : 0;
    const values = [base, ...curve.map((p) => p.balance), ...[floor, target].filter((v) => v !== null)];
    const lo = Math.min(...values), hi = Math.max(...values);
    const pad = (hi - lo) * 0.08 || Math.max(1, Math.abs(base) * 0.01);
    const y0 = lo - pad, y1 = hi + pad;
    const n = curve.length;
    const X = (i) => L + (i / n) * (W - L - R); // point 0 is the start, point i is after trade i
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const step = niceStep((y1 - y0) / 4);
    const ticks = [];
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) ticks.push(+v.toFixed(6));
    const axisMoney = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v) >= 10000 ? `${+(Math.abs(v) / 1000).toFixed(1)}k` : Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    // A step line: the balance is flat until a trade closes, then jumps. A smoothed curve would
    // bulge past values the account never had, which matters right next to a loss limit.
    let path = `M${X(0).toFixed(1)},${Y(base).toFixed(1)}`;
    curve.forEach((p, i) => { path += `H${X(i + 1).toFixed(1)}V${Y(p.balance).toFixed(1)}`; });
    const area = `${path}L${X(n).toFixed(1)},${Y(base).toFixed(1)}Z`;
    const limit = (v, colour, text) => (v === null ? "" :
      `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${colour}" stroke-width="1.5" stroke-dasharray="6 5"/>` +
      `<text x="${L + 6}" y="${Y(v) - 5}" class="axis" style="fill:${colour}">${escapeHtml(text)}</text>`);
    // Date labels under evenly spaced trades, each the trading day that trade closed.
    const marks = Math.min(5, n);
    const dateTicks = [...new Set(Array.from({ length: marks }, (_, k) => Math.round(1 + (k * (n - 1)) / Math.max(1, marks - 1))))];
    const years = new Set(curve.map((p) => p.trade.exitDay.slice(0, 4))).size > 1;
    const dayLabel = (day) => `${shortDay(day)}${years ? ` ${day.slice(2, 4)}` : ""}`;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML =
      ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}" stroke-width="1"/>` +
        `<text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis">${axisMoney(v)}</text>`).join("") +
      `<line x1="${L}" x2="${W - R}" y1="${Y(base)}" y2="${Y(base)}" stroke="${MUTED}" stroke-width="1"/>` +
      limit(floor, DOWN, floor === null ? "" : `Max loss ${axisMoney(floor)}`) +
      limit(target, UP, target === null ? "" : `Profit target ${axisMoney(target)}`) +
      `<path d="${area}" fill="${LINE}" fill-opacity="0.10"/>` +
      `<path d="${path}" fill="none" stroke="${LINE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${X(n)}" cy="${Y(end)}" r="4" fill="${LINE}" stroke="#1e222d" stroke-width="2"/>` +
      dateTicks.map((i) => `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 1 ? "start" : i === n ? "end" : "middle"}" class="axis">` +
        `${escapeHtml(dayLabel(curve[i - 1].trade.exitDay))}</text>`).join("") +
      `<line class="crosshair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${MUTED}" stroke-width="1" visibility="hidden"/>` +
      `<circle class="hover-dot" r="4" fill="${LINE}" stroke="#1e222d" stroke-width="2" visibility="hidden"/>`;
    svg.onpointermove = (event) => {
      const box = svg.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * W;
      const i = Math.max(1, Math.min(n, Math.round(((x - L) / (W - L - R)) * n)));
      const p = curve[i - 1];
      for (const attr of ["x1", "x2"]) svg.querySelector(".crosshair").setAttribute(attr, X(i));
      svg.querySelector(".crosshair").setAttribute("visibility", "visible");
      const dot = svg.querySelector(".hover-dot");
      dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(p.balance)); dot.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = `<b>${escapeHtml(account ? plain(p.balance) : usd(p.balance))}</b> after trade ${i}<br><span class="muted">` +
        `#${escapeHtml(p.trade.row.trade_id)} ${escapeHtml(p.trade.side)} ${escapeHtml(usd(p.trade.money))} · closed ${escapeHtml(p.trade.row.exit_time)}</span>`;
      tip.style.left = `${Math.min(box.width - 260, Math.max(0, (X(i) / W) * box.width + 10))}px`;
      tip.style.top = `${(Y(p.balance) / H) * box.height - 40}px`;
    };
    svg.onpointerleave = () => {
      tip.hidden = true;
      svg.querySelector(".crosshair").setAttribute("visibility", "hidden");
      svg.querySelector(".hover-dot").setAttribute("visibility", "hidden");
    };
  }

  /** A month of trading days, each with its $ (or R when no $ was recorded) and trade count, and a total per week. */
  renderCalendar(trades) {
    const days = dailyPnl(trades);
    const months = [...new Set([...days.keys()].map((d) => d.slice(0, 7)))].sort().reverse();
    const select = this.el("an-month");
    if (!months.includes(this.month)) this.month = months[0] || "";
    select.innerHTML = months.map((m) => `<option value="${m}"${m === this.month ? " selected" : ""}>` +
      `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}</option>`).join("");
    const i = months.indexOf(this.month);
    this.el("an-month-prev").disabled = i < 0 || i === months.length - 1;
    this.el("an-month-next").disabled = i <= 0;
    const table = this.el("an-calendar");
    if (!this.month) { table.innerHTML = ""; return; }
    const value = (d) => (d.withMoney === d.trades ? d.money : d.r); // $ only when every trade has it
    const result = (d) => {
      if (!d || !d.trades) return "";
      const hasMoney = d.withMoney === d.trades;
      return `<div class="amount ${tone(value(d))}">${escapeHtml(hasMoney ? usd(d.money) : r2(d.r))}</div>` +
        `<div class="count">${d.trades} trade${d.trades === 1 ? "" : "s"}</div>`;
    };
    const cellTone = (d) => (!d || !d.trades ? "" : value(d) > 0 ? "win" : value(d) < 0 ? "loss" : "");
    const weeks = monthWeeks(Number(this.month.slice(0, 4)), Number(this.month.slice(5, 7)), days);
    table.innerHTML = `<thead><tr>${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<th>${d}</th>`).join("")}<th>Week</th></tr></thead><tbody>` +
      weeks.map((w) => `<tr>${w.days.map((d) => `<td class="${[d.inMonth ? "" : "out", cellTone(d.result)].join(" ").trim()}">` +
        `<div class="date">${Number(d.date.slice(8, 10))}</div>${result(d.result)}</td>`).join("")}` +
        `<td class="week ${cellTone(w.total)}">${w.total.trades ? result(w.total) : `<div class="count">no trades</div>`}</td></tr>`).join("") +
      "</tbody>";
  }


  /** Cumulative R after each trade: one line, a light wash under it, a crosshair with the trade under the pointer. */
  renderEquity(trades) {
    const W = 760, H = 240, L = 48, R = 16, T = 14, B = 26;
    const curve = [0, ...equityCurve(trades)];
    const lo = Math.min(0, ...curve), hi = Math.max(0, ...curve);
    const pad = (hi - lo) * 0.08 || 1;
    const y0 = lo - pad, y1 = hi + pad;
    const X = (i) => L + (i / Math.max(1, curve.length - 1)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const step = niceStep((y1 - y0) / 4);
    const ticks = [];
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) ticks.push(+v.toFixed(6));
    const path = curve.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const area = `${path}L${X(curve.length - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;
    const last = curve[curve.length - 1];
    const svg = this.el("an-equity");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML =
      ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}" stroke-width="1"/>` +
        `<text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis">${v}R</text>`).join("") +
      `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="${MUTED}" stroke-width="1"/>` +
      `<path d="${area}" fill="${LINE}" fill-opacity="0.10"/>` +
      `<path d="${path}" fill="none" stroke="${LINE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${X(curve.length - 1)}" cy="${Y(last)}" r="4" fill="${LINE}" stroke="#1e222d" stroke-width="2"/>` +
      `<text x="${Math.min(X(curve.length - 1), W - R)}" y="${Y(last) - 9}" text-anchor="end" class="label">${escapeHtml(r2(last))}</text>` +
      `<text x="${L}" y="${H - 6}" class="axis">trade 1</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="axis">trade ${trades.length}</text>` +
      `<line class="crosshair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${MUTED}" stroke-width="1" visibility="hidden"/>` +
      `<circle class="hover-dot" r="4" fill="${LINE}" stroke="#1e222d" stroke-width="2" visibility="hidden"/>`;
    const tip = this.el("an-equity-tip");
    svg.onpointermove = (event) => {
      const box = svg.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * W;
      const i = Math.max(1, Math.min(curve.length - 1, Math.round(((x - L) / (W - L - R)) * (curve.length - 1))));
      const t = trades[i - 1];
      svg.querySelector(".crosshair").setAttribute("x1", X(i));
      svg.querySelector(".crosshair").setAttribute("x2", X(i));
      svg.querySelector(".crosshair").setAttribute("visibility", "visible");
      const dot = svg.querySelector(".hover-dot");
      dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(curve[i])); dot.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = `<b>${escapeHtml(r2(curve[i]))}</b> after trade ${i}<br><span class="muted">#${escapeHtml(t.row.trade_id)} ${escapeHtml(t.side)} ` +
        `${escapeHtml(r2(t.r))} · ${escapeHtml(t.row.exit_time || "")}</span>`;
      tip.style.left = `${Math.min(box.width - 190, Math.max(0, (X(i) / W) * box.width + 10))}px`;
      tip.style.top = `${(Y(curve[i]) / H) * box.height - 40}px`;
    };
    svg.onpointerleave = () => {
      tip.hidden = true;
      svg.querySelector(".crosshair").setAttribute("visibility", "hidden");
      svg.querySelector(".hover-dot").setAttribute("visibility", "hidden");
    };
  }

  /** How many trades ended in each half-R band: losses red, wins green. */
  renderHistogram(trades) {
    const buckets = histogram(trades, 0.5);
    const W = 760, H = 210, L = 36, R = 8, T = 14, B = 40;
    const max = Math.max(...buckets.map((b) => b.count));
    const slot = (W - L - R) / buckets.length;
    const bar = Math.min(24, slot - 2);
    const Y = (n) => T + (1 - n / max) * (H - T - B);
    const svg = this.el("an-histogram");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const every = Math.ceil(buckets.length / 12); // keep the axis labels apart
    svg.innerHTML = `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="${MUTED}" stroke-width="1"/>` +
      `<text x="${L - 6}" y="${Y(max) + 4}" text-anchor="end" class="axis">${max}</text>` +
      buckets.map((b, i) => {
        const x = L + i * slot + (slot - bar) / 2;
        const colour = b.to <= 0 ? DOWN : b.from >= 0 ? UP : MUTED;
        const h = Y(0) - Y(b.count);
        const r = Math.min(4, h / 2, bar / 2);
        const shape = b.count === 0 ? "" : `<path d="M${x},${Y(0)}V${Y(b.count) + r}Q${x},${Y(b.count)} ${x + r},${Y(b.count)}H${x + bar - r}` +
          `Q${x + bar},${Y(b.count)} ${x + bar},${Y(b.count) + r}V${Y(0)}Z" fill="${colour}"/>`;
        const label = i % every === 0 ? `<text x="${L + i * slot + slot / 2}" y="${H - 24}" text-anchor="middle" class="axis">${b.from}</text>` : "";
        return `<g class="bucket" data-tip="${b.count} trade${b.count === 1 ? "" : "s"} from ${b.from}R to ${b.to}R">` +
          `<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>${shape}${label}</g>`;
      }).join("") +
      `<text x="${W - R}" y="${H - 4}" text-anchor="end" class="axis">result in R: each bar counts trades from its label up to the next (half an R)</text>`;
    const tip = this.el("an-histogram-tip");
    svg.onpointermove = (event) => {
      const g = event.target.closest(".bucket");
      svg.querySelectorAll(".bucket.hover").forEach((n) => n.classList.remove("hover"));
      if (!g) { tip.hidden = true; return; }
      g.classList.add("hover");
      const box = svg.getBoundingClientRect();
      tip.hidden = false;
      tip.textContent = g.dataset.tip;
      tip.style.left = `${Math.min(box.width - 190, event.clientX - box.left + 10)}px`;
      tip.style.top = `${event.clientY - box.top - 30}px`;
    };
    svg.onpointerleave = () => { tip.hidden = true; svg.querySelectorAll(".bucket.hover").forEach((n) => n.classList.remove("hover")); };
  }

  renderInsights(s, trades) {
    const risk = Number(this.el("an-risk").value) || 1;
    const p = propCheck(s, risk);
    const g = gaveBack(trades, 1);
    const flag = (bad, okText, badText) => `<span class="${bad ? "down" : "up"}">${bad ? "✗ " + badText : "✓ " + okText}</span>`;
    const runs = new Set(trades.map((t) => t.run));
    const challenges = this.backtests.filter((b) => b.journal === this.journal && runs.has(b.id) && b.result && b.result.challenge);
    const count = (outcome) => challenges.filter((b) => b.result.challenge === outcome).length;
    this.el("an-insights").innerHTML =
      `<li><b>As a prop-firm account at ${escapeHtml(String(risk))}% risk per trade</b> (8% target, 5% daily, 10% max loss, every trade in a row as one account): ` +
      `return ${p.return_pct >= 0 ? "+" : ""}${p.return_pct.toFixed(1)}%, max drawdown ${p.max_drawdown_pct.toFixed(1)}%, ` +
      `worst day ${Number.isFinite(p.worst_day_pct) ? p.worst_day_pct.toFixed(1) + "%" : "–"}. ` +
      `${flag(!p.hits_target, "target reached", "target not reached")} · ${flag(p.breaches_daily, "daily limit kept", "daily limit broken")} · ` +
      `${flag(p.breaches_max, "max loss kept", "max loss broken")}</li>` +
      `<li><b>Losses that were +1R first:</b> ${g.reached} of ${g.known} losing trades with MFE recorded` +
      `${g.known < g.losers ? ` (${g.losers - g.known} older losses have none)` : ""}. ` +
      `${g.reached ? "A stop moved to breakeven at +1R would have turned these into scratches." : ""}</li>` +
      (challenges.length ? `<li><b>Challenge runs in this selection:</b> ${count("PASSED")} passed, ${count("FAILED")} failed, ${count("RUNNING")} unfinished.</li>` : "");
  }

  renderBreakdowns(trades) {
    const names = this.runNames();
    const groups = [
      ["Session", "session"], ["Weekday", "weekday"], ["Side", "side"], ["Exit", "exitReason"],
      ["Tag", (t) => (t.tags.length ? t.tags : ["(no tag)"])], ["Run", "run"],
    ];
    this.el("an-breakdowns").innerHTML = groups.map(([title, by]) => {
      const table = breakdown(trades, by);
      const most = Math.max(...table.map((row) => Math.abs(row.total_r)), 0.0001);
      return `<div class="block"><h2>By ${title.toLowerCase()}</h2><table class="grid">` +
        `<thead><tr><th>${title}</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Avg</th><th class="num">Total R</th><th></th></tr></thead><tbody>` +
        table.map((row) => {
          const width = (Math.abs(row.total_r) / most) * 50;
          const label = title === "Run" ? names[row.group] || row.group : row.group || "(blank)";
          return `<tr><td>${escapeHtml(label)}</td><td class="num">${row.trades}</td><td class="num">${pct(row.win_rate)}</td>` +
            `<td class="num ${tone(row.expectancy_r)}">${r2(row.expectancy_r)}</td>` +
            `<td class="num ${tone(row.total_r)}">${r2(row.total_r)}</td>` +
            `<td><div class="divbar" title="Total R: losses to the left of the centre line, wins to the right">` +
            `<i style="${row.total_r >= 0 ? "left:50%" : `left:${50 - width}%`};width:${width}%;background:${row.total_r >= 0 ? UP : DOWN}"></i></div></td></tr>`;
        }).join("") + "</tbody></table></div>";
    }).join("");
  }

  renderTrades(trades) {
    const shown = trades.slice(-300).reverse();
    this.el("an-trades-note").textContent = trades.length > shown.length ? `Latest ${shown.length} of ${trades.length}.` : "";
    const saved = new Set(this.backtests.filter((b) => b.journal === this.journal).map((b) => b.id)); // runs whose backtest still exists
    this.el("an-trades").innerHTML = shown.map((t) => {
      const shots = (t.row.screenshots || "").split(";").map((s) => s.trim()).filter(Boolean);
      const links = !this.store.screenshots ? "" : shots.map((name, i) => `<a href="${this.store.screenshotUrl(this.journal, name)}" target="_blank" rel="noopener">${i + 1}</a>`).join(" ");
      return `<tr><td>#${escapeHtml(t.row.trade_id)}</td><td>${escapeHtml(t.side)}</td><td class="nowrap">${escapeHtml(t.row.entry_time)}</td>` +
        `<td class="num ${tone(t.r)}">${r2(t.r)}</td><td class="num">${Number.isFinite(t.money) ? usd(t.money) : ""}</td>` +
        `<td>${escapeHtml(t.exitReason.toLowerCase().replace("_", " "))}</td><td>${escapeHtml(t.tags.join(", "))}</td>` +
        `<td class="note">${escapeHtml(t.row.note || "")}</td><td>${links}</td>` +
        `<td>${saved.has(t.run) ? `<button class="plain small" data-show-trade="${escapeHtml(t.row.trade_id)}" data-run="${escapeHtml(t.run)}" title="Show this trade on the chart">&#9656;</button>` : ""}</td></tr>`;
    }).join("");
  }
}

/** How far trades went your way, and on how many it is known (older rows have no MFE). */
function mfeNote(trades) {
  const known = trades.filter((t) => Number.isFinite(t.mfe)).length;
  return known === trades.length ? "how far trades went your way" : `how far trades went your way · only ${known} of ${trades.length} have it`;
}

/** 1, 2 or 5 times a power of ten: tidy gridline spacing. */
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}

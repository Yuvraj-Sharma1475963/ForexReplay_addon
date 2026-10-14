// The Strategies tab: every strategy you test, with its rules, its versions and what changed in
// each, how each version did, two versions side by side, and the backtests behind them.
//
// A backtest belongs to a strategy and version through its details (backtestmeta.js). The trades
// come from every journal, so a strategy tested in several journals is still one strategy.
// Discarded backtests are left out of the numbers unless asked for; archived ones count.

import { breakdown, computeStats, parseRows } from "./analytics.js";
import { cleanLibrary, cleanMeta, periodText, statusLabel } from "./backtestmeta.js";

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const r2 = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}R` : "–");
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "–");
const ratio = (v) => (v === Infinity ? "∞" : Number.isFinite(v) ? v.toFixed(2) : "–");
const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const NONE = "(no strategy)";
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const KEY_OPEN = "forexreplay.strategies.open";
const KEY_DISCARDED = "forexreplay.strategies.discarded";

function recall(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

export class StrategyView {
  /**
   * @param {HTMLElement} root  the Strategies section
   * @param {object} store  store.js
   * @param {object} actions  { onAnalytics(journal, id), onChart(journal, id) -> Promise<problem text> }
   */
  constructor(root, store, actions) {
    this.root = root;
    this.store = store;
    this.actions = actions;
    this.el = (id) => root.querySelector(`#${id}`);
    this.backtests = [];
    this.trades = []; // parsed journal rows of every journal, each with .backtest
    this.library = { strategies: {} };
    this.chosen = recall(KEY_OPEN, "");
    this.compare = ["", ""];
    this.el("st-discarded").checked = recall(KEY_DISCARDED, "0") === "1";
    this.el("st-discarded").addEventListener("change", (event) => { remember(KEY_DISCARDED, event.target.checked ? "1" : "0"); this.render(); });
    root.addEventListener("click", (event) => this.click(event));
    root.addEventListener("change", (event) => {
      if (event.target.matches("[data-compare]")) { this.compare[Number(event.target.dataset.compare)] = event.target.value; this.renderCompare(); }
    });
  }

  /** Called when the tab opens: read every backtest and journal again. */
  async open() {
    this.message("Reading backtests and journals…");
    try {
      const [backtests, journals, library] = await Promise.all([this.store.listBacktests(), this.store.listJournals(), this.store.getLibrary()]);
      this.backtests = backtests.filter((b) => !b.error);
      this.library = cleanLibrary(library);
      const byRun = new Map(this.backtests.map((b) => [`${b.journal}/${b.id}`, b]));
      this.trades = [];
      for (const j of journals) {
        for (const t of parseRows(await this.store.journalRows(j.name))) {
          t.journal = j.name;
          t.backtest = byRun.get(`${j.name}/${t.run}`) || null;
          this.trades.push(t);
        }
      }
    } catch (err) {
      this.message(`Could not read the backtests: ${err.message}`);
      return;
    }
    this.message("");
    this.render();
  }

  message(text) {
    this.el("st-message").textContent = text;
    this.el("st-message").hidden = !text;
  }

  get withDiscarded() { return this.el("st-discarded").checked; }

  /** Backtests and trades of each strategy: Map name -> { backtests, trades }. */
  groups() {
    const out = new Map();
    const group = (name) => { if (!out.has(name)) out.set(name, { backtests: [], trades: [] }); return out.get(name); };
    for (const name of Object.keys(this.library.strategies)) group(name); // a strategy with rules but no backtest yet
    for (const b of this.backtests) group(cleanMeta(b).strategy || NONE).backtests.push(b);
    for (const t of this.trades) {
      if (!t.backtest) continue; // rows whose backtest was deleted (or v1 rows) belong to no strategy
      const m = cleanMeta(t.backtest);
      if (m.status === "discarded" && !this.withDiscarded) continue;
      group(m.strategy || NONE).trades.push(t);
    }
    return out;
  }

  render() {
    const groups = this.groups();
    const names = [...groups.keys()].sort((a, b) => (a === NONE) - (b === NONE) || groups.get(b).backtests.length - groups.get(a).backtests.length || a.localeCompare(b));
    if (names.length === 0) {
      this.el("st-cards").innerHTML = "";
      this.el("st-detail").innerHTML = "";
      this.message("No strategies yet. In Backtests, open a backtest's details (✎) and give it a strategy, or set the strategy for new replays.");
      return;
    }
    if (!groups.has(this.chosen)) this.chosen = names.find((n) => n !== NONE) || names[0];
    this.el("st-cards").innerHTML = names.map((name) => this.card(name, groups.get(name))).join("") +
      `<button class="st-card st-new" data-new-strategy="1"><b>+ New strategy</b><span class="muted">write its rules before you test it</span></button>`;
    this.renderDetail(groups.get(this.chosen));
  }

  card(name, g) {
    const s = computeStats(g.trades);
    const versions = new Set(g.backtests.map((b) => cleanMeta(b).strategyVersion).filter(Boolean));
    const rules = (this.library.strategies[name] || {}).rules || "";
    return `<button class="st-card${name === this.chosen ? " active" : ""}" data-strategy="${escapeHtml(name)}">
      <b>${escapeHtml(name)}</b>
      <span class="muted">${g.backtests.length} backtest${g.backtests.length === 1 ? "" : "s"} · ${versions.size} version${versions.size === 1 ? "" : "s"} · ${g.trades.length} trades</span>
      ${s ? `<span class="st-figures"><span class="${tone(s.total_r)}">${r2(s.total_r)}</span> · ${pct(s.win_rate)} won · exp <span class="${tone(s.expectancy_r)}">${r2(s.expectancy_r)}</span></span>` : '<span class="muted">no closed trades yet</span>'}
      ${rules ? `<span class="st-rules-peek">${escapeHtml(rules.slice(0, 90))}${rules.length > 90 ? "…" : ""}</span>` : ""}
    </button>`;
  }

  /** Versions of the chosen strategy, oldest first: [{ version, backtests, trades }]. */
  versions(g) {
    const map = new Map();
    const of = (v) => { if (!map.has(v)) map.set(v, { version: v, backtests: [], trades: [] }); return map.get(v); };
    for (const v of Object.keys((this.library.strategies[this.chosen] || {}).versions || {})) of(v);
    for (const b of g.backtests) of(cleanMeta(b).strategyVersion || "(none)").backtests.push(b);
    for (const t of g.trades) of(cleanMeta(t.backtest).strategyVersion || "(none)").trades.push(t);
    return [...map.values()].sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  }

  renderDetail(g) {
    const name = this.chosen;
    const entry = this.library.strategies[name] || { rules: "", versions: {} };
    const editable = name !== NONE;
    const versions = this.versions(g);
    const s = computeStats(g.trades);
    this.currentVersions = versions;
    const ids = versions.map((v) => v.version);
    if (!ids.includes(this.compare[0])) this.compare[0] = ids[Math.max(0, ids.length - 2)] || "";
    if (!ids.includes(this.compare[1])) this.compare[1] = ids[ids.length - 1] || "";

    const versionRows = versions.map((v) => {
      const vs = computeStats(v.trades);
      return `<tr><td><b>${escapeHtml(v.version)}</b></td>
        <td>${editable && v.version !== "(none)" ? `<input class="st-version-note" data-version="${escapeHtml(v.version)}" maxlength="2000" value="${escapeHtml(entry.versions[v.version] || "")}" placeholder="what changed in this version">` : ""}</td>
        <td class="num">${v.backtests.length}</td><td class="num">${v.trades.length}</td>
        <td class="num">${vs ? pct(vs.win_rate) : "–"}</td><td class="num ${vs ? tone(vs.expectancy_r) : ""}">${vs ? r2(vs.expectancy_r) : "–"}</td>
        <td class="num ${vs ? tone(vs.total_r) : ""}">${vs ? r2(vs.total_r) : "–"}</td><td class="num">${vs ? ratio(vs.profit_factor) : "–"}</td>
        <td class="num">${vs && Number.isFinite(vs.max_drawdown_r) ? `${vs.max_drawdown_r.toFixed(2)}R` : "–"}</td></tr>`;
    }).join("");

    const runs = [...g.backtests].sort((a, b) => String(b.saved || "").localeCompare(String(a.saved || "")));
    const runRows = runs.map((b) => {
      const m = cleanMeta(b);
      const r = b.result || {};
      return `<tr><td>${escapeHtml(b.name)}${m.archived ? ' <span class="tag">archived</span>' : ""}</td><td>${escapeHtml(m.strategyVersion || "–")}</td>
        <td><span class="status ${m.status}">${statusLabel(m.status)}</span></td><td class="nowrap">${escapeHtml(periodText(b))}</td>
        <td class="num">${r.closed || 0}</td><td class="num ${tone(r.totalR || 0)}">${r2(r.totalR || 0)}</td>
        <td class="actions"><button class="plain small" data-analytics="${escapeHtml(b.journal)}/${escapeHtml(b.id)}">Analytics</button>
          <button class="plain small" data-chart="${escapeHtml(b.journal)}/${escapeHtml(b.id)}">Chart</button></td></tr>`;
    }).join("");

    this.el("st-detail").innerHTML = `
      <div class="block">
        <div class="block-head"><h2>${escapeHtml(name)}</h2>
          <span class="muted">${g.backtests.length} backtests · ${g.trades.length} trades${s ? ` · ${pct(s.win_rate)} won · expectancy <span class="${tone(s.expectancy_r)}">${r2(s.expectancy_r)}</span> · total <span class="${tone(s.total_r)}">${r2(s.total_r)}</span>` : ""}</span></div>
        ${editable ? `<label class="st-label">Rules: entry, stop, target, filters. Written before testing, so each backtest follows the same plan.
          <textarea id="st-rules" rows="5" maxlength="8000" placeholder="e.g. Entry: retest of an H1 order block in the London session&#10;Stop: beyond the block&#10;Target: 2R or the next liquidity">${escapeHtml(entry.rules)}</textarea></label>
          <div class="edit-actions"><button class="plain primary small" data-save-library="1">Save rules and version notes</button><span class="muted" id="st-saved"></span>
            <span class="spacer"></span><button class="plain small" data-rename-strategy="1" title="Rename this strategy in every backtest">Rename strategy</button></div>`
          : '<p class="muted">These backtests have no strategy. Give them one in Backtests: tick them, then "Set strategy and version".</p>'}
      </div>
      <div class="block"><h2>Versions</h2>
        <div class="table-scroll"><table class="grid"><thead><tr><th>Version</th><th>What changed</th><th class="num">Backtests</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Expectancy</th><th class="num">Total</th><th class="num">Profit factor</th><th class="num">Max DD</th></tr></thead>
        <tbody>${versionRows || '<tr><td colspan="9" class="muted">No versions yet.</td></tr>'}</tbody></table></div>
        ${editable ? `<div class="st-add-version"><input id="st-new-version" maxlength="20" placeholder="new version, e.g. v3"> <button class="plain bordered small" data-add-version="1">Add version</button>
          <span class="muted">then set it as the version for new replays in Backtests.</span></div>` : ""}
      </div>
      <div class="block" id="st-compare-block"><div class="block-head"><h2>Compare versions</h2>
        <span>${this.versionSelect(0, ids)} vs ${this.versionSelect(1, ids)}</span></div><div id="st-compare"></div></div>
      <div class="block"><h2>Backtests</h2>
        <div class="table-scroll"><table class="grid"><thead><tr><th>Name</th><th>Version</th><th>Status</th><th>Period</th><th class="num">Trades</th><th class="num">Result</th><th></th></tr></thead>
        <tbody>${runRows || '<tr><td colspan="7" class="muted">No backtests with this strategy yet.</td></tr>'}</tbody></table></div></div>`;
    this.renderCompare();
  }

  versionSelect(side, ids) {
    return `<select data-compare="${side}" aria-label="Version ${side ? "B" : "A"}">${ids.map((v) => `<option value="${escapeHtml(v)}"${v === this.compare[side] ? " selected" : ""}>${escapeHtml(v)}</option>`).join("")}</select>`;
  }

  /** Version A and B side by side: the main numbers, then by weekday and by session. */
  renderCompare() {
    const box = this.el("st-compare");
    if (!box) return;
    const pick = (v) => (this.currentVersions || []).find((x) => x.version === v) || { trades: [] };
    const [A, B] = this.compare.map(pick);
    const [a, b] = [computeStats(A.trades), computeStats(B.trades)];
    if (!a && !b) { box.innerHTML = '<p class="muted">Pick two versions with closed trades.</p>'; return; }
    const better = (x, y, higher = true) => (!Number.isFinite(x) || !Number.isFinite(y) || x === y ? ["", ""] : (x > y) === higher ? ["best", ""] : ["", "best"]);
    const line = (label, get, fmt, higher = true) => {
      const x = a ? get(a) : NaN, y = b ? get(b) : NaN;
      const [cx, cy] = better(x, y, higher);
      return `<tr><td>${label}</td><td class="num ${cx}">${a ? fmt(x) : "–"}</td><td class="num ${cy}">${b ? fmt(y) : "–"}</td></tr>`;
    };
    const head = `<thead><tr><th></th><th class="num">${escapeHtml(this.compare[0])}</th><th class="num">${escapeHtml(this.compare[1])}</th></tr></thead>`;
    const main = `<table class="grid">${head}<tbody>
      ${line("Trades", (s) => s.trades, (v) => `${v}`)}
      ${line("Win rate", (s) => s.win_rate, pct)}
      ${line("Expectancy", (s) => s.expectancy_r, r2)}
      ${line("Total", (s) => s.total_r, r2)}
      ${line("Profit factor", (s) => s.profit_factor, ratio)}
      ${line("Payoff (avg win ÷ avg loss)", (s) => s.payoff_ratio, ratio)}
      ${line("Max drawdown", (s) => s.max_drawdown_r, (v) => (Number.isFinite(v) ? `${v.toFixed(2)}R` : "–"), false)}
      ${line("Longest losing streak", (s) => s.longest_loss_streak, (v) => `${v}`, false)}
    </tbody></table>`;
    const split = (title, by, order) => {
      const ta = new Map(breakdown(A.trades, by).map((r) => [r.group, r]));
      const tb = new Map(breakdown(B.trades, by).map((r) => [r.group, r]));
      const keys = order.filter((k) => ta.has(k) || tb.has(k)).concat([...new Set([...ta.keys(), ...tb.keys()])].filter((k) => !order.includes(k)));
      const cell = (r) => (r ? `<span class="${tone(r.expectancy_r)}">${r2(r.expectancy_r)}</span> <span class="muted">${pct(r.win_rate)} · ${r.trades}</span>` : '<span class="muted">–</span>');
      return `<table class="grid"><thead><tr><th>${title}</th><th class="num">${escapeHtml(this.compare[0])}</th><th class="num">${escapeHtml(this.compare[1])}</th></tr></thead><tbody>` +
        keys.map((k) => `<tr><td>${escapeHtml(k || "(blank)")}</td><td class="num">${cell(ta.get(k))}</td><td class="num">${cell(tb.get(k))}</td></tr>`).join("") + "</tbody></table>";
    };
    box.innerHTML = `<div class="st-compare-grid">${main}${split("By weekday", "weekday", WEEKDAYS)}${split("By session", "session", ["Asia", "London", "London/NY overlap", "New York"])}</div>
      <p class="muted small">Per weekday and session: expectancy, then win rate and number of trades. The better figure of each main line is highlighted; a version with few trades can look better by chance.</p>`;
  }

  async click(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.strategy !== undefined) {
      this.chosen = button.dataset.strategy;
      remember(KEY_OPEN, this.chosen);
      this.render();
    } else if (button.dataset.newStrategy) {
      const name = (prompt("Name of the new strategy (e.g. OB Retest):") || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!name) return;
      if (!this.library.strategies[name]) this.library.strategies[name] = { rules: "", versions: { v1: "" } };
      await this.saveLibrary();
      this.chosen = name;
      remember(KEY_OPEN, name);
      this.render();
    } else if (button.dataset.saveLibrary) {
      this.collectEdits();
      await this.saveLibrary();
    } else if (button.dataset.addVersion) {
      const v = this.el("st-new-version").value.replace(/\s+/g, " ").trim().slice(0, 20);
      if (!v) return;
      this.collectEdits();
      const entry = this.library.strategies[this.chosen] || (this.library.strategies[this.chosen] = { rules: "", versions: {} });
      if (!(v in entry.versions)) entry.versions[v] = "";
      await this.saveLibrary();
      this.render();
    } else if (button.dataset.renameStrategy) {
      await this.renameStrategy();
    } else if (button.dataset.analytics) {
      const [journal, id] = button.dataset.analytics.split("/");
      this.actions.onAnalytics(journal, id);
    } else if (button.dataset.chart) {
      const [journal, id] = button.dataset.chart.split("/");
      const problem = await this.actions.onChart(journal, id);
      if (problem) this.message(problem);
    }
  }

  /** The rules and version notes as typed on the page, into this.library. */
  collectEdits() {
    if (this.chosen === NONE) return;
    const entry = this.library.strategies[this.chosen] || (this.library.strategies[this.chosen] = { rules: "", versions: {} });
    const rules = this.el("st-rules");
    if (rules) entry.rules = rules.value;
    for (const input of this.root.querySelectorAll(".st-version-note")) entry.versions[input.dataset.version] = input.value;
  }

  async saveLibrary() {
    try {
      await this.store.putLibrary(this.library);
      this.library = await this.store.getLibrary();
      const saved = this.el("st-saved");
      if (saved) saved.textContent = `Saved ${new Date().toLocaleTimeString("en-IN")}.`;
    } catch (err) {
      this.message(`Could not save: ${err.message}`);
    }
  }

  /** Give the strategy a new name in its library entry and in every backtest that tests it. */
  async renameStrategy() {
    const from = this.chosen;
    const to = (prompt(`New name for "${from}":`, from) || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!to || to === from) return;
    this.collectEdits();
    try {
      for (const b of this.backtests.filter((x) => cleanMeta(x).strategy === from)) {
        const data = await this.store.getBacktest(b.journal, b.id);
        data.strategy = to;
        await this.store.putBacktest(data);
      }
      if (this.library.strategies[from]) {
        this.library.strategies[to] = this.library.strategies[to] || this.library.strategies[from];
        delete this.library.strategies[from];
      }
      await this.store.putLibrary(this.library);
    } catch (err) {
      this.message(`Could not rename: ${err.message}`);
    }
    this.chosen = to;
    remember(KEY_OPEN, to);
    await this.open();
  }
}

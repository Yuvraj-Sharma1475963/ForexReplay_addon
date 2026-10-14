// Saving backtests as you go, and the "Backtests" dialog (resume or delete a saved one).
//
// Each replay is a backtest. Once it has a trade or a drawing, it is saved to the
// local server a moment after anything changes, when you leave it, and when the
// tab closes. The server writes it to strategies/<journal>/backtests/<id>.json and
// adds its closed trades to strategies/<journal>/trades.csv.
// The rules for what is saved and how a run is rebuilt live in backtest.js.

import { formatSignedMoney } from "./account.js";
import { newId, snapshot, validName } from "./backtest.js";
import { backupAge, download, exportBackup, importBackup, KEY_LAST_BACKUP, tradesCsv } from "./backup.js";
import { autoName, cleanMeta, periodText, STATUSES, statusLabel, strategiesIn } from "./backtestmeta.js";
import { formatDateTime } from "./time.js";

export const DEFAULT_JOURNAL = "manual_backtests";
const KEY_JOURNAL = "forexreplay.journal";
const KEY_FILTER = "forexreplay.backtests.filter"; // the journal the list shows ("" = all)
const KEY_FILTERS = "forexreplay.backtests.filters"; // { strategy, status } the list shows
const KEY_NEW_RUN = "forexreplay.newrun"; // { strategy, strategyVersion } for new replays
const SAVE_DELAY_MS = 1500;
const MAX_NAME = 80;

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export class Backtests {
  /**
   * @param {object} options
   *   dialog, status   the dialog element and the status-bar element
   *   collect()        { trading, drawings, m5, clock, manifest, timeframe } for a save
   *   onResume(journal, id)  rebuilds and opens a saved backtest; returns its list of problems
   *   onAnalytics(journal, id)  opens the analytics page on that backtest alone
   *   onChart(journal, id)  draws its trades on the chart; resolves to an error text, or "" when shown
   */
  constructor({ dialog, status, collect, onResume, onAnalytics, onChart, store }) {
    this.store = store; // files on disk (desktop app) or this browser (online): see store.js
    if (store.kind === "browser") {
      dialog.querySelector("#backtests-about").textContent = "Online, each replay with a trade or a drawing is saved in this browser as you go, " +
        "with its trades, its drawings and where it got to. Only this browser on this computer can see them; clearing the site's data removes them. " +
        "Resume rebuilds a run by repeating every action on the same candles.";
    }
    this.dialog = dialog;
    this.status = status;
    this.collect = collect;
    this.onResume = onResume;
    this.onAnalytics = onAnalytics || (() => {});
    this.onChart = onChart || (async () => "");
    this.current = null; // { id, name, journal, created, startTime, strategy, strategyVersion, status, notes, archived } of the run on screen
    this.everSaved = false;
    this.drawingsTouched = false;
    this.timer = null;
    this.queue = Promise.resolve(); // saves go out one after another, never overlapping
    this.armedDelete = null;

    this.el = (id) => dialog.querySelector(`#${id}`);
    this.el("backtest-journal").value = this.journal;
    this.el("backtest-journal").addEventListener("change", (event) => {
      const name = event.target.value.trim();
      if (validName(name)) {
        try { localStorage.setItem(KEY_JOURNAL, name); } catch { /* private mode: not kept */ }
        this.say(`New replays will be journaled in strategies/${name}/trades.csv.`, "ok");
      } else {
        this.say("A journal name may use only letters, digits, - and _.", "bad");
      }
      event.target.value = this.journal;
    });
    this.el("backtest-close").addEventListener("click", () => dialog.close());
    this.list = []; // the saved backtests as last read
    this.el("backtest-filter").addEventListener("change", (event) => {
      try { localStorage.setItem(KEY_FILTER, event.target.value); } catch { /* private mode: not kept */ }
      this.render();
    });
    this.el("backtest-search").addEventListener("input", () => this.render());
    for (const key of ["strategy", "status"]) {
      this.el(`backtest-${key}-filter`).addEventListener("change", (event) => {
        const f = this.filters;
        f[key] = event.target.value;
        try { localStorage.setItem(KEY_FILTERS, JSON.stringify(f)); } catch { /* private mode: not kept */ }
        this.render();
      });
    }
    const newRun = this.newRun;
    this.el("new-strategy").value = newRun.strategy;
    this.el("new-version").value = newRun.strategyVersion;
    for (const id of ["new-strategy", "new-version"]) {
      this.el(id).addEventListener("change", () => {
        const m = cleanMeta({ strategy: this.el("new-strategy").value, strategyVersion: this.el("new-version").value });
        try { localStorage.setItem(KEY_NEW_RUN, JSON.stringify({ strategy: m.strategy, strategyVersion: m.strategyVersion })); } catch { /* private mode */ }
        this.el("new-strategy").value = m.strategy;
        this.el("new-version").value = m.strategyVersion;
        this.say(m.strategy ? `New replays will test "${m.strategy}${m.strategyVersion ? ` ${m.strategyVersion}` : ""}" and be named after it.` : "New replays will have no strategy.", "ok");
      });
    }
    this.el("backup-export").addEventListener("click", () => this.exportFile());
    this.el("backup-import").addEventListener("click", () => this.el("backup-file").click());
    this.el("backup-file").addEventListener("change", (event) => this.importFile(event.target));
    this.el("trades-csv").addEventListener("click", () => this.csvFile());
    this.el("backtest-rows").addEventListener("click", (event) => this.handleRowClick(event));
    this.el("backtest-rows").addEventListener("keydown", (event) => {
      const form = event.target.closest("tr.edit-row");
      if (!form) return;
      if (event.key === "Enter" && event.target.tagName !== "TEXTAREA") { event.preventDefault(); this.finishEdit(form); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.render(); } // cancel, keep the dialog open
    });
    this.renderStatus();
  }

  /** The strategy and version new replays test (set at the bottom of the dialog). */
  get newRun() {
    try { return cleanMeta(JSON.parse(localStorage.getItem(KEY_NEW_RUN) || "null") || {}); } catch { return cleanMeta(); }
  }

  get filters() {
    if (!this.filterState) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY_FILTERS) || "{}") || {}; } catch { /* private mode */ }
      this.filterState = { strategy: typeof saved.strategy === "string" ? saved.strategy : "", status: typeof saved.status === "string" ? saved.status : "" };
    }
    return this.filterState;
  }

  get journal() {
    try {
      const saved = localStorage.getItem(KEY_JOURNAL);
      return validName(saved) ? saved : DEFAULT_JOURNAL;
    } catch { return DEFAULT_JOURNAL; }
  }

  // ----- the run on screen ------------------------------------------------
  /** A new replay has started with its last candle at `startTime`. */
  begin(startTime, symbol) {
    this.stopTimer();
    const meta = { ...this.newRun, status: "testing", notes: "", archived: false };
    this.current = {
      id: newId(), journal: this.journal, created: new Date().toISOString(), startTime, ...meta,
      name: autoName({ ...meta, startTime }) || `${symbol} from ${formatDateTime(startTime)}`,
    };
    this.everSaved = false;
    this.drawingsTouched = false;
    this.renderStatus();
  }

  /** A saved backtest has been rebuilt and is on screen again. */
  continueWith(saved) {
    this.stopTimer();
    const { id, name, journal, created, startTime } = saved;
    this.current = { id, name, journal, created, startTime, ...cleanMeta(saved) };
    this.everSaved = true;
    this.drawingsTouched = false;
    this.renderStatus(`resumed · saved ${new Date(saved.saved).toLocaleTimeString("en-IN")}`);
  }

  /** A replay with no trades and no drawings is just a look around; it is not written to disk. */
  get worthSaving() {
    return !!this.current && (this.everSaved || this.drawingsTouched || this.collect().trading.actions.length > 0);
  }

  drawingsChanged() {
    this.drawingsTouched = true;
    this.changed();
  }

  /** Something changed: save shortly (at most one save per SAVE_DELAY_MS while the replay plays). */
  changed() {
    if (!this.current || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  stopTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Save now. Resolves to true when saved (or there was nothing worth saving), false on failure. */
  save() {
    this.stopTimer();
    if (!this.worthSaving) {
      this.renderStatus("not saved: no trades or drawings yet");
      return Promise.resolve(true);
    }
    const data = snapshot(this.current, this.collect()); // the state at this moment, even if the save waits in the queue
    const result = this.queue.then(() => this.put(data));
    this.queue = result;
    return result;
  }

  async put(data) {
    try {
      const reply = await this.store.putBacktest(data);
      if (this.current && this.current.id === data.id) this.everSaved = true;
      const added = reply.journalAdded ? ` · ${reply.journalAdded} trade(s) added to ${reply.journal}` : "";
      this.renderStatus(`saved ${new Date().toLocaleTimeString("en-IN")}${added}`, "ok", data);
      return true;
    } catch (err) {
      const offline = err.message.includes("fetch") && this.store.kind === "server";
      this.renderStatus(`NOT saved: ${offline ? "the app's server is not running" : err.message}`, "bad", data);
      return false;
    }
  }

  /** Last chance when the tab is closing: send the save without waiting for an answer. */
  saveOnUnload() {
    if (!this.worthSaving) return;
    const data = snapshot(this.current, this.collect());
    try {
      this.store.putBacktestNow(data);
    } catch { /* the tab is going away; nothing more can be done */ }
  }

  /** Leaving the replay: save, then forget the run. Resolves to false (and keeps the run) if the save failed. */
  async end() {
    const ok = await this.save();
    if (ok) this.abandon();
    return ok;
  }

  abandon() {
    this.stopTimer();
    this.current = null;
    this.renderStatus();
  }

  renderStatus(text = "", tone = "", data = null) {
    const name = (data && data.name) || (this.current && this.current.name);
    this.status.hidden = !name;
    this.status.className = tone;
    this.status.textContent = name ? `Backtest "${name}"${text ? ` · ${text}` : ""}` : "";
  }

  // ----- dialog -----------------------------------------------------------
  say(text, tone = "") {
    const box = this.el("backtest-message");
    box.textContent = text;
    box.className = `order-message ${tone}`;
  }

  async open() {
    this.armedDelete = null;
    this.say("");
    this.el("backtest-journal").value = this.journal;
    if (!this.dialog.open) this.dialog.showModal();
    if (this.current) await this.save(); // so the list shows the run on screen as it is now
    await this.refresh();
  }

  async refresh() {
    const rows = this.el("backtest-rows");
    let list;
    try {
      list = await this.store.listBacktests();
    } catch (err) {
      rows.innerHTML = "";
      this.say(`Could not read the saved backtests: ${err.message}`, "bad");
      return;
    }
    this.list = list;
    this.render();
  }

  // ----- backups --------------------------------------------------------------
  renderBackup() {
    let last = null;
    try { last = localStorage.getItem(KEY_LAST_BACKUP); } catch { /* private mode */ }
    const age = backupAge(last);
    const line = this.el("backup-status");
    const where = this.store.kind === "browser"
      ? `Saved only in this browser (${this.store.backend}).` : "Saved as files under strategies/ on this computer.";
    line.textContent = `${where} Last backup: ${age.text}.`;
    // Online, a backup file is the only other copy: nudge after a week without one.
    line.classList.toggle("warn", this.store.kind === "browser" && this.list.length > 0 && age.days > 7);
  }

  async exportFile() {
    try {
      if (this.current) await this.save(); // the run on screen as it is now
      const backup = await exportBackup(this.store);
      const stamp = backup.exported.slice(0, 16).replace("T", "_").replace(":", "-");
      download(`forexreplay-backup-${stamp}.json`, JSON.stringify(backup), "application/json");
      try { localStorage.setItem(KEY_LAST_BACKUP, backup.exported); } catch { /* private mode */ }
      this.say(`Exported ${backup.backtests.length} backtest(s). Keep the file somewhere safe (Drive, email, USB).`, "ok");
    } catch (err) {
      this.say(`Could not export: ${err.message}`, "bad");
    }
    this.renderBackup();
  }

  async importFile(input) {
    const file = input.files && input.files[0];
    input.value = ""; // the same file can be picked again
    if (!file) return;
    try {
      const result = await importBackup(this.store, JSON.parse(await file.text()));
      const parts = [`${result.added} added`, `${result.updated} updated`, `${result.unchanged} already up to date`];
      const problems = result.problems.length ? ` · skipped: ${result.problems.join("; ")}` : "";
      this.say(`Imported ${file.name}: ${parts.join(", ")}${problems}.`, result.problems.length ? "bad" : "ok");
    } catch (err) {
      this.say(`Could not import ${file.name}: ${err instanceof SyntaxError ? "the file is not valid JSON" : err.message}`, "bad");
    }
    await this.refresh();
  }

  async csvFile() {
    try {
      if (this.current) await this.save();
      const { text, trades } = await tradesCsv(this.store);
      download(`forexreplay-trades-${new Date().toISOString().slice(0, 10)}.csv`, text, "text/csv");
      this.say(`Downloaded ${trades} trade(s) as CSV.`, "ok");
    } catch (err) {
      this.say(`Could not make the CSV: ${err.message}`, "bad");
    }
  }

  /** The list, narrowed to one journal and to names containing the search words. */
  render() {
    this.renderBackup();
    const rows = this.el("backtest-rows");
    const list = this.list;
    const counts = new Map();
    for (const b of list) counts.set(b.journal, (counts.get(b.journal) || 0) + 1);
    const journals = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    let wanted = "";
    try { wanted = localStorage.getItem(KEY_FILTER) || ""; } catch { /* private mode */ }
    if (!counts.has(wanted)) wanted = ""; // that journal has no backtests any more
    this.el("backtest-filter").innerHTML = `<option value="">All journals (${list.length})</option>` +
      journals.map((j) => `<option value="${escapeHtml(j)}"${j === wanted ? " selected" : ""}>${escapeHtml(j)} (${counts.get(j)})</option>`).join("");
    const f = this.filters;
    const strategies = strategiesIn(list);
    if (f.strategy && f.strategy !== "-" && !strategies.includes(f.strategy)) f.strategy = "";
    this.el("backtest-strategy-filter").innerHTML = `<option value="">All strategies</option>` +
      strategies.map((s) => `<option value="${escapeHtml(s)}"${s === f.strategy ? " selected" : ""}>${escapeHtml(s)}</option>`).join("") +
      `<option value="-"${f.strategy === "-" ? " selected" : ""}>(no strategy)</option>`;
    this.el("backtest-status-filter").innerHTML = `<option value="">Any status</option>` +
      STATUSES.map((s) => `<option value="${s.id}"${s.id === f.status ? " selected" : ""}>${s.label}</option>`).join("");
    this.el("new-strategies").innerHTML = strategies.map((s) => `<option value="${escapeHtml(s)}">`).join(""); // suggestions while typing
    const words = this.el("backtest-search").value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = list.filter((b) => {
      const m = cleanMeta(b);
      return (!wanted || b.journal === wanted) &&
        (!f.strategy || (f.strategy === "-" ? !m.strategy : m.strategy === f.strategy)) && (!f.status || m.status === f.status) &&
        words.every((w) => `${b.name || b.id} ${m.strategy} ${m.strategyVersion} ${m.notes}`.toLowerCase().includes(w));
    });
    this.el("backtest-count").textContent = shown.length === list.length ? "" : `${shown.length} of ${list.length} shown`;
    rows.innerHTML = list.length === 0
      ? '<tr><td colspan="7" class="muted">No saved backtests yet. Start a replay and place a trade or draw something.</td></tr>'
      : shown.length === 0 ? '<tr><td colspan="7" class="muted">No backtest matches. Choose "All journals" or clear the search.</td></tr>'
        : shown.map((b) => this.row(b)).join("");
  }

  row(b) {
    const key = `${escapeHtml(b.journal)}/${escapeHtml(b.id)}`;
    if (b.error) {
      return `<tr><td colspan="6">${escapeHtml(b.id)} <span class="bad">${escapeHtml(b.error)}</span></td>` +
        `<td class="actions"><button class="plain small" data-delete="${key}">Delete</button></td></tr>`;
    }
    const r = b.result || {};
    const running = this.current && this.current.id === b.id;
    const tone = (r.totalR || 0) >= 0 ? "up" : "down";
    const trades = `${r.closed || 0}` + (r.open || r.pending ? ` + ${(r.open || 0) + (r.pending || 0)} active` : "");
    return `<tr>
      <td class="name-cell"><span class="bt-name">${escapeHtml(b.name)}</span>${running ? ' <span class="tag">on screen</span>' : ""}
        <button class="plain small rename-button" data-edit="${key}" title="Name, strategy, version, status and notes" aria-label="Edit details">&#9998;</button>
        <div class="bt-meta">${this.metaLine(b)}</div></td>
      <td>${escapeHtml(b.journal)}</td>
      <td class="nowrap">${formatDateTime(b.furthestTime)}</td>
      <td class="num">${trades}</td>
      <td class="num ${tone}">${r.challenge ? `<span class="tag ${r.challenge.toLowerCase()}" title="Prop-firm challenge">${r.challenge === "RUNNING" ? "challenge" : r.challenge}</span> ` : ""}${(r.totalR || 0) >= 0 ? "+" : ""}${(r.totalR || 0).toFixed(2)}R · ${formatSignedMoney(r.money || 0)}</td>
      <td class="nowrap muted">${b.saved ? new Date(b.saved).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : ""}</td>
      <td class="actions">
        <button class="plain small" data-analytics="${key}" title="Statistics, balance, calendar and trades of this backtest alone">Analytics</button>
        <button class="plain small" data-chart="${key}" title="Show this backtest's trades on the chart as long/short boxes">Chart</button>
        <button class="plain bordered small" data-resume="${key}"${running ? " disabled" : ""}>Resume</button>
        <button class="plain small" data-delete="${key}"${running ? " disabled" : ""}>Delete</button>
      </td></tr>`;
  }

  /** "OB Retest · v2 · Done · 05 Feb 2026 → 16 Apr 2026 · M15 · has notes" under the name. */
  metaLine(b) {
    const m = cleanMeta(b);
    const parts = [];
    if (m.strategy) parts.push(`<b>${escapeHtml(m.strategy)}</b>${m.strategyVersion ? ` · ${escapeHtml(m.strategyVersion)}` : ""}`);
    parts.push(`<span class="status ${m.status}">${statusLabel(m.status)}</span>`);
    const period = periodText(b);
    if (period) parts.push(escapeHtml(period));
    if (b.timeframe) parts.push(escapeHtml(b.timeframe));
    if (m.notes) parts.push(`<span title="${escapeHtml(m.notes)}">notes</span>`);
    return parts.join(" · ");
  }

  async handleRowClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.edit) {
      this.startEdit(button);
    } else if (button.dataset.editSave) {
      await this.finishEdit(button.closest("tr.edit-row"));
    } else if (button.dataset.editCancel) {
      this.render();
    } else if (button.dataset.editAuto) {
      const form = button.closest("tr.edit-row");
      const b = this.list.find((x) => `${x.journal}/${x.id}` === form.dataset.key) || {};
      const name = autoName({ ...b, strategy: form.querySelector("[name=strategy]").value, strategyVersion: form.querySelector("[name=strategyVersion]").value });
      if (name) form.querySelector("[name=name]").value = name;
      else this.say("Type a strategy first: the name is made from it, the version, the period and the timeframe.", "bad");
    } else if (button.dataset.chart) {
      const [journal, id] = button.dataset.chart.split("/");
      const problem = await this.onChart(journal, id);
      if (problem) this.say(problem, "bad");
      else this.dialog.close();
    } else if (button.dataset.analytics) {
      const [journal, id] = button.dataset.analytics.split("/");
      this.dialog.close();
      this.onAnalytics(journal, id);
    } else if (button.dataset.resume) {
      const [journal, id] = button.dataset.resume.split("/");
      this.say("Rebuilding the run from its saved actions...");
      try {
        const problems = await this.onResume(journal, id);
        if (problems.length === 0) this.dialog.close();
        else this.say(`Resumed, but the rebuild does not match the save: ${problems.join(" ")}`, "bad");
      } catch (err) {
        this.say(`Could not resume: ${err.message}`, "bad");
      }
    } else if (button.dataset.delete) {
      if (this.armedDelete !== button.dataset.delete) { // deleting cannot be undone, so it takes a second click
        this.armedDelete = button.dataset.delete;
        button.textContent = "Delete?";
        button.classList.add("armed");
        this.say("Click Delete? again to remove this backtest for good. Its trades stay in the journal.");
        return;
      }
      const [journal, id] = button.dataset.delete.split("/");
      try {
        await this.store.deleteBacktest(journal, id);
        this.say("Deleted. Its trades are still in the journal.", "ok");
      } catch (err) {
        this.say(`Could not delete: ${err.message}`, "bad");
      }
      this.armedDelete = null;
      await this.refresh();
    }
  }

  // ----- details: name, strategy, version, status, notes -------------------------
  /** Open the details of one backtest in a row under it. */
  startEdit(button) {
    this.render(); // one form at a time
    const key = button.dataset.edit;
    const b = this.list.find((x) => `${x.journal}/${x.id}` === key);
    const row = [...this.el("backtest-rows").querySelectorAll("button[data-edit]")].find((x) => x.dataset.edit === key);
    if (!b || !row) return;
    const m = cleanMeta(b);
    const form = document.createElement("tr");
    form.className = "edit-row";
    form.dataset.key = key;
    form.innerHTML = `<td colspan="7"><div class="edit-grid">
      <label class="wide">Name <span class="with-button"><input name="name" type="text" maxlength="${MAX_NAME}" value="${escapeHtml(b.name)}">
        <button class="plain bordered small" data-edit-auto="1" title="Strategy, version, period and timeframe">Auto name</button></span></label>
      <label>Strategy <input name="strategy" type="text" maxlength="60" list="new-strategies" value="${escapeHtml(m.strategy)}" placeholder="e.g. OB Retest"></label>
      <label>Version <input name="strategyVersion" type="text" maxlength="20" value="${escapeHtml(m.strategyVersion)}" placeholder="e.g. v2"></label>
      <label>Status <select name="status">${STATUSES.map((s) => `<option value="${s.id}"${s.id === m.status ? " selected" : ""}>${s.label}</option>`).join("")}</select></label>
      <label class="wide">Notes: what you are testing, what you learnt <textarea name="notes" rows="3" maxlength="4000">${escapeHtml(m.notes)}</textarea></label>
      <div class="wide edit-actions"><button class="plain primary small" data-edit-save="1">Save</button> <button class="plain small" data-edit-cancel="1">Cancel</button>
        <span class="muted">Enter saves, Esc cancels.</span></div>
    </div></td>`;
    row.closest("tr").after(form);
    form.querySelector("[name=name]").focus();
  }

  async finishEdit(form) {
    const field = (name) => form.querySelector(`[name=${name}]`).value;
    const name = field("name").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (!name) { this.say("A name cannot be empty.", "bad"); form.querySelector("[name=name]").focus(); return; }
    const [journal, id] = form.dataset.key.split("/");
    const b = this.list.find((x) => x.journal === journal && x.id === id) || {};
    const fields = { name, ...cleanMeta({ ...cleanMeta(b), strategy: field("strategy"), strategyVersion: field("strategyVersion"), status: field("status"), notes: field("notes") }) };
    try {
      await this.update(journal, id, fields);
      this.say(`Saved "${name}".`, "ok");
    } catch (err) {
      this.say(`Could not save: ${err.message}`, "bad");
    }
    await this.refresh();
  }

  /**
   * Change a saved backtest's name and details. They are labels only: the id, the journal and the
   * journal rows stay as they are, so the analytics page shows a new name at once.
   */
  async update(journal, id, fields) {
    if (this.current && this.current.id === id && this.current.journal === journal) {
      Object.assign(this.current, fields); // the run on screen: the next save carries them
      if (!(await this.save())) throw new Error("the save failed");
      return;
    }
    const data = await this.store.getBacktest(journal, id);
    Object.assign(data, fields);
    await this.store.putBacktest(data);
  }

  /** Kept for callers of the first version: only the name. */
  rename(journal, id, name) { return this.update(journal, id, { name }); }
}

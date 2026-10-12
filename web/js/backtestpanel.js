// Saving backtests as you go, and the "Backtests" dialog (resume or delete a saved one).
//
// Each replay is a backtest. Once it has a trade or a drawing, it is saved to the
// local server a moment after anything changes, when you leave it, and when the
// tab closes. The server writes it to strategies/<journal>/backtests/<id>.json and
// adds its closed trades to strategies/<journal>/trades.csv.
// The rules for what is saved and how a run is rebuilt live in backtest.js.

import { formatSignedMoney } from "./account.js";
import { newId, snapshot, validName } from "./backtest.js";
import { formatDateTime } from "./time.js";

export const DEFAULT_JOURNAL = "manual_backtests";
const KEY_JOURNAL = "forexreplay.journal";
const KEY_FILTER = "forexreplay.backtests.filter"; // the journal the list shows ("" = all)
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
    this.current = null; // { id, name, journal, created, startTime } of the run on screen
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
    this.el("backtest-rows").addEventListener("click", (event) => this.handleRowClick(event));
    this.el("backtest-rows").addEventListener("keydown", (event) => {
      const input = event.target.closest("input.rename");
      if (!input) return;
      if (event.key === "Enter") { event.preventDefault(); this.finishRename(input); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.refresh(); } // cancel, keep the dialog open
    });
    this.renderStatus();
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
    this.current = {
      id: newId(), name: `${symbol} from ${formatDateTime(startTime)}`, journal: this.journal,
      created: new Date().toISOString(), startTime,
    };
    this.everSaved = false;
    this.drawingsTouched = false;
    this.renderStatus();
  }

  /** A saved backtest has been rebuilt and is on screen again. */
  continueWith(saved) {
    this.stopTimer();
    const { id, name, journal, created, startTime } = saved;
    this.current = { id, name, journal, created, startTime };
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

  /** The list, narrowed to one journal and to names containing the search words. */
  render() {
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
    const words = this.el("backtest-search").value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = list.filter((b) => (!wanted || b.journal === wanted) &&
      words.every((w) => String(b.name || b.id).toLowerCase().includes(w)));
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
        <button class="plain small rename-button" data-rename="${key}" title="Rename this backtest" aria-label="Rename">&#9998;</button></td>
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

  async handleRowClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.rename) {
      this.startRename(button);
    } else if (button.dataset.renameSave) {
      await this.finishRename(button.closest("td").querySelector("input.rename"));
    } else if (button.dataset.renameCancel) {
      await this.refresh();
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

  // ----- renaming -----------------------------------------------------------
  /** Swap the name for a box to type the new one in. */
  startRename(button) {
    const cell = button.closest("td");
    const name = cell.querySelector(".bt-name").textContent;
    cell.innerHTML = `<input class="rename" type="text" maxlength="${MAX_NAME}" value="${escapeHtml(name)}" data-key="${escapeHtml(button.dataset.rename)}" aria-label="New name">
      <button class="plain bordered small" data-rename-save="1">Save</button> <button class="plain small" data-rename-cancel="1">Cancel</button>`;
    const input = cell.querySelector("input");
    input.focus();
    input.select();
  }

  async finishRename(input) {
    const name = input.value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (!name) { this.say("A name cannot be empty.", "bad"); input.focus(); return; }
    const [journal, id] = input.dataset.key.split("/");
    try {
      await this.rename(journal, id, name);
      this.say(`Renamed to "${name}".`, "ok");
    } catch (err) {
      this.say(`Could not rename: ${err.message}`, "bad");
    }
    await this.refresh();
  }

  /**
   * Give a saved backtest a name of your own. The name is only a label: the id, the journal and the
   * journal rows stay as they are, so the analytics page shows the new name at once.
   */
  async rename(journal, id, name) {
    if (this.current && this.current.id === id && this.current.journal === journal) {
      this.current.name = name; // the run on screen: the next save carries the new name
      if (!(await this.save())) throw new Error("the save failed");
      return;
    }
    const data = await this.store.getBacktest(journal, id);
    data.name = name;
    await this.store.putBacktest(data);
  }
}

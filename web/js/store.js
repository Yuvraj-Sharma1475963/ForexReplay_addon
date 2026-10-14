// Where backtests, journals and screenshots are kept.
//
// On your computer the app runs with its Python server, which keeps them as files under
// strategies/ (forex_replay/backtests.py). Online (a static website, built with
// `python -m forex_replay site`) there is no server, so they are kept in the visitor's own
// browser instead: each visitor has their own, nobody else can see them, and clearing the
// browser's site data removes them (Backtests -> Export backup keeps a copy as a file).
// They live in the browser's IndexedDB, which holds hundreds of megabytes; localStorage (about
// 5 MB) is used only where IndexedDB is missing, and to carry a save made as the tab closes.
// Screenshots are not kept online.
//
// Both stores offer the same calls, so the rest of the app does not care which one it has.

import { cleanLibrary } from "./backtestmeta.js";
import { serverOffsetSeconds } from "./timeframes.js";

/** The static build writes site.json; the Python server does not serve one. */
export async function openStore(fetchFn = fetch) {
  let online = false;
  try {
    const response = await fetchFn("site.json", { cache: "no-store" });
    online = response.ok && (await response.json()).static === true;
  } catch { /* no site.json: the local app */ }
  if (!online) return new ServerStore(fetchFn);
  const db = await IdbBackend.open();
  if (!db) return new BrowserStore(globalThis.localStorage, null);
  const store = new BrowserStore(globalThis.localStorage, db);
  try {
    await store.adoptLocalStorage(); // backtests saved before IndexedDB was used move over once
    return store;
  } catch {
    // IndexedDB opened but would not take the data: carry on with localStorage, where it still is.
    return new BrowserStore(globalThis.localStorage, null);
  }
}

/** One record ("store": every backtest) in an IndexedDB database. */
export class IdbBackend {
  constructor(db) { this.db = db; }

  /** Resolves to a backend, or null where IndexedDB is missing or refused (some private windows). */
  static open(name = "forexreplay", factory = globalThis.indexedDB) {
    return new Promise((resolve) => {
      if (!factory) { resolve(null); return; }
      let request;
      try { request = factory.open(name, 1); } catch { resolve(null); return; }
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(new IdbBackend(request.result));
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  run(mode, work) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("kv", mode);
      const request = work(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  read() { return this.run("readonly", (kv) => kv.get("store")); }
  write(data) { return this.run("readwrite", (kv) => kv.put(data, "store")); }
}

async function request(fetchFn, path, options = {}) {
  const response = await fetchFn(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

const enc = encodeURIComponent;

/** Files on disk through the local Python server (the desktop app). */
export class ServerStore {
  constructor(fetchFn = fetch) {
    this.kind = "server";
    this.screenshots = true;
    this.fetch = fetchFn;
  }

  health() { return request(this.fetch, "api/health").catch(() => null); }
  listBacktests() { return request(this.fetch, "api/backtests").then((b) => b.backtests || []); }
  getBacktest(journal, id) { return request(this.fetch, `api/backtests/${enc(journal)}/${enc(id)}`); }
  putBacktest(data) {
    return request(this.fetch, `api/backtests/${enc(data.journal)}/${enc(data.id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
  }
  /** The tab is closing: send without waiting. */
  putBacktestNow(data) {
    try {
      this.fetch(`api/backtests/${enc(data.journal)}/${enc(data.id)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), keepalive: true,
      });
    } catch { /* the tab is going away */ }
  }
  deleteBacktest(journal, id) { return request(this.fetch, `api/backtests/${enc(journal)}/${enc(id)}`, { method: "DELETE" }); }
  /** Each strategy's rules and what each version changed (strategies/_library.json). */
  getLibrary() { return request(this.fetch, "api/library").then(cleanLibrary); }
  putLibrary(library) {
    return request(this.fetch, "api/library", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cleanLibrary(library)),
    });
  }
  /** Move a backtest to another journal: the server moves its file, journal rows and screenshots. */
  moveBacktest(journal, id, to) {
    return request(this.fetch, `api/backtests/${enc(journal)}/${enc(id)}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to }),
    });
  }
  listJournals() { return request(this.fetch, "api/journals").then((b) => b.journals || []); }
  journalRows(name) { return request(this.fetch, `api/journal/${enc(name)}`).then((b) => b.rows); }
  screenshotUrl(journal, name) { return `api/screenshots/${enc(journal)}/${enc(name)}`; }
  async putScreenshot(journal, name, blob) {
    const response = await this.fetch(this.screenshotUrl(journal, name), { method: "PUT", headers: { "Content-Type": "image/png" }, body: blob });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  }
  async deleteScreenshot(journal, name) { await this.fetch(this.screenshotUrl(journal, name), { method: "DELETE" }); }
}

export const BROWSER_KEY = "forexreplay.store.v1"; // localStorage: the store itself (no IndexedDB, or before it was used)
export const PENDING_KEY = "forexreplay.store.pending"; // localStorage: saves made as the tab closed, merged on the next read
const SUMMARY = ["id", "name", "journal", "symbol", "startTime", "furthestTime", "created", "saved", "result", "settings", "challenge",
  "timeframe", "strategy", "strategyVersion", "status", "notes", "archived"];

const clean = (data) => (data && typeof data.backtests === "object" && data.backtests !== null ? data : { backtests: {} });

/** Put `incoming` backtests into `data`, keeping whichever copy of each was saved last. Returns how many changed. */
export function mergeBacktests(data, incoming) {
  let changed = 0;
  for (const [key, b] of Object.entries(incoming || {})) {
    const had = data.backtests[key];
    if (!had || String(b.saved || "") >= String(had.saved || "")) { data.backtests[key] = b; changed++; }
  }
  return changed;
}

/** Backtests in this browser (the online site): in IndexedDB (`db`), or in `storage` (localStorage) without it. */
export class BrowserStore {
  constructor(storage = globalThis.localStorage, db = null) {
    this.kind = "browser";
    this.screenshots = false;
    this.storage = storage;
    this.db = db;
  }

  get backend() { return this.db ? "IndexedDB" : "localStorage"; }

  readLocal(key) {
    try { return JSON.parse(this.storage.getItem(key) || "null"); } catch { return null; }
  }

  async read() {
    if (!this.db) return clean(this.readLocal(BROWSER_KEY));
    let data;
    try { data = clean(await this.db.read()); } catch { data = { backtests: {} }; }
    const pending = this.readLocal(PENDING_KEY); // saved as a tab closed: IndexedDB may not have finished
    if (pending && mergeBacktests(data, pending)) await this.write(data);
    if (pending) try { this.storage.removeItem(PENDING_KEY); } catch { /* nothing to do */ }
    return data;
  }

  async write(data) {
    if (this.db) {
      try { await this.db.write(data); return; } catch (err) {
        throw new Error(err && err.name === "QuotaExceededError" ? "this browser's storage is full; export a backup and delete some old backtests"
          : `this browser refused the save (${err && err.message ? err.message : "IndexedDB error"})`);
      }
    }
    try {
      this.storage.setItem(BROWSER_KEY, JSON.stringify(data));
    } catch (err) {
      throw new Error(err && err.name === "QuotaExceededError"
        ? "this browser's storage is full; export a backup and delete some old backtests" : "this browser does not allow saving (private window?)");
    }
  }

  /** Move backtests saved in localStorage (before IndexedDB, or by an old tab) into IndexedDB, then free localStorage. */
  async adoptLocalStorage() {
    const old = this.readLocal(BROWSER_KEY);
    if (!old || typeof old.backtests !== "object") return 0;
    const data = await this.read();
    const changed = mergeBacktests(data, old.backtests);
    await this.write(data);
    try { this.storage.removeItem(BROWSER_KEY); } catch { /* kept: merged again next time, harmlessly */ }
    return changed;
  }

  async health() { return { ok: true, version: "online" }; }

  async listBacktests() {
    return Object.values((await this.read()).backtests)
      .map((b) => Object.fromEntries(SUMMARY.map((k) => [k, b[k] ?? null])))
      .sort((a, b) => String(b.saved).localeCompare(String(a.saved)));
  }

  async getBacktest(journal, id) {
    const b = (await this.read()).backtests[`${journal}/${id}`];
    if (!b) throw new Error(`No saved backtest ${journal}/${id}.`);
    return b;
  }

  async putBacktest(data) {
    const all = await this.read();
    const key = `${data.journal}/${data.id}`;
    const closed = (d) => new Set((d ? d.trades : []).filter((t) => t.status === "CLOSED").map((t) => t.id));
    const before = closed(all.backtests[key]);
    all.backtests[key] = data;
    await this.write(all);
    const added = [...closed(data)].filter((id) => !before.has(id)).length;
    return { ok: true, journalAdded: added, journal: "this browser" };
  }

  /** The tab is closing. IndexedDB writes may not finish in time, so the save is also kept in localStorage. */
  putBacktestNow(data) {
    if (this.db) {
      try {
        const pending = this.readLocal(PENDING_KEY) || {};
        pending[`${data.journal}/${data.id}`] = data;
        this.storage.setItem(PENDING_KEY, JSON.stringify(pending));
      } catch { /* full: the IndexedDB write below may still make it */ }
    }
    this.putBacktest(data).catch(() => { /* the tab is going away */ });
  }

  /** Each strategy's rules and what each version changed, kept next to the backtests. */
  async getLibrary() { return cleanLibrary((await this.read()).library); }
  async putLibrary(library) {
    const all = await this.read();
    all.library = cleanLibrary(library);
    await this.write(all);
    return { ok: true };
  }

  /** Move a backtest to another journal (online, its journal rows are made from it, so they follow). */
  async moveBacktest(journal, id, to) {
    if (typeof to !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(to)) throw new Error("a journal name may use only letters, digits, - and _");
    if (to === journal) throw new Error("it is already in that journal");
    const all = await this.read();
    const b = all.backtests[`${journal}/${id}`];
    if (!b) throw new Error(`No saved backtest ${journal}/${id}.`);
    if (all.backtests[`${to}/${id}`]) throw new Error(`${to} already has a backtest ${id}`);
    delete all.backtests[`${journal}/${id}`];
    all.backtests[`${to}/${id}`] = { ...b, journal: to };
    await this.write(all);
    return { ok: true };
  }

  async deleteBacktest(journal, id) {
    const all = await this.read();
    delete all.backtests[`${journal}/${id}`];
    await this.write(all);
    return { ok: true };
  }

  /** Journals: the closed trades of the backtests saved under each journal name. */
  async listJournals() {
    const counts = new Map();
    for (const b of Object.values((await this.read()).backtests)) {
      counts.set(b.journal, (counts.get(b.journal) || 0) + (b.trades || []).filter((t) => t.status === "CLOSED").length);
    }
    return [...counts].filter(([, n]) => n > 0).map(([name, trades]) => ({ name, trades })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async journalRows(name) {
    return Object.values((await this.read()).backtests)
      .filter((b) => b.journal === name)
      .sort((a, b) => String(a.created).localeCompare(String(b.created))) // in the order the runs were made
      .flatMap((b) => (b.trades || []).filter((t) => t.status === "CLOSED").map((t) => journalRow(t, b)));
  }

  screenshotUrl() { return ""; }
  async putScreenshot() { throw new Error("screenshots are kept only in the desktop app"); }
  async deleteScreenshot() {}
}

// ----- journal rows, as forex_replay/journal.py writes them --------------------------
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// v1's sessions, in broker-server hours (forex_replay/sessions.py)
const SESSIONS = [["Asia", 0, 10], ["London", 10, 15], ["London/NY overlap", 15, 19], ["New York", 19, 24]];

/** A UTC time as broker-server time text, "2026-03-05 11:05:00". */
function serverText(utc) {
  return new Date((utc + serverOffsetSeconds(utc)) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** The same row the Python server writes to trades.csv for a closed trade of the browser app (as text). */
export function journalRow(trade, backtest) {
  const scale = 10 ** backtest.digits, pip = backtest.pipPoints;
  const text = (v) => (v === null || v === undefined || Number.isNaN(v) ? "" : String(v));
  const price = (p) => (p === null || p === undefined ? "" : String(Math.round((p / scale) * scale) / scale));
  const round = (v, n) => (v === null || v === undefined ? "" : String(Math.round(v * 10 ** n) / 10 ** n));
  const entry = trade.entryTime;
  const serverEntry = entry === null ? null : new Date((entry + serverOffsetSeconds(entry)) * 1000);
  const hour = serverEntry ? serverEntry.getUTCHours() : null;
  return {
    trade_id: text(trade.id), run_id: backtest.id, symbol: backtest.symbol || "EURUSD", side: trade.side, order_type: trade.orderType,
    placed_time: trade.placedTime === null ? "" : serverText(trade.placedTime),
    entry_time: entry === null ? "" : serverText(entry),
    exit_time: trade.exitTime === null ? "" : serverText(trade.exitTime),
    entry_price: price(trade.entryPrice), exit_price: price(trade.exitPrice),
    stop_loss: price(trade.stopLoss), take_profit: price(trade.takeProfit),
    risk_pips: round(trade.plannedRisk / pip, 1), pnl_pips: trade.pnl === null ? "" : round(trade.pnl / pip, 1),
    result_r: round(trade.resultR, 2), planned_rr: round(trade.plannedRewardR, 2),
    mfe_r: round(trade.mfeR, 2), mae_r: round(trade.maeR, 2), exit_reason: text(trade.exitReason),
    session: hour === null ? "" : (SESSIONS.find(([, a, b]) => hour >= a && hour < b) || ["Unknown"])[0],
    weekday: serverEntry ? WEEKDAYS[serverEntry.getUTCDay()] : "",
    duration_min: entry === null || trade.exitTime === null ? "" : round((trade.exitTime - entry) / 60, 0),
    lots: round(trade.lots, 2), pnl_usd: round(trade.money, 2), commission_usd: round(trade.commission, 2),
    note: typeof trade.note === "string" ? trade.note : "",
    tags: Array.isArray(trade.tags) ? trade.tags.join("; ") : "",
    screenshots: Array.isArray(trade.screenshots) ? trade.screenshots.join("; ") : "",
  };
}

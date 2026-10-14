// Backups: every saved backtest as one JSON file, loading such a file back, and every closed
// trade as a CSV for Excel, Google Sheets or Python.
//
// Online, backtests live only in this browser (store.js), so a file is the only copy that
// survives clearing the browser or moving to another computer. The file holds each backtest
// whole (actions, drawings, notes, trades), so an imported one can be resumed like any other.

import { FORMAT_VERSION, validName } from "./backtest.js";

export const BACKUP_FORMAT = "forexreplay-backtests";
export const KEY_LAST_BACKUP = "forexreplay.lastBackup"; // ISO time of the last export, in localStorage

/** Every saved backtest, whole, as the object a backup file holds. */
export async function exportBackup(store, now = new Date()) {
  const list = await store.listBacktests();
  const backtests = [];
  for (const b of list) {
    if (b.error) continue; // a damaged file on disk: nothing to keep
    backtests.push(await store.getBacktest(b.journal, b.id));
  }
  return { format: BACKUP_FORMAT, version: 1, exported: now.toISOString(), backtests };
}

/** Why a backtest from a file cannot be loaded, or "" if it can. */
export function problemWith(b) {
  if (!b || typeof b !== "object") return "not a backtest";
  if (b.version !== FORMAT_VERSION) return `unknown format ${b.version}`;
  if (!validName(b.id)) return "no valid id";
  if (!validName(b.journal)) return "no valid journal name";
  for (const key of ["actions", "drawings", "trades"]) if (!Array.isArray(b[key])) return `no valid ${key}`;
  if (!b.settings || typeof b.settings !== "object") return "no valid settings";
  for (const key of ["startTime", "furthestTime", "digits", "pipPoints"]) if (!Number.isInteger(b[key])) return `no valid ${key}`;
  return "";
}

/**
 * Load a backup file's backtests. One already here is replaced only if the file's copy was saved
 * later, so importing an old file never undoes newer work. Resolves to counts and the problems found.
 */
export async function importBackup(store, file) {
  if (!file || file.format !== BACKUP_FORMAT || !Array.isArray(file.backtests)) {
    throw new Error("this is not a ForexReplay backup file");
  }
  const here = new Map((await store.listBacktests()).map((b) => [`${b.journal}/${b.id}`, b]));
  const out = { added: 0, updated: 0, unchanged: 0, problems: [] };
  for (const b of file.backtests) {
    const problem = problemWith(b);
    if (problem) { out.problems.push(`${(b && (b.name || b.id)) || "?"}: ${problem}`); continue; }
    const had = here.get(`${b.journal}/${b.id}`);
    if (had && String(had.saved || "") >= String(b.saved || "")) { out.unchanged++; continue; }
    await store.putBacktest(b);
    if (had) out.updated++; else out.added++;
  }
  return out;
}

const CSV_COLUMNS_FIRST = ["journal", "backtest"];

/** One CSV cell: quoted when it holds a comma, a quote or a line break. */
export function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Every closed trade of every journal, with the journal and backtest name first: { text (CSV), trades }. */
export async function tradesCsv(store) {
  const names = new Map((await store.listBacktests()).map((b) => [b.id, b.name]));
  const rows = [];
  for (const j of await store.listJournals()) {
    for (const row of await store.journalRows(j.name)) rows.push({ journal: j.name, backtest: names.get(row.run_id) || "", ...row });
  }
  const columns = [...CSV_COLUMNS_FIRST];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const text = [columns.join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(","))].join("\r\n") + "\r\n";
  return { text, trades: rows.length };
}

/** Offer `text` to the browser as a file to save. */
export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "today", "1 day ago", "9 days ago" or "never", for the backup line in the Backtests dialog. */
export function backupAge(iso, now = new Date()) {
  if (!iso) return { text: "never", days: Infinity };
  const days = Math.floor((now - new Date(iso)) / 86400000);
  if (!Number.isFinite(days)) return { text: "never", days: Infinity };
  return { text: days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`, days };
}

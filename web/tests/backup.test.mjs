// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { backupAge, BACKUP_FORMAT, csvCell, exportBackup, importBackup, problemWith, tradesCsv } from "../js/backup.js";
import { BROWSER_KEY, BrowserStore, mergeBacktests, PENDING_KEY } from "../js/store.js";

/** localStorage stand-in. */
function memory() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
    raw: data,
  };
}
/** IndexedDB stand-in: the one record, copied in and out as the real one does. */
function fakeDb() {
  let value;
  return { read: async () => (value === undefined ? undefined : structuredClone(value)), write: async (v) => { value = structuredClone(v); } };
}

const UTC = Date.parse("2026-03-05T09:05:00Z") / 1000;
const trade = (id, extra = {}) => ({
  id, status: "CLOSED", side: "BUY", orderType: "MARKET", placedTime: UTC - 300, entryTime: UTC, exitTime: UTC + 3300,
  entryPrice: 108500, exitPrice: 108700, stopLoss: 108400, takeProfit: 108700, plannedRisk: 100, pnl: 200, resultR: 2,
  plannedRewardR: 2, mfeR: 2, maeR: 0.3, exitReason: "TAKE_PROFIT", lots: 1.5, money: 296, commission: 6,
  note: 'said "wait", then, entered', tags: ["A+"], screenshots: [], ...extra,
});
const backtest = (id, saved, extra = {}) => ({
  version: 1, id, name: `Run ${id}`, journal: "j1", symbol: "EURUSD", digits: 5, pipPoints: 10, created: saved, saved,
  startTime: 1, furthestTime: 2, settings: { startingBalance: 5000 }, result: { closed: 1 }, trades: [trade(1)], actions: [], drawings: [], ...extra,
});

test("a backup holds every backtest whole, and importing it into an empty store brings them all back", async () => {
  const a = new BrowserStore(memory(), fakeDb());
  await a.putBacktest(backtest("bt-1", "2026-10-01T10:00:00Z"));
  await a.putBacktest(backtest("bt-2", "2026-10-02T10:00:00Z", { journal: "j2" }));
  const file = await exportBackup(a, new Date("2026-10-15T08:00:00Z"));
  assert.equal(file.format, BACKUP_FORMAT);
  assert.equal(file.exported, "2026-10-15T08:00:00.000Z");
  assert.equal(file.backtests.length, 2);
  assert.ok(Array.isArray(file.backtests[0].actions), "whole backtests, not summaries");

  const b = new BrowserStore(memory(), fakeDb());
  const result = await importBackup(b, JSON.parse(JSON.stringify(file)));
  assert.deepEqual([result.added, result.updated, result.unchanged, result.problems], [2, 0, 0, []]);
  assert.deepEqual((await b.listBacktests()).map((x) => x.id), ["bt-2", "bt-1"]);
});

test("importing never undoes newer work, and skips what is not a backtest", async () => {
  const store = new BrowserStore(memory(), fakeDb());
  await store.putBacktest(backtest("bt-1", "2026-10-05T10:00:00Z", { name: "newer here" }));
  await store.putBacktest(backtest("bt-2", "2026-10-01T10:00:00Z", { name: "older here" }));
  const file = { format: BACKUP_FORMAT, version: 1, backtests: [
    backtest("bt-1", "2026-10-03T10:00:00Z", { name: "older in file" }),
    backtest("bt-2", "2026-10-09T10:00:00Z", { name: "newer in file" }),
    backtest("bt-3", "2026-10-09T10:00:00Z"),
    { ...backtest("bt-4", "2026-10-09T10:00:00Z"), journal: "no spaces allowed" },
    { ...backtest("bt-5", "2026-10-09T10:00:00Z"), version: 9 },
  ] };
  const result = await importBackup(store, file);
  assert.deepEqual([result.added, result.updated, result.unchanged], [1, 1, 1]);
  assert.equal(result.problems.length, 2);
  assert.equal((await store.getBacktest("j1", "bt-1")).name, "newer here");
  assert.equal((await store.getBacktest("j1", "bt-2")).name, "newer in file");
  await assert.rejects(importBackup(store, { hello: 1 }), /not a ForexReplay backup/);
  assert.equal(problemWith(backtest("bt-1", "x")), "");
  assert.match(problemWith({ ...backtest("bt-1", "x"), trades: null }), /trades/);
});

test("trades CSV: journal and backtest first, commas, quotes and line breaks quoted", async () => {
  const store = new BrowserStore(memory(), fakeDb());
  await store.putBacktest(backtest("bt-1", "2026-10-01T10:00:00Z", { trades: [trade(1), trade(2, { note: "line one\nline two" })] }));
  const { text, trades } = await tradesCsv(store);
  assert.equal(trades, 2);
  const [header, first] = text.split("\r\n");
  assert.ok(header.startsWith("journal,backtest,trade_id,"));
  assert.ok(first.startsWith("j1,Run bt-1,1,"));
  assert.ok(first.includes('"said ""wait"", then, entered"'));
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell("a\nb"), '"a\nb"');
});

test("IndexedDB store: old localStorage backtests move over once, and a save made as the tab closed is not lost", async () => {
  const storage = memory();
  storage.setItem(BROWSER_KEY, JSON.stringify({ backtests: { "j1/bt-1": backtest("bt-1", "2026-10-01T10:00:00Z") } }));
  const db = fakeDb();
  const store = new BrowserStore(storage, db);
  assert.equal(store.backend, "IndexedDB");
  assert.equal(await store.adoptLocalStorage(), 1);
  assert.equal(storage.getItem(BROWSER_KEY), null, "localStorage freed");
  assert.deepEqual((await store.listBacktests()).map((b) => b.id), ["bt-1"]);

  // Closing the tab: the save goes to localStorage at once, and is merged on the next read.
  store.putBacktestNow(backtest("bt-1", "2026-10-02T10:00:00Z", { name: "renamed as the tab closed" }));
  const next = new BrowserStore(storage, db); // the next visit
  assert.equal((await next.getBacktest("j1", "bt-1")).name, "renamed as the tab closed");
  assert.equal(storage.getItem(PENDING_KEY), null);

  const data = { backtests: { k: { saved: "2026-10-05" } } };
  assert.equal(mergeBacktests(data, { k: { saved: "2026-10-01" }, n: { saved: "2026-10-01" } }), 1); // the older copy of k is not taken
  assert.equal(data.backtests.k.saved, "2026-10-05");
});

test("backup age for the reminder", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  assert.deepEqual(backupAge(null, now), { text: "never", days: Infinity });
  assert.equal(backupAge("2026-10-15T08:00:00Z", now).text, "today");
  assert.equal(backupAge("2026-10-14T08:00:00Z", now).text, "1 day ago");
  assert.equal(backupAge("2026-10-06T08:00:00Z", now).days, 9);
});

test("online: moving a backtest to another journal moves its trades with it", async () => {
  const store = new BrowserStore(memory(), fakeDb());
  await store.putBacktest(backtest("bt-1", "2026-10-01T10:00:00Z"));
  await store.putBacktest(backtest("bt-2", "2026-10-02T10:00:00Z", { journal: "j2" }));
  await store.moveBacktest("j1", "bt-1", "j2");
  assert.deepEqual((await store.listBacktests()).map((b) => `${b.journal}/${b.id}`), ["j2/bt-2", "j2/bt-1"]);
  assert.deepEqual(await store.listJournals(), [{ name: "j2", trades: 2 }]);
  assert.equal((await store.journalRows("j2")).length, 2);
  await assert.rejects(store.moveBacktest("j2", "bt-1", "j2"), /already in that journal/);
  await assert.rejects(store.moveBacktest("j2", "bt-1", "has space"), /journal name/);
  await store.putBacktest(backtest("bt-1", "2026-10-03T10:00:00Z", { journal: "j3" }));
  await assert.rejects(store.moveBacktest("j2", "bt-1", "j3"), /already has/);
});

test("the strategy library travels in a backup; importing fills gaps and never overwrites what is here", async () => {
  const a = new BrowserStore(memory(), fakeDb());
  await a.putLibrary({ strategies: { "OB Retest": { rules: "from the file", versions: { v1: "first", v2: "London only" } }, "FVG": { rules: "x", versions: {} } } });
  const file = await exportBackup(a);
  const b = new BrowserStore(memory(), fakeDb());
  await b.putLibrary({ strategies: { "OB Retest": { rules: "mine", versions: { v1: "" } } } });
  const result = await importBackup(b, JSON.parse(JSON.stringify(file)));
  assert.equal(result.strategiesAdded, 1);
  assert.deepEqual(await b.getLibrary(), { strategies: {
    "OB Retest": { rules: "mine", versions: { v1: "first", v2: "London only" } }, "FVG": { rules: "x", versions: {} } } });
});

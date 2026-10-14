// What a backtest is about, besides its trades: the strategy and version it tests, how far along
// it is, notes, and whether it is archived. Kept in the saved backtest next to its name; none of it
// changes how a run is rebuilt or what its trades are.

import { formatDate } from "./time.js";

export const STATUSES = Object.freeze([
  { id: "testing", label: "Testing" },
  { id: "done", label: "Done" },
  { id: "discarded", label: "Discarded" },
]);
export const statusLabel = (id) => (STATUSES.find((s) => s.id === id) || STATUSES[0]).label;

const LIMITS = { strategy: 60, strategyVersion: 20, notes: 4000 };
const tidy = (v, n) => (typeof v === "string" ? v.replace(/[ \t]+/g, " ").trim().slice(0, n) : "");

/** The fields as they are kept: trimmed text, a known status, archived true or false. */
export function cleanMeta(raw = {}) {
  return {
    strategy: tidy(raw.strategy, LIMITS.strategy),
    strategyVersion: tidy(raw.strategyVersion, LIMITS.strategyVersion),
    status: STATUSES.some((s) => s.id === raw.status) ? raw.status : "testing",
    notes: typeof raw.notes === "string" ? raw.notes.trim().slice(0, LIMITS.notes) : "",
    archived: raw.archived === true,
  };
}

/** "05 Feb 2026 → 16 Apr 2026": from the replay's start to the furthest candle it reached. */
export function periodText(b) {
  if (!Number.isFinite(b.startTime)) return "";
  const from = formatDate(b.startTime);
  return Number.isFinite(b.furthestTime) && formatDate(b.furthestTime) !== from ? `${from} → ${formatDate(b.furthestTime)}` : from;
}

/** "OB Retest v2 · 05 Feb 2026 → 16 Apr 2026 · M15", or "" without a strategy. */
export function autoName(b) {
  const m = cleanMeta(b);
  if (!m.strategy) return "";
  return [`${m.strategy}${m.strategyVersion ? ` ${m.strategyVersion}` : ""}`, periodText(b), b.timeframe || ""].filter(Boolean).join(" · ");
}

/** Strategy names in use, most used first (for suggestions and filters). */
export function strategiesIn(list) {
  const count = new Map();
  for (const b of list) { const s = cleanMeta(b).strategy; if (s) count.set(s, (count.get(s) || 0) + 1); }
  return [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b));
}

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

/**
 * The strategy library: { strategies: { name: { rules, versions: { version: what changed } } } }.
 * The same rules as forex_replay/backtests.py clean_library, so both stores keep the same shape.
 */
export function cleanLibrary(raw) {
  const out = { strategies: {} };
  const strategies = raw && typeof raw === "object" && raw.strategies && typeof raw.strategies === "object" ? raw.strategies : {};
  for (const [name, entry] of Object.entries(strategies).slice(0, 500)) {
    if (!name.trim() || name.length > 60 || !entry || typeof entry !== "object") continue;
    const versions = entry.versions && typeof entry.versions === "object" ? entry.versions : {};
    out.strategies[name] = {
      rules: String(entry.rules || "").slice(0, 8000),
      versions: Object.fromEntries(Object.entries(versions).slice(0, 100)
        .filter(([v]) => typeof v === "string" && v.trim()).map(([v, t]) => [v.slice(0, 20), String(t || "").slice(0, 2000)])),
    };
  }
  return out;
}

/** `incoming` library entries added to `library`; where both have text, the one here wins. Returns how many strategies were new. */
export function mergeLibrary(library, incoming) {
  let added = 0;
  for (const [name, entry] of Object.entries(cleanLibrary(incoming).strategies)) {
    const here = library.strategies[name];
    if (!here) { library.strategies[name] = entry; added++; continue; }
    if (!here.rules) here.rules = entry.rules;
    for (const [v, text] of Object.entries(entry.versions)) if (!here.versions[v]) here.versions[v] = text;
  }
  return added;
}

/** Strategy names in use, most used first (for suggestions and filters). */
export function strategiesIn(list) {
  const count = new Map();
  for (const b of list) { const s = cleanMeta(b).strategy; if (s) count.set(s, (count.get(s) || 0) + 1); }
  return [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b));
}

// ----- coverage: which dates a strategy has been tested on ---------------------------
const DAY = 86400;

/** Time spans [from, to] (UTC seconds) joined where they touch or overlap, sorted. */
export function joinSpans(spans) {
  const sorted = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The parts of time covered by two or more of `spans`. */
export function overlaps(spans) {
  const edges = [];
  for (const [a, b] of spans) if (Number.isFinite(a) && Number.isFinite(b) && b > a) edges.push([a, 1], [b, -1]);
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // an end before a start at the same moment: touching is not overlapping
  const out = [];
  let depth = 0, from = null;
  for (const [t, d] of edges) {
    depth += d;
    if (depth >= 2 && from === null) from = t;
    if (depth < 2 && from !== null) { if (t > from) out.push([from, t]); from = null; }
  }
  return joinSpans(out);
}

/** Stretches of [first, last] no span covers, at least `minDays` long. */
export function gaps(spans, first, last, minDays = 7) {
  const out = [];
  let at = first;
  for (const [a, b] of joinSpans(spans)) {
    if (a - at >= minDays * DAY) out.push([at, Math.min(a, last)]);
    at = Math.max(at, b);
  }
  if (last - at >= minDays * DAY) out.push([at, last]);
  return out;
}

/** The span a backtest covers: from its start to the furthest candle it reached. */
export const spanOf = (b) => [b.startTime, Number.isFinite(b.furthestTime) ? b.furthestTime : b.startTime];

/** Backtests of `strategy` (not discarded, not `exceptId`) whose span holds `time`. */
export function testedAt(list, strategy, time, exceptId = null) {
  if (!strategy) return [];
  return list.filter((b) => {
    const m = cleanMeta(b);
    const [a, z] = spanOf(b);
    return b.id !== exceptId && m.strategy === strategy && m.status !== "discarded" && time >= a && time <= z;
  });
}

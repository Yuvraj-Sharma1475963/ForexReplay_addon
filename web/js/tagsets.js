// Trade tags from fixed lists, so the same thing is always spelt the same way ("OB retest", never
// "ob retest" and "OB-retest"), and analytics can group them: setup, grade, mistake, context.
//
// A tag is still plain text on the trade (tradenotes.js), so journals, filters and the CSV are as
// before; the lists only decide which chips are offered and how analytics groups them. They are
// kept in this browser and can be edited (Journal box -> Edit tag lists).

import { cleanTag } from "./tradenotes.js";

export const STORAGE_KEY = "forexreplay.tagsets";

export const GROUPS = Object.freeze([
  { id: "setup", label: "Setup", single: false },
  { id: "grade", label: "Grade", single: true }, // one grade per trade: picking one replaces another
  { id: "mistake", label: "Mistake", single: false },
  { id: "context", label: "Context", single: false },
]);

export const DEFAULT_TAGSETS = Object.freeze({
  setup: ["OB retest", "FVG fill", "Liquidity sweep", "BOS retest", "Breakout"],
  grade: ["A+", "A", "B", "C"],
  mistake: ["early entry", "late entry", "moved stop", "early exit", "FOMO", "broke rules", "revenge"],
  context: ["followed plan", "news", "A+ setup"],
});

/** The lists as kept: each tag cleaned, no repeats across groups (the first group wins), at most 30 a group. */
export function cleanTagSets(raw) {
  const out = {};
  const seen = new Set();
  for (const g of GROUPS) {
    const list = raw && Array.isArray(raw[g.id]) ? raw[g.id] : DEFAULT_TAGSETS[g.id];
    out[g.id] = [];
    for (const t of list) {
      const tag = cleanTag(t);
      if (tag && !seen.has(tag.toLowerCase()) && out[g.id].length < 30) { seen.add(tag.toLowerCase()); out[g.id].push(tag); }
    }
  }
  return out;
}

export function loadTagSets() {
  try { return cleanTagSets(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); } catch { return cleanTagSets(null); }
}

export function saveTagSets(sets) {
  const clean = cleanTagSets(sets);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch { /* private mode: not kept */ }
  return clean;
}

/** The group id a tag belongs to, or "" when it is in no list. */
export function groupOf(tag, sets) {
  const lower = String(tag).toLowerCase();
  for (const g of GROUPS) if (sets[g.id].some((t) => t.toLowerCase() === lower)) return g.id;
  return "";
}

/** A typed tag spelt as one already known (in the lists or `used`), ignoring case and spaces; else cleaned as typed. */
export function canonicalTag(text, sets, used = []) {
  const tag = cleanTag(text);
  if (!tag) return null;
  const key = (t) => t.toLowerCase().replace(/[\s-]+/g, "");
  const known = [...GROUPS.flatMap((g) => sets[g.id]), ...used].find((t) => key(t) === key(tag));
  return known || tag;
}

/** "Edit tag lists" text: one line per group, tags separated by commas. */
export const setsToText = (sets) => Object.fromEntries(GROUPS.map((g) => [g.id, sets[g.id].join(", ")]));
export const textToList = (text) => String(text || "").split(",").map((t) => t.trim()).filter(Boolean);

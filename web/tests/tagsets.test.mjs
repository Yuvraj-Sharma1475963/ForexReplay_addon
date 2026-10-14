// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalTag, cleanTagSets, DEFAULT_TAGSETS, groupOf, setsToText, textToList } from "../js/tagsets.js";

test("the lists are cleaned: no repeats across groups, no odd characters, defaults where missing", () => {
  const sets = cleanTagSets({ setup: ["OB retest", "  FVG   fill ", "ob retest", "<b>x</b>"], grade: ["A+", "OB retest", "B"] });
  assert.deepEqual(sets.setup, ["OB retest", "FVG fill", "bx/b"]); // < and > go; / is allowed in tags
  assert.deepEqual(sets.grade, ["A+", "B"]); // "OB retest" is already a setup
  assert.deepEqual(sets.mistake, DEFAULT_TAGSETS.mistake);
  assert.deepEqual(cleanTagSets(null).grade, ["A+", "A", "B", "C"]);
});

test("a typed tag takes the spelling already known, and tags are grouped", () => {
  const sets = cleanTagSets(null);
  assert.equal(canonicalTag("ob retest", sets), "OB retest");
  assert.equal(canonicalTag("OB-Retest", sets), "OB retest");
  assert.equal(canonicalTag("fomo", sets), "FOMO");
  assert.equal(canonicalTag("my idea", sets, ["My Idea"]), "My Idea");
  assert.equal(canonicalTag("brand new", sets), "brand new");
  assert.equal(canonicalTag("   ", sets), null);
  assert.equal(groupOf("a+", sets), "grade");
  assert.equal(groupOf("moved stop", sets), "mistake");
  assert.equal(groupOf("anything", sets), "");
});

test("editing the lists as comma-separated text", () => {
  assert.deepEqual(textToList(" a, b ,, c "), ["a", "b", "c"]);
  assert.equal(setsToText(cleanTagSets(null)).grade, "A+, A, B, C");
});

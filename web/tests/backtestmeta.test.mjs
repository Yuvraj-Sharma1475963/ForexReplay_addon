// Run with:  node --test web/tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { autoName, cleanMeta, gaps, joinSpans, overlaps, testedAt } from "../js/backtestmeta.js";

const D = 86400;

test("details are cleaned: trimmed text, a known status, archived only when true", () => {
  assert.deepEqual(cleanMeta({ strategy: "  OB   Retest ", strategyVersion: " v2 ", status: "weird", notes: "  n ", archived: "yes" }),
    { strategy: "OB Retest", strategyVersion: "v2", status: "testing", notes: "n", archived: false });
  assert.equal(cleanMeta({ status: "done" }).status, "done");
  assert.equal(autoName({ strategy: "" }), "");
  assert.ok(autoName({ strategy: "OB Retest", strategyVersion: "v2", startTime: 1772701200, furthestTime: 1772701200 + 9 * D, timeframe: "M15" })
    .startsWith("OB Retest v2 · "));
});

test("spans join where they touch, overlap only where two or more cover the same time", () => {
  assert.deepEqual(joinSpans([[5, 8], [0, 2], [2, 4], [7, 10]]), [[0, 4], [5, 10]]);
  assert.deepEqual(overlaps([[0, 10], [5, 15], [20, 30], [30, 40]]), [[5, 10]]); // 30 only touches
  assert.deepEqual(overlaps([[0, 10], [2, 4], [3, 8]]), [[2, 8]]);
  assert.deepEqual(overlaps([[0, 10]]), []);
});

test("gaps of at least a week between and around what was tested", () => {
  const first = 0, last = 100 * D;
  assert.deepEqual(gaps([[10 * D, 20 * D], [23 * D, 50 * D]], first, last, 7), [[0, 10 * D], [50 * D, 100 * D]]); // the 3-day gap is too short
  assert.deepEqual(gaps([], first, last, 7), [[0, 100 * D]]);
  assert.deepEqual(gaps([[0, 100 * D]], first, last, 7), []);
});

test("was this strategy already tested on this date? (discarded runs and the run itself do not count)", () => {
  const list = [
    { id: "a", strategy: "OB", status: "done", startTime: 10 * D, furthestTime: 20 * D },
    { id: "b", strategy: "OB", status: "discarded", startTime: 10 * D, furthestTime: 20 * D },
    { id: "c", strategy: "FVG", status: "done", startTime: 10 * D, furthestTime: 20 * D },
    { id: "d", strategy: "OB", status: "testing", startTime: 15 * D, furthestTime: 30 * D },
  ];
  assert.deepEqual(testedAt(list, "OB", 16 * D).map((b) => b.id), ["a", "d"]);
  assert.deepEqual(testedAt(list, "OB", 16 * D, "d").map((b) => b.id), ["a"]);
  assert.deepEqual(testedAt(list, "OB", 40 * D), []);
  assert.deepEqual(testedAt(list, "", 16 * D), []);
});

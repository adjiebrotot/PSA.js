// SPDX-License-Identifier: MIT
/** Helpers for parity tests against PyPSA reference fixtures. */

import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = path.join(ROOT, "test", "fixtures");
export const EXAMPLES = path.join(ROOT, "examples", "networks");

export function examplePath(name) {
  return path.join(EXAMPLES, name, name);
}

export function loadFixture(name) {
  const p = path.join(FIXTURES, `${name}.json.gz`);
  if (!existsSync(p)) throw new Error(`Fixture ${name} missing; run scripts/parity/generate_all.sh`);
  return JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"));
}

export function decode(v) {
  if (v === null) return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  return v;
}

function labelKey(v) {
  return JSON.stringify(v);
}

function fmtLabel(v) {
  return Array.isArray(v) ? v.join("|") : String(v);
}

export function isClose(a, b, rtol, atol) {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= atol + rtol * Math.abs(b);
}

/** Normalise a JS value for comparison (numbers stay numbers). */
function jsVal(v) {
  if (v === null || v === undefined) return NaN;
  return v;
}

/**
 * Compare a PSA.js DataFrame with a fixture frame.
 * @param {import("../src/core/frame.js").DataFrame} actual
 * @param {object} expected fixture frame {index, columns, data}
 */
export function assertFrameClose(actual, expected, { rtol = 1e-9, atol = 1e-9, path: where = "frame", columnOrder = true, ignoreIndexOrder = false } = {}) {
  const expIndex = expected.index.values;
  const actIndex = actual.index.values;
  if (!ignoreIndexOrder) {
    assert.deepEqual(actIndex.map(fmtLabel), expIndex.map(fmtLabel), `${where}: index differs`);
  } else {
    assert.deepEqual([...actIndex.map(fmtLabel)].sort(), [...expIndex.map(fmtLabel)].sort(), `${where}: index set differs`);
  }
  const expCols = expected.columns.map(fmtLabel);
  const actCols = actual.columns.values.map(fmtLabel);
  if (columnOrder) assert.deepEqual(actCols, expCols, `${where}: columns differ`);
  else assert.deepEqual([...actCols].sort(), [...expCols].sort(), `${where}: column set differs`);
  const rowPos = ignoreIndexOrder ? expIndex.map((l) => actIndex.findIndex((a) => fmtLabel(a) === fmtLabel(l))) : expIndex.map((_, i) => i);
  for (const c of expected.columns) {
    const key = fmtLabel(c);
    const exp = expected.data[key].map(decode);
    const act = actual.col(c);
    for (let i = 0; i < exp.length; i++) {
      const a = jsVal(act[rowPos[i]]);
      const b = exp[i];
      if (!isClose(a, b, rtol, atol)) {
        assert.fail(`${where}: mismatch at [${fmtLabel(expIndex[i])}, ${key}]: PSA.js=${a} PyPSA=${b}`);
      }
    }
  }
}

/** Compare a Series or plain {label: value} object with a fixture series. */
export function assertSeriesClose(actual, expected, { rtol = 1e-9, atol = 1e-9, path: where = "series", ignoreOrder = false } = {}) {
  const expIdx = expected.index.values.map(fmtLabel);
  const actIdx = actual.index.values.map(fmtLabel);
  if (ignoreOrder) assert.deepEqual([...actIdx].sort(), [...expIdx].sort(), `${where}: index set differs`);
  else assert.deepEqual(actIdx, expIdx, `${where}: index differs`);
  const pos = new Map(actIdx.map((k, i) => [k, i]));
  expected.values.forEach((v, i) => {
    const a = jsVal(actual.values[pos.get(expIdx[i])]);
    const b = decode(v);
    if (!isClose(a, b, rtol, atol)) assert.fail(`${where}: mismatch at ${expIdx[i]}: PSA.js=${a} PyPSA=${b}`);
  });
}

/** Compare a full network dump. */
export function assertNetworkMatches(n, expected, opts = {}) {
  const pre = opts.path ? `${opts.path}: ` : "";
  assert.equal(n.name, expected.name);
  assert.deepEqual(n.snapshots.values.map(fmtLabel), expected.snapshots.values.map(fmtLabel), `${pre}snapshots differ`);
  assertFrameClose(n.snapshot_weightings, expected.snapshot_weightings, { ...opts, path: `${pre}snapshot_weightings` });
  for (const [listName, comp] of Object.entries(expected.components)) {
    const c = n.c.get(listName);
    const st = c.static.has("obj") ? c.static.dropCols(["obj"]) : c.static;
    const sOverride = opts.path_tolerance?.[`${listName}.static`] ?? {};
    assertFrameClose(st, comp.static, { ...opts, ...sOverride, path: `${pre}${listName}.static` });
    if (comp.dynamic) {
      for (const [attr, df] of Object.entries(comp.dynamic)) {
        assert.ok(attr in c.dynamic, `${pre}${listName}.dynamic missing ${attr}`);
        const override = opts.path_tolerance?.[`${listName}.dynamic.${attr}`] ?? {};
        assertFrameClose(c.dynamic[attr], df, { ...opts, ...override, path: `${pre}${listName}.dynamic.${attr}` });
      }
    }
  }
}

export { fmtLabel, labelKey };

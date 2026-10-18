// SPDX-License-Identifier: MIT
/** Frame helpers for the `(scenario, name)` layout of stochastic networks. */

import { DataFrame, isNumberArray } from "../core/frame.js";
import { Index, labelKey } from "../core/index.js";

function concatArrays(arrays) {
  if (arrays.length && arrays.every(isNumberArray)) {
    const out = new Float64Array(arrays.reduce((a, x) => a + x.length, 0));
    let off = 0;
    for (const a of arrays) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }
  return arrays.flatMap((a) => Array.from(a));
}

/** `pd.concat(dict.fromkeys(scenarios, df), names=["scenario"])` (rows). */
export function broadcastStatic(df, scenarios) {
  const sc = scenarios.values;
  const tuples = [];
  for (const s of sc) for (const nm of df.index.values) tuples.push([s, nm]);
  const data = new Map();
  for (const c of df.columns) data.set(c, concatArrays(sc.map(() => df.col(c))));
  return new DataFrame({ index: new Index(tuples, ["scenario", "name"]), columns: df.columns, data, dtypes: df.dtypes });
}

/** `pd.concat(dict.fromkeys(scenarios, df), names=["scenario"], axis=1)` (columns). */
export function broadcastDynamic(df, scenarios) {
  const cols = [];
  const data = new Map();
  for (const s of scenarios.values) {
    for (const nm of df.columns.values) {
      const t = [s, nm];
      cols.push(t);
      data.set(t, df.col(nm).slice());
    }
  }
  return new DataFrame({ index: df.index, columns: new Index(cols, ["scenario", "name"]), data });
}

/** `df.xs(scenario, level="scenario", axis=0)` for `(scenario, name)` rows. */
export function xsStatic(df, scenario) {
  const pos = df.index.locLevel("scenario", scenario);
  const out = df.takeRows(pos);
  out.index = new Index(
    pos.map((i) => df.index.at(i)[1]),
    "name",
  );
  return out;
}

/** `df.xs(scenario, level="scenario", axis=1)` for `(scenario, name)` columns. */
export function xsDynamic(df, scenario) {
  const k = labelKey(scenario);
  const cols = df.columns.values.filter((t) => labelKey(t[0]) === k);
  const data = new Map(cols.map((t) => [t[1], df.col(t)]));
  return new DataFrame({ index: df.index, columns: new Index(cols.map((t) => t[1]), "name"), data });
}

// ----------------------------------------------------------------------
// pandas' level order of the `name` level
// ----------------------------------------------------------------------
//
// xarray's `unstack` of the `(scenario, name)` columns yields the `name`
// coordinate in the order of the MultiIndex level; when `c.da` then reindexes
// it to the component order, the result's dims become (snapshot, scenario,
// name) instead of (scenario, name, snapshot). `set_scenarios` keeps the
// names in component order; adding components afterwards unions the levels
// like `MultiIndex.append` (`Index.union`: sorted unless equal or empty).

/** Unique `name` labels of a `(scenario, name)` index, in row order. */
export function uniqueNames(index) {
  const seen = new Set();
  const out = [];
  for (const t of index.values) {
    const nm = index.isMulti ? t[1] : t;
    if (!seen.has(nm)) {
      seen.add(nm);
      out.push(nm);
    }
  }
  return out;
}

/** `Index.union(other)` with `sort=None`. */
export function unionLevel(a, b) {
  if (!a.length) return b.slice();
  if (!b.length || (a.length === b.length && a.every((x, i) => x === b[i]))) return a.slice();
  return [...new Set([...a, ...b])].sort();
}

/**
 * Whether the operational data of a stochastic component is laid out
 * (snapshot, scenario, name) by `c.da` (its `name` level, without unused
 * names, is not in component order).
 */
export function isSnapshotMajor(c) {
  if (!c.static.index.isMulti || !c._nameLevel) return false;
  const names = uniqueNames(c.static.index);
  const present = new Set(names);
  const level = c._nameLevel.filter((nm) => present.has(nm));
  return level.length !== names.length || level.some((nm, i) => nm !== names[i]);
}

// SPDX-License-Identifier: MIT
/**
 * Piecewise breakpoint data (mirrors the piecewise parts of
 * `pypsa.constants`, `pypsa.components.components` and
 * `pypsa.network.io._import_piecewise_from_df`).
 *
 * Piecewise curves are stored per component and y attribute as a DataFrame
 * whose index is the breakpoint number (0..n-1, named "breakpoint") and whose
 * columns are `[name, attribute]` tuples, the attribute level holding the
 * x-axis attribute (e.g. "p_pu") and the y attribute (e.g. "marginal_cost").
 */

import definitions from "../data/definitions.js";
import { DataFrame } from "../core/frame.js";
import { Index, compareLabels, labelKey } from "../core/index.js";
import { logger } from "../logger.js";

const PIECEWISE_ROWS = definitions.piecewise ?? [];

const COL_NAMES = ["name", "attribute"];

/** Piecewise schema rows for a component type (empty if none). */
export function piecewiseAttrs(component) {
  return PIECEWISE_ROWS.filter((r) => r.component === component);
}

/** Piecewise schema row for a component type and y attribute (null if undefined). */
export function piecewiseSchema(component, y) {
  return PIECEWISE_ROWS.find((r) => r.component === component && r.y === y) ?? null;
}

/** Split a trailing port number off an attribute name ('efficiency2' -> ['efficiency', '2']). */
export function splitPort(attr) {
  const base = attr.replace(/[0-9]+$/, "");
  return [base, attr.slice(base.length)];
}

/** Empty piecewise frame with a "breakpoint" index and (name, attribute) columns. */
export function emptyPiecewiseFrame() {
  return new DataFrame({ index: new Index([], "breakpoint"), columns: new Index([], COL_NAMES) });
}

function pyList(values) {
  return `[${values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ")}]`;
}

const isNull = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

/**
 * Sort segment rows by x-coordinate and align ragged curves with trailing NaNs
 * (`_normalize_breakpoints`).
 *
 * Replicates pandas' `groupby(level="name").apply(...)`: groups are processed
 * in sorted name order and their row selections are concatenated with a
 * label-based column union, so the row order of the result follows the first
 * group (and any rows only later groups have are appended in their order).
 */
export function normalizeBreakpoints(df, schema, yAttr) {
  const xAttr = schema.x;
  const cols = df.columns.values;
  const nR = df.index.length;
  const groupNames = [...new Map(cols.map((t) => [labelKey(t[0]), t[0]])).values()].sort(compareLabels);
  const unionPos = [];
  const seen = new Set();
  for (const nm of groupNames) {
    const gcols = cols.filter((t) => labelKey(t[0]) === labelKey(nm)).map((t) => df.col(t));
    const filled = new Array(nR);
    for (let i = 0; i < nR; i++) filled[i] = gcols.some((a) => !isNull(a[i]));
    const gaps = [];
    let later = false;
    for (let i = nR - 1; i >= 0; i--) {
      if (!filled[i] && later) gaps.unshift(df.index.at(i));
      if (filled[i]) later = true;
    }
    if (gaps.length) {
      throw new Error(`ValueError: Piecewise '${yAttr}' segments for component '${nm}' contain non-trailing missing breakpoint rows: ${pyList(gaps)}.`);
    }
    const partial = [];
    for (let i = 0; i < nR; i++) if (filled[i] && gcols.some((a) => isNull(a[i]))) partial.push(df.index.at(i));
    if (partial.length) {
      throw new Error(`ValueError: Piecewise '${yAttr}' segments for component '${nm}' have incomplete breakpoint data at rows: ${pyList(partial)}.`);
    }
    if (!df.has([nm, xAttr])) throw new Error(`KeyError: ('${nm}', '${xAttr}')`);
    const x = df.col([nm, xAttr]);
    const kept = [];
    for (let i = 0; i < nR; i++) if (filled[i]) kept.push(i);
    // stable sort (mergesort)
    kept.sort((a, b) => x[a] - x[b]);
    for (const i of kept) {
      if (!seen.has(i)) {
        seen.add(i);
        unionPos.push(i);
      }
    }
  }
  const data = new Map();
  for (const t of cols) {
    const a = df.col(t);
    data.set(t, Float64Array.from(unionPos, (i) => (isNull(a[i]) ? NaN : Number(a[i]))));
  }
  return new DataFrame({
    index: new Index(unionPos.map((_, i) => i), "breakpoint"),
    columns: new Index(cols.slice(), COL_NAMES),
    data,
  });
}

/** Values of the `attr` attribute level as [names, arrays] (`df.xs(attr, level="attribute", axis=1)`). */
export function xsAttribute(df, attr) {
  const names = [];
  const arrays = [];
  for (const t of df.columns.values) {
    if (t[1] === attr) {
      names.push(t[0]);
      arrays.push(df.col(t));
    }
  }
  return [names, arrays];
}

/**
 * Import piecewise breakpoint data (`Network._import_piecewise_from_df`).
 *
 * @param {Network} n
 * @param {DataFrame} df frame with (name, attribute) tuple columns
 * @param {string} clsName component class name
 * @param {string} attr piecewise y attribute (with optional port suffix)
 * @param {object} [opts] { isExtendable: Map name -> bool | null, overwrite }
 */
export function importPiecewiseFromDf(n, df, clsName, attr, { isExtendable = null, overwrite = false } = {}) {
  const c = n.c.get(clsName);
  const pwAttr = c._piecewise_schema(attr);
  if (!pwAttr) {
    const valid = [...new Set(piecewiseAttrs(c.name).map((r) => r.y))];
    throw new Error(`ValueError: '${attr}' is not a recognised piecewise attribute for ${c.name}. Known piecewise attributes: ${pyList(valid)}.`);
  }
  const xAttr = pwAttr.x;
  if (!df.columns.isMulti || df.columns.nlevels !== 2) {
    throw new Error(
      "TypeError: Pass a MultiIndex-columned DataFrame to _import_piecewise_from_df with levels ['name', 'attribute']. Use network.add() for the user-facing interface.",
    );
  }
  df = new DataFrame({
    index: df.index.rename("breakpoint"),
    columns: new Index(df.columns.values, COL_NAMES),
    data: new Map(df.columns.values.map((t) => [t, df.col(t)])),
  });

  df = normalizeBreakpoints(df, pwAttr, pwAttr.y);
  const newNames = df.columns.uniqueLevel("name");
  if (!pwAttr.allow_extendable) {
    const extendable = isExtendable !== null ? new Index([...isExtendable].filter(([, v]) => v).map(([k]) => k)) : c.extendables;
    const bad = newNames.intersection(extendable);
    if (!bad.empty) {
      throw new Error(
        `ValueError: Piecewise '${attr}' breakpoints are not supported for extendable components (fixed p_nom required). Extendable components: ${pyList(bad.values)}.`,
      );
    }
  }
  if (pwAttr.y === "rate" || pwAttr.y === "efficiency") {
    const [names, arrays] = xsAttribute(df, attr);
    const bad = names.filter((_, j) => {
      const a = arrays[j];
      const pos = Array.from(a).every((v) => v >= 0 || Number.isNaN(v));
      const neg = Array.from(a).every((v) => v <= 0 || Number.isNaN(v));
      return !(pos || neg);
    });
    if (bad.length) throw new Error(`NotImplementedError: Cannot mix positive and negative values for piecewise ${attr} curves of ${c.name} components ${pyList(bad)}`);
  }

  if (df.index.length === 0) throw new Error("KeyError: 0");
  const [xNames, xArrays] = xsAttribute(df, xAttr);
  const badStart = xNames.filter((_, j) => xArrays[j][0] > 0);
  if (badStart.length) {
    const equivalents = { p_pu: "p_min_pu", p_nom: "p_nom_min" };
    throw new Error(
      `ValueError: Piecewise '${attr}' curves must start at ${xAttr}=0. Otherwise, you implicitly bound ${xAttr} from below (equivalent to setting ${equivalents[xAttr] ?? "None"}). Even if you are explicitly bounding from below, you should still set a breakpoint at (0, 0).Affected components: ${pyList(badStart)}.`,
    );
  }
  if (xAttr.endsWith("_pu")) {
    const last = df.index.length - 1;
    let prev = NaN;
    const badEnd = [];
    xNames.forEach((nm, j) => {
      let v = xArrays[j][last];
      if (Number.isNaN(v)) v = prev;
      prev = v;
      if (v < 1) badEnd.push(nm);
    });
    if (badEnd.length) {
      throw new Error(
        `ValueError: Piecewise '${attr}' curves must end at ${xAttr}=1. Otherwise, you implicitly bound ${xAttr} from above (equivalent to setting ${xAttr === "p_pu" ? "p_max_pu" : "None"}). Even if you are explicitly bounding from above, you should still set a breakpoint at (1, <y-value>).Affected components: ${pyList(badEnd)}.`,
      );
    }
  }
  const [yNames, yArrays] = xsAttribute(df, attr);
  const badY = yNames.filter((_, j) => yArrays[j][0] > 0);
  if (badY.length) {
    const preamble = attr.includes("cost")
      ? `Piecewise '${attr}' values price the increment from the previous breakpoint, so the y-value at x=0 spans zero width and will be ignored. To set the y-value for the first segment, set the value on the second breakpoint instead, e.g. {0.0: 0.0, 0.5: 40.0} for a '${attr}' of 40 up to 0.5 '${xAttr}'.`
      : `A non-zero y value at x=0 for piecewise '${attr}' will be ignored when the piecewise constraint is defined since y values are denormalised using x values. To approximate '${attr}' as non-zero at '${xAttr}'=0, consider setting it at a very small x value instead, e.g. {0.0: 0.0, 0.001: 10, 0.5: 40.0}.`;
    logger.warning(`${preamble} Affected components: ${pyList(badY)}.`);
  }

  if (!(attr in c.piecewise)) c.piecewise[attr] = emptyPiecewiseFrame();
  let existing = c.piecewise[attr];

  const attrValues = df.columns.uniqueLevel("attribute");
  const expected = new Set([xAttr, attr]);
  if (attrValues.length !== expected.size || attrValues.values.some((v) => !expected.has(v))) {
    throw new Error(
      `ValueError: DataFrame for piecewise attribute '${attr}' must have attribute level values ['${xAttr}', '${attr}']. Got: ${pyList(attrValues.values.slice().sort())}.`,
    );
  }

  if (overwrite) {
    const keys = new Set(newNames.values.map(labelKey));
    const keep = existing.columns.values.filter((t) => !keys.has(labelKey(t[0])));
    existing = existing.loc(null, new Index(keep, COL_NAMES));
  }

  const all = existing.index.union(df.index);
  const allIdx = new Index(all.values, "breakpoint");
  const a = existing.reindex({ index: allIdx });
  const b = df.reindex({ index: allIdx });
  const data = new Map();
  const cols = [];
  for (const f of [a, b]) {
    for (const t of f.columns.values) {
      cols.push(t);
      data.set(t, f.col(t));
    }
  }
  c.piecewise[attr] = new DataFrame({ index: allIdx, columns: new Index(cols, COL_NAMES), data });
}

/**
 * Convert an `n.add` keyword value for a piecewise attribute into a
 * (name, attribute) frame, or return null when it is not piecewise data.
 * Accepts a Map {x: y} (Python dict shorthand), a DataFrame with columns
 * [x_attr, attr] (broadcast to all names) or a DataFrame with
 * (name, attribute) tuple columns.
 */
export function piecewiseFromAddValue(v, k, xAttr, names, addSuffix) {
  if (v instanceof Map) {
    const xs = [...v.keys()].map(Number);
    const ys = [...v.values()].map(Number);
    v = new DataFrame({ index: new Index(xs.map((_, i) => i)), columns: [xAttr, k], data: new Map([[xAttr, Float64Array.from(xs)], [k, Float64Array.from(ys)]]) });
  }
  if (!(v instanceof DataFrame)) return null;
  if (v.columns.isMulti) {
    const cols = v.columns.values.map((t) => [addSuffix(t[0]), t[1]]);
    const nameKeys = new Set(names.values.map(labelKey));
    const diffNames = [...new Set(cols.map((t) => t[0]))].filter((nm) => !nameKeys.has(labelKey(nm)));
    if (diffNames.length) throw new Error(`ValueError: Piecewise ${k} Dataframe has name column level which does not align with the passed names: ${pyList(diffNames)}.`);
    const attrs = new Set(cols.map((t) => t[1]));
    const diffAttrs = [...attrs].filter((x) => x !== xAttr && x !== k).concat([xAttr, k].filter((x) => !attrs.has(x)));
    if (diffAttrs.length) throw new Error(`ValueError: Piecewise ${k} Dataframe has attribute column level which does not align with the passed attributes: ${pyList(diffAttrs)}.`);
    // `reindex(columns=[x_attr, k], level=1)` (pandas `_get_leaf_sorter`): keep
    // contiguous runs of equal names in place, order x before y within a run
    const order = [];
    for (let j = 0; j < cols.length; ) {
      let e = j + 1;
      while (e < cols.length && labelKey(cols[e][0]) === labelKey(cols[j][0])) e++;
      const run = [];
      for (let i = j; i < e; i++) run.push(i);
      run.sort((a, b) => (cols[a][1] === xAttr ? 0 : 1) - (cols[b][1] === xAttr ? 0 : 1));
      order.push(...run);
      j = e;
    }
    const outCols = [];
    const data = new Map();
    for (const j of order) {
      outCols.push(cols[j]);
      data.set(cols[j], Float64Array.from(v.col(v.columns.values[j]), Number));
    }
    return new DataFrame({ index: v.index, columns: new Index(outCols, COL_NAMES), data });
  }
  const colSet = new Set(v.columns.values);
  if (colSet.size === 2 && colSet.has(xAttr) && colSet.has(k)) {
    const outCols = [];
    const data = new Map();
    for (const nm of names.values) {
      for (const a of [xAttr, k]) {
        const t = [nm, a];
        outCols.push(t);
        data.set(t, Float64Array.from(v.col(a), Number));
      }
    }
    return new DataFrame({ index: v.index.rename("breakpoint"), columns: new Index(outCols, COL_NAMES), data });
  }
  return null;
}

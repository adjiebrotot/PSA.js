// SPDX-License-Identifier: MIT
/**
 * Small row-major table used by the statistics module to mimic the pandas
 * operations PyPSA relies on (groupby with sorted keys, concat, round,
 * drop_zero). A table with `cols === null` behaves like a Series.
 */

import { Index, compareLabels, labelKey } from "../core/index.js";
import { DataFrame, Series } from "../core/frame.js";

export class KeyError extends Error {
  constructor(msg) {
    super(`KeyError: ${msg}`);
    this.name = "KeyError";
  }
}

export function isKeyError(e) {
  return e instanceof KeyError || (e instanceof Error && /^KeyError/.test(e.message));
}

export class Tab {
  /**
   * @param {Index} index row labels
   * @param {Index|null} cols column labels (null for a Series)
   * @param {Float64Array[]} rows one array per row
   */
  constructor(index, cols, rows) {
    this.index = index;
    this.cols = cols;
    this.rows = rows;
  }

  static series(index, values) {
    const idx = index instanceof Index ? index : new Index(index);
    return new Tab(
      idx,
      null,
      Array.from(values, (v) => Float64Array.of(v)),
    );
  }

  static empty(names = "name") {
    return new Tab(new Index([], names), null, []);
  }

  get isSeries() {
    return this.cols === null;
  }

  get length() {
    return this.rows.length;
  }

  get empty() {
    return this.rows.length === 0 || (this.cols !== null && this.cols.length === 0);
  }

  get width() {
    return this.cols === null ? 1 : this.cols.length;
  }

  /** Rows for the given labels (in that order); missing labels give NaN rows. */
  loc(labels) {
    const vals = labels instanceof Index ? labels.values : labels;
    const rows = vals.map((l) => {
      const i = this.index.getLoc(l);
      return i < 0 ? new Float64Array(this.width).fill(NaN) : this.rows[i];
    });
    return new Tab(new Index(vals, this.index.names.length > 1 ? this.index.names : this.index.name), this.cols, rows);
  }

  /** Keep rows where mask is true. */
  filter(mask) {
    const keep = [];
    mask.forEach((m, i) => m && keep.push(i));
    return new Tab(
      this.index.take(keep),
      this.cols,
      keep.map((i) => this.rows[i]),
    );
  }

  map(fn) {
    return new Tab(
      this.index,
      this.cols,
      this.rows.map((r) => r.map(fn)),
    );
  }

  renameIndex(name) {
    return new Tab(this.index.rename(name), this.cols, this.rows);
  }

  /** Element-wise combination with another table aligned on the index (outer join, sorted when different). */
  combine(other, fn, fill = NaN) {
    let index = this.index;
    if (!this.index.equals(other.index)) index = this.index.union(other.index);
    const a = this.loc(index);
    const b = other.loc(index);
    const rows = a.rows.map((r, i) =>
      r.map((x, j) => {
        const y = b.rows[i][j];
        // pandas fill_value: fill a missing side, both missing stays missing
        if (Number.isNaN(x) && Number.isNaN(y)) return NaN;
        return fn(Number.isNaN(x) ? fill : x, Number.isNaN(y) ? fill : y);
      }),
    );
    return new Tab(index, this.cols, rows);
  }

  toPandas(name = null) {
    if (this.cols === null) return new Series(Float64Array.from(this.rows, (r) => r[0]), this.index, name);
    const df = new DataFrame({ index: this.index });
    this.cols.values.forEach((c, j) => df.set(c, Float64Array.from(this.rows, (r) => r[j])));
    return df;
  }
}

/** Aggregation of an array of numbers like pandas (NaN skipped). */
export function aggregate(values, agg) {
  if (typeof agg === "function") return agg(values);
  const v = values.filter((x) => !Number.isNaN(x));
  switch (agg) {
    case "sum": {
      let s = 0;
      for (const x of v) s += x;
      return s;
    }
    case "mean": {
      if (!v.length) return NaN;
      let s = 0;
      for (const x of v) s += x;
      return s / v.length;
    }
    case "max":
      return v.length ? Math.max(...v) : NaN;
    case "min":
      return v.length ? Math.min(...v) : NaN;
    case "first":
      return v.length ? v[0] : NaN;
    case "last":
      return v.length ? v[v.length - 1] : NaN;
    case "count":
      return v.length;
    case "median": {
      if (!v.length) return NaN;
      const s = [...v].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    default:
      throw new Error(`Unsupported aggregation '${agg}'`);
  }
}

function isMissing(k) {
  return k === null || k === undefined || (typeof k === "number" && Number.isNaN(k));
}

/**
 * Group rows by key arrays (aligned with rows) like `groupby(keys, sort=True,
 * dropna=True).agg(agg)`.
 */
export function groupRows(tab, keys, names, agg) {
  const groups = new Map();
  const labels = [];
  const multi = keys.length > 1;
  for (let i = 0; i < tab.rows.length; i++) {
    const k = keys.map((arr) => arr[i]);
    if (k.some(isMissing)) continue;
    const label = multi ? k : k[0];
    const lk = labelKey(label);
    let g = groups.get(lk);
    if (!g) {
      g = [];
      groups.set(lk, g);
      labels.push(label);
    }
    g.push(i);
  }
  labels.sort(compareLabels);
  const w = tab.width;
  const rows = labels.map((l) => {
    const members = groups.get(labelKey(l));
    const out = new Float64Array(w);
    for (let j = 0; j < w; j++) out[j] = aggregate(members.map((i) => tab.rows[i][j]), agg);
    return out;
  });
  return new Tab(new Index(labels, multi ? names : names[0]), tab.cols, rows);
}

/** Group by all index levels (used for non-unique indexes). */
export function groupByLevels(tab, agg) {
  const names = tab.index.names;
  const nl = tab.index.isMulti ? tab.index.nlevels : 1;
  const keys = [];
  for (let l = 0; l < nl; l++) keys.push(tab.index.values.map((v) => (nl > 1 ? v[l] : v)));
  return groupRows(tab, keys, names.length ? names : [tab.index.name], agg);
}

/** Concatenate tables row-wise (pd.concat). */
export function concatRows(tabs, keys = null, names = null) {
  if (!tabs.length) return Tab.empty();
  let cols = tabs[0].cols;
  for (const t of tabs.slice(1)) {
    if (cols === null || t.cols === null) continue;
    if (!cols.equals(t.cols)) {
      const extra = t.cols.values.filter((c) => !cols.has(c));
      cols = new Index([...cols.values, ...extra], cols.names.length > 1 ? cols.names : cols.name);
    }
  }
  const labels = [];
  const rows = [];
  tabs.forEach((t, k) => {
    const pos = cols === null || t.cols === null ? null : cols.values.map((c) => t.cols.getLoc(c));
    t.index.values.forEach((l, i) => {
      const lab = keys ? [keys[k], ...(t.index.isMulti ? l : [l])] : l;
      labels.push(lab);
      rows.push(pos ? Float64Array.from(pos, (p) => (p < 0 ? NaN : t.rows[i][p])) : t.rows[i]);
    });
  });
  const idxNames = names ?? (tabs[0].index.isMulti ? tabs[0].index.names : tabs[0].index.name);
  return new Tab(new Index(labels, idxNames), cols, rows);
}

/** numpy's round half to even. */
export function rint(x) {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** `np.round(x, decimals)` (rint(x * 10**d) / 10**d). */
export function roundTo(x, decimals) {
  if (decimals >= 0) {
    const f = 10 ** decimals;
    return rint(x * f) / f;
  }
  const f = 10 ** -decimals;
  return rint(x / f) * f;
}

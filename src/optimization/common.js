// SPDX-License-Identifier: MIT
/** Helpers shared by the optimisation modules. */

import { Index } from "../core/index.js";
import { NOMINAL_ATTRS } from "../components/components.js";

export { NOMINAL_ATTRS };

/** Rows of PyPSA's `data/variables.csv` lookup table. */
export const LOOKUP = [
  // component, variable, marginal_cost, marginal_cost_quadratic, spill_cost, marginal_cost_storage, nominal, handle_separately
  ["Generator", "p", true, true, false, false, false, false],
  ["Generator", "status", false, false, false, false, false, true],
  ["Generator", "start_up", false, false, false, false, false, true],
  ["Generator", "shut_down", false, false, false, false, false, true],
  ["Generator", "p_nom", false, false, false, false, true, false],
  ["Generator", "n_mod", false, false, false, false, false, true],
  ["Line", "s", false, false, false, false, false, false],
  ["Line", "s_nom", false, false, false, false, true, false],
  ["Line", "n_mod", false, false, false, false, false, true],
  ["Transformer", "s", false, false, false, false, false, false],
  ["Transformer", "s_nom", false, false, false, false, true, false],
  ["Transformer", "n_mod", false, false, false, false, false, true],
  ["Link", "p", true, true, false, false, false, false],
  ["Link", "status", false, false, false, false, false, true],
  ["Link", "start_up", false, false, false, false, false, true],
  ["Link", "shut_down", false, false, false, false, false, true],
  ["Link", "p_nom", false, false, false, false, true, false],
  ["Link", "n_mod", false, false, false, false, false, true],
  ["Process", "p", true, true, false, false, false, false],
  ["Process", "status", false, false, false, false, false, true],
  ["Process", "start_up", false, false, false, false, false, true],
  ["Process", "shut_down", false, false, false, false, false, true],
  ["Process", "p_nom", false, false, false, false, true, false],
  ["Process", "n_mod", false, false, false, false, false, true],
  ["Store", "e", false, false, false, true, false, false],
  ["Store", "p", true, true, false, false, false, true],
  ["Store", "e_nom", false, false, false, false, true, false],
  ["Store", "n_mod", false, false, false, false, false, true],
  ["StorageUnit", "p_dispatch", true, true, false, false, false, false],
  ["StorageUnit", "p_store", false, false, false, false, false, false],
  ["StorageUnit", "state_of_charge", false, false, false, true, false, false],
  ["StorageUnit", "p_nom", false, false, false, false, true, false],
  ["StorageUnit", "n_mod", false, false, false, false, false, true],
  ["StorageUnit", "spill", false, false, true, false, false, true],
].map(([component, variable, marginal_cost, marginal_cost_quadratic, spill_cost, marginal_cost_storage, nominal, handle_separately]) => ({
  component,
  variable,
  marginal_cost,
  marginal_cost_quadratic,
  spill_cost,
  marginal_cost_storage,
  nominal,
  handle_separately,
}));

export function lookupQuery(pred) {
  return LOOKUP.filter(pred).map((r) => [r.component, r.variable]);
}

/** Dense values (Float64Array, snapshot-major) of an attribute for names over sns. */
export function denseValues(c, attr, sns, names) {
  const nS = sns.length;
  const nN = names.length;
  const out = new Float64Array(nS * nN);
  const st = c.static;
  const staticCol = st.colOr(attr, null);
  const dyn = c.dynamic[attr] ?? null;
  const rowPos = dyn ? dyn.index.getIndexer(sns) : null;
  for (let j = 0; j < nN; j++) {
    const nm = names.at(j);
    if (dyn && dyn.has(nm)) {
      const a = dyn.col(nm);
      for (let s = 0; s < nS; s++) out[s * nN + j] = rowPos[s] < 0 ? NaN : a[rowPos[s]];
    } else {
      const i = st.index.getLoc(nm);
      let v = staticCol && i >= 0 ? staticCol[i] : NaN;
      if (typeof v === "boolean") v = v ? 1 : 0;
      else if (typeof v !== "number") v = NaN;
      for (let s = 0; s < nS; s++) out[s * nN + j] = v;
    }
  }
  return out;
}

/** Static values for names (plain array). */
export function staticValues(c, attr, names) {
  const st = c.static;
  const col = st.col(attr);
  return names.values.map((nm) => col[st.index.getLoc(nm)]);
}

/** Activity mask (Uint8Array, snapshot-major) for names over sns. */
export function activityMask(c, sns, names) {
  const nS = sns.length;
  const nN = names.length;
  const out = new Uint8Array(nS * nN);
  if (c.has_investment_periods) {
    const periods = c.n.investment_periods;
    const perPeriod = new Map();
    for (const p of periods) {
      const a = c.get_active_assets(p);
      perPeriod.set(p, names.values.map((nm) => a.get(nm)));
    }
    for (let s = 0; s < nS; s++) {
      const act = perPeriod.get(sns.at(s)[0]);
      for (let j = 0; j < nN; j++) out[s * nN + j] = act[j] ? 1 : 0;
    }
  } else {
    const a = c.get_active_assets();
    const act = names.values.map((nm) => a.get(nm));
    for (let s = 0; s < nS; s++) for (let j = 0; j < nN; j++) out[s * nN + j] = act[j] ? 1 : 0;
  }
  return out;
}

/** Snapshot weightings column for sns as Float64Array. */
export function weightings(n, column, sns) {
  const w = n.snapshot_weightings;
  const col = w.col(column);
  const pos = w.index.getIndexer(sns);
  return Float64Array.from(pos, (p) => col[p]);
}

/** Objective weighting incl. investment period weighting for multi-investment. */
export function objectiveWeighting(n, sns) {
  const w = weightings(n, "objective", sns);
  if (n._multi_invest) {
    const pw = n.investment_period_weightings;
    for (let s = 0; s < sns.length; s++) {
      const p = sns.at(s)[0];
      w[s] *= pw.at(p, "objective");
    }
  }
  return w;
}

/** Index of names where predicate over static row holds (static order). */
export function whereStatic(c, fn) {
  const st = c.static;
  return st.index.filter(st.index.values.map((_, i) => fn(i)));
}

/** Boolean: first snapshot of each investment period (or the first snapshot). */
export function periodStartMask(sns) {
  const out = new Array(sns.length).fill(false);
  if (sns.length) out[0] = true;
  if (sns.isMulti) for (let i = 1; i < sns.length; i++) out[i] = sns.at(i)[0] !== sns.at(i - 1)[0];
  return out;
}

export function emptyIndex(name = "name") {
  return new Index([], name);
}

/** Bus usage counts over all components (mirrors `get_bus_counts`). */
export function getBusCounts(n) {
  const counts = new Map();
  for (const c of n.components.values()) {
    for (const col of c.static.columns) {
      if (!/^bus(\d*)$/.test(col)) continue;
      for (const b of c.static.col(col)) {
        if (b === "") continue;
        counts.set(b, (counts.get(b) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export function isinf(x) {
  return x === Infinity || x === -Infinity;
}

/** numpy-like pairwise summation (matches `np.sum` for float64 arrays). */
export function npSum(arr) {
  const a = Float64Array.from(arr);
  const rec = (off, n) => {
    if (n < 8) {
      let res = 0;
      for (let i = 0; i < n; i++) res += a[off + i];
      return res;
    }
    if (n <= 128) {
      const r = [a[off], a[off + 1], a[off + 2], a[off + 3], a[off + 4], a[off + 5], a[off + 6], a[off + 7]];
      let i;
      for (i = 8; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[off + i + j];
      let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
      for (; i < n; i++) res += a[off + i];
      return res;
    }
    let n2 = Math.floor(n / 2);
    n2 -= n2 % 8;
    return rec(off, n2) + rec(off + n2, n - n2);
  };
  return rec(0, a.length);
}

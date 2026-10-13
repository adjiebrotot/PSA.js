// SPDX-License-Identifier: MIT
/**
 * Constraint definitions (mirrors `pypsa.optimization.constraints`).
 *
 * Each function builds rows in linopy's order: C order over the constraint
 * dimensions, terms in the `_term` order produced by the corresponding
 * xarray/linopy expression, and rhs computed as `-(lhs_const - rhs)`.
 */

import { Index } from "../core/index.js";
import { getDelaySourceIndexer } from "../components/components.js";
import { NOMINAL_ATTRS, activityMask, denseValues, staticValues, weightings, periodStartMask, isinf } from "./common.js";
import { labeler1, labeler2 } from "./variables.js";
import { logger } from "../logger.js";
import { pyPow } from "../core/pymath.js";

const r = (lc, rc) => -(lc - rc);

/** Minimal scalar linear expression used to mirror linopy arithmetic per row. */
function E(vars, coeffs, c = 0) {
  return { vars, coeffs, const: c };
}
function add(a, b) {
  return E([...a.vars, ...b.vars], [...a.coeffs, ...b.coeffs], a.const + b.const);
}
function scale(a, k) {
  return E(a.vars.slice(), a.coeffs.map((x) => x * k), a.const * k);
}
function sub(a, b) {
  return add(a, scale(b, -1));
}

function boundsPu(c, attr, sns, names) {
  const name = c.name;
  const nS = sns.length;
  const nN = names.length;
  if (name === "Line" || name === "Transformer") {
    const max = denseValues(c, "s_max_pu", sns, names);
    return [max.map((v) => -v), max];
  }
  if (name === "StorageUnit") {
    if (attr === "p_store") {
      const max = denseValues(c, "p_min_pu", sns, names).map((v) => -v);
      return [new Float64Array(nS * nN), max];
    }
    if (attr === "state_of_charge") {
      const mh = staticValues(c, "max_hours", names);
      const max = new Float64Array(nS * nN);
      for (let s = 0; s < nS; s++) for (let j = 0; j < nN; j++) max[s * nN + j] = mh[j];
      return [new Float64Array(nS * nN), max];
    }
    return [new Float64Array(nS * nN), denseValues(c, "p_max_pu", sns, names)];
  }
  if (name === "Store") return [denseValues(c, "e_min_pu", sns, names), denseValues(c, "e_max_pu", sns, names)];
  return [denseValues(c, "p_min_pu", sns, names), denseValues(c, "p_max_pu", sns, names)];
}

export { boundsPu };

// ----------------------------------------------------------------------
// operational constraints
// ----------------------------------------------------------------------

export function define_operational_constraints_for_non_extendables(n, sns, component, attr, transmissionLosses = false) {
  const c = n.c.get(component);
  const fixI = c.fixed.difference(c.committables).intersection(c.active_assets);
  if (fixI.empty) return;
  const m = n.model;
  const nom = staticValues(c, c._operational_attrs.nom, fixI);
  const [minPu, maxPu] = boundsPu(c, attr, sns, fixI);
  const act = activityMask(c, sns, fixI);
  const v = labeler2(m.variables.get(`${c.name}-${attr}`), sns, fixI);
  const withLoss = n.passive_branch_components.has(c.name) && transmissionLosses;
  const loss = withLoss ? labeler2(m.variables.get(`${c.name}-loss`), sns, fixI) : null;
  const nN = fixI.length;
  // maintenance reduces the available capacity by `maintenance_pu * maintenance`
  const maintFixI = c.maintainables.intersection(fixI);
  const maint = maintFixI.empty ? null : labeler2(m.variables.get(`${c.name}-maintenance`), sns, fixI);
  const isMaint = maintFixI.empty ? null : fixI.isin(maintFixI);
  const alpha = maintFixI.empty ? null : staticValues(c, "maintenance_pu", fixI);
  const lower = (s, j) => {
    const k = s * nN + j;
    const inf = isinf(nom[j]);
    return inf && minPu[k] === 0 ? 0 : minPu[k] * nom[j];
  };
  const upper = (s, j) => {
    const k = s * nN + j;
    const inf = isinf(nom[j]);
    return inf && maxPu[k] === 0 ? 0 : maxPu[k] * nom[j];
  };
  const dims = ["snapshot", "name"];
  const coords = [sns, fixI];
  const row = (s, j, bound, lossSign) => {
    const vars = withLoss ? [v(s, j), loss(s, j)] : [v(s, j)];
    const coeffs = withLoss ? [1, lossSign] : [1];
    if (maint) {
      vars.push(isMaint[j] ? maint(s, j) : -1);
      coeffs.push(isMaint[j] ? bound * alpha[j] : NaN);
    }
    return [vars, coeffs];
  };
  m.add_constraints(`${c.name}-fix-${attr}-lower`, dims, coords, (s, j) => {
    const [vars, coeffs] = row(s, j, lower(s, j), -1);
    return [vars, coeffs, ">=", r(0, lower(s, j)), act[s * nN + j]];
  });
  m.add_constraints(`${c.name}-fix-${attr}-upper`, dims, coords, (s, j) => {
    const [vars, coeffs] = row(s, j, upper(s, j), 1);
    return [vars, coeffs, "<=", r(0, upper(s, j)), act[s * nN + j]];
  });
}

export function define_operational_constraints_for_extendables(n, sns, component, attr, transmissionLosses = false) {
  const c = n.c.get(component);
  let extI = c.extendables.intersection(c.active_assets);
  const comExtI = c.committables.intersection(extI);
  extI = extI.difference(comExtI);
  if (extI.empty) return;
  const m = n.model;
  const [minPu, maxPu] = boundsPu(c, attr, sns, extI);
  const v = labeler2(m.variables.get(`${c.name}-${attr}`), sns, extI);
  const cap = labeler1(m.variables.get(`${c.name}-${NOMINAL_ATTRS[c.name]}`), extI);
  const act = activityMask(c, sns, extI);
  const withLoss = n.passive_branch_components.has(c.name) && transmissionLosses;
  const loss = withLoss ? labeler2(m.variables.get(`${c.name}-loss`), sns, extI) : null;
  const nN = extI.length;
  // maintenance of extendables enters through z = p_nom * maintenance
  const maintExtI = c.maintainables.intersection(extI);
  const z = maintExtI.empty ? null : labeler2(m.variables.get(`${c.name}-maintenance_capacity`), sns, extI);
  const isMaint = maintExtI.empty ? null : extI.isin(maintExtI);
  const alpha = maintExtI.empty ? null : staticValues(c, "maintenance_pu", extI);
  const dims = ["snapshot", "name"];
  const coords = [sns, extI];
  const row = (s, j, pu, lossSign) => {
    const vars = [v(s, j), cap(j)];
    const coeffs = [1, -(pu * 1)];
    if (withLoss) {
      vars.push(loss(s, j));
      coeffs.push(lossSign);
    }
    if (z) {
      vars.push(isMaint[j] ? z(s, j) : -1);
      coeffs.push(isMaint[j] ? pu * alpha[j] : NaN);
    }
    return [vars, coeffs];
  };
  m.add_constraints(`${c.name}-ext-${attr}-lower`, dims, coords, (s, j) => {
    const k = s * nN + j;
    const [vars, coeffs] = row(s, j, minPu[k], -1);
    return [vars, coeffs, ">=", r(0, 0), act[k]];
  });
  m.add_constraints(`${c.name}-ext-${attr}-upper`, dims, coords, (s, j) => {
    const k = s * nN + j;
    const [vars, coeffs] = row(s, j, maxPu[k], 1);
    return [vars, coeffs, "<=", r(0, 0), act[k]];
  });
}

/**
 * Maintenance scheduling (`define_maintenance_constraints`): event count,
 * window coverage of each event (snapshots whose weightings sum to at least
 * `maintenance_duration`), starts that cannot complete within the horizon,
 * and McCormick bounds for `z = p_nom * maintenance` of extendables.
 */
export function define_maintenance_constraints(n, sns, component) {
  const c = n.c.get(component);
  const maintI = c.maintainables.intersection(c.active_assets);
  if (maintI.empty) return;
  const m = n.model;
  const nS = sns.length;
  const nN = maintI.length;
  const w = weightings(n, "generators", sns);
  const maint = labeler2(m.variables.get(`${c.name}-maintenance`), sns, maintI);
  const start = labeler2(m.variables.get(`${c.name}-maintenance_start`), sns, maintI);
  const act = activityMask(c, sns, maintI);
  const duration = staticValues(c, "maintenance_duration", maintI);
  const events = staticValues(c, "maintenance_events", maintI);
  const dims = ["snapshot", "name"];

  m.add_constraints(`${c.name}-maint-event-count`, ["name"], [maintI], (j) => {
    const vars = [];
    for (let s = 0; s < nS; s++) vars.push(start(s, j));
    return [vars, vars.map(() => 1), "=", r(0, events[j])];
  });

  const cum = new Float64Array(nS);
  for (let s = 0, acc = 0; s < nS; s++) cum[s] = acc += w[s];
  const cumPrev = cum.map((x, s) => x - w[s]);
  const searchsorted = (arr, v) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const windowEnd = [];
  const valid = [];
  const width = [];
  for (let j = 0; j < nN; j++) {
    const ends = new Int32Array(nS);
    for (let s = 0; s < nS; s++) ends[s] = searchsorted(cum, duration[j] * (1 - 1e-6) + cumPrev[s]);
    const inactiveCum = new Int32Array(nS);
    for (let s = 0, acc = 0; s < nS; s++) inactiveCum[s] = acc += act[s * nN + j] ? 0 : 1;
    const ok = new Uint8Array(nS);
    for (let s = 0; s < nS; s++) {
      const a = act[s * nN + j];
      const windowInactive = inactiveCum[Math.min(ends[s], nS - 1)] - inactiveCum[s] + (a ? 0 : 1);
      ok[s] = a && ends[s] < nS && windowInactive === 0 ? 1 : 0;
    }
    const wd = new Int32Array(nS);
    const starts = new Int32Array(nS);
    let maxWidth = -Infinity;
    for (let s = 0; s < nS; s++) {
      starts[s] = searchsorted(ends, s);
      wd[s] = s - starts[s] + 1;
      maxWidth = Math.max(maxWidth, wd[s]);
    }
    for (let s = 0; s < nS; s++) if (!(starts[s] > 0)) wd[s] = maxWidth;
    windowEnd.push(ends);
    valid.push(ok);
    width.push(wd);
  }
  const widths = [...new Set(width.flatMap((wd) => [...wd]))].sort((a, b) => a - b);
  // -maintenance + sum over widths of rolling(start, width) * (width == w)
  m.add_constraints(`${c.name}-maint-window`, dims, [sns, maintI], (s, j) => {
    const vars = [maint(s, j)];
    const coeffs = [-1];
    for (const wv of widths) {
      const on = width[j][s] === wv ? 1 : 0;
      for (let t = s - wv + 1; t <= s; t++) {
        vars.push(t >= 0 ? start(t, j) : -1);
        coeffs.push(t >= 0 ? on : NaN);
      }
    }
    return [vars, coeffs, "=", r(0, 0), act[s * nN + j]];
  });
  const forbidden = (s, j) => act[s * nN + j] && !valid[j][s];
  let anyForbidden = false;
  for (let s = 0; s < nS && !anyForbidden; s++) for (let j = 0; j < nN; j++) if (forbidden(s, j)) anyForbidden = true;
  if (anyForbidden) {
    m.add_constraints(`${c.name}-maint-start-horizon`, dims, [sns, maintI], (s, j) => [[start(s, j)], [1], "=", r(0, 0), forbidden(s, j)]);
  }

  const extI = c.extendables.intersection(c.active_assets);
  const modularCom = c.modulars.intersection(c.committables);
  const maintExtI = maintI.intersection(extI).difference(modularCom);
  if (!maintExtI.empty) {
    const nomAttr = c._operational_attrs.nom;
    const pNom = labeler1(m.variables.get(`${c.name}-${nomAttr}`), maintExtI);
    const pMin = staticValues(c, `${nomAttr}_min`, maintExtI);
    const pMax = staticValues(c, `${nomAttr}_max`, maintExtI);
    const mm = labeler2(m.variables.get(`${c.name}-maintenance`), sns, maintExtI);
    const z = labeler2(m.variables.get(`${c.name}-maintenance_capacity`), sns, maintExtI);
    const actE = activityMask(c, sns, maintExtI);
    const nE = maintExtI.length;
    const coords = [sns, maintExtI];
    m.add_constraints(`${c.name}-maintcap_upper`, dims, coords, (s, j) => [[z(s, j), pNom(j), mm(s, j)], [1, -1, -pMin[j]], "<=", r(pMin[j] - 0, 0), actE[s * nE + j]]);
    m.add_constraints(`${c.name}-maintcap_upper_nommax`, dims, coords, (s, j) => [[z(s, j), mm(s, j)], [1, -pMax[j]], "<=", r(0, 0), actE[s * nE + j]]);
    m.add_constraints(`${c.name}-maintcap_lower_nommax`, dims, coords, (s, j) => [[z(s, j), pNom(j), mm(s, j)], [1, -1, -pMax[j]], ">=", r(pMax[j] - 0, 0), actE[s * nE + j]]);
    if (pMin.some((x) => x > 0)) {
      m.add_constraints(`${c.name}-maintcap_lower_nommin`, dims, coords, (s, j) => [[z(s, j), mm(s, j)], [1, -pMin[j]], ">=", r(0, 0), actE[s * nE + j] && pMin[j] > 0]);
    }
  }
}

/** Position of the window's first snapshot in `n.snapshots`. */
function windowStart(n, sns) {
  return n.snapshots.getLoc(sns.at(0));
}

/**
 * Commitment status at the `length` snapshots before the window
 * (`_status_history`): `hist[lag - 1][j]`. Snapshots solved in previous runs
 * are read from `status`; earlier ones follow `up_time_before` /
 * `down_time_before`. Non-committable components are always on.
 */
export function statusHistory(n, c, idx, sns, length) {
  const nN = idx.length;
  const startI = windowStart(n, sns);
  const st = c.dynamic.status;
  const solved = st && !st.empty ? Math.min(startI, length) : 0;
  const up = staticValues(c, "up_time_before", idx);
  const down = staticValues(c, "down_time_before", idx);
  const com = staticValues(c, "committable", idx);
  const past = solved ? denseValues(c, "status", n.snapshots.slice(startI - solved, startI), idx) : null;
  const hist = [];
  for (let lag = 1; lag <= length; lag++) {
    const row = new Float64Array(nN);
    for (let j = 0; j < nN; j++) {
      let v;
      if (lag <= solved) v = past[(solved - lag) * nN + j];
      else {
        const rel = lag - solved;
        v = down[j] > 0 ? (rel > down[j] ? 1 : 0) : rel <= up[j] ? 1 : 0;
      }
      row[j] = com[j] ? v : 1;
    }
    hist.push(row);
  }
  return hist;
}

/**
 * Dispatch right before the window given the status at that time
 * (`_dispatch_before`): the solved dispatch inside `n.snapshots`, else
 * `p_init` (0 for units that were off).
 */
export function dispatchBefore(n, c, idx, sns, status) {
  const attr = n.branch_components.has(c.name) ? "p0" : "p";
  const startI = windowStart(n, sns);
  const d = c.dynamic[attr];
  if (startI && d && !d.empty) return denseValues(c, attr, n.snapshots.slice(startI - 1, startI), idx);
  const pInit = staticValues(c, "p_init", idx);
  return Float64Array.from(pInit, (v, j) => (status[j] > 0 ? v : 0));
}

export function define_operational_constraints_for_committables(n, sns, component) {
  const c = n.c.get(component);
  const comI = c.committables.intersection(c.active_assets);
  if (comI.empty) return;
  const m = n.model;
  const statusV = m.variables.get(`${c.name}-status`);
  const status = labeler2(statusV, sns, comI);
  const startUp = labeler2(m.variables.get(`${c.name}-start_up`), sns, comI);
  const shutDown = labeler2(m.variables.get(`${c.name}-shut_down`), sns, comI);
  const p = labeler2(m.variables.get(`${c.name}-p`), sns, comI);
  const act = activityMask(c, sns, comI);
  const nS = sns.length;
  const nN = comI.length;
  const extI = c.extendables.intersection(c.active_assets);
  const comExtI = comI.intersection(extI).difference(c.modulars);
  const comFixI = comI.difference(extI).difference(c.modulars);

  const nomAttr = c._operational_attrs.nom;
  const nominal = staticValues(c, nomAttr, comI);
  const [minPu, maxPu] = boundsPu(c, "p", sns, comI);
  const lowerP = minPu.map((v, k) => v * nominal[k % nN]);
  const upperP = maxPu.map((v, k) => v * nominal[k % nN]);
  const minUp = staticValues(c, "min_up_time", comI);
  const minDown = staticValues(c, "min_down_time", comI);
  const rampUp = denseValues(c, "ramp_limit_up", sns, comI).map((v, k) => nominal[k % nN] * (Number.isNaN(v) ? 1 : v));
  const rampDown = denseValues(c, "ramp_limit_down", sns, comI).map((v, k) => nominal[k % nN] * (Number.isNaN(v) ? 1 : v));
  const rampStart = staticValues(c, "ramp_limit_start_up", comI).map((v, j) => nominal[j] * (Number.isNaN(v) ? 1 : v));
  const rampShut = staticValues(c, "ramp_limit_shut_down", comI).map((v, j) => nominal[j] * (Number.isNaN(v) ? 1 : v));
  const maxTime = Math.max(Math.trunc(Math.max(...minUp)), Math.trunc(Math.max(...minDown)), 1);
  const history = statusHistory(n, c, comI, sns, maxTime + 1);
  const statusBefore = history[0];
  // switches[lag - 1][j]: +1 if started up, -1 if shut down `lag` snapshots before
  const switches = history.slice(0, maxTime).map((row, l) => row.map((v, j) => v - history[l + 1][j]));
  const maintI = c.maintainables.intersection(c.active_assets);
  const alphaOf = (names) => staticValues(c, "maintenance_pu", names);

  const dims = ["snapshot", "name"];
  if (!comExtI.empty) {
    const pNomVar = m.variables.get(`${c.name}-${nomAttr}`);
    const maxPuExt = new Float64Array(nS * comExtI.length);
    const colOf = comI.getIndexer(comExtI);
    for (let s = 0; s < nS; s++) for (let j = 0; j < comExtI.length; j++) maxPuExt[s * comExtI.length + j] = maxPu[s * nN + colOf[j]];
    const M = bigMValues(c, comExtI, sns, maxPuExt, n._committable_big_m);
    const pE = labeler2(m.variables.get(`${c.name}-p`), sns, comExtI);
    const stE = labeler2(statusV, sns, comExtI);
    const pn = labeler1(pNomVar, comExtI);
    const nE = comExtI.length;
    const coords = [sns, comExtI];
    const actE = (s, j) => act[s * nN + colOf[j]];
    const minPuE = (s, j) => minPu[s * nN + colOf[j]];
    // maintenance through z = p_nom * maintenance
    const maintComExtI = comExtI.intersection(maintI);
    const z = maintComExtI.empty ? null : labeler2(m.variables.get(`${c.name}-maintenance_capacity`), sns, comExtI);
    const isMaintE = comExtI.isin(maintComExtI);
    const alphaE = maintComExtI.empty ? null : alphaOf(comExtI);
    const withZ = (vars, coeffs, s, j, pu) => {
      if (z) {
        vars.push(isMaintE[j] ? z(s, j) : -1);
        coeffs.push(isMaintE[j] ? pu * alphaE[j] : NaN);
      }
      return [vars, coeffs];
    };
    m.add_constraints(`${c.name}-com-ext-p-lower`, dims, coords, (s, j) => [
      ...withZ([pE(s, j), pn(j), stE(s, j)], [1, -minPuE(s, j), -M[s * nE + j]], s, j, minPuE(s, j)),
      ">=",
      r(0, -M[s * nE + j]),
      actE(s, j),
    ]);
    m.add_constraints(`${c.name}-com-ext-p-upper-bigM`, dims, coords, (s, j) => [[pE(s, j), stE(s, j)], [1, -M[s * nE + j]], "<=", r(0, 0), actE(s, j)]);
    m.add_constraints(`${c.name}-com-ext-p-upper-cap`, dims, coords, (s, j) => [
      ...withZ([pE(s, j), pn(j)], [1, -maxPuExt[s * nE + j]], s, j, maxPuExt[s * nE + j]),
      "<=",
      r(0, 0),
      actE(s, j),
    ]);
    const nonneg = comExtI.values.filter((_, j) => {
      for (let s = 0; s < nS; s++) if (!(minPuE(s, j) >= 0)) return false;
      return true;
    });
    if (nonneg.length) {
      const nnI = new Index(nonneg, "name");
      const pos = comExtI.getIndexer(nnI);
      const pNN = labeler2(m.variables.get(`${c.name}-p`), sns, nnI);
      m.add_constraints(`${c.name}-com-ext-p-lower-nonneg`, dims, [sns, nnI], (s, j) => [[pNN(s, j)], [1], ">=", r(0, 0), actE(s, pos[j])]);
    }
  }

  // McCormick linearisation of w = status * maintenance (or modules in maintenance)
  const maintStatusConstraints = (names, kind, modulesMax) => {
    const pos = comI.getIndexer(names);
    const u = labeler2(statusV, sns, names);
    const mm = labeler2(m.variables.get(`${c.name}-maintenance`), sns, names);
    const w = labeler2(m.variables.get(`${c.name}-maintenance_status`), sns, names);
    const coords = [sns, names];
    const a = (s, j) => act[s * nN + pos[j]];
    const mx = (j) => (modulesMax ? modulesMax[j] : 1);
    m.add_constraints(`${c.name}-maint-${kind}-le-status`, dims, coords, (s, j) => [[w(s, j), u(s, j)], [1, -1], "<=", r(0, 0), a(s, j)]);
    m.add_constraints(`${c.name}-maint-${kind}-le-maint`, dims, coords, (s, j) => [[w(s, j), mm(s, j)], [1, -mx(j)], "<=", r(0, 0), a(s, j)]);
    m.add_constraints(`${c.name}-maint-${kind}-lb`, dims, coords, (s, j) => [[w(s, j), u(s, j), mm(s, j)], [1, -1, -mx(j)], ">=", r(0, -mx(j)), a(s, j)]);
  };
  const withW = (names, maintNames) => {
    if (maintNames.empty) return () => [[], []];
    const w = labeler2(m.variables.get(`${c.name}-maintenance_status`), sns, names);
    const isMaint = names.isin(maintNames);
    const alpha = alphaOf(names);
    return (s, j, bound) => (isMaint[j] ? [[w(s, j)], [bound * alpha[j]]] : [[-1], [NaN]]);
  };

  if (!comFixI.empty) {
    const pos = comI.getIndexer(comFixI);
    const pF = labeler2(m.variables.get(`${c.name}-p`), sns, comFixI);
    const sF = labeler2(statusV, sns, comFixI);
    const coords = [sns, comFixI];
    const maintComFixI = comFixI.intersection(maintI);
    if (!maintComFixI.empty) maintStatusConstraints(maintComFixI, "status", null);
    const wTerm = withW(comFixI, maintComFixI);
    m.add_constraints(`${c.name}-com-p-lower`, dims, coords, (s, j) => {
      const lo = lowerP[s * nN + pos[j]];
      const [wv, wc] = wTerm(s, j, lo);
      return [[pF(s, j), sF(s, j), ...wv], [1, -lo, ...wc], ">=", r(0, 0), act[s * nN + pos[j]]];
    });
    m.add_constraints(`${c.name}-com-p-upper`, dims, coords, (s, j) => {
      const up = upperP[s * nN + pos[j]];
      const [wv, wc] = wTerm(s, j, up);
      return [[pF(s, j), sF(s, j), ...wv], [1, -up, ...wc], "<=", r(0, 0), act[s * nN + pos[j]]];
    });
  }

  const comModI = comI.intersection(c.modulars);
  if (!comModI.empty) {
    const pos = comI.getIndexer(comModI);
    const nomMod = staticValues(c, c._operational_attrs.nom_mod, comModI);
    const pM = labeler2(m.variables.get(`${c.name}-p`), sns, comModI);
    const sM = labeler2(statusV, sns, comModI);
    const coords = [sns, comModI];
    const maintComModI = comModI.intersection(maintI);
    if (!maintComModI.empty) {
      const nomMax = staticValues(c, `${nomAttr}_max`, maintComModI);
      const modOf = staticValues(c, c._operational_attrs.nom_mod, maintComModI);
      maintStatusConstraints(maintComModI, "modstatus", nomMax.map((x, j) => x / modOf[j]));
    }
    const wTerm = withW(comModI, maintComModI);
    m.add_constraints(`${c.name}-com-mod-p-lower`, dims, coords, (s, j) => {
      const lo = minPu[s * nN + pos[j]] * nomMod[j];
      const [wv, wc] = wTerm(s, j, lo);
      return [[pM(s, j), sM(s, j), ...wv], [1, -lo, ...wc], ">=", r(0, 0), act[s * nN + pos[j]]];
    });
    m.add_constraints(`${c.name}-com-mod-p-upper`, dims, coords, (s, j) => {
      const up = maxPu[s * nN + pos[j]] * nomMod[j];
      const [wv, wc] = wTerm(s, j, up);
      return [[pM(s, j), sM(s, j), ...wv], [1, -up, ...wc], "<=", r(0, 0), act[s * nN + pos[j]]];
    });
  }

  // status transitions; the status before the window enters the first row
  const coordsAll = [sns, comI];
  const prior = (s, j) => (s === 0 ? 1 : 0) * statusBefore[j];
  const prev = (lab, s, j) => (s === 0 ? -1 : lab(s - 1, j));
  m.add_constraints(`${c.name}-com-transition-start-up`, dims, coordsAll, (s, j) => [
    [startUp(s, j), status(s, j), prev(status, s, j)],
    [1, -1, 1],
    ">=",
    r(0, -prior(s, j)),
    act[s * nN + j],
  ]);
  m.add_constraints(`${c.name}-com-transition-shut-down`, dims, coordsAll, (s, j) => [
    [shutDown(s, j), status(s, j), prev(status, s, j)],
    [1, 1, -1],
    ">=",
    r(0, prior(s, j)),
    act[s * nN + j],
  ]);

  // minimum up / down times incl. the switches before the window
  for (const [kind, minTime, transition, sign, bound] of [
    ["up", minUp, startUp, -1, 0],
    ["down", minDown, shutDown, 1, 1],
  ]) {
    if (!minTime.some((v) => v > 0)) continue;
    const K = Math.trunc(Math.max(...minTime));
    m.add_constraints(`${c.name}-com-${kind}-time`, dims, coordsAll, (s, j) => {
      const vars = [status(s, j)];
      const coeffs = [sign];
      for (let k = 0; k < K; k++) {
        const present = k < minTime[j] && s - k >= 0;
        vars.push(present ? transition(s - k, j) : -1);
        coeffs.push(present ? 1 : NaN);
      }
      let past = 0;
      for (let l = 0; l < maxTime; l++) {
        const sw = Math.max(-sign * switches[l][j], 0);
        if (l + 1 + s < minTime[j]) past += sw;
      }
      return [vars, coeffs, "<=", r(0, bound - past), act[s * nN + j] && minTime[j] > 0];
    });
  }

  // tightening for linearised unit commitment
  const suCost = denseValues(c, "start_up_cost", sns, comI);
  const sdCost = denseValues(c, "shut_down_cost", sns, comI);
  const costEqualAll = comI.values.map((_, j) => {
    for (let s = 0; s < nS; s++) if (suCost[s * nN + j] !== sdCost[s * nN + j]) return false;
    return true;
  });
  if (n._linearized_uc && !costEqualAll.every(Boolean)) {
    logger.warning(
      "The linear relaxation of the unit commitment cannot be tightened for all generators since the start up costs are not equal to the shut down costs in all snapshots. Proceed with the linear relaxation without the tightening by additional constraints for these. This might result in a longer solving time.",
    );
  }
  // tightening is only valid for fixed-capacity committables
  const isFix = comI.isin(comFixI);
  const costEqual = costEqualAll.map((v, j) => v && isFix[j]);
  if (n._linearized_uc && costEqual.some(Boolean)) {
    const ceI = comI.filter(costEqual);
    const pos = comI.getIndexer(ceI);
    const coords = [sns, ceI];
    const K = (s, j) => s * nN + pos[j];
    const sBefore = Array.from(pos, (jj) => statusBefore[jj]);
    const pInit = dispatchBefore(n, c, ceI, sns, sBefore);
    const pInitF = pInit.map((v) => (Number.isNaN(v) ? 0 : v));
    const first = (s) => (s === 0 ? 1 : 0);
    const actPrev = (s, j) => act[K(s, j)] && (s !== 0 || !Number.isNaN(pInit[j]));
    const pPrev = (s, jj) => (s === 0 ? -1 : p(s - 1, jj));
    const stPrev = (s, jj) => (s === 0 ? -1 : status(s - 1, jj));
    m.add_constraints(`${c.name}-com-p-before`, dims, coords, (s, j) => {
      const jj = pos[j];
      const up = upperP[K(s, j)];
      const rsd = rampShut[jj];
      const lc = 0 + pInitF[j] * first(s) - rsd * (0 + sBefore[j] * first(s)) - (up - rsd) * 0;
      return [[pPrev(s, jj), stPrev(s, jj), status(s, jj), startUp(s, jj)], [1, -rsd, -(up - rsd), up - rsd], "<=", r(lc, 0), actPrev(s, j)];
    });
    m.add_constraints(`${c.name}-com-p-current`, dims, coords, (s, j) => {
      const jj = pos[j];
      const up = upperP[K(s, j)];
      return [[p(s, jj), status(s, jj), startUp(s, jj)], [1, -up, up - rampStart[jj]], "<=", r(0, 0), act[K(s, j)]];
    });
    m.add_constraints(`${c.name}-com-partly-start-up`, dims, coords, (s, j) => {
      const jj = pos[j];
      const lo = lowerP[K(s, j)];
      const ru = rampUp[K(s, j)];
      const lc = 0 - (0 + pInitF[j] * first(s)) - (lo + ru) * 0 + lo * (0 + sBefore[j] * first(s)) + (lo + ru - rampStart[jj]) * 0;
      return [
        [p(s, jj), pPrev(s, jj), status(s, jj), stPrev(s, jj), startUp(s, jj)],
        [1, -1, -(lo + ru), lo, lo + ru - rampStart[jj]],
        "<=",
        r(lc, 0),
        actPrev(s, j),
      ];
    });
    m.add_constraints(`${c.name}-com-partly-shut-down`, dims, coords, (s, j) => {
      const jj = pos[j];
      const lo = lowerP[K(s, j)];
      const rd = rampDown[K(s, j)];
      const rsd = rampShut[jj];
      const lc = 0 + pInitF[j] * first(s) - 0 - rsd * (0 + sBefore[j] * first(s)) + (rsd - rd) * 0 - (lo + rd - rsd) * 0;
      return [
        [pPrev(s, jj), p(s, jj), stPrev(s, jj), status(s, jj), startUp(s, jj)],
        [1, -1, -rsd, rsd - rd, -(lo + rd - rsd)],
        "<=",
        r(lc, 0),
        actPrev(s, j),
      ];
    });
  }
}


/** Big-M values (snapshot-major Float64Array) for committable extendables. */
export function bigMValues(c, names, sns, maxPu = null, committableBigM = null) {
  const nomAttr = c._operational_attrs.nom;
  const nomMax = staticValues(c, `${nomAttr}_max`, names);
  const mp = maxPu ?? boundsPu(c, c._operational_attrs.base, sns, names)[1];
  let bigM = committableBigM;
  if (bigM === null || bigM === undefined) bigM = c.n?._committable_big_m ?? null;
  if (bigM === null || bigM === undefined) bigM = c._infer_committable_big_m_scale();
  else {
    if (!Number.isFinite(bigM)) throw new Error(`committable_big_m must be finite, got ${bigM}.`);
    if (bigM <= 0) throw new Error(`committable_big_m must be positive, got ${bigM}.`);
  }
  const nN = names.length;
  return mp.map((v, k) => {
    const nm = nomMax[k % nN];
    return Number.isFinite(nm) && nm > 0 ? nm * v : bigM * (Number.isNaN(v) ? 1 : v);
  });
}

// ----------------------------------------------------------------------
// nominal constraints
// ----------------------------------------------------------------------

export function define_nominal_constraints_for_extendables(n, component, attr) {
  const c = n.c.get(component);
  const extI = c.extendables.intersection(c.active_assets);
  if (extI.empty) return;
  const m = n.model;
  const v = m.variables.get(`${c.name}-${attr}`);
  const lower = staticValues(c, `${attr}_min`, v.coords[0]);
  const upper = staticValues(c, `${attr}_max`, v.coords[0]);
  m.add_constraints(`${c.name}-ext-${attr}-lower`, ["name"], [v.coords[0]], (j) => [[v.at(j)], [1], ">=", r(0, lower[j])]);
  if (upper.some((u) => u !== Infinity)) {
    m.add_constraints(`${c.name}-ext-${attr}-upper`, ["name"], [v.coords[0]], (j) => [[v.at(j)], [1], "<=", r(0, upper[j]), upper[j] !== Infinity]);
  }
}

export function define_fixed_nominal_constraints(n, component, attr) {
  const c = n.c.get(component);
  if (!c.static.has(`${attr}_set`)) return;
  const col = c.static.col(`${attr}_set`);
  const fixNames = c.static.index.values.filter((_, i) => !Number.isNaN(col[i]));
  if (!fixNames.length) return;
  const m = n.model;
  const v = m.variables.get(`${component}-${attr}`);
  const idx = new Index(fixNames, `${component}-${attr}_set_i`);
  const vals = staticValues(c, `${attr}_set`, idx);
  m.add_constraints(`${component}-${attr}_set`, [`${component}-${attr}_set_i`], [idx], (j) => [[v.get(idx.at(j))], [1], "=", r(0, vals[j])]);
}

export function define_modular_constraints(n, component, attr) {
  const m = n.model;
  const c = n.c.get(component);
  const modI = c.extendables.intersection(c.modulars);
  if (modI.empty) return;
  const modCap = staticValues(c, c._operational_attrs.nom_mod, modI);
  const nmod = m.variables.get(`${c.name}-n_mod`);
  const cap = m.variables.get(`${c.name}-${attr}`);
  m.add_constraints(`${c.name}-${attr}_modularity`, ["name"], [modI], (j) => [[cap.get(modI.at(j)), nmod.get(modI.at(j))], [1, -modCap[j]], "=", r(0, 0)]);
}

export function define_committability_variables_constraints_with_fixed_upper_limit(n, sns, component, attr) {
  const c = n.c.get(component);
  const m = n.model;
  const comI = c.committables;
  if (comI.empty) return;
  const modI = c.modulars;
  const fixI = c.fixed;
  let interI = comI.intersection(modI).intersection(fixI);
  const nomAttr = c._operational_attrs.nom;
  const modAttr = c._operational_attrs.nom_mod;
  const rhsVal = new Map();
  if (!interI.empty) {
    const bad = [];
    for (const g of interI) {
      const nm = c.static.at(g, nomAttr) / c.static.at(g, modAttr);
      if (Math.abs(nm - Math.round(nm)) > 1e-6) bad.push(g);
      rhsVal.set(g, nm);
    }
    if (bad.length) {
      throw new Error(
        `For non-extendable but committable assets, if both ${nomAttr} and ${modAttr} are declared, ${nomAttr} must be a multiple of ${modAttr}. Found assets in component ${component} that do not respect this criterion:\n\n\t${bad.join(", ")}`,
      );
    }
  }
  const interI2 = comI.difference(modI);
  if (!interI2.empty) {
    for (const g of interI2) rhsVal.set(g, 1);
    interI = interI.empty ? interI2 : interI.union(interI2);
  }
  if (interI.empty) return;
  const act = n._multi_invest ? activityMask(c, sns, interI) : null;
  const nN = interI.length;
  for (const vname of ["status", "start_up", "shut_down"]) {
    const v = labeler2(m.variables.get(`${component}-${vname}`), sns, interI);
    m.add_constraints(`${component}-${vname}-${attr}-fixed-upper`, ["snapshot", "name"], [sns, interI], (s, j) => [
      [v(s, j)],
      [1],
      "<=",
      r(0, rhsVal.get(interI.at(j))),
      act ? act[s * nN + j] : true,
    ]);
  }
}

export function define_committability_variables_constraints_with_variable_upper_limit(n, sns, component, attr) {
  const c = n.c.get(component);
  const m = n.model;
  const interI = c.committables.intersection(c.modulars).intersection(c.extendables);
  if (interI.empty) return;
  const act = n._multi_invest ? activityMask(c, sns, interI) : null;
  const nmod = labeler1(m.variables.get(`${component}-n_mod`), interI);
  const nN = interI.length;
  for (const vname of ["status", "start_up", "shut_down"]) {
    const v = labeler2(m.variables.get(`${component}-${vname}`), sns, interI);
    m.add_constraints(`${component}-${vname}-${attr}-variable-upper`, ["snapshot", "name"], [sns, interI], (s, j) => [
      [v(s, j), nmod(j)],
      [1, -1],
      "<=",
      r(0, 0),
      act ? act[s * nN + j] : true,
    ]);
  }
}

// ----------------------------------------------------------------------
// ramping
// ----------------------------------------------------------------------

export function define_ramp_limit_constraints(n, sns, component, attr) {
  const m = n.model;
  const c = n.c.get(component);
  const nomAttr = c._operational_attrs?.nom;
  if (!c.static.has("ramp_limit_up") && !c.static.has("ramp_limit_down")) return;
  if (c.static.index.length === 0) return;
  const idx = c.active_assets;
  const nN = idx.length;
  const nS = sns.length;
  const isExt = idx.isin(c.extendables);
  const isCom = idx.isin(c.committables);
  const isMod = idx.isin(c.modulars);
  const isComExt = isCom.map((v, j) => v && isExt[j] && !isMod[j]);
  const isComExtMod = isCom.map((v, j) => v && isExt[j] && isMod[j]);
  const isComFix = isCom.map((v, j) => v && !isComExt[j]);

  const limitUp0 = denseValues(c, "ramp_limit_up", sns, idx);
  const limitDown0 = denseValues(c, "ramp_limit_down", sns, idx);
  const limitStart0 = staticValues(c, "ramp_limit_start_up", idx);
  const limitShut0 = staticValues(c, "ramp_limit_shut_down", idx);
  const mask = activityMask(c, sns, idx);
  const noUp = new Uint8Array(nS * nN);
  const noDown = new Uint8Array(nS * nN);
  let allNull = true;
  for (let s = 0; s < nS; s++) {
    for (let j = 0; j < nN; j++) {
      const k = s * nN + j;
      noUp[k] = Number.isNaN(limitUp0[k]) && Number.isNaN(limitStart0[j]) ? 1 : 0;
      noDown[k] = Number.isNaN(limitDown0[k]) && Number.isNaN(limitShut0[j]) ? 1 : 0;
      if (!(noUp[k] && noDown[k])) allNull = false;
    }
  }
  if (allNull) return;
  const f1 = (v) => (Number.isNaN(v) ? 1.0 : v);
  const limitUp = limitUp0.map(f1);
  const limitDown = limitDown0.map(f1);
  const limitStart = limitStart0.map(f1);
  const limitShut = limitShut0.map(f1);
  const filterFirst = (s) => (s === 0 ? 1 : 0);

  const nomVals = staticValues(c, nomAttr, idx);
  let pNom = nomVals.map((v, j) => (isExt[j] ? 0 : v));
  if (isComExtMod.some(Boolean)) {
    const nomMod = staticValues(c, c._operational_attrs.nom_mod, idx);
    pNom = pNom.map((v, j) => (isComExtMod[j] ? nomMod[j] : v));
  }
  const isExtMain = isExt.map((v, j) => v && !isComExt[j] && !isComExtMod[j]);
  const extMainNames = idx.filter(isExtMain);
  const pNomExt = extMainNames.length ? labeler1(m.variables.get(`${c.name}-${nomAttr}`), extMainNames) : null;
  const extPos = new Map(extMainNames.values.map((nm, k) => [nm, k]));

  const hasComFix = isComFix.some(Boolean);
  const comMainNames = idx.filter(isComFix);
  const statusLab = hasComFix ? labeler2(m.variables.get(`${c.name}-status`), sns, comMainNames) : null;
  const comPos = new Map(comMainNames.values.map((nm, k) => [nm, k]));

  const sInit = statusHistory(n, c, idx, sns, 1)[0];
  const pInit = dispatchBefore(n, c, idx, sns, sInit);
  for (let j = 0; j < nN; j++) mask[j] = Number.isNaN(pInit[j]) ? 0 : 1;
  // skip starts of periods except the first where p_init is used
  const boundary = periodStartMask(sns);
  boundary[0] = false;
  for (let s = 0; s < nS; s++) if (boundary[s]) for (let j = 0; j < nN; j++) mask[s * nN + j] = 0;

  const p = labeler2(m.variables.get(`${c.name}-p`), sns, idx);
  const pInitF = pInit.map((v) => (Number.isNaN(v) ? 0 : v));

  // Scalar expression algebra mirroring the linopy expressions of PyPSA.
  const status = (s, j) =>
    hasComFix
      ? E([-1, isComFix[j] ? statusLab(s, comPos.get(idx.at(j))) : -1], [NaN, 1], isComFix[j] ? 0 : 1)
      : E([], [], 1);
  const statusShifted = (s, j) => {
    if (s === 0) {
      const z = status(0, j);
      return E(z.vars.map(() => -1), z.coeffs.map(() => NaN), 0);
    }
    return status(s - 1, j);
  };
  const statusPrev = (s, j) => add(statusShifted(s, j), E([], [], sInit[j] * filterFirst(s)));

  const lhsExpr = (s, j) => E([p(s, j), s === 0 ? -1 : p(s - 1, j)], [1, -1], 0 - (0 + pInitF[j] * filterFirst(s)));
  const dims = ["snapshot", "name"];
  const coords = [sns, idx];
  m.add_constraints(`${c.name}-${attr}-ramp_limit_up`, dims, coords, (s, j) => {
    const k = s * nN + j;
    const sp = statusPrev(s, j);
    let rhs = scale(sp, limitUp[k] * pNom[j]);
    if (hasComFix) rhs = add(rhs, scale(sub(status(s, j), sp), limitStart[j] * pNom[j]));
    if (pNomExt) rhs = add(rhs, E([isExtMain[j] ? pNomExt(extPos.get(idx.at(j))) : -1], [isExtMain[j] ? limitUp[k] : NaN], 0));
    const lhs = sub(lhsExpr(s, j), rhs);
    const active = mask[k] && !noUp[k] && !isComExt[j];
    return [lhs.vars, lhs.coeffs, "<=", r(lhs.const, 0), active];
  });
  m.add_constraints(`${c.name}-${attr}-ramp_limit_down`, dims, coords, (s, j) => {
    const k = s * nN + j;
    let rhs = scale(status(s, j), -limitDown[k] * pNom[j]);
    if (hasComFix) rhs = sub(rhs, scale(sub(statusPrev(s, j), status(s, j)), limitShut[j] * pNom[j]));
    if (pNomExt) rhs = add(rhs, E([isExtMain[j] ? pNomExt(extPos.get(idx.at(j))) : -1], [isExtMain[j] ? -limitDown[k] : NaN], 0));
    const lhs = sub(lhsExpr(s, j), rhs);
    const active = mask[k] && !noDown[k] && !isComExt[j];
    return [lhs.vars, lhs.coeffs, ">=", r(lhs.const, 0), active];
  });

  if (isComExt.some(Boolean)) {
    defineRampLimitBigM(n, sns, c, attr, idx.filter(isComExt), { limitUp, limitDown, limitStart, limitShut, noUp, noDown, mask, idx });
  }
}

function defineRampLimitBigM(n, sns, c, attr, names, ctx) {
  const m = n.model;
  const nomAttr = c._operational_attrs.nom;
  const M = bigMValues(c, names, sns, null, n._committable_big_m);
  const p = labeler2(m.variables.get(`${c.name}-p`), sns, names);
  const pNom = labeler1(m.variables.get(`${c.name}-${nomAttr}`), names);
  const status = labeler2(m.variables.get(`${c.name}-status`), sns, names);
  const startUp = labeler2(m.variables.get(`${c.name}-start_up`), sns, names);
  const shutDown = labeler2(m.variables.get(`${c.name}-shut_down`), sns, names);
  const nN = names.length;
  const pos = ctx.idx.getIndexer(names);
  const nAll = ctx.idx.length;
  const sInit = statusHistory(n, c, names, sns, 1)[0];
  const pInit = dispatchBefore(n, c, names, sns, sInit);
  const pInitF = pInit.map((v) => (Number.isNaN(v) ? 0 : v));
  const ff = (s) => (s === 0 ? 1 : 0);
  const dims = ["snapshot", "name"];
  const coords = [sns, names];
  const K = (s, j) => s * nAll + pos[j];
  const maskUp = (s, j) => ctx.mask[K(s, j)] && !ctx.noUp[K(s, j)];
  const maskDown = (s, j) => ctx.mask[K(s, j)] && !ctx.noDown[K(s, j)];
  // lhs_delta = p - p_prev, p_prev = p.shift(1) + p_init*filter
  const delta = (s, j) => [[p(s, j), s === 0 ? -1 : p(s - 1, j)], [1, -1], 0 - (0 + pInitF[j] * ff(s))];
  // status_prev = status.shift(1) + s_init*filter
  m.add_constraints(`${c.name}-${attr}-ramp_limit_up-run-bigM`, dims, coords, (s, j) => {
    const [vars, coeffs, lc] = delta(s, j);
    const Mv = M[s * nN + j];
    const lu = ctx.limitUp[K(s, j)];
    // rhs = lu*p_nom + M*(1 - status_prev)
    vars.push(pNom(j), s === 0 ? -1 : status(s - 1, j));
    coeffs.push(-lu, -(-Mv));
    return [vars, coeffs, "<=", r(lc, Mv * (1 - (0 + sInit[j] * ff(s)))), maskUp(s, j)];
  });
  m.add_constraints(`${c.name}-${attr}-ramp_limit_up-start-bigM`, dims, coords, (s, j) => {
    const [vars, coeffs, lc] = delta(s, j);
    const Mv = M[s * nN + j];
    const ls = ctx.limitStart[pos[j]];
    vars.push(pNom(j), startUp(s, j));
    coeffs.push(-ls, -(-Mv));
    return [vars, coeffs, "<=", r(lc, Mv), maskUp(s, j)];
  });
  m.add_constraints(`${c.name}-${attr}-ramp_limit_down-run-bigM`, dims, coords, (s, j) => {
    const [vars, coeffs, lc] = delta(s, j);
    const Mv = M[s * nN + j];
    const ld = ctx.limitDown[K(s, j)];
    vars.push(pNom(j), status(s, j));
    coeffs.push(-(-ld), -Mv);
    return [vars, coeffs, ">=", r(lc, -Mv), maskDown(s, j)];
  });
  m.add_constraints(`${c.name}-${attr}-ramp_limit_down-shut-bigM`, dims, coords, (s, j) => {
    const [vars, coeffs, lc] = delta(s, j);
    const Mv = M[s * nN + j];
    const lsh = ctx.limitShut[pos[j]];
    vars.push(pNom(j), shutDown(s, j));
    coeffs.push(-(-lsh), -Mv);
    return [vars, coeffs, ">=", r(lc, -Mv), maskDown(s, j)];
  });
}

// ----------------------------------------------------------------------
// fixed operation, nodal balance, KVL
// ----------------------------------------------------------------------

export function define_fixed_operation_constraints(n, sns, component, attr) {
  const c = n.c.get(component);
  const attrSet = `${attr}_set`;
  if (!(attrSet in c.dynamic)) return;
  const names = c.active_assets;
  const fix = denseValues(c, attrSet, sns, names);
  if (fix.every((v) => Number.isNaN(v))) return;
  const act = activityMask(c, sns, names);
  const m = n.model;
  const nN = names.length;
  const dims = ["snapshot", "name"];
  const coords = [sns, names];
  if (component === "StorageUnit" && attr === "p") {
    const pd = labeler2(m.variables.get("StorageUnit-p_dispatch"), sns, names);
    const ps = labeler2(m.variables.get("StorageUnit-p_store"), sns, names);
    m.add_constraints("StorageUnit-p_set", dims, coords, (s, j) => {
      const k = s * nN + j;
      return [[pd(s, j), ps(s, j)], [1, -1], "=", r(0, fix[k]), act[k] && !Number.isNaN(fix[k])];
    });
  } else {
    const v = labeler2(m.variables.get(`${c.name}-${attr}`), sns, names);
    m.add_constraints(`${c.name}-${attrSet}`, dims, coords, (s, j) => {
      const k = s * nN + j;
      return [[v(s, j)], [1], "=", r(0, fix[k]), act[k] && !Number.isNaN(fix[k])];
    });
  }
}

/** Group term contributions per bus: returns Map bus -> list of {lab(s), coef(s)} in member order. */
function iterBalanceArgs(c, sns) {
  const out = [];
  if (c.empty) return out;
  const active = c.active_assets;
  for (const port of c._output_ports) {
    const suffix = c._port_suffix(port);
    const delayCol = `delay${suffix}`;
    const cyclicCol = `cyclic_delay${suffix}`;
    const st = c.static;
    const delays = st.has(delayCol) ? st.col(delayCol) : st.index.values.map(() => 0);
    const cyclics = st.has(cyclicCol) ? st.col(cyclicCol) : st.index.values.map(() => true);
    const groups = new Map();
    st.index.values.forEach((nm, i) => {
      const key = `${delays[i]}|${cyclics[i] ? 1 : 0}`;
      if (!groups.has(key)) groups.set(key, { delay: Math.trunc(delays[i]), cyclic: Boolean(cyclics[i]), names: [] });
      groups.get(key).names.push(nm);
    });
    const keys = [...groups.keys()].sort((a, b) => {
      const [da, ca] = a.split("|").map(Number);
      const [db, cb] = b.split("|").map(Number);
      return da - db || ca - cb;
    });
    for (const key of keys) {
      const g = groups.get(key);
      const names = new Index(g.names, "name").intersection(active);
      if (names.empty) continue;
      out.push({ busCol: `bus${port}`, coeffAttr: `${c._coefficient_attr}${suffix}`, names, delay: g.delay, cyclic: g.cyclic });
    }
  }
  return out;
}

export function define_nodal_balance_constraints(n, sns, { transmissionLosses = false, buses = null, suffix = "" } = {}) {
  const m = n.model;
  const busI = buses ?? n.c.buses.names;
  const nS = sns.length;
  const args = [
    ["Generator", "p", "bus", 1],
    ["Store", "p", "bus", 1],
    ["StorageUnit", "p_dispatch", "bus", 1],
    ["StorageUnit", "p_store", "bus", -1],
    ["Line", "s", "bus0", -1],
    ["Line", "s", "bus1", 1],
    ["Transformer", "s", "bus0", -1],
    ["Transformer", "s", "bus1", 1],
    ["Link", "p", "bus0", -1],
  ];
  if (transmissionLosses) {
    args.push(["Line", "loss", "bus0", -0.5], ["Line", "loss", "bus1", -0.5], ["Transformer", "loss", "bus0", -0.5], ["Transformer", "loss", "bus1", -0.5]);
  }
  // blocks: each is Map(bus -> array of members {lab:(s)=>label, coef:(s)=>number}), maxSize
  const blocks = [];
  const pushBlock = (members) => {
    // members: [{bus, lab, coef}] in member order; groups sorted by bus
    const byBus = new Map();
    for (const mbr of members) {
      if (!byBus.has(mbr.bus)) byBus.set(mbr.bus, []);
      byBus.get(mbr.bus).push(mbr);
    }
    let maxSize = 0;
    for (const v of byBus.values()) maxSize = Math.max(maxSize, v.length);
    blocks.push({ byBus, maxSize });
  };
  for (const [component, attr, column, sign0] of args) {
    const c = n.c.get(component);
    if (c.static.index.length === 0) continue;
    const names = c.active_assets;
    const signAttr = c.static.has("sign") ? staticValues(c, "sign", names) : null;
    const busCol = staticValues(c, column, names);
    const v = labeler2(m.variables.get(`${c.name}-${attr}`), sns, names);
    const members = [];
    names.values.forEach((nm, j) => {
      const bus = busCol[j];
      if (!busI.has(bus)) return;
      const coef = signAttr ? sign0 * signAttr[j] : sign0;
      members.push({ bus, lab: (s) => v(s, j), coef: () => coef });
    });
    if (!members.length) continue;
    pushBlock(members);
  }
  for (const component of ["Process", "Link"]) {
    const c = n.c.get(component);
    for (const { busCol, coeffAttr, names, delay, cyclic } of iterBalanceArgs(c, sns)) {
      const coeff = denseValues(c, coeffAttr, sns, names);
      const v = labeler2(m.variables.get(`${c.name}-p`), sns, names);
      let src = null;
      let valid = null;
      if (delay > 0) {
        [src, valid] = getDelaySourceIndexer(sns, weightings(n, "generators", sns), delay, cyclic);
      }
      const busVals = staticValues(c, busCol, names);
      const nN = names.length;
      const members = [];
      names.values.forEach((nm, j) => {
        const bus = busVals[j];
        if (!busI.has(bus) || bus === "") return;
        if (delay <= 0) members.push({ bus, lab: (s) => v(s, j), coef: (s) => coeff[s * nN + j] });
        else members.push({ bus, lab: (s) => v(src[s], j), coef: (s) => coeff[s * nN + j] * (valid[s] ? 1 : 0) });
      });
      if (!members.length) continue;
      pushBlock(members);
    }
  }
  // rhs from loads
  const loads = n.c.loads;
  const rhs = new Map(busI.values.map((b) => [b, new Float64Array(nS)]));
  if (loads.static.index.length > 0) {
    const ln = loads.active_assets;
    const pset = denseValues(loads, "p_set", sns, ln);
    const sign = staticValues(loads, "sign", ln);
    const lbus = staticValues(loads, "bus", ln);
    const act = activityMask(loads, sns, ln);
    const nL = ln.length;
    // grouped sums ordered by load (static) order within each bus
    for (let j = 0; j < nL; j++) {
      const arr = rhs.get(lbus[j]);
      if (!arr) continue;
      for (let s = 0; s < nS; s++) {
        const k = s * nL + j;
        const val = act[k] ? -pset[k] * sign[j] : NaN;
        if (!Number.isNaN(val)) arr[s] += val;
      }
    }
  }
  const name = `Bus${suffix}-nodal_balance`;
  let anyEmpty = false;
  const rowTerms = (s, b) => {
    const vars = [];
    const coeffs = [];
    for (const blk of blocks) {
      const mem = blk.byBus.get(b) ?? [];
      for (let t = 0; t < blk.maxSize; t++) {
        if (t < mem.length) {
          vars.push(mem[t].lab(s));
          coeffs.push(mem[t].coef(s));
        } else {
          vars.push(-1);
          coeffs.push(NaN);
        }
      }
    }
    return [vars, coeffs];
  };
  // check empties
  for (let s = 0; s < nS && !anyEmpty; s++) {
    for (const b of busI) {
      const [vars] = rowTerms(s, b);
      if (vars.every((x) => x === -1)) {
        anyEmpty = true;
        break;
      }
    }
  }
  const row = (s, j) => {
    const b = busI.at(j);
    const [vars, coeffs] = rowTerms(s, b);
    const rv = rhs.get(b)[s];
    const empty = vars.every((x) => x === -1);
    if (empty && rv !== 0) throw new Error("Empty LHS with non-zero RHS in nodal balance constraint.");
    return [vars, coeffs.map((x) => (Number.isNaN(x) ? 0 : x)), "=", r(0, rv), anyEmpty ? !empty : true];
  };
  m.add_constraints(name, ["snapshot", "name"], [sns, busI], row);
}

const DEG2RAD = Math.PI / 180.0;

/** Names of transformers with an optimised phase shift. */
function optimisedPhaseShifts(m) {
  const v = m.variables.get("Transformer-phase_shift");
  return v ? v.coords[1] : new Index([], "name");
}

export function define_kirchhoff_voltage_constraints(n, sns, cycle_basis_method = "bfs-refined") {
  const m = n.model;
  n.calculate_dependent_values();
  const periods = n._multi_invest ? sns.uniqueLevel(0).values : [null];
  const parts = [];
  for (const period of periods) {
    const snapshots = period === null ? sns : sns.filter(sns.values.map((t) => t[0] === period));
    const C = n.cycle_matrix({ investment_period: period, apply_weights: true, cycle_basis_method });
    if (C.empty) continue;
    const types = [];
    for (const [t] of C.index.values) if (!types.includes(t)) types.push(t);
    const typeTerms = [];
    for (const t of types) {
      const rows = C.index.values.map((lab, i) => [lab, i]).filter(([lab]) => lab[0] === t);
      const names = new Index(rows.map(([lab]) => lab[1]), "name");
      const flowNames = names.intersection(n.c.get(t).active_assets);
      const rowOf = new Map(rows.map(([lab, i]) => [lab[1], i]));
      const v = labeler2(m.variables.get(`${t}-s`), snapshots, flowNames);
      typeTerms.push({ flowNames, rowOf, v });
    }
    // transformer phase shifts: a constant when fixed, a variable when optimised
    let shift = null;
    if (types.includes("Transformer")) {
      const Cplain = n.cycle_matrix({ investment_period: period, apply_weights: false, cycle_basis_method });
      const tr = n.c.get("Transformer");
      const trRows = Cplain.index.values.map((lab, i) => [lab, i]).filter(([lab]) => lab[0] === "Transformer");
      const rowOf = new Map(trRows.map(([lab, i]) => [lab[1], i]));
      const names = new Index(trRows.map(([lab]) => lab[1]), "name").intersection(tr.active_assets);
      const optimised = names.isin(optimisedPhaseShifts(m));
      const fixedNames = names.filter(optimised.map((o) => !o));
      const optNames = names.filter(optimised);
      const ps = denseValues(tr, "phase_shift", snapshots, fixedNames);
      const psVar = optNames.empty ? null : labeler2(m.variables.get("Transformer-phase_shift"), snapshots, optNames);
      shift = { Cplain, rowOf, fixedNames, ps, optNames, psVar };
    }
    parts.push({ snapshots, typeTerms, C, shift });
  }
  if (!parts.length) return;
  const allSns = parts.length === 1 ? parts[0].snapshots : new Index(parts.flatMap((p) => p.snapshots.values), sns.names);
  // periods may have different cycle counts: linopy's merge then aligns the
  // cycle coordinate (outer join) which moves it in front of the snapshots.
  let cycleCount = 0;
  for (const p of parts) cycleCount = Math.max(cycleCount, p.C.columns.length);
  const aligned = parts.every((p) => p.C.columns.length === cycleCount);
  const cycleIdx = new Index(Array.from({ length: cycleCount }, (_, i) => i), "cycle");
  const partOf = [];
  for (const p of parts) for (let s = 0; s < p.snapshots.length; s++) partOf.push([p, s]);
  const row = (si, cyc) => {
    const [p, s] = partOf[si];
    if (cyc >= p.C.columns.length) return [[], [], "=", NaN];
    const col = p.C.col(cyc);
    const vars = [];
    const coeffs = [];
    for (const { flowNames, rowOf, v } of p.typeTerms) {
      for (let j = 0; j < flowNames.length; j++) {
        vars.push(v(s, j));
        coeffs.push(col[rowOf.get(flowNames.at(j))] * 1e5);
      }
    }
    let lc = 0;
    if (p.shift) {
      const { Cplain, rowOf, fixedNames, ps, optNames, psVar } = p.shift;
      const pcol = Cplain.col(cyc);
      // (phase_shift @ C) * deg2rad * 1e5
      let dot = 0;
      const nF = fixedNames.length;
      for (let j = 0; j < nF; j++) dot += ps[s * nF + j] * pcol[rowOf.get(fixedNames.at(j))];
      lc = lc + dot * DEG2RAD * 1e5;
      for (let j = 0; j < optNames.length; j++) {
        vars.push(psVar(s, j));
        coeffs.push(pcol[rowOf.get(optNames.at(j))] * DEG2RAD * 1e5);
      }
    }
    return [vars, coeffs, "=", r(lc, 0)];
  };
  if (aligned) m.add_constraints("Kirchhoff-Voltage-Law", ["snapshot", "cycle"], [allSns, cycleIdx], row);
  else m.add_constraints("Kirchhoff-Voltage-Law", ["cycle", "snapshot"], [cycleIdx, allSns], (cyc, si) => row(si, cyc));
}

/**
 * Voltage angle difference limits (`v_ang_max`, degrees) for AC lines and
 * transformers: |x_pu_eff * s + phase_shift| <= v_ang_max.
 */
export function define_voltage_angle_constraints(n, sns) {
  const m = n.model;
  const dims = ["snapshot", "name"];
  for (const cName of ["Line", "Transformer"]) {
    const c = n.c.get(cName);
    const st = c.static;
    if (st.col("v_ang_min").some((x) => Number.isFinite(x))) {
      logger.warning(`The \`v_ang_min\` attribute of ${cName} is deprecated and ignored. \`v_ang_max\` applies symmetrically as an absolute voltage angle difference limit.`);
    }
    const vmax = st.col("v_ang_max");
    let assets = new Index(
      st.index.values.filter((_, i) => Number.isFinite(vmax[i])),
      "name",
    )
      .unique()
      .intersection(c.active_assets);
    if (cName === "Line") assets = assets.filter(staticValues(c, "carrier", assets).map((x) => x === "AC"));
    if (assets.empty) continue;
    const x = staticValues(c, "x_pu_eff", assets);
    const cap = staticValues(c, "v_ang_max", assets).map((v, j) => (v * DEG2RAD) / x[j]);
    const sv = labeler2(m.variables.get(`${cName}-s`), sns, assets);
    const act = activityMask(c, sns, assets);
    const nN = assets.length;
    const on = (s, j) => act[s * nN + j] && Number.isFinite(cap[j]);
    if (cName === "Line") {
      m.add_constraints("Line-v_ang-lower", dims, [sns, assets], (s, j) => [[sv(s, j)], [1], ">=", r(0, -cap[j]), on(s, j)]);
      m.add_constraints("Line-v_ang-upper", dims, [sns, assets], (s, j) => [[sv(s, j)], [1], "<=", r(0, cap[j]), on(s, j)]);
      continue;
    }
    const varying = assets.isin(optimisedPhaseShifts(m));
    const fixedI = assets.filter(varying.map((v) => !v));
    const varI = assets.filter(varying);
    if (!fixedI.empty) {
      const pos = assets.getIndexer(fixedI);
      const ps = denseValues(c, "phase_shift", sns, fixedI);
      const nF = fixedI.length;
      const offset = (s, j) => (DEG2RAD * ps[s * nF + j]) / x[pos[j]];
      m.add_constraints("Transformer-v_ang-lower", dims, [sns, fixedI], (s, j) => [[sv(s, pos[j])], [1], ">=", r(0, -cap[pos[j]] - offset(s, j)), on(s, pos[j])]);
      m.add_constraints("Transformer-v_ang-upper", dims, [sns, fixedI], (s, j) => [[sv(s, pos[j])], [1], "<=", r(0, cap[pos[j]] - offset(s, j)), on(s, pos[j])]);
    }
    if (!varI.empty) {
      const pos = assets.getIndexer(varI);
      const psV = labeler2(m.variables.get("Transformer-phase_shift"), sns, varI);
      const row = (s, j) => [[sv(s, pos[j]), psV(s, j)], [1, DEG2RAD / x[pos[j]]]];
      m.add_constraints("Transformer-v_ang-var-lower", dims, [sns, varI], (s, j) => [...row(s, j), ">=", r(0, -cap[pos[j]]), on(s, pos[j])]);
      m.add_constraints("Transformer-v_ang-var-upper", dims, [sns, varI], (s, j) => [...row(s, j), "<=", r(0, cap[pos[j]]), on(s, pos[j])]);
    }
  }
}

// ----------------------------------------------------------------------
// storage
// ----------------------------------------------------------------------

/**
 * Previous-state label (mirrors `var.where(active).ffill().roll(1).ffill().where(include)`).
 */
function previousLabels(lab, act, nS, nN) {
  const out = new Int32Array(nS * nN).fill(-1);
  for (let j = 0; j < nN; j++) {
    const col = new Int32Array(nS);
    for (let s = 0; s < nS; s++) col[s] = act[s * nN + j] ? lab(s, j) : -1;
    // ffill
    for (let s = 1; s < nS; s++) if (col[s] === -1) col[s] = col[s - 1];
    // roll by 1
    const rolled = new Int32Array(nS);
    for (let s = 0; s < nS; s++) rolled[s] = col[(s - 1 + nS) % nS];
    for (let s = 1; s < nS; s++) if (rolled[s] === -1) rolled[s] = rolled[s - 1];
    for (let s = 0; s < nS; s++) out[s * nN + j] = rolled[s];
  }
  return out;
}

/** Previous labels rolled within each investment period. */
function previousLabelsPerPeriod(lab, sns, nN) {
  const nS = sns.length;
  const out = new Int32Array(nS * nN).fill(-1);
  const starts = periodStartMask(sns);
  let begin = 0;
  for (let s = 0; s <= nS; s++) {
    if (s === nS || (s > 0 && starts[s])) {
      const end = s;
      const len = end - begin;
      for (let j = 0; j < nN; j++) {
        for (let t = 0; t < len; t++) out[(begin + t) * nN + j] = lab(begin + ((t - 1 + len) % len), j);
      }
      begin = s;
    }
  }
  return out;
}

export function define_storage_unit_constraints(n, sns) {
  const m = n.model;
  const c = n.c.get("StorageUnit");
  if (c.static.index.length === 0) return;
  const names = c.active_assets;
  const nS = sns.length;
  const nN = names.length;
  const act = activityMask(c, sns, names);
  const eh = weightings(n, "stores", sns);
  const standing = denseValues(c, "standing_loss", sns, names);
  const effStand = standing.map((v, k) => pyPow(1 - v, eh[Math.floor(k / nN)]));
  const effDispatch = denseValues(c, "efficiency_dispatch", sns, names);
  const effStore = denseValues(c, "efficiency_store", sns, names);
  const inflow = denseValues(c, "inflow", sns, names);
  const soc = labeler2(m.variables.get("StorageUnit-state_of_charge"), sns, names);
  const pd = labeler2(m.variables.get("StorageUnit-p_dispatch"), sns, names);
  const ps = labeler2(m.variables.get("StorageUnit-p_store"), sns, names);
  const spillVar = m.variables.get("StorageUnit-spill");
  const spill = spillVar ? labeler2(spillVar, sns, names) : null;
  const cyclic = staticValues(c, "cyclic_state_of_charge", names);
  const socInit = staticValues(c, "state_of_charge_initial", names);
  const include = new Uint8Array(nS * nN);
  for (let j = 0; j < nN; j++) {
    let cum = 0;
    for (let s = 0; s < nS; s++) {
      const k = s * nN + j;
      cum += act[k];
      include[k] = cyclic[j] ? 1 : cum !== 1 ? 1 : 0;
    }
  }
  const prev = previousLabels(soc, act, nS, nN);
  if (n._multi_invest) {
    const cpp = staticValues(c, "cyclic_state_of_charge_per_period", names);
    const ipp = staticValues(c, "state_of_charge_initial_per_period", names);
    const perPeriod = cpp.map((v, j) => Boolean(v) || Boolean(ipp[j]));
    const prevPP = previousLabelsPerPeriod(soc, sns, nN);
    const starts = periodStartMask(sns);
    for (let s = 0; s < nS; s++) {
      for (let j = 0; j < nN; j++) {
        const k = s * nN + j;
        const inclPP = act[k] && (!starts[s] || cpp[j]);
        if (perPeriod[j]) {
          prev[k] = prevPP[k];
          include[k] = inclPP ? 1 : 0;
        }
      }
    }
  }
  const hasInitial = socInit.map((v) => v !== 0);
  const ignored = names.values.filter((_, j) => cyclic[j] && hasInitial[j]);
  if (ignored.length) {
    logger.warning(
      `StorageUnits ${JSON.stringify(ignored)}: Cyclic state of charge constraint overrules initial storage level setting. User-defined state_of_charge_initial will be ignored.`,
    );
  }
  m.add_constraints("StorageUnit-energy_balance", ["snapshot", "name"], [sns, names], (s, j) => {
    const k = s * nN + j;
    // the previous state of charge is included through its coefficient
    const vars = [soc(s, j), pd(s, j), ps(s, j), prev[k]];
    const coeffs = [-1, (-1 / effDispatch[k]) * eh[s], effStore[k] * eh[s], effStand[k] * include[k]];
    if (spill) {
      vars.push(spill(s, j));
      coeffs.push(-eh[s]);
    }
    let rhs = -inflow[k] * eh[s];
    if (!include[k]) rhs = rhs - socInit[j];
    return [vars, coeffs, "=", r(0, rhs), act[k]];
  });
}

export function define_store_constraints(n, sns) {
  const m = n.model;
  const c = n.c.get("Store");
  if (c.static.index.length === 0) return;
  const names = c.active_assets;
  const nS = sns.length;
  const nN = names.length;
  const act = activityMask(c, sns, names);
  const eh = weightings(n, "stores", sns);
  const standing = denseValues(c, "standing_loss", sns, names);
  const effStand = standing.map((v, k) => pyPow(1 - v, eh[Math.floor(k / nN)]));
  const e = labeler2(m.variables.get("Store-e"), sns, names);
  const p = labeler2(m.variables.get("Store-p"), sns, names);
  const cyclic = staticValues(c, "e_cyclic", names);
  const eInit = staticValues(c, "e_initial", names);
  const include = new Uint8Array(nS * nN);
  for (let j = 0; j < nN; j++) {
    let cum = 0;
    for (let s = 0; s < nS; s++) {
      const k = s * nN + j;
      cum += act[k];
      include[k] = cyclic[j] ? 1 : cum !== 1 ? 1 : 0;
    }
  }
  const prev = previousLabels(e, act, nS, nN);
  if (n._multi_invest) {
    const cpp = staticValues(c, "e_cyclic_per_period", names);
    const ipp = staticValues(c, "e_initial_per_period", names);
    const perPeriod = cpp.map((v, j) => Boolean(v) || Boolean(ipp[j]));
    const prevPP = previousLabelsPerPeriod(e, sns, nN);
    const starts = periodStartMask(sns);
    for (let s = 0; s < nS; s++) {
      for (let j = 0; j < nN; j++) {
        const k = s * nN + j;
        const inclPP = act[k] && (!starts[s] || cpp[j]);
        if (perPeriod[j]) {
          prev[k] = prevPP[k];
          include[k] = inclPP ? 1 : 0;
        }
      }
    }
  }
  const ignored = names.values.filter((_, j) => cyclic[j] && eInit[j] !== 0);
  if (ignored.length) {
    logger.warning(
      `Stores ${JSON.stringify(ignored)}: Cyclic energy level constraint overrules initial value setting. User-defined e_initial will be ignored.`,
    );
  }
  m.add_constraints("Store-energy_balance", ["snapshot", "name"], [sns, names], (s, j) => {
    const k = s * nN + j;
    const vars = [e(s, j), p(s, j), prev[k]];
    const coeffs = [-1, -eh[s], effStand[k] * include[k]];
    const rhs = -(include[k] ? 0 : eInit[j]);
    return [vars, coeffs, "=", r(0, rhs), act[k]];
  });
}

export function define_total_supply_constraints(n, sns, component = "Generator") {
  const m = n.model;
  const c = n.c.get(component);
  if (c.static.index.length === 0) return;
  const eh = weightings(n, "generators", sns);
  const v = m.variables.get(`${c.name}-p`);
  for (const [attr, sign, test] of [
    ["e_sum_min", ">=", (x) => x > -Infinity],
    ["e_sum_max", "<=", (x) => x < Infinity],
  ]) {
    const col = c.static.col(attr);
    const names = c.static.index.filter(Array.from(col, test));
    if (names.empty) continue;
    const lab = labeler2(v, sns, names);
    const vals = staticValues(c, attr, names);
    m.add_constraints(`${c.name}-${attr}`, ["name"], [names], (j) => {
      // (p * eh).sum("snapshot"): terms in snapshot order
      const vars = [];
      const coeffs = [];
      for (let s = 0; s < sns.length; s++) {
        vars.push(lab(s, j));
        coeffs.push(eh[s]);
      }
      return [vars, coeffs, sign, r(0, vals[j])];
    });
  }
}

// ----------------------------------------------------------------------
// transmission losses
// ----------------------------------------------------------------------

function lossBase(n, sns, component) {
  const c = n.c.get(component);
  if (c.static.index.length === 0 || !n.passive_branch_components.has(component)) return null;
  const names = c.active_assets;
  const act = activityMask(c, sns, names);
  const sMaxPu = denseValues(c, "s_max_pu", sns, names);
  const isExt = staticValues(c, "s_nom_extendable", names);
  const sNomMaxRaw = staticValues(c, "s_nom_max", names);
  const sNom = staticValues(c, "s_nom", names);
  const sNomMax = names.values.map((_, j) => (isExt[j] ? sNomMaxRaw[j] : sNom[j]));
  if (!sNomMax.every((v) => Number.isFinite(v))) {
    throw new Error(`Loss approximation requires finite 's_nom_max' for extendable branches`);
  }
  const rPuEff = staticValues(c, "r_pu_eff", names);
  return { c, names, act, sMaxPu, sNomMax, rPuEff };
}

export function define_tangent_loss_constraints(n, sns, component, segments) {
  if (!Number.isInteger(segments) || segments < 1) throw new Error(`'segments' must be a positive integer, got ${segments}`);
  const b = lossBase(n, sns, component);
  if (!b) return;
  const m = n.model;
  const { c, names, act, sMaxPu, sNomMax, rPuEff } = b;
  const nN = names.length;
  const loss = labeler2(m.variables.get(`${c.name}-loss`), sns, names);
  const flow = labeler2(m.variables.get(`${c.name}-s`), sns, names);
  const dims = ["snapshot", "name"];
  const coords = [sns, names];
  m.add_constraints(`${c.name}-loss_upper`, dims, coords, (s, j) => {
    const k = s * nN + j;
    return [[loss(s, j)], [1], "<=", r(0, rPuEff[j] * (sMaxPu[k] * sNomMax[j]) ** 2), act[k]];
  });
  for (let kk = 1; kk <= segments; kk++) {
    for (const sign of [-1, 1]) {
      m.add_constraints(`${c.name}-loss_tangents-${kk}-${sign}`, dims, coords, (s, j) => {
        const k = s * nN + j;
        const pk = (kk / segments) * sMaxPu[k] * sNomMax[j];
        const lossK = rPuEff[j] * pk ** 2;
        const slope = 2 * rPuEff[j] * pk;
        const offset = lossK - slope * pk;
        return [[loss(s, j), flow(s, j)], [1, sign * slope], ">=", r(0, offset), act[k]];
      });
    }
  }
}

export function define_secant_loss_constraints(n, sns, component, { atol = 1, rtol = 0.1, max_segments = 20 } = {}) {
  if (atol <= 0) throw new Error(`'atol' must be positive, got ${atol}`);
  if (rtol < 0) throw new Error(`'rtol' must be non-negative, got ${rtol}`);
  if (max_segments < 1) throw new Error(`'max_segments' must be >= 1, got ${max_segments}`);
  const b = lossBase(n, sns, component);
  if (!b) return;
  const m = n.model;
  const { c, names, act, sMaxPu, sNomMax, rPuEff } = b;
  const nN = names.length;
  const nS = sns.length;
  const loss = labeler2(m.variables.get(`${c.name}-loss`), sns, names);
  const flow = labeler2(m.variables.get(`${c.name}-s`), sns, names);
  const dims = ["snapshot", "name"];
  m.add_constraints(`${c.name}-loss_upper`, dims, [sns, names], (s, j) => {
    const k = s * nN + j;
    return [[loss(s, j)], [1], "<=", r(0, rPuEff[j] * (sMaxPu[k] * sNomMax[j]) ** 2), act[k]];
  });
  const lossy = rPuEff.map((x) => x > 0);
  const p1 = rPuEff.map((x, j) => (lossy[j] ? 2 * Math.sqrt(atol / x) : 0));
  const targetFactors = names.values.map((_, j) => {
    if (!lossy[j]) return 0;
    let mx = -Infinity;
    for (let s = 0; s < nS; s++) mx = Math.max(mx, sNomMax[j] * sMaxPu[s * nN + j]);
    return mx / p1[j];
  });
  const factors = [0.0, 1.0];
  while (targetFactors.some((t) => factors[factors.length - 1] < t)) {
    const k = factors.length;
    const stepAtol = k / (k - 1);
    const stepRtol = 1 + 2 * (rtol + Math.sqrt(rtol + rtol ** 2));
    factors.push(factors[factors.length - 1] * Math.max(stepAtol, stepRtol));
    if (k >= max_segments) {
      throw new Error(
        `Secant loop hit max_segments; check atol/rtol or line parameters; current inputs would result in ${2 * max_segments} additional constraints per line`,
      );
    }
  }
  const K = factors.length - 1;
  const secIdx = new Index(Array.from({ length: K }, (_, i) => i), "secant");
  for (const [sign, sname] of [
    [-1, "neg"],
    [1, "pos"],
  ]) {
    m.add_constraints(`${c.name}-loss_secants-${sname}`, ["snapshot", "name", "secant"], [sns, names, secIdx], (s, j, kk) => {
      const a = lossy[j] ? factors[kk] : 0;
      const bb = lossy[j] ? factors[kk + 1] : 0;
      const slope = 2 * Math.sqrt(atol * rPuEff[j]) * (a + bb);
      const offset = -4 * atol * (a * bb);
      return [[loss(s, j), flow(s, j)], [1, sign * slope], ">=", r(0, offset), act[s * nN + j]];
    });
  }
}

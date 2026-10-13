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
  const fixI = c.fixed.difference(c.committables).difference(c.inactive_assets);
  if (fixI.empty) return;
  const m = n.model;
  const nom = staticValues(c, c._operational_attrs.nom, fixI);
  const [minPu, maxPu] = boundsPu(c, attr, sns, fixI);
  const act = activityMask(c, sns, fixI);
  const v = labeler2(m.variables.get(`${c.name}-${attr}`), sns, fixI);
  const withLoss = n.passive_branch_components.has(c.name) && transmissionLosses;
  const loss = withLoss ? labeler2(m.variables.get(`${c.name}-loss`), sns, fixI) : null;
  const nN = fixI.length;
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
  m.add_constraints(`${c.name}-fix-${attr}-lower`, dims, coords, (s, j) => {
    const vars = withLoss ? [v(s, j), loss(s, j)] : [v(s, j)];
    const coeffs = withLoss ? [1, -1] : [1];
    return [vars, coeffs, ">=", r(0, lower(s, j)), act[s * nN + j]];
  });
  m.add_constraints(`${c.name}-fix-${attr}-upper`, dims, coords, (s, j) => {
    const vars = withLoss ? [v(s, j), loss(s, j)] : [v(s, j)];
    const coeffs = withLoss ? [1, 1] : [1];
    return [vars, coeffs, "<=", r(0, upper(s, j)), act[s * nN + j]];
  });
}

export function define_operational_constraints_for_extendables(n, sns, component, attr, transmissionLosses = false) {
  const c = n.c.get(component);
  let extI = c.extendables.difference(c.inactive_assets);
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
  const dims = ["snapshot", "name"];
  const coords = [sns, extI];
  m.add_constraints(`${c.name}-ext-${attr}-lower`, dims, coords, (s, j) => {
    const k = s * nN + j;
    const vars = [v(s, j), cap(j)];
    const coeffs = [1, -(minPu[k] * 1)];
    if (withLoss) {
      vars.push(loss(s, j));
      coeffs.push(-1);
    }
    return [vars, coeffs, ">=", r(0, 0), act[k]];
  });
  m.add_constraints(`${c.name}-ext-${attr}-upper`, dims, coords, (s, j) => {
    const k = s * nN + j;
    const vars = [v(s, j), cap(j)];
    const coeffs = [1, -(maxPu[k] * 1)];
    if (withLoss) {
      vars.push(loss(s, j));
      coeffs.push(1);
    }
    return [vars, coeffs, "<=", r(0, 0), act[k]];
  });
}

/** Shift labels along snapshot by 1 (first row gets -1). */
function prevLabel(lab, s, j) {
  return s === 0 ? -1 : lab(s - 1, j);
}

export function define_operational_constraints_for_committables(n, sns, component) {
  const c = n.c.get(component);
  const comI = c.committables.difference(c.inactive_assets);
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
  const extI = c.extendables.difference(c.inactive_assets);
  const comExtI = comI.intersection(extI).difference(c.modulars);
  const comFixI = comI.difference(extI);

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
  let upBefore = staticValues(c, "up_time_before", comI);
  let downBefore = staticValues(c, "down_time_before", comI);
  let initiallyUp = upBefore.map((v) => Boolean(v));
  let initiallyDown = downBefore.map((v) => Boolean(v));

  if (labelKeyEq(sns.at(0), n.snapshots.at(0)) === false) {
    // rolling horizon: derive initial state from previous dispatch
    const startI = n.snapshots.getLoc(sns.at(0));
    const prevSns = n.snapshots.slice(0, startI).values.slice().reverse();
    const st = c.dynamic.status;
    upBefore = comI.values.map((g, j) => {
      let cnt = 0;
      for (let t = 0; t < prevSns.length; t++) {
        const v = st.has(g) ? st.col(g)[n.snapshots.getLoc(prevSns[t])] : 1;
        if (v) cnt++;
        else break;
      }
      return Math.min(cnt, minUp[j]);
    });
    initiallyUp = upBefore.map((v) => Boolean(v));
    downBefore = comI.values.map((g, j) => {
      let cnt = 0;
      for (let t = 0; t < prevSns.length; t++) {
        const v = st.has(g) ? st.col(g)[n.snapshots.getLoc(prevSns[t])] : 1;
        if (!v) cnt++;
        else break;
      }
      return Math.min(cnt, minDown[j]);
    });
    initiallyDown = downBefore.map((v) => Boolean(v));
  }

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
    m.add_constraints(`${c.name}-com-ext-p-lower`, dims, coords, (s, j) => [
      [pE(s, j), pn(j), stE(s, j)],
      [1, -minPuE(s, j), -M[s * nE + j]],
      ">=",
      r(0, -M[s * nE + j]),
      actE(s, j),
    ]);
    m.add_constraints(`${c.name}-com-ext-p-upper-bigM`, dims, coords, (s, j) => [[pE(s, j), stE(s, j)], [1, -M[s * nE + j]], "<=", r(0, 0), actE(s, j)]);
    m.add_constraints(`${c.name}-com-ext-p-upper-cap`, dims, coords, (s, j) => [
      [pE(s, j), pn(j)],
      [1, -maxPuExt[s * nE + j]],
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

  if (!comFixI.empty) {
    const pos = comI.getIndexer(comFixI);
    const pF = labeler2(m.variables.get(`${c.name}-p`), sns, comFixI);
    const sF = labeler2(statusV, sns, comFixI);
    const coords = [sns, comFixI];
    m.add_constraints(`${c.name}-com-p-lower`, dims, coords, (s, j) => [
      [pF(s, j), sF(s, j)],
      [1, -lowerP[s * nN + pos[j]]],
      ">=",
      r(0, 0),
      act[s * nN + pos[j]],
    ]);
    m.add_constraints(`${c.name}-com-p-upper`, dims, coords, (s, j) => [
      [pF(s, j), sF(s, j)],
      [1, -upperP[s * nN + pos[j]]],
      "<=",
      r(0, 0),
      act[s * nN + pos[j]],
    ]);
  }

  const comModI = comI.intersection(c.modulars);
  if (!comModI.empty) {
    const pos = comI.getIndexer(comModI);
    const nomMod = staticValues(c, c._operational_attrs.nom_mod, comModI);
    const pM = labeler2(m.variables.get(`${c.name}-p`), sns, comModI);
    const sM = labeler2(statusV, sns, comModI);
    const coords = [sns, comModI];
    m.add_constraints(`${c.name}-com-mod-p-lower`, dims, coords, (s, j) => [
      [pM(s, j), sM(s, j)],
      [1, -(minPu[s * nN + pos[j]] * nomMod[j])],
      ">=",
      r(0, 0),
      act[s * nN + pos[j]],
    ]);
    m.add_constraints(`${c.name}-com-mod-p-upper`, dims, coords, (s, j) => [
      [pM(s, j), sM(s, j)],
      [1, -(maxPu[s * nN + pos[j]] * nomMod[j])],
      "<=",
      r(0, 0),
      act[s * nN + pos[j]],
    ]);
  }

  // status transitions
  const coordsAll = [sns, comI];
  m.add_constraints(`${c.name}-com-transition-start-up`, dims, coordsAll, (s, j) => {
    const rhs = s === 0 && initiallyUp[j] ? -1 : 0;
    return [[startUp(s, j), status(s, j), prevLabel(status, s, j)], [1, -1, 1], ">=", r(0, rhs), act[s * nN + j]];
  });
  m.add_constraints(`${c.name}-com-transition-shut-down`, dims, coordsAll, (s, j) => {
    const rhs = s === 0 && initiallyUp[j] ? 1 : 0;
    return [[shutDown(s, j), status(s, j), prevLabel(status, s, j)], [1, 1, -1], ">=", r(0, rhs), act[s * nN + j]];
  });

  // minimum up time
  const minUpI = comI.filter(minUp.map(Boolean));
  if (!minUpI.empty) {
    const pos = comI.getIndexer(minUpI);
    const sns1 = sns.slice(1);
    m.add_constraints(`${c.name}-com-up-time`, dims, [sns1, minUpI], (s1, j) => {
      const s = s1 + 1;
      const jj = pos[j];
      const k = minUp[jj];
      const vars = [status(s, jj)];
      const coeffs = [-1];
      for (let w = k - 1; w >= 0; w--) {
        const t = s - w;
        vars.push(t >= 0 ? startUp(t, jj) : -1);
        coeffs.push(1);
      }
      return [vars, coeffs, "<=", r(0, 0), act[s * nN + jj]];
    });
  }
  const minDownI = comI.filter(minDown.map(Boolean));
  if (!minDownI.empty) {
    const pos = comI.getIndexer(minDownI);
    const sns1 = sns.slice(1);
    m.add_constraints(`${c.name}-com-down-time`, dims, [sns1, minDownI], (s1, j) => {
      const s = s1 + 1;
      const jj = pos[j];
      const k = minDown[jj];
      const vars = [status(s, jj)];
      const coeffs = [1];
      for (let w = k - 1; w >= 0; w--) {
        const t = s - w;
        vars.push(t >= 0 ? shutDown(t, jj) : -1);
        coeffs.push(1);
      }
      return [vars, coeffs, "<=", r(0, 1), act[s * nN + jj]];
    });
  }

  // initial up / down requirements
  const statusCoords = statusV.coords;
  const statusNames = statusCoords[1];
  if (initiallyUp.some(Boolean)) {
    const mustUp = comI.values.map((_, j) => Math.max(minUp[j] - upBefore[j], 0));
    m.add_constraints(`${c.name}-com-status-min_up_time_must_stay_up`, dims, [statusCoords[0], statusNames], (s, j) => {
      const jj = comI.getLoc(statusNames.at(j));
      const sp = sns.getLoc(statusCoords[0].at(s));
      const mask = mustUp[jj] >= sp + 1 && initiallyUp[jj] && act[sp * nN + jj];
      return [[statusV.at(s, j)], [1], "=", r(0, 1), mask];
    });
  }
  if (initiallyDown.some(Boolean)) {
    const mustDown = comI.values.map((_, j) => Math.max(minDown[j] - downBefore[j], 0));
    m.add_constraints(`${c.name}-com-status-min_down_time_must_stay_up`, dims, [statusCoords[0], statusNames], (s, j) => {
      const jj = comI.getLoc(statusNames.at(j));
      const sp = sns.getLoc(statusCoords[0].at(s));
      const mask = mustDown[jj] >= sp + 1 && initiallyDown[jj] && act[sp * nN + jj];
      return [[statusV.at(s, j)], [1], "=", r(0, 0), mask];
    });
  }

  // tightening for linearised unit commitment
  const suCost = staticValues(c, "start_up_cost", comI);
  const sdCost = staticValues(c, "shut_down_cost", comI);
  const costEqual = suCost.map((v, j) => v === sdCost[j]);
  if (n._linearized_uc && !costEqual.every(Boolean)) {
    logger.warning(
      "The linear relaxation of the unit commitment cannot be tightened for all generators since the start up costs are not equal to the shut down costs. Proceed with the linear relaxation without the tightening by additional constraints for these. This might result in a longer solving time.",
    );
  }
  if (n._linearized_uc && costEqual.some(Boolean)) {
    const ceI = comI.filter(costEqual);
    const pos = comI.getIndexer(ceI);
    const sns1 = sns.slice(1);
    const coords = [sns1, ceI];
    const K = (s, j) => s * nN + pos[j];
    m.add_constraints(`${c.name}-com-p-before`, dims, coords, (s1, j) => {
      const s = s1 + 1;
      const jj = pos[j];
      const up = upperP[K(s, j)];
      const rsd = rampShut[jj];
      return [
        [p(s - 1, jj), status(s - 1, jj), status(s, jj), startUp(s, jj)],
        [1, -rsd, -(up - rsd), up - rsd],
        "<=",
        r(0, 0),
        act[K(s, j)],
      ];
    });
    m.add_constraints(`${c.name}-com-p-current`, dims, coords, (s1, j) => {
      const s = s1 + 1;
      const jj = pos[j];
      const up = upperP[K(s, j)];
      return [[p(s, jj), status(s, jj), startUp(s, jj)], [1, -up, up - rampStart[jj]], "<=", r(0, 0), act[K(s, j)]];
    });
    m.add_constraints(`${c.name}-com-partly-start-up`, dims, coords, (s1, j) => {
      const s = s1 + 1;
      const jj = pos[j];
      const lo = lowerP[K(s, j)];
      const ru = rampUp[K(s, j)];
      return [
        [p(s, jj), p(s - 1, jj), status(s, jj), status(s - 1, jj), startUp(s, jj)],
        [1, -1, -(lo + ru), lo, lo + ru - rampStart[jj]],
        "<=",
        r(0, 0),
        act[K(s, j)],
      ];
    });
    m.add_constraints(`${c.name}-com-partly-shut-down`, dims, coords, (s1, j) => {
      const s = s1 + 1;
      const jj = pos[j];
      const lo = lowerP[K(s, j)];
      const rd = rampDown[K(s, j)];
      const rsd = rampShut[jj];
      return [
        [p(s - 1, jj), p(s, jj), status(s - 1, jj), status(s, jj), startUp(s, jj)],
        [1, -1, -rsd, rsd - rd, -(lo + rd - rsd)],
        "<=",
        r(0, 0),
        act[K(s, j)],
      ];
    });
  }
}

function labelKeyEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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
  const extI = c.extendables.difference(c.inactive_assets);
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
  const histAttr = n.branch_components.has(component) ? "p0" : "p";
  if (!c.static.has("ramp_limit_up") && !c.static.has("ramp_limit_down")) return;
  if (c.static.index.length === 0) return;
  const idx = c.static.index;
  const nN = idx.length;
  const nS = sns.length;
  const ext = c.extendables;
  const com = c.committables;
  const mod = c.modulars;
  const isExt = idx.isin(ext);
  const isCom = idx.isin(com);
  const isMod = idx.isin(mod);
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

  const isRollingHorizon = !labelKeyEq(sns.at(0), n.snapshots.at(0)) && c.dynamic[histAttr] && c.dynamic[histAttr].columns.length > 0 && c.dynamic[histAttr].index.length > 0;
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

  let pInit;
  let sInit;
  let startI = -1;
  if (isRollingHorizon) {
    startI = n.snapshots.getLoc(sns.at(0)) - 1;
    pInit = idx.values.map((nm) => {
      const d = c.dynamic[histAttr];
      return d.has(nm) ? d.col(nm)[startI] : NaN;
    });
    sInit = idx.values.map((nm) => {
      const d = c.dynamic.status;
      const v = d && d.has(nm) ? d.col(nm)[startI] : NaN;
      return Number.isNaN(v) ? 1 : v;
    });
  } else {
    const upb = staticValues(c, "up_time_before", idx);
    const initiallyUp = upb.map((v) => v > 0);
    const pi = staticValues(c, "p_init", idx);
    pInit = pi.map((v, j) => (initiallyUp[j] ? v : 0));
    sInit = initiallyUp.map((v) => (v ? 1 : 0));
    for (let j = 0; j < nN; j++) mask[j] = Number.isNaN(pInit[j]) ? 0 : 1;
  }
  const boundary = periodStartMask(sns);
  boundary[0] = false;
  for (let s = 0; s < nS; s++) if (boundary[s]) for (let j = 0; j < nN; j++) mask[s * nN + j] = 0;

  const p = labeler2(m.variables.get(`${c.name}-p`), sns, idx);
  const pInitF = pInit.map((v) => (Number.isNaN(v) ? 0 : v));
  const sInitF = sInit.map((v) => (Number.isNaN(v) ? 0 : v));

  // Scalar expression algebra mirroring the linopy expressions of PyPSA.
  const status = (s, j) =>
    hasComFix
      ? E([-1, isComFix[j] ? statusLab(s, comPos.get(idx.at(j))) : -1], [NaN, 1], isComFix[j] ? 0 : 1)
      : E([], [], 1);
  const statusShifted = (s, j) => {
    if (s === 0) {
      const z = status(0, j);
      const e = E(z.vars.map(() => -1), z.coeffs.map(() => NaN), NaN);
      if (!hasComFix) e.const = 0; // fillna(0) on the numeric status
      return e;
    }
    return status(s - 1, j);
  };
  const statusPrev = (s, j) => add(statusShifted(s, j), E([], [], sInitF[j] * filterFirst(s)));

  let sInitExt = null;
  if (pNomExt) {
    if (isRollingHorizon) {
      sInitExt = extMainNames.values.map((nm) => {
        const d = c.dynamic.status;
        const v = d && d.has(nm) ? d.col(nm)[startI] : NaN;
        return Number.isNaN(v) ? 1 : v;
      });
    } else {
      const upb = staticValues(c, "up_time_before", extMainNames);
      sInitExt = upb.map((v) => (v > 0 ? 1 : 0) * 1.0);
    }
  }

  const lhsExpr = (s, j) => E([p(s, j), s === 0 ? -1 : p(s - 1, j)], [1, -1], 0 - pInitF[j] * filterFirst(s));
  const dims = ["snapshot", "name"];
  const coords = [sns, idx];
  m.add_constraints(`${c.name}-${attr}-ramp_limit_up`, dims, coords, (s, j) => {
    const k = s * nN + j;
    const sp = statusPrev(s, j);
    let rhs = scale(sp, limitUp[k] * pNom[j]);
    if (hasComFix) rhs = add(rhs, scale(sub(status(s, j), sp), limitStart[j] * pNom[j]));
    if (pNomExt && isExtMain[j]) {
      const e = extPos.get(idx.at(j));
      const spExt = 1 - filterFirst(s) + sInitExt[e] * filterFirst(s);
      rhs = add(rhs, E([pNomExt(e)], [limitUp[k] * spExt], 0));
      if (hasComFix) {
        const dsExt = filterFirst(s) * (1 - sInitExt[e]);
        rhs = add(rhs, E([pNomExt(e)], [limitStart[j] * dsExt], 0));
      }
    }
    const lhs = sub(lhsExpr(s, j), rhs);
    const active = mask[k] && !noUp[k] && !isComExt[j];
    return [lhs.vars, lhs.coeffs, "<=", r(lhs.const, 0), active];
  });
  m.add_constraints(`${c.name}-${attr}-ramp_limit_down`, dims, coords, (s, j) => {
    const k = s * nN + j;
    let rhs = scale(status(s, j), -limitDown[k] * pNom[j]);
    if (hasComFix) rhs = sub(rhs, scale(sub(statusPrev(s, j), status(s, j)), limitShut[j] * pNom[j]));
    if (pNomExt && isExtMain[j]) {
      const e = extPos.get(idx.at(j));
      rhs = sub(rhs, E([pNomExt(e)], [limitDown[k]], 0));
      if (hasComFix) {
        const dsExt = filterFirst(s) * (1 - sInitExt[e]);
        rhs = add(rhs, E([pNomExt(e)], [limitShut[j] * dsExt], 0));
      }
    }
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
  const histAttr = n.branch_components.has(c.name) ? "p0" : "p";
  const isRollingHorizon = !labelKeyEq(sns.at(0), n.snapshots.at(0)) && c.dynamic[histAttr] && c.dynamic[histAttr].columns.length > 0;
  const M = bigMValues(c, names, sns, null, n._committable_big_m);
  const p = labeler2(m.variables.get(`${c.name}-p`), sns, names);
  const pNom = labeler1(m.variables.get(`${c.name}-${nomAttr}`), names);
  const status = labeler2(m.variables.get(`${c.name}-status`), sns, names);
  const startUp = labeler2(m.variables.get(`${c.name}-start_up`), sns, names);
  const shutDown = labeler2(m.variables.get(`${c.name}-shut_down`), sns, names);
  const nN = names.length;
  const pos = ctx.idx.getIndexer(names);
  const nAll = ctx.idx.length;
  let pInit;
  let sInit;
  if (isRollingHorizon) {
    const startI = n.snapshots.getLoc(sns.at(0)) - 1;
    pInit = names.values.map((nm) => c.dynamic[histAttr].col(nm)[startI]);
    sInit = names.values.map((nm) => {
      const v = c.dynamic.status?.has(nm) ? c.dynamic.status.col(nm)[startI] : NaN;
      return Number.isNaN(v) ? 1 : v;
    });
  } else {
    const upb = staticValues(c, "up_time_before", names);
    const pi = staticValues(c, "p_init", names);
    pInit = pi.map((v, j) => (upb[j] > 0 ? v : 0));
    sInit = upb.map((v) => (v > 0 ? 1 : 0));
  }
  const pInitF = pInit.map((v) => (Number.isNaN(v) ? 0 : v));
  const sInitF = sInit.map((v) => (Number.isNaN(v) ? 0 : v));
  const ff = (s) => (s === 0 ? 1 : 0);
  const dims = ["snapshot", "name"];
  const coords = [sns, names];
  const K = (s, j) => s * nAll + pos[j];
  const maskUp = (s, j) => ctx.mask[K(s, j)] && !ctx.noUp[K(s, j)];
  const maskDown = (s, j) => ctx.mask[K(s, j)] && !ctx.noDown[K(s, j)];
  // lhs_delta = p - p_prev, p_prev = p.shift(1) + p_init*filter
  const delta = (s, j) => [[p(s, j), s === 0 ? -1 : p(s - 1, j)], [1, -1], 0 - pInitF[j] * ff(s)];
  // status_prev = status.shift(1) + s_init*filter
  m.add_constraints(`${c.name}-${attr}-ramp_limit_up-run-bigM`, dims, coords, (s, j) => {
    const [vars, coeffs, lc] = delta(s, j);
    const Mv = M[s * nN + j];
    const lu = ctx.limitUp[K(s, j)];
    // rhs = lu*p_nom + M*(1 - status_prev)
    vars.push(pNom(j), s === 0 ? -1 : status(s - 1, j));
    coeffs.push(-lu, -(-Mv));
    const rc = Mv * (1 - sInitF[j] * ff(s));
    return [vars, coeffs, "<=", r(lc, s === 0 ? rc : Mv), maskUp(s, j)];
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
  m.add_constraints(name, ["snapshot", "name"], [sns, busI], (s, j) => {
    const b = busI.at(j);
    const [vars, coeffs] = rowTerms(s, b);
    const rv = rhs.get(b)[s];
    const empty = vars.every((x) => x === -1);
    if (empty && rv !== 0) throw new Error("Empty LHS with non-zero RHS in nodal balance constraint.");
    return [vars, coeffs.map((x) => (Number.isNaN(x) ? 0 : x)), "=", r(0, rv), anyEmpty ? !empty : true];
  });
}

export function define_kirchhoff_voltage_constraints(n, sns) {
  const m = n.model;
  n.calculate_dependent_values();
  const periods = n._multi_invest ? sns.uniqueLevel(0).values : [null];
  const parts = [];
  for (const period of periods) {
    const snapshots = period === null ? sns : sns.filter(sns.values.map((t) => t[0] === period));
    const C = n.cycle_matrix({ investment_period: period, apply_weights: true });
    if (C.empty) continue;
    const types = [];
    for (const [t] of C.index.values) if (!types.includes(t)) types.push(t);
    const typeTerms = [];
    for (const t of types) {
      const rows = C.index.values.map((lab, i) => [lab, i]).filter(([lab]) => lab[0] === t);
      const names = new Index(rows.map(([lab]) => lab[1]), "name");
      const flowNames = names.difference(n.c.get(t).inactive_assets);
      const rowOf = new Map(rows.map(([lab, i]) => [lab[1], i]));
      const v = labeler2(m.variables.get(`${t}-s`), snapshots, flowNames);
      typeTerms.push({ flowNames, rowOf, v });
    }
    parts.push({ snapshots, typeTerms, C });
  }
  if (!parts.length) return;
  const allSns = parts.length === 1 ? parts[0].snapshots : new Index(parts.flatMap((p) => p.snapshots.values), sns.names);
  const ncycles = parts[0].C.columns.length;
  // periods may have different cycle counts; build cycle coordinate as max
  let cycleCount = 0;
  for (const p of parts) cycleCount = Math.max(cycleCount, p.C.columns.length);
  const cycleIdx = new Index(Array.from({ length: cycleCount }, (_, i) => i), "cycle");
  const partOf = [];
  for (const p of parts) for (let s = 0; s < p.snapshots.length; s++) partOf.push([p, s]);
  m.add_constraints("Kirchhoff-Voltage-Law", ["snapshot", "cycle"], [allSns, cycleIdx], (si, cyc) => {
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
    return [vars, coeffs, "=", r(0, 0)];
  });
  void ncycles;
}

// ----------------------------------------------------------------------
// storage
// ----------------------------------------------------------------------

/**
 * Previous-state label (mirrors `var.where(active).ffill().roll(1).ffill().where(include)`).
 */
function previousLabels(lab, act, nS, nN, include) {
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
    for (let s = 0; s < nS; s++) out[s * nN + j] = include[s * nN + j] ? rolled[s] : -1;
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
  let prev = previousLabels(soc, act, nS, nN, include);
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
          prev[k] = inclPP ? prevPP[k] : -1;
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
    const vars = [soc(s, j), pd(s, j), ps(s, j)];
    const coeffs = [-1, (-1 / effDispatch[k]) * eh[s], effStore[k] * eh[s]];
    if (spill) {
      vars.push(spill(s, j));
      coeffs.push(-eh[s]);
    }
    vars.push(prev[k]);
    coeffs.push(effStand[k]);
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
  const prev = previousLabels(e, act, nS, nN, include);
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
          prev[k] = inclPP ? prevPP[k] : -1;
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
    const coeffs = [-1, -eh[s], effStand[k]];
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

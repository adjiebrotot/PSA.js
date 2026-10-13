// SPDX-License-Identifier: MIT
/**
 * Optimisation entry points (mirrors `pypsa.optimization.optimize`).
 */

import { installAbstract } from "./abstract.js";
import { installMGA } from "./mga.js";
import { DataFrame, Series, isNumberArray } from "../core/frame.js";
import { Index } from "../core/index.js";
import { Network } from "../network/network.js";
import { as_index, isOptions } from "../common.js";
import { getDelaySourceIndexer } from "../components/components.js";
import { Model } from "./linopy.js";
import { NOMINAL_ATTRS, LOOKUP, lookupQuery, activityMask, denseValues, staticValues, objectiveWeighting, getBusCounts, weightings } from "./common.js";
import { labeler1, labeler2 } from "./variables.js";
import * as V from "./variables.js";
import * as C from "./constraints.js";
import * as G from "./global_constraints.js";
import { sparseLU } from "../linalg/sparse.js";
import { logger } from "../logger.js";
import { checkForUnknownBuses } from "../network/network.js";

let warnedObjectiveConstant = false;

function resolveIncludeObjectiveConstant(value) {
  if (value === null || value === undefined) {
    if (!warnedObjectiveConstant) {
      logger.warning(
        "The default value of `include_objective_constant` will change from True to False in version 2.0. Set `include_objective_constant` explicitly to suppress this warning.",
      );
      warnedObjectiveConstant = true;
    }
    return true;
  }
  return value;
}

// ----------------------------------------------------------------------
// objective
// ----------------------------------------------------------------------

function anyActive(c, names, sns, period = null) {
  // `c.da.active.sel(name=names[, period]).any(dim)`
  if (period !== null) {
    const a = c.get_active_assets(period);
    return names.values.map((nm) => a.get(nm));
  }
  const act = activityMask(c, sns ?? c.n.snapshots, names);
  const nN = names.length;
  const nS = act.length / Math.max(nN, 1);
  return names.values.map((_, j) => {
    for (let s = 0; s < nS; s++) if (act[s * nN + j]) return true;
    return false;
  });
}

function periodizedCostFor(c, names) {
  const pc = c.periodized_cost;
  return names.values.map((nm) => pc[c.static.index.getLoc(nm)]);
}

export function define_objective(n, sns, includeObjectiveConstant) {
  const m = n.model;
  const capexTerms = [];
  const opexTerms = [];
  const quadTerms = [];
  let periods = null;
  let periodWeighting = null;
  if (n._multi_invest) {
    periods = sns.uniqueLevel(0).values;
    periodWeighting = periods.map((p) => n.investment_period_weightings.at(p, "objective"));
  }

  if (includeObjectiveConstant) {
    let constant = 0;
    const terms = [];
    for (const [cName, attr] of Object.entries(NOMINAL_ATTRS)) {
      const c = n.c.get(cName);
      const extI = c.extendables.difference(c.inactive_assets);
      if (extI.empty) continue;
      const pc = periodizedCostFor(c, extI);
      if (!pc.length) continue;
      const nominal = staticValues(c, attr, extI);
      if (n._multi_invest) {
        // PyPSA does not add the objective constant for multi-investment models
      } else {
        const active = anyActive(c, extI, null);
        terms.push(npSum(extI.values.map((_, j) => (active[j] ? 1 : 0) * pc[j] * nominal[j])));
      }
    }
    for (const t of terms) constant += t;
    n._objective_constant = constant;
    if (constant !== 0) {
      const v = m.add_variables({ name: "objective_constant", lower: constant, upper: constant });
      capexTerms.push([[v.at()], [-1]]);
    }
  } else {
    n._objective_constant = 0.0;
  }

  const weight = objectiveWeighting(n, sns);

  for (const costType of ["marginal_cost", "marginal_cost_storage", "spill_cost"]) {
    for (const [cName, attr] of lookupQuery((r) => r[costType])) {
      const c = n.c.get(cName);
      if (c.static.index.length === 0) continue;
      const varName = `${c.name}-${attr}`;
      if (!m.variables.has(varName) && costType === "spill_cost") continue;
      const names = c.active_assets;
      const cost = denseValues(c, costType, sns, names);
      if (cost.length === 0 || cost.every((x) => x === 0)) continue;
      const nN = names.length;
      const lab = labeler2(m.variables.get(varName), sns, names);
      const vars = [];
      const coeffs = [];
      for (let j = 0; j < nN; j++) {
        for (let s = 0; s < sns.length; s++) {
          vars.push(lab(s, j));
          coeffs.push(cost[s * nN + j] * weight[s]);
        }
      }
      opexTerms.push([vars, coeffs]);
    }
  }

  for (const [cName, attr] of lookupQuery((r) => r.marginal_cost_quadratic)) {
    const c = n.c.get(cName);
    if (c.static.index.length === 0 || !c.static.has("marginal_cost_quadratic")) continue;
    const names = c.static.index;
    const cost = denseValues(c, "marginal_cost_quadratic", sns, names);
    if (cost.length === 0 || cost.every((x) => x === 0)) continue;
    const nN = names.length;
    const lab = labeler2(m.variables.get(`${c.name}-${attr}`), sns, names);
    const v1 = [];
    const cs = [];
    for (let j = 0; j < nN; j++) {
      for (let s = 0; s < sns.length; s++) {
        v1.push(lab(s, j));
        cs.push(cost[s * nN + j] * weight[s]);
      }
    }
    quadTerms.push([v1, v1, cs]);
  }

  for (const cName of ["Generator", "Link", "Process"]) {
    const c = n.c.get(cName);
    const comI = c.committables.difference(c.inactive_assets);
    if (comI.empty) continue;
    const cost = denseValues(c, "stand_by_cost", sns, comI);
    if (cost.length === 0 || cost.every((x) => x === 0)) continue;
    const nN = comI.length;
    const lab = labeler2(m.variables.get(`${c.name}-status`), sns, comI);
    const vars = [];
    const coeffs = [];
    for (let j = 0; j < nN; j++) {
      for (let s = 0; s < sns.length; s++) {
        vars.push(lab(s, j));
        coeffs.push(cost[s * nN + j] * weight[s]);
      }
    }
    opexTerms.push([vars, coeffs]);
  }

  for (const [cName, attr] of Object.entries(NOMINAL_ATTRS)) {
    const c = n.c.get(cName);
    const extI = c.extendables.difference(c.inactive_assets);
    if (extI.empty) continue;
    const pc = periodizedCostFor(c, extI);
    if (pc.length === 0 || pc.every((x) => x === 0)) continue;
    let weighted;
    if (n._multi_invest) {
      weighted = extI.values.map(() => 0);
      periods.forEach((p, pi) => {
        const active = anyActive(c, extI, null, p);
        weighted = weighted.map((w, j) => w + (active[j] ? 1 : 0) * pc[j] * periodWeighting[pi]);
      });
    } else {
      const active = anyActive(c, extI, sns);
      weighted = pc.map((x, j) => (active[j] ? 1 : 0) * x);
    }
    const lab = labeler1(m.variables.get(`${c.name}-${attr}`), extI);
    capexTerms.push([extI.values.map((_, j) => lab(j)), weighted]);
  }

  for (const [cName, attr] of LOOKUP.filter((r) => r.variable === "start_up" || r.variable === "shut_down").map((r) => [r.component, r.variable])) {
    const c = n.c.get(cName);
    const comI = c.committables.difference(c.inactive_assets);
    if (comI.empty) continue;
    const cost = staticValues(c, `${attr}_cost`, comI);
    if (cost.length === 0 || cost.reduce((a, b) => a + b, 0) === 0) continue;
    const lab = labeler2(m.variables.get(`${c.name}-${attr}`), sns, comI);
    const vars = [];
    const coeffs = [];
    for (let j = 0; j < comI.length; j++) {
      for (let s = 0; s < sns.length; s++) {
        vars.push(lab(s, j));
        coeffs.push(cost[j]);
      }
    }
    opexTerms.push([vars, coeffs]);
  }

  if (!capexTerms.length && !opexTerms.length && !quadTerms.length) {
    throw new Error("Objective function could not be created. Please make sure the components have assigned costs.");
  }
  if (quadTerms.length) {
    // linopy: LinearExpression + QuadraticExpression evaluates as quad + lin,
    // so the (linear part of the) OPEX precedes the CAPEX terms
    for (const [v, c] of opexTerms) m.add_objective_terms(v, c);
    for (const [v, c] of capexTerms) m.add_objective_terms(v, c);
  } else {
    for (const [v, c] of capexTerms) m.add_objective_terms(v, c);
    for (const [v, c] of opexTerms) m.add_objective_terms(v, c);
  }
  for (const [v1, v2, c] of quadTerms) m.add_quadratic_objective_terms(v1, v2, c);
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

// ----------------------------------------------------------------------
// model creation
// ----------------------------------------------------------------------

export function create_model(
  n,
  {
    snapshots = null,
    multi_investment_periods = false,
    transmission_losses = false,
    linearized_unit_commitment = false,
    consistency_check = true,
    include_objective_constant = null,
    committable_big_m = null,
    meshed_thresholds = null,
  } = {},
) {
  const sns = as_index(n, snapshots, "snapshots");
  n._linearized_uc = linearized_unit_commitment ? 1 : 0;
  n._linearizedUcSet = true;
  n._multi_invest = multi_investment_periods ? 1 : 0;
  n._committable_big_m = committable_big_m;
  if (linearized_unit_commitment) checkNoModularCommittables(n);
  if (consistency_check && typeof n.consistency_check === "function") n.consistency_check();
  const includeConst = resolveIncludeObjectiveConstant(include_objective_constant);

  const m = new Model();
  n._model = m;
  m.parameters.snapshots = sns;

  for (const [c, attr] of lookupQuery((r) => r.nominal)) {
    V.define_nominal_variables(n, c, attr);
    V.define_modular_variables(n, c, attr);
  }
  for (const [c, attr] of lookupQuery((r) => !r.nominal && !r.handle_separately)) {
    V.define_operational_variables(n, sns, c, attr);
    V.define_status_variables(n, sns, c, linearized_unit_commitment);
    V.define_start_up_variables(n, sns, c, linearized_unit_commitment);
    V.define_shut_down_variables(n, sns, c, linearized_unit_commitment);
    C.define_committability_variables_constraints_with_fixed_upper_limit(n, sns, c, attr);
  }
  V.define_spillage_variables(n, sns);
  V.define_operational_variables(n, sns, "Store", "p");
  if (transmission_losses) for (const c of ["Line", "Transformer"]) V.define_loss_variables(n, sns, c);

  for (const [c, attr] of lookupQuery((r) => r.nominal)) {
    C.define_nominal_constraints_for_extendables(n, c, attr);
    C.define_fixed_nominal_constraints(n, c, attr);
    C.define_modular_constraints(n, c, attr);
    C.define_committability_variables_constraints_with_variable_upper_limit(n, sns, c, attr);
  }
  for (const [c, attr] of lookupQuery((r) => !r.nominal && !r.handle_separately)) {
    C.define_operational_constraints_for_non_extendables(n, sns, c, attr, transmission_losses);
    C.define_operational_constraints_for_extendables(n, sns, c, attr, transmission_losses);
    C.define_operational_constraints_for_committables(n, sns, c);
    C.define_ramp_limit_constraints(n, sns, c, attr);
    C.define_fixed_operation_constraints(n, sns, c, attr);
  }
  C.define_fixed_operation_constraints(n, sns, "StorageUnit", "p");
  C.define_fixed_operation_constraints(n, sns, "Store", "p");

  const thresholds = meshed_thresholds !== null ? [...new Set(meshed_thresholds)].sort((a, b) => a - b) : [30, 100, 400];
  const counts = getBusCounts(n);
  const busNames = n.c.buses.names;
  const busCounts = busNames.values.map((b) => counts.get(b) ?? 0);
  let prev = 0;
  for (const t of [...thresholds, Infinity]) {
    const sel = busNames.filter(busCounts.map((cnt) => (t === Infinity ? cnt > prev : cnt > prev && cnt <= t)));
    const suffix = prev > 0 ? `-meshed-${prev}` : "";
    if (!sel.empty) C.define_nodal_balance_constraints(n, sns, { transmissionLosses: transmission_losses, buses: sel, suffix });
    prev = t;
  }

  C.define_kirchhoff_voltage_constraints(n, sns);
  C.define_storage_unit_constraints(n, sns);
  C.define_store_constraints(n, sns);
  C.define_total_supply_constraints(n, sns);

  if (transmission_losses) {
    let tl = transmission_losses;
    if (tl === true) tl = { mode: "secants" };
    else if (typeof tl === "number") {
      logger.warning("Passing an int for `transmission_losses` is deprecated; use {mode: 'tangents', segments}.");
      tl = { mode: "tangents", segments: tl };
    }
    const { mode = "secants", ...rest } = tl;
    if (mode === "tangents" && rest.segments === undefined) {
      throw new Error("The 'tangents' mode requires a 'segments' key, e.g. transmission_losses={'mode': 'tangents', 'segments': 3}");
    }
    for (const c of ["Line", "Transformer"]) {
      if (mode === "secants") C.define_secant_loss_constraints(n, sns, c, rest);
      else if (mode === "tangents") C.define_tangent_loss_constraints(n, sns, c, rest.segments);
      else throw new Error(`Unknown transmission_losses mode: ${mode}`);
    }
  }

  G.define_primary_energy_limit(n, sns);
  G.define_transmission_expansion_cost_limit(n, sns);
  G.define_transmission_volume_expansion_limit(n, sns);
  G.define_tech_capacity_expansion_limit(n, sns);
  G.define_operational_limit(n, sns);
  G.define_nominal_constraints_per_bus_carrier(n, sns);
  G.define_growth_limit(n, sns);

  define_objective(n, sns, includeConst);
  return m;
}

function checkNoModularCommittables(n) {
  for (const c of ["Generator", "Link", "Process"]) {
    const comp = n.c.get(c);
    const both = comp.committables.intersection(comp.modulars);
    if (!both.empty) {
      throw new Error(`Linearized unit commitment does not support modular committable components: ${both.values.join(", ")}`);
    }
  }
}

// ----------------------------------------------------------------------
// solution assignment
// ----------------------------------------------------------------------

/** Mirrors `_set_dynamic_data`: merge df into the dynamic attribute, reindex, fillna(0). */
export function setDynamicData(n, component, attr, df) {
  const c = n.c.get(component);
  const sns = n.snapshots;
  const names = c.static.index;
  const old = c.dynamic[attr];
  const out = new DataFrame({ index: sns });
  const rowPos = df.index.length ? sns.getIndexer(df.index) : new Int32Array(0);
  const oldRowPos = old ? old.index.getIndexer(sns) : null;
  for (const nm of names) {
    const a = new Float64Array(sns.length).fill(NaN);
    if (old && old.has(nm) && old.index.length) {
      const o = old.col(nm);
      for (let i = 0; i < sns.length; i++) a[i] = oldRowPos[i] < 0 ? NaN : o[oldRowPos[i]];
    }
    if (df.has(nm)) {
      const v = df.col(nm);
      for (let i = 0; i < df.index.length; i++) {
        const p = rowPos[i];
        if (p >= 0 && !Number.isNaN(v[i])) a[p] = v[i];
      }
    }
    for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = 0.0;
    out.set(nm, a);
  }
  c.dynamic[attr] = out;
}

function solutionFrame(v, sns) {
  const names = v.coords[1];
  const lab = labeler2(v, sns, names);
  const nN = names.length;
  const data = new Map();
  names.values.forEach((nm, j) => {
    const a = new Float64Array(sns.length);
    for (let s = 0; s < sns.length; s++) a[s] = v.solution[v.coords[0].getLoc(sns.at(s)) * nN + j];
    data.set(nm, a);
  });
  void lab;
  return new DataFrame({ index: sns, columns: names, data });
}

function negFrame(df) {
  return df.applyNumeric((x) => -x);
}

function applyDelayShift(portDf, c, delayCol, cyclicCol, sns, n) {
  const st = c.static;
  if (!st.has(delayCol)) return;
  const delays = st.col(delayCol);
  const cyc = st.has(cyclicCol) ? st.col(cyclicCol) : null;
  const groups = new Map();
  st.index.values.forEach((nm, i) => {
    if (!(delays[i] > 0)) return;
    const key = `${delays[i]}|${cyc ? (cyc[i] ? 1 : 0) : 1}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(nm);
  });
  const w = weightings(n, "generators", sns);
  for (const [key, cols] of groups) {
    const [d, cy] = key.split("|").map(Number);
    const [src, valid] = getDelaySourceIndexer(sns, w, Math.trunc(d), Boolean(cy));
    for (const col of cols) {
      if (!portDf.has(col)) continue;
      const a = portDf.col(col).slice();
      const out = portDf.col(col);
      for (let s = 0; s < sns.length; s++) out[s] = valid[s] ? a[src[s]] : 0.0;
    }
  }
}

export function assign_solution(n) {
  const m = n.model;
  const sns = m.parameters.snapshots;
  for (const [name, v] of m.variables) {
    if (name === "objective_constant" || name.startsWith("CVaR")) continue;
    if (!name.includes("-")) continue;
    const k = name.indexOf("-");
    const cName = name.slice(0, k);
    const attr = name.slice(k + 1);
    if (!n.c.has(cName)) continue;
    const c = n.c.get(cName);
    if (v.dims.includes("snapshot")) {
      const df = solutionFrame(v, sns);
      if (n.passive_branch_components.has(c.name) && attr === "s") {
        setDynamicData(n, c.name, "p0", df);
        setDynamicData(n, c.name, "p1", negFrame(df));
      } else if (c.name === "Link" && attr === "p") {
        setDynamicData(n, c.name, "p", df);
        setDynamicData(n, c.name, "p0", df);
        for (const i of ["1", ...c.additional_ports]) {
          const suf = i === "1" ? "" : i;
          const eff = n.get_switchable_as_dense("Link", `efficiency${suf}`, sns);
          const portDf = df.applyNumeric((x, r, col) => -x * eff.col(col)[r]);
          applyDelayShift(portDf, c, `delay${suf}`, `cyclic_delay${suf}`, sns, n);
          setDynamicData(n, c.name, `p${i}`, portDf);
          const busCol = c.static.col(`bus${i}`);
          const def = Number(c.defaults.get(`p${i}`).default);
          const dyn = c.dynamic[`p${i}`];
          const sp = n.snapshots.getIndexer(sns);
          c.static.index.values.forEach((nm, ii) => {
            if (busCol[ii] === "") for (const p of sp) dyn.col(nm)[p] = def;
          });
        }
      } else if (c.name === "Process" && attr === "p") {
        setDynamicData(n, c.name, "p", df);
        for (const i of c.ports) {
          const rate = n.get_switchable_as_dense(c.name, `rate${i}`, sns);
          const portDf = df.applyNumeric((x, r, col) => -x * rate.col(col)[r]);
          applyDelayShift(portDf, c, `delay${i}`, `cyclic_delay${i}`, sns, n);
          setDynamicData(n, c.name, `p${i}`, portDf);
          const busCol = c.static.col(`bus${i}`);
          const def = Number(c.defaults.get(`p${i}`).default);
          const dyn = c.dynamic[`p${i}`];
          const sp = n.snapshots.getIndexer(sns);
          c.static.index.values.forEach((nm, ii) => {
            if (busCol[ii] === "") for (const p of sp) dyn.col(nm)[p] = def;
          });
        }
      } else {
        setDynamicData(n, c.name, attr, df);
      }
    } else if (attr === "n_mod") {
      // nothing
    } else {
      const col = `${attr}_opt`;
      const st = c.static;
      if (!st.has(col)) st.set(col, new Float64Array(st.index.length).fill(NaN));
      const a = st.col(col);
      v.coords[0].values.forEach((nm, j) => {
        const val = v.solution[j];
        if (!Number.isNaN(val)) a[st.index.getLoc(nm)] = val;
      });
    }
  }
  for (const [cName, attr] of lookupQuery((r) => r.nominal)) {
    const c = n.c.get(cName);
    const fix = c.fixed;
    if (fix.empty) continue;
    const st = c.static;
    const opt = st.col(`${attr}_opt`);
    const base = st.col(attr);
    for (const nm of fix) {
      const i = st.index.getLoc(nm);
      opt[i] = base[i];
    }
  }
  const su = n.c.storage_units;
  if (!su.empty) {
    const pd = su.dynamic.p_dispatch;
    const ps = su.dynamic.p_store;
    const out = new DataFrame({ index: n.snapshots });
    for (const nm of pd.columns) {
      const a = pd.col(nm);
      const b = ps.has(nm) ? ps.col(nm) : new Float64Array(a.length).fill(NaN);
      out.set(nm, Float64Array.from(a, (x, i) => x - b[i]));
    }
    su.dynamic.p = out;
  }
  n._objective = m.objectiveValue;
}

export function assign_duals(n, assignAllDuals = false) {
  const m = n.model;
  const unassigned = [];
  if ([...m.constraints.values()].every((c) => c.dual === null)) {
    logger.info("No shadow prices were assigned to the network.");
    return;
  }
  const sns = m.parameters.snapshots;
  for (const [cname, con] of m.constraints) {
    const k = cname.indexOf("-");
    if (k < 0) {
      unassigned.push(cname);
      continue;
    }
    const prefix = cname.slice(0, k);
    const suffix = cname.slice(k + 1);
    let c;
    try {
      c = n.components.get(prefix);
    } catch {
      unassigned.push(cname);
      continue;
    }
    if (c.name === "GlobalConstraint" && !c.static.index.has(suffix) && assignAllDuals) {
      // `c.static.loc[suffix] = None`: a row of missing values
      const st = c.static;
      const row = new DataFrame({ index: new Index([suffix], st.index.name) });
      for (const col of st.columns) row.set(col, isNumberArray(st.col(col)) ? Float64Array.of(NaN) : [null]);
      c.static = DataFrame.concatRows([st, row]);
    }
    if (con.dims.includes("snapshot")) {
      let dualSpec = suffix.split("-").pop();
      if (c.name === "GlobalConstraint") dualSpec = suffix;
      let attrName;
      if (suffix.endsWith("nodal_balance")) attrName = "marginal_price";
      else if (assignAllDuals || c.static.has(`mu_${dualSpec}`)) attrName = `mu_${dualSpec}`;
      else {
        unassigned.push(cname);
        continue;
      }
      // dual frame: (snapshot, name); a missing name dimension is expanded
      // over all component names
      const si = con.dims.indexOf("snapshot");
      const ni = con.dims.indexOf("name");
      const names = ni >= 0 ? con.coords[ni] : c.static.index;
      const snsC = con.coords[si];
      const data = new Map();
      names.values.forEach((nm, j) => {
        const a = new Float64Array(snsC.length);
        for (let s = 0; s < snsC.length; s++) {
          const idx = ni < 0 ? [s] : si === 0 ? [s, j] : [j, s];
          a[s] = con.dual[con.flat(...idx)];
        }
        data.set(nm, a);
      });
      setDynamicData(n, c.name, attrName, new DataFrame({ index: snsC, columns: names, data }));
    } else if (c.name === "GlobalConstraint" && c.static.index.has(suffix)) {
      c.static.setAt(suffix, "mu", con.dual[0]);
    }
  }
  if (unassigned.length) logger.info(`The shadow-prices of the constraints ${unassigned.join(", ")} were not assigned to the network.`);
  void sns;
}

export function post_processing(n) {
  const m = n.model;
  const sns = m.parameters.snapshots;
  if (typeof n._checkBigMExceeded === "function") n._checkBigMExceeded();
  const w = objectiveWeighting(n, sns);
  const mp = n.c.buses.dynamic.marginal_price;
  if (mp && mp.columns.length) {
    const sp = mp.index.getIndexer(sns);
    for (const b of mp.columns) {
      const a = mp.col(b);
      sp.forEach((p, s) => {
        if (p >= 0) a[p] = a[p] / w[s];
      });
    }
  }
  if (n.c.loads.static.index.length) setDynamicData(n, "Load", "p", n.get_switchable_as_dense("Load", "p_set", sns));
  if (m.variables.has("Line-loss")) {
    const v = m.variables.get("Line-loss");
    const losses = solutionFrame(v, sns);
    for (const attr of ["p0", "p1"]) {
      const dyn = n.c.lines.dynamic[attr];
      const sp = dyn.index.getIndexer(sns);
      for (const nm of dyn.columns) {
        if (!losses.has(nm)) {
          // pandas: aligned addition gives NaN for missing columns
          for (const p of sp) dyn.col(nm)[p] = NaN;
          continue;
        }
        const l = losses.col(nm);
        sp.forEach((p, s) => (dyn.col(nm)[p] += l[s] / 2));
      }
    }
  }
  // bus power balance
  const ca = [
    ["Generator", "p", "bus"],
    ["Store", "p", "bus"],
    ["Load", "p", "bus"],
    ["StorageUnit", "p", "bus"],
  ];
  for (const c of ["Link", "Process"]) for (const i of n.c.get(c).ports) ca.push([c, `p${i}`, `bus${i}`]);
  const buses = n.c.buses.static.index;
  const busP = new Map(buses.values.map((b) => [b, new Float64Array(n.snapshots.length)]));
  for (const [cName, attr, group] of ca) {
    const c = n.c.get(cName);
    const dyn = c.dynamic[attr];
    if (!dyn || dyn.columns.length === 0) continue;
    const signCol = c.static.has("sign") ? c.static.series("sign") : null;
    const groupCol = c.static.series(group);
    for (const nm of dyn.columns) {
      const sign = signCol ? signCol.getOr(nm, NaN) : -1;
      const bus = groupCol.getOr(nm, NaN);
      const acc = busP.get(bus);
      if (!acc) continue;
      const a = dyn.col(nm);
      for (let i = 0; i < a.length; i++) {
        const v = a[i] * sign;
        if (!Number.isNaN(v)) acc[i] += v;
      }
    }
  }
  const pdf = new DataFrame({ index: n.snapshots });
  for (const b of buses) pdf.set(b, busP.get(b));
  n.c.buses.dynamic.p = pdf;

  // voltage angles
  if (n.c.sub_networks.static.index.length === 0) n.determine_network_topology();
  if (n.c.sub_networks.static.has("obj")) {
    // pd.concat(axis=1) over sub-networks: single-bus sub-networks only cover
    // the optimised snapshots, the others all snapshots (unsorted union).
    const parts = [];
    for (const sub of n.c.sub_networks.static.col("obj")) {
      const busesO = sub.buses_o;
      if (busesO.length === 1) {
        parts.push({ index: sns, cols: busesO.values, data: [new Float64Array(sns.length)] });
        continue;
      }
      sub.calculate_B_H({ skip_pre: true });
      parts.push({ index: n.snapshots, cols: busesO.values, data: pinvApply(sub.B, busesO, pdf) });
    }
    let index = parts.length ? parts[0].index : n.snapshots;
    for (const part of parts.slice(1)) {
      if (part.index.equals(index)) continue;
      const extra = part.index.values.filter((x) => !index.has(x));
      index = new Index([...index.values, ...extra], index.names);
    }
    const vang = new DataFrame({ index });
    for (const b of buses) vang.set(b, new Float64Array(index.length));
    for (const part of parts) {
      const pos = part.index.getIndexer(index);
      part.cols.forEach((b, i) => vang.set(b, Float64Array.from(pos, (p) => (p < 0 ? NaN : part.data[i][p]))));
    }
    n.c.buses.dynamic.v_ang = vang;
  }
}

/**
 * Compute `p @ (pinv(B) - pinv(B)[slack])` per snapshot without a dense
 * pseudo-inverse: for a connected Laplacian, pinv(B) r is the mean-zero
 * solution of B theta = r - mean(r).
 */
function pinvApply(B, busesO, pdf) {
  const nb = busesO.length;
  const idx = Array.from({ length: nb - 1 }, (_, i) => i + 1);
  const lu = sparseLU(B.sub(idx, idx));
  const solveMeanZero = (rhs) => {
    let mean = 0;
    for (const x of rhs) mean += x;
    mean /= nb;
    const r1 = new Float64Array(nb - 1);
    for (let i = 1; i < nb; i++) r1[i - 1] = rhs[i] - mean;
    const sol = lu.solve(r1);
    const th = new Float64Array(nb);
    for (let i = 1; i < nb; i++) th[i] = sol[i - 1];
    let tm = 0;
    for (const x of th) tm += x;
    tm /= nb;
    for (let i = 0; i < nb; i++) th[i] -= tm;
    return th;
  };
  const e0 = new Float64Array(nb);
  e0[0] = 1;
  const zs = solveMeanZero(e0);
  const nS = pdf.index.length;
  const out = Array.from({ length: nb }, () => new Float64Array(nS));
  const cols = busesO.values.map((b) => pdf.col(b));
  for (let t = 0; t < nS; t++) {
    const p = Float64Array.from(cols, (c) => c[t]);
    let ps = 0;
    for (const x of p) ps += x;
    const th = solveMeanZero(p);
    for (let i = 0; i < nb; i++) out[i][t] = th[i] - ps * zs[i];
  }
  return out;
}

// ----------------------------------------------------------------------
// accessor
// ----------------------------------------------------------------------

export class OptimizationAccessor {
  constructor(n) {
    this._n = n;
  }

  async optimize(opts = {}) {
    const n = this._n;
    const {
      snapshots = null,
      multi_investment_periods = false,
      transmission_losses = false,
      linearized_unit_commitment = false,
      extra_functionality = null,
      assign_all_duals = false,
      solver_name = "highs",
      solver_options = {},
      log_to_console = false,
      include_objective_constant = null,
      committable_big_m = null,
      meshed_thresholds = null,
    } = opts;
    const sns = as_index(n, snapshots, "snapshots");
    n._multi_invest = multi_investment_periods ? 1 : 0;
    n._linearized_uc = linearized_unit_commitment ? 1 : 0;
    for (const c of n.components.values()) checkForUnknownBuses(n, c, true);
    const m = create_model(n, {
      snapshots: sns,
      multi_investment_periods,
      transmission_losses,
      linearized_unit_commitment,
      consistency_check: false,
      include_objective_constant,
      committable_big_m,
      meshed_thresholds,
    });
    if (extra_functionality) await extra_functionality(n, sns);
    const [status, condition] = await m.solve({ solver_name, solver_options, log_to_console });
    if (status === "ok") {
      assign_solution(n);
      assign_duals(n, assign_all_duals);
      post_processing(n);
    }
    return [status, condition];
  }

  create_model(opts = {}) {
    return create_model(this._n, opts);
  }

  async solve_model({ extra_functionality = null, solver_name = "highs", solver_options = {}, log_to_console = false, assign_all_duals = false } = {}) {
    const n = this._n;
    if (extra_functionality) await extra_functionality(n, n.snapshots);
    const [status, condition] = await n.model.solve({ solver_name, solver_options, log_to_console });
    if (status === "ok") {
      assign_solution(n);
      assign_duals(n, assign_all_duals);
      post_processing(n);
    }
    return [status, condition];
  }

  assign_solution() {
    assign_solution(this._n);
  }

  assign_duals(assignAllDuals = false) {
    assign_duals(this._n, assignAllDuals);
  }

  post_processing() {
    post_processing(this._n);
  }

  fix_optimal_capacities() {
    const n = this._n;
    for (const [cName, attr] of Object.entries(NOMINAL_ATTRS)) {
      const c = n.c.get(cName);
      const extI = c.extendables.difference(c.inactive_assets);
      const st = c.static;
      for (const nm of extI) st.setAt(nm, attr, st.at(nm, `${attr}_opt`));
      st.set(`${attr}_extendable`, st.index.values.map(() => false));
    }
  }

  fix_optimal_dispatch() {
    const n = this._n;
    for (const c of n.one_port_components) n.c.get(c).dynamic.p_set = n.c.get(c).dynamic.p.copy();
    for (const c of n.controllable_branch_components) n.c.get(c).dynamic.p_set = n.c.get(c).dynamic.p0.copy();
  }

  add_load_shedding({ suffix = " load shedding", buses = null, sign = 1e-3, marginal_cost = 1e2, p_nom = 1e9 } = {}) {
    const n = this._n;
    if (!n.c.carriers.static.index.has("Load")) n.add("Carrier", "Load");
    const b = buses ?? n.c.buses.static.index;
    return n.add("Generator", b.values ?? b, { bus: b.values ?? b, carrier: "load", sign, marginal_cost, p_nom }, { suffix, return_names: true });
  }
}

installAbstract(OptimizationAccessor);
installMGA(OptimizationAccessor);

/** Install `n.optimize(...)` callable accessor with methods. */
Network._accessorInitialisers.push((n) => {
  const acc = new OptimizationAccessor(n);
  const fn = (opts = {}) => acc.optimize(isOptions(opts) ? opts : { snapshots: opts });
  for (const name of Object.getOwnPropertyNames(OptimizationAccessor.prototype)) {
    if (name === "constructor") continue;
    fn[name] = acc[name].bind(acc);
  }
  fn._accessor = acc;
  Object.defineProperty(n, "optimize", { value: fn, writable: true, configurable: true, enumerable: false });
});

export { Index, Series };

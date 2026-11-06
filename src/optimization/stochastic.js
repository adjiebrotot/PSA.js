// SPDX-License-Identifier: MIT
/**
 * Stochastic (two-stage) optimisation for networks with scenarios.
 *
 * PyPSA builds one linopy model in which every operational variable and
 * constraint gains a `scenario` dimension while investment variables
 * (`*_nom`, `n_mod`) are shared. Row by row, that model is the union of the
 * deterministic models of the individual scenarios: the same terms (in the
 * same order), coefficients, signs and right-hand sides, only with the
 * operational variables of each scenario renumbered. PSA.js therefore builds
 * the deterministic model of every scenario (on a view of the network that
 * holds that scenario's data) and merges them into the stochastic model with
 * PyPSA's dimension order and label numbering:
 *
 * - variables `(snapshot, name)` become `(scenario, name, snapshot)`
 *   (`(snapshot, scenario, name)` for components whose `c.da` layout is
 *   snapshot-major, see `isSnapshotMajor`), variables without a snapshot
 *   dimension are shared;
 * - constraints `(snapshot, name, ...)` become `(scenario, name, snapshot, ...)`
 *   (`(snapshot, scenario, name)` for snapshot-major components, and for the
 *   nodal balance of multi-period networks or when its first contributing
 *   component is snapshot-major), `(name)` become `(name, scenario)`, `()`
 *   become `(scenario)` and constraints over other dimensions gain a leading
 *   `scenario`;
 * - sums over all names and snapshots (global constraints) list their terms
 *   name-major, following the stochastic variable layout;
 * - the objective is the probability-weighted CAPEX and OPEX of all
 *   scenarios, optionally with PyPSA's CVaR risk-aversion terms.
 */

import { Index } from "../core/index.js";
import { DataFrame, isNumberArray } from "../core/frame.js";
import { Model, Variable, unravel } from "./linopy.js";
import { scenarioView, copyFrame } from "../network/scenarios.js";
import { isSnapshotMajor } from "../network/scenario_frames.js";

export { scenarioView };

// ----------------------------------------------------------------------
// layouts
// ----------------------------------------------------------------------

/** Stochastic dims of a variable, or null if it is shared across scenarios. */
function variableDims(dims, snapshotMajor = false) {
  if (!dims.includes("snapshot")) return null;
  const rest = dims.filter((d) => d !== "snapshot" && d !== "name");
  if (snapshotMajor && dims.includes("name")) return ["snapshot", "scenario", "name", ...rest];
  return ["scenario", ...(dims.includes("name") ? ["name"] : []), "snapshot", ...rest];
}

/** Components whose operational variables are laid out (snapshot, scenario, name). */
function snapshotMajorComponents(n) {
  return new Set([...n.components.values()].filter(isSnapshotMajor).map((c) => c.name));
}

/** The component whose expression leads the nodal balance (PyPSA's `args` order). */
function nodalBalanceLead(n) {
  for (const name of ["Generator", "Store", "StorageUnit", "Line", "Transformer", "Link"]) {
    if (!n.c.get(name).static.empty) return name;
  }
  return null;
}

/** Stochastic dims of a constraint (PyPSA's xarray broadcasting order). */
function constraintDims(name, dims, multiInvest, major = new Set(), lead = null) {
  if (dims.includes("snapshot") && dims.includes("name")) {
    const rest = dims.filter((d) => d !== "snapshot" && d !== "name");
    const owner = name.split("-")[0];
    const nodal = name.endsWith("nodal_balance");
    if ((nodal && (multiInvest || major.has(lead))) || (!nodal && major.has(owner))) return ["snapshot", "scenario", "name", ...rest];
    return ["scenario", "name", "snapshot", ...rest];
  }
  if (dims.length === 1 && dims[0] === "name") return name.endsWith("-maint-event-count") ? ["scenario", "name"] : ["name", "scenario"];
  return ["scenario", ...dims];
}

/** Union of ordered name lists, keeping first-seen relative order. */
function orderedUnion(lists) {
  const out = [];
  for (const list of lists) {
    let insertAt = 0;
    for (const name of list) {
      const p = out.indexOf(name);
      if (p >= 0) {
        insertAt = p + 1;
        continue;
      }
      out.splice(insertAt, 0, name);
      insertAt++;
    }
  }
  return out;
}

/** Map from stochastic flat position to the deterministic flat position. */
function positionMap(stochDims, stochShape, stochStrides, detDims, detStrides) {
  const where = detDims.map((d) => stochDims.indexOf(d));
  return (K) => {
    const idx = unravel(K, stochShape, stochStrides);
    let k = 0;
    for (let i = 0; i < detDims.length; i++) k += idx[where[i]] * detStrides[i];
    return k;
  };
}

// ----------------------------------------------------------------------
// merge
// ----------------------------------------------------------------------

function mergeVariables(M, n, models, scenarios) {
  const S = scenarios.length;
  const maps = models.map((m) => new Int32Array(m._xCounter).fill(-1));
  const order = orderedUnion(models.map((m) => [...m.variables.keys()]));
  const cvarSlot = models[0]._cvarSlot ?? order.length;
  const cvarAfter = cvarSlot > 0 ? [...models[0].variables.keys()][cvarSlot - 1] : null;
  const info = new Map();
  const addCvar = () => {
    if (!(n.has_scenarios && n.has_risk_preference)) return;
    M.add_variables({ name: "CVaR-a", dims: ["scenario"], coords: [scenarios], lower: 0 });
    M.add_variables({ name: "CVaR-theta" });
    M.add_variables({ name: "CVaR" });
  };
  if (cvarAfter === null) addCvar();
  const major = snapshotMajorComponents(n);
  for (const name of order) {
    const dets = models.map((m) => m.variables.get(name) ?? null);
    const ref = dets.find((d) => d !== null);
    const sdims = variableDims(ref.dims, major.has(name.split("-")[0]));
    if (sdims === null) {
      // shared (first-stage) variable
      const v = new Variable(M, {
        name,
        dims: ref.dims,
        coords: ref.coords,
        start: M._xCounter,
        lower: ref.lower,
        upper: ref.upper,
        mask: Uint8Array.from(ref.labels, (l) => (l >= 0 ? 1 : 0)),
        binary: ref.binary,
        integer: ref.integer,
      });
      M._xCounter += v.size;
      M.variables.set(name, v);
      dets.forEach((d, s) => {
        if (!d) return;
        for (let k = 0; k < d.size; k++) if (d.labels[k] >= 0) maps[s][d.labels[k]] = v.labels[k];
      });
      info.set(name, { shared: true });
    } else {
      const coords = sdims.map((dim) => (dim === "scenario" ? scenarios : ref.coords[ref.dims.indexOf(dim)]));
      const shape = coords.map((c) => c.length);
      const size = shape.reduce((a, b) => a * b, 1);
      const strides = shape.map((_, i) => shape.slice(i + 1).reduce((a, b) => a * b, 1));
      const toDet = positionMap(sdims, shape, strides, ref.dims, ref.strides);
      const scPos = sdims.indexOf("scenario");
      const lower = new Float64Array(size);
      const upper = new Float64Array(size);
      const mask = new Uint8Array(size);
      const detPos = new Int32Array(size);
      for (let K = 0; K < size; K++) {
        const s = Math.floor(K / strides[scPos]) % S;
        const d = dets[s];
        const k = toDet(K);
        detPos[K] = k;
        if (!d) continue;
        lower[K] = d.lower[k];
        upper[K] = d.upper[k];
        mask[K] = d.labels[k] >= 0 ? 1 : 0;
      }
      const v = new Variable(M, { name, dims: sdims, coords, start: M._xCounter, lower, upper, mask, binary: ref.binary, integer: ref.integer });
      M._xCounter += v.size;
      M.variables.set(name, v);
      for (let K = 0; K < size; K++) {
        const s = Math.floor(K / strides[scPos]) % S;
        const d = dets[s];
        if (d && d.labels[detPos[K]] >= 0) maps[s][d.labels[detPos[K]]] = v.labels[K];
      }
      info.set(name, { shared: false });
    }
    if (name === cvarAfter) addCvar();
  }
  return { maps, info };
}

/** Variable owning a stochastic label (binary search over variable starts). */
function makeOwner(M) {
  const vars = [...M.variables.values()].sort((a, b) => a.start - b.start);
  const starts = vars.map((v) => v.start);
  return (label) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= label) lo = mid;
      else hi = mid - 1;
    }
    return vars[lo];
  };
}

/** Sort the terms of each run of one variable by label (name-major sums). */
function sortVariableRuns(vars, coeffs, owner) {
  let i = 0;
  while (i < vars.length) {
    if (vars[i] < 0) {
      i++;
      continue;
    }
    const v = owner(vars[i]);
    let j = i + 1;
    while (j < vars.length && vars[j] >= 0 && owner(vars[j]) === v) j++;
    if (j - i > 1) {
      const run = [];
      for (let t = i; t < j; t++) run.push([vars[t], coeffs[t]]);
      run.sort((a, b) => a[0] - b[0]);
      run.forEach(([x, c], t) => {
        vars[i + t] = x;
        coeffs[i + t] = c;
      });
    }
    i = j;
  }
}

function mergeConstraints(M, n, models, scenarios, maps, { extra = false, rowMaps = models.map(() => new Map()) } = {}) {
  const S = scenarios.length;
  // constraints added after building the scenario models are merged last
  const isExtra = (m, c) => m._extraStart !== undefined && c.start >= m._extraStart;
  const order = orderedUnion(
    models.map((m) =>
      [...m.constraints.values()]
        .filter((c) => isExtra(m, c) === extra)
        .sort((a, b) => a.start - b.start)
        .map((c) => c.name),
    ),
  );
  const owner = makeOwner(M);
  const multiInvest = Boolean(n._multi_invest);
  const major = snapshotMajorComponents(n);
  const lead = nodalBalanceLead(n);
  for (const name of order) {
    const dets = models.map((m) => m.constraints.get(name) ?? null);
    const ref = dets.find((d) => d !== null);
    const sdims = constraintDims(name, ref.dims, multiInvest, major, lead);
    const coords = sdims.map((dim) => (dim === "scenario" ? scenarios : ref.coords[ref.dims.indexOf(dim)]));
    const con = M.new_constraint(name, sdims, coords);
    const toDet = positionMap(sdims, con.shape, con.strides, ref.dims, ref.strides);
    const scPos = sdims.indexOf("scenario");
    const sumOrder = name.startsWith("GlobalConstraint-");
    const rowMapArr = dets.map((d) => (d ? new Int32Array(d.size).fill(-1) : null));
    for (let K = 0; K < con.size; K++) {
      const s = Math.floor(K / con.strides[scPos]) % S;
      const d = dets[s];
      if (!d) {
        con.push([], [], "=", 0, false);
        continue;
      }
      const k = toDet(K);
      rowMapArr[s][k] = K;
      const [dv, dc] = d.rawTerms(k);
      const map = maps[s];
      const vars = dv.map((l) => (l >= 0 ? map[l] : -1));
      if (sumOrder) sortVariableRuns(vars, dc, owner);
      con.push(vars, dc, d.sign[k], d.rhs[k], d.labels[k] >= 0);
    }
    M.add_constraint(con);
    dets.forEach((d, s) => d && rowMaps[s].set(name, rowMapArr[s]));
  }
  return rowMaps;
}

/** Concatenate term blocks of a scenario model, mapped to stochastic labels. */
function mapTerms(terms, map) {
  const vars = [];
  const coeffs = [];
  for (const [vs, cs] of terms) {
    for (let t = 0; t < vs.length; t++) {
      vars.push(vs[t] >= 0 ? map[vs[t]] : -1);
      coeffs.push(cs[t]);
    }
  }
  return [vars, coeffs];
}

function defineStochasticObjective(M, n, models, scenarios, maps) {
  const weights = Array.from(n.scenario_weightings.col("weight"));
  const S = scenarios.length;
  const parts = models.map((m) => m._objectiveParts);
  const quadratic = parts.some((p) => p.quadTerms.length > 0);
  if (quadratic && n.has_risk_preference) {
    throw new Error(
      "ValueError: CVaR with quadratic operational costs yields quadratic constraints. So a(s) >= OPEX(s) - theta becomes a quadratic inequality. Remove/approximate quadratic costs (e.g. set 'marginal_cost_quadratic=0' or use a piecewise-linear approximation).",
    );
  }
  // objective constant per scenario, weighted by the scenario probabilities
  const constants = parts.map((p) => p.constant);
  let weighted = 0;
  constants.forEach((c, s) => (weighted += c * weights[s]));
  n._objective_constant = parts[0].includeConstant ? weighted : 0.0;
  let objConst = null;
  if (parts[0].includeConstant && constants.some((c) => c !== 0)) {
    objConst = M.add_variables({ name: "objective_constant", dims: ["scenario"], coords: [scenarios], lower: Float64Array.from(constants), upper: Float64Array.from(constants) });
  }
  // `_combine_scenario(terms, s) * p` for CAPEX and OPEX of each scenario
  const capex = [];
  const opex = [];
  const opexBy = [];
  for (let s = 0; s < S; s++) {
    let [cv, cc] = mapTerms(parts[s].capexTerms, maps[s]);
    if (objConst) {
      cv = [objConst.labels[s], ...cv];
      cc = [-1, ...cc];
    }
    capex.push([cv, cc.map((x) => x * weights[s])]);
    const [ov, oc] = mapTerms(parts[s].opexTerms, maps[s]);
    opexBy.push([ov, oc]);
    opex.push([ov, oc.map((x) => x * weights[s])]);
  }
  if (!capex.some(([v]) => v.length) && !opex.some(([v]) => v.length)) {
    throw new Error("Objective function could not be created. Please make sure the components have assigned costs.");
  }
  if (n.has_risk_preference) {
    const { alpha, omega } = n.risk_preference;
    const a = M.variables.get("CVaR-a");
    const theta = M.variables.get("CVaR-theta");
    const cvar = M.variables.get("CVaR");
    for (let s = 0; s < S; s++) {
      // a[s] - OPEX(s) + theta >= 0
      const [ov, oc] = opexBy[s];
      M.add_constraints(`CVaR-excess-${scenarios.at(s)}`, [], [], () => [[a.labels[s], ...ov, theta.labels[0]], [1, ...oc.map((x) => -x), 1], ">=", -0.0]);
    }
    // theta + 1/(1-alpha) * sum_s p_s a[s] <= CVaR
    const invTail = 1.0 / (1.0 - alpha);
    M.add_constraints("CVaR-def", [], [], () => [[theta.labels[0], ...scenarios.values.map((_, s) => a.labels[s]), cvar.labels[0]], [1, ...weights.map((p) => invTail * p), -1], "<=", -0.0]);
    for (const [v, c] of capex) M.add_objective_terms(v, c);
    for (const [v, c] of opex) M.add_objective_terms(v, c.map((x) => (1 - omega) * x));
    M.add_objective_terms([cvar.labels[0]], [omega]);
  } else if (quadratic) {
    // `expected_capex + expected_opex` with a quadratic OPEX evaluates as
    // quad + lin in linopy: the linear OPEX terms precede the CAPEX terms
    for (const [v, c] of opex) M.add_objective_terms(v, c);
    for (const [v, c] of capex) M.add_objective_terms(v, c);
    parts.forEach((p, s) => {
      for (const [v1, v2, c] of p.quadTerms) {
        M.add_quadratic_objective_terms(
          v1.map((l) => (l >= 0 ? maps[s][l] : -1)),
          v2.map((l) => (l >= 0 ? maps[s][l] : -1)),
          c.map((x) => x * weights[s]),
        );
      }
    });
  } else {
    for (const [v, c] of capex) M.add_objective_terms(v, c);
    for (const [v, c] of opex) M.add_objective_terms(v, c);
  }
}

/**
 * Build the stochastic model from the deterministic models of the scenario
 * views (each built with `create_model(view, {_stochastic: ...})`).
 */
export function mergeScenarioModels(n, views, models) {
  const scenarios = n.scenarios;
  const M = new Model();
  M.parameters = { ...models[0].parameters };
  const { maps } = mergeVariables(M, n, models, scenarios);
  const rowMaps = mergeConstraints(M, n, models, scenarios, maps);
  defineStochasticObjective(M, n, models, scenarios, maps);
  mergeConstraints(M, n, models, scenarios, maps, { extra: true, rowMaps });
  M._stochastic = { views, models, maps, rowMaps };
  return M;
}

// ----------------------------------------------------------------------
// results
// ----------------------------------------------------------------------

/** Distribute the stochastic solution and duals to the scenario models. */
export function distributeSolution(M) {
  const { models, maps, rowMaps } = M._stochastic;
  const sol = new Map();
  for (const v of M.variables.values()) {
    if (!v.solution) continue;
    for (let k = 0; k < v.size; k++) if (v.labels[k] >= 0) sol.set(v.labels[k], v.solution[k]);
  }
  models.forEach((m, s) => {
    for (const v of m.variables.values()) {
      v.solution = new Float64Array(v.size);
      for (let k = 0; k < v.size; k++) {
        const l = v.labels[k];
        const L = l >= 0 ? maps[s][l] : -1;
        v.solution[k] = L >= 0 ? sol.get(L) ?? NaN : NaN;
      }
    }
    for (const c of m.constraints.values()) {
      const rm = rowMaps[s].get(c.name);
      const sc = M.constraints.get(c.name);
      c.dual = new Float64Array(c.size).fill(NaN);
      if (!rm || !sc || !sc.dual) continue;
      for (let k = 0; k < c.size; k++) if (rm[k] >= 0) c.dual[k] = sc.dual[rm[k]];
    }
    m.status = M.status;
    m.termination_condition = M.termination_condition;
    m.objectiveValue = M.objectiveValue;
  });
}

function concatScenarioColumns(n, frames, names) {
  const sns = frames[0].index;
  const cols = [];
  const data = new Map();
  n.scenarios.values.forEach((sc, s) => {
    for (const nm of names.values) {
      const t = [sc, nm];
      cols.push(t);
      const f = frames[s];
      data.set(t, f.has(nm) ? Float64Array.from(f.col(nm)) : new Float64Array(sns.length));
    }
  });
  return new DataFrame({ index: sns, columns: new Index(cols, ["scenario", "name"]), data });
}

/**
 * Copy the results assigned to the scenario views back to the stochastic
 * network: time series as `(scenario, name)` columns and static columns into
 * the `(scenario, name)` rows.
 */
export function collectResults(n, views, before) {
  for (const [ln, comp] of n.components) {
    if (ln === "sub_networks") continue;
    const vcomps = views.map((v) => v.c.get(ln));
    // time series written by the assignment
    for (const attr of Object.keys(vcomps[0].dynamic)) {
      const changed = vcomps.some((vc, s) => vc.dynamic[attr] !== before[s].get(`${ln}.${attr}`));
      if (!changed) continue;
      comp.dynamic[attr] = concatScenarioColumns(
        n,
        vcomps.map((vc) => vc.dynamic[attr]),
        comp.names,
      );
    }
    // static columns (dependent values, optimal capacities, topology)
    if (!comp.static.index.isMulti || comp.static.index.length === 0) continue;
    const st = comp.static;
    for (const col of vcomps[0].static.columns) {
      if (ln === "global_constraints" && col === "mu") continue;
      const vals = vcomps.map((vc) => vc.static.colOr(col, null));
      const numeric = vals.every((a) => a === null || isNumberArray(a));
      const out = numeric ? new Float64Array(st.index.length).fill(NaN) : new Array(st.index.length).fill(null);
      const existing = st.colOr(col, null);
      st.index.values.forEach(([sc, nm], i) => {
        const s = n.scenarios.getLoc(sc);
        const vc = vcomps[s];
        const p = vc.static.index.getLoc(nm);
        out[i] = p >= 0 && vals[s] ? vals[s][p] : existing ? existing[i] : out[i];
      });
      const dtype = vcomps[0].static.dtypes[col];
      st.set(col, out);
      if (dtype) st.dtypes[col] = dtype;
    }
  }
  // the topology is identical in all scenarios (sub-networks are not broadcast)
  const sub = views[0].c.sub_networks.static;
  if (sub.index.length) {
    const st = copyFrame(sub.has("obj") ? sub.dropCols(["obj"]) : sub);
    n.c.sub_networks.static = st;
  }
}

/** Snapshot of dynamic frame identities, to detect what the assignment wrote. */
export function dynamicIdentities(views) {
  return views.map((v) => {
    const out = new Map();
    for (const [ln, comp] of v.components) for (const [k, df] of Object.entries(comp.dynamic)) out.set(`${ln}.${k}`, df);
    return out;
  });
}

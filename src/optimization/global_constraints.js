// SPDX-License-Identifier: MIT
/** Global constraints (mirrors `pypsa.optimization.global_constraints`). */

import { Index } from "../core/index.js";
import { NOMINAL_ATTRS, denseValues, staticValues, weightings, npSum } from "./common.js";

/** `pandas.Series.sum()`: NaN skipped, numpy pairwise summation. */
const pandasSum = (vals) => npSum(Array.from(vals, (v) => (Number.isNaN(v) ? 0 : v)));
import { labeler1, labeler2 } from "./variables.js";
import { logger } from "../logger.js";
import { define_piecewise, optionsFor } from "./piecewise.js";

const r = (lc, rc) => -(lc - rc);

function glcsOfType(n, type) {
  const st = n.c.global_constraints.static;
  return st.index.values.map((nm, i) => [nm, i]).filter(([, i]) => st.col("type")[i] === type);
}

function glcRow(n, i) {
  const st = n.c.global_constraints.static;
  const row = {};
  for (const c of st.columns) row[c] = st.col(c)[i];
  return row;
}

function snsForPeriod(sns, period) {
  if (period === null || Number.isNaN(period)) return sns;
  return sns.filter(sns.values.map((t) => t[0] === period));
}

/** Last snapshot of every period (MultiIndex). */
function periodLastSnapshots(sns) {
  const last = new Map();
  for (const t of sns) last.set(t[0], t);
  return [...last.values()];
}

function addScalarConstraint(m, name, vars, coeffs, sign, rhs, lhsConst = 0) {
  m.add_constraints(name, [], [], () => [vars, coeffs, sign, r(lhsConst, rhs)]);
}

export function define_tech_capacity_expansion_limit(n, sns) {
  const m = n.model;
  const glcs = glcsOfType(n, "tech_capacity_expansion_limit");
  if (!glcs.length) return;
  // group by (carrier_attribute, sense, investment_period) sorted like pandas groupby
  const groups = new Map();
  for (const [name, i] of glcs) {
    const g = glcRow(n, i);
    const key = JSON.stringify([g.carrier_attribute, g.sense, Number.isNaN(g.investment_period) ? null : g.investment_period]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([name, g]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const A = JSON.parse(a);
    const B = JSON.parse(b);
    for (let k = 0; k < 3; k++) {
      if (A[k] === B[k]) continue;
      if (A[k] === null) return 1;
      if (B[k] === null) return -1;
      return A[k] < B[k] ? -1 : 1;
    }
    return 0;
  });
  for (const key of keys) {
    const [carrier, sense, period] = JSON.parse(key);
    const sign = sense === "==" ? "=" : sense;
    // per-bus terms: Map bus -> {vars, coeffs} in merged order (component blocks)
    const blocks = [];
    for (const [cName, attr] of Object.entries(NOMINAL_ATTRS)) {
      const c = n.c.get(cName);
      const st = c.static;
      if (!st.has("carrier")) continue;
      let extI = c.extendables.intersection(st.index.filter(st.col("carrier").map((x) => x === carrier)));
      extI = c.filter_by_active_assets(extI, period);
      if (extI.empty) continue;
      const bus = n.branch_components.has(cName) ? "bus0" : "bus";
      const buses = staticValues(c, bus, extI);
      const v = labeler1(m.variables.get(`${cName}-${attr}`), extI);
      const byBus = new Map();
      extI.values.forEach((_, j) => {
        if (!byBus.has(buses[j])) byBus.set(buses[j], []);
        byBus.get(buses[j]).push(v(j));
      });
      blocks.push(byBus);
    }
    if (!blocks.length) continue;
    for (const [name, g] of groups.get(key)) {
      const busGlc = g.bus || null;
      const vars = [];
      const coeffs = [];
      if (busGlc === null || (typeof busGlc === "number" && Number.isNaN(busGlc))) {
        // sum over all buses: terms ordered by (term, bus) for each merged block
        const allBuses = [...new Set(blocks.flatMap((b) => [...b.keys()]))].sort();
        // merged expression terms: per block, max group size
        const blockTerms = blocks.map((b) => {
          let mx = 0;
          for (const v of b.values()) mx = Math.max(mx, v.length);
          return mx;
        });
        let offset = 0;
        const totalTerms = blockTerms.reduce((a, b) => a + b, 0);
        const grid = Array.from({ length: totalTerms }, () => []);
        blocks.forEach((b, bi) => {
          for (let t = 0; t < blockTerms[bi]; t++) {
            for (const bus of allBuses) {
              const mem = b.get(bus) ?? [];
              grid[offset + t].push(t < mem.length ? mem[t] : -1);
            }
          }
          offset += blockTerms[bi];
        });
        for (const termRow of grid) for (const vv of termRow) {
          vars.push(vv);
          coeffs.push(1);
        }
      } else {
        for (const b of blocks) for (const vv of b.get(String(busGlc)) ?? []) {
          vars.push(vv);
          coeffs.push(1);
        }
      }
      addScalarConstraint(m, `GlobalConstraint-${name}`, vars, coeffs, sign, g.constant);
    }
  }
}

export function define_nominal_constraints_per_bus_carrier(n, sns) {
  const m = n.model;
  const bst = n.c.buses.static;
  const cols = bst.columns.values.filter((c) => c.startsWith("nom_"));
  if (cols.length) {
    logger.warning(
      "Nominal constraints per bus carrier are deprecated and will be removed in the future. Use global constraint of type 'define_tech_capacity_expansion_limit' instead.",
    );
  }
  const buses = bst.index.filter(bst.index.values.map((_, i) => cols.some((c) => !Number.isNaN(bst.col(c)[i]))));
  for (const col of cols) {
    let sign;
    if (col.startsWith("nom_min_")) sign = ">=";
    else if (col.startsWith("nom_max_")) sign = "<=";
    else {
      logger.warning(`Bus column '${col}' has invalid specification and cannot be interpreted as constraint`);
      continue;
    }
    const remainder = col.slice("nom_max_".length);
    let carrier;
    let period = null;
    if (n.c.carriers.static.index.has(remainder)) carrier = remainder;
    else if (n.snapshots.isMulti) {
      const k = remainder.lastIndexOf("_");
      carrier = remainder.slice(0, k);
      period = Number(remainder.slice(k + 1));
      if (!n.c.carriers.static.index.has(carrier) || !sns.uniqueLevel(0).has(period)) continue;
    } else continue;
    const blocks = [];
    for (const [cName, attr] of Object.entries(NOMINAL_ATTRS)) {
      const c = n.c.get(cName);
      const st = c.static;
      if (!n.one_port_components.has(cName) || !st.has("carrier")) continue;
      let extI = c.extendables.intersection(st.index.filter(st.col("carrier").map((x) => x === carrier)));
      extI = c.filter_by_active_assets(extI, period);
      if (extI.empty) continue;
      const busOf = staticValues(c, "bus", extI);
      const v = labeler1(m.variables.get(`${cName}-${attr}`), extI);
      const byBus = new Map();
      extI.values.forEach((_, j) => {
        if (!byBus.has(busOf[j])) byBus.set(busOf[j], []);
        byBus.get(busOf[j]).push(v(j));
      });
      let mx = 0;
      for (const vv of byBus.values()) mx = Math.max(mx, vv.length);
      blocks.push({ byBus, mx });
    }
    if (!blocks.length) continue;
    const rhs = staticValues({ static: bst }, col, buses);
    m.add_constraints(`Bus-${col}`, [buses.name ?? "name"], [buses], (j) => {
      const b = buses.at(j);
      const vars = [];
      const coeffs = [];
      for (const { byBus, mx } of blocks) {
        const mem = byBus.get(b) ?? [];
        for (let t = 0; t < mx; t++) {
          vars.push(t < mem.length ? mem[t] : -1);
          coeffs.push(1);
        }
      }
      return [vars, coeffs, sign, r(0, rhs[j]), !Number.isNaN(rhs[j])];
    });
  }
}

export function define_growth_limit(n, sns) {
  if (!n._multi_invest) return;
  const m = n.model;
  const periods = sns.uniqueLevel(0);
  const cst = n.c.carriers.static;
  const maxGrowth = cst.col("max_growth");
  const maxRel = cst.col("max_relative_growth");
  const carrierI = cst.index.filter(Array.from(maxGrowth, (v) => v !== Infinity));
  if (carrierI.empty) return;
  const absGrowth = carrierI.values.map((c) => maxGrowth[cst.index.getLoc(c)]);
  const relGrowth = carrierI.values.map((c) => Math.max(maxRel[cst.index.getLoc(c)], 0));
  // per (period, carrier) terms
  const blocks = [];
  for (const [cName, attr] of Object.entries(NOMINAL_ATTRS)) {
    const c = n.c.get(cName);
    const st = c.static;
    if (!st.has("carrier")) continue;
    const carrierMap = st.series("carrier");
    const matches = st.index.filter(st.col("carrier").map((x) => carrierI.has(x)));
    const limited = matches.intersection(c.filter_by_active_assets(c.extendables));
    if (limited.empty) continue;
    const activeP = periods.values.map((p) => c.get_active_assets(p));
    const firstActive = limited.values.map((nm) => {
      let cum = 0;
      return periods.values.map((_, pi) => {
        cum += activeP[pi].get(nm) ? 1 : 0;
        return cum === 1 && activeP[pi].get(nm);
      });
    });
    const v = labeler1(m.variables.get(`${cName}-${attr}`), limited);
    const carriers = limited.values.map((nm) => carrierMap.get(nm));
    const uniq = [...new Set(carriers)].sort();
    const hasRel = uniq.some((cc) => relGrowth[carrierI.getLoc(cc)] > 0);
    const groups = new Map(uniq.map((cc) => [cc, []]));
    limited.values.forEach((_, j) => groups.get(carriers[j]).push(j));
    let mx = 0;
    for (const g of groups.values()) mx = Math.max(mx, g.length);
    blocks.push({ v, firstActive, groups, mx, hasRel });
  }
  if (!blocks.length) return;
  const allCarriers = [...new Set(blocks.flatMap((b) => [...b.groups.keys()]))].sort();
  m.add_constraints("Carrier-growth_limit", ["periods", "Carrier"], [periods, new Index(allCarriers, "Carrier")], (pi, ci) => {
    const carrier = allCarriers[ci];
    const vars = [];
    const coeffs = [];
    for (const b of blocks) {
      const g = b.groups.get(carrier) ?? [];
      const term = (p) => {
        const out = [];
        for (let t = 0; t < b.mx; t++) {
          const j = g[t];
          out.push(j !== undefined && b.firstActive[j][p] ? b.v(j) : -1);
        }
        return out;
      };
      const cur = term(pi);
      for (const vv of cur) {
        vars.push(vv);
        coeffs.push(1);
      }
      if (b.hasRel) {
        const rel = relGrowth[carrierI.getLoc(carrier)];
        const prev = pi === 0 ? cur.map(() => -1) : term(pi - 1);
        for (const vv of prev) {
          vars.push(vv);
          coeffs.push(-rel);
        }
      }
    }
    const rhs = absGrowth[carrierI.getLoc(carrier)];
    return [vars, coeffs, "<=", r(0, rhs ?? NaN)];
  });
}

/** Storage terms for primary energy / operational limit constraints. */
function storageTerms(n, sns, snsSel, comp, varName, initAttr, cyclicAttr, perPeriodAttr, em, period, vars, coeffs, constAcc, label, kindName) {
  const c = n.c.get(comp);
  const st = c.static;
  let sel = st.index.filter(st.index.values.map((nm, i) => em.has(st.col("carrier")[i]) && !st.col(cyclicAttr)[i]));
  sel = c.filter_by_active_assets(sel, period);
  if (sel.empty) return;
  const emPu = sel.values.map((nm) => em.get(st.at(nm, "carrier")));
  const v = labeler2(n.model.variables.get(varName), snsSel, sel);
  const nS = snsSel.length;
  const lastLabel = (j) => {
    // ffill along snapshot then take last
    let lab = -1;
    for (let s = 0; s < nS; s++) {
      const l = v(s, j);
      if (l !== -1) lab = l;
    }
    return lab;
  };
  const init = staticValues(c, initAttr, sel);
  if (n._multi_invest) {
    const periodWeighting = n.investment_period_weightings.series("years").reindex(sns.uniqueLevel(0).values);
    const perPeriodFlag = staticValues(c, perPeriodAttr, sel);
    const continuous = sel.values.map((_, j) => !perPeriodFlag[j]);
    if (continuous.some(Boolean) && Array.from(periodWeighting.values).some((x) => x !== 1)) {
      throw new Error(
        `Found non-cyclic ${kindName} with associated carrier emissions and continuous depletion over multiple investment periods combined with investment period year weightings != 1. The ${label} constraint will be inconsistent.`,
      );
    }
    if (continuous.some(Boolean) && Array.from(periodWeighting.values).every((x) => x === 1)) {
      const js = sel.values.map((_, j) => j).filter((j) => continuous[j]);
      for (const j of js) {
        vars.push(lastLabel(j));
        coeffs.push(-emPu[j]);
      }
      let dot = 0;
      for (const j of js) dot += emPu[j] * init[j];
      constAcc.value += dot;
    }
    const pp = sel.values.map((_, j) => j).filter((j) => perPeriodFlag[j]);
    if (pp.length) {
      const lastSns = periodLastSnapshots(snsSel);
      const vfull = labeler2(n.model.variables.get(varName), sns, sel);
      for (const t of lastSns) {
        const s = sns.getLoc(t);
        const w = periodWeighting.get(t[0]);
        for (const j of pp) {
          vars.push(vfull(s, j));
          coeffs.push(-1 * w * emPu[j]);
          constAcc.value += init[j] * w * emPu[j];
        }
      }
    }
  } else {
    sel.values.forEach((_, j) => {
      vars.push(lastLabel(j));
      coeffs.push(-emPu[j]);
    });
    let dot = 0;
    sel.values.forEach((_, j) => (dot += emPu[j] * init[j]));
    constAcc.value += dot;
  }
}

export function define_primary_energy_limit(n, sns, piecewiseOptions = []) {
  const m = n.model;
  const glcs = glcsOfType(n, "primary_energy");
  const gcAll = n.c.generators;
  const pwSchemaEff = gcAll._piecewise_schema("efficiency");
  let pePw = null;
  if (glcs.length && pwSchemaEff && m.variables.has("Generator-p")) {
    const status = gcAll.committables.intersection(gcAll.active_assets).empty ? null : m.variables.get("Generator-status");
    pePw = define_piecewise(n, gcAll, {
      xVar: m.variables.get("Generator-p"),
      sns,
      pwAttr: "efficiency",
      auxVarName: `Generator-${pwSchemaEff.aux_variable}`,
      activeNames: gcAll.active_assets,
      sign: "=",
      cumulativeAttr: false,
      extraOptions: optionsFor(piecewiseOptions, "Generator", "efficiency"),
      invertAttr: true,
      status,
    });
  }
  for (const [name, i] of glcs) {
    const glc = glcRow(n, i);
    let snsSel;
    if (Number.isNaN(glc.investment_period)) snsSel = sns;
    else if (!n._multi_invest) {
      throw new Error(`GlobalConstraint '${name}' sets \`investment_period\`, but the network has no investment periods.`);
    } else if (sns.isMulti && sns.uniqueLevel(0).has(glc.investment_period)) snsSel = snsForPeriod(sns, glc.investment_period);
    else continue;
    const cst = n.c.carriers.static;
    const emCol = cst.col(glc.carrier_attribute);
    const em = new Map();
    cst.index.values.forEach((cc, k) => {
      if (emCol[k] !== 0) em.set(cc, emCol[k]);
    });
    if (!em.size) continue;
    const period = n._multi_invest ? glc.investment_period : null;
    const vars = [];
    const coeffs = [];
    const constAcc = { value: 0 };
    // generators
    const gc = n.c.generators;
    let gens = gc.static.index.filter(gc.static.col("carrier").map((x) => em.has(x)));
    gens = gc.filter_by_active_assets(gens, Number.isNaN(period) ? null : period);
    if (!gens.empty) {
      const w = weightingsFor(n, sns, snsSel, "generators");
      const pwNames = pePw ? gens.intersection(pePw.names) : new Index([], "name");
      if (pwNames.empty) {
        const eff = denseValues(gc, "efficiency", snsSel, gens);
        const v = labeler2(m.variables.get("Generator-p"), snsSel, gens);
        const nN = gens.length;
        const carriers = staticValues(gc, "carrier", gens);
        for (let s = 0; s < snsSel.length; s++) {
          for (let j = 0; j < nN; j++) {
            vars.push(v(s, j));
            // `(p / efficiency) * weight * emission_rate` in linopy's operation order
            coeffs.push((1 / eff[s * nN + j]) * w[s] * em.get(carriers[j]));
          }
        }
      } else {
        // piecewise primary energy for `pw_names`, `p / efficiency` for the rest;
        // the outer join of both expressions sorts the names
        const linear = gens.difference(pwNames);
        const order = linear.empty ? pwNames : pwNames.union(linear);
        const isPw = order.values.map((nm) => pwNames.has(nm));
        const vPw = labeler2(pePw.variable, snsSel, order);
        const vLin = labeler2(m.variables.get("Generator-p"), snsSel, order);
        const eff = denseValues(gc, "efficiency", snsSel, order);
        const carriers = staticValues(gc, "carrier", order);
        const nN = order.length;
        for (let s = 0; s < snsSel.length; s++) {
          for (let j = 0; j < nN; j++) {
            const e = em.get(carriers[j]);
            if (isPw[j]) {
              vars.push(vPw(s, j));
              coeffs.push(w[s] * e);
            } else {
              vars.push(vLin(s, j));
              coeffs.push((1 / eff[s * nN + j]) * w[s] * e);
            }
          }
        }
      }
    }
    const per = Number.isNaN(period) ? null : period;
    storageTerms(n, sns, snsSel, "StorageUnit", "StorageUnit-state_of_charge", "state_of_charge_initial", "cyclic_state_of_charge", "state_of_charge_initial_per_period", em, per, vars, coeffs, constAcc, "primary energy", "storage units");
    storageTerms(n, sns, snsSel, "Store", "Store-e", "e_initial", "e_cyclic", "e_initial_per_period", em, per, vars, coeffs, constAcc, "primary energy", "stores");
    if (!vars.length && constAcc.value === 0) continue;
    addScalarConstraint(m, `GlobalConstraint-${name}`, vars, coeffs, glc.sense === "==" ? "=" : glc.sense, glc.constant, constAcc.value);
  }
}

/** Snapshot weightings for selected snapshots, multiplied by period years if multi-invest. */
function weightingsFor(n, sns, snsSel, column) {
  const w = weightings(n, column, snsSel);
  if (n._multi_invest) {
    const pw = n.investment_period_weightings;
    for (let s = 0; s < snsSel.length; s++) w[s] *= pw.at(snsSel.at(s)[0], "years");
  }
  return w;
}

export function define_operational_limit(n, sns) {
  const m = n.model;
  const glcs = glcsOfType(n, "operational_limit");
  for (const [name, i] of glcs) {
    const glc = glcRow(n, i);
    let snsSel;
    if (Number.isNaN(glc.investment_period)) snsSel = sns;
    else if (!n._multi_invest) {
      throw new Error(`GlobalConstraint '${name}' sets \`investment_period\`, but the network has no investment periods.`);
    } else if (sns.isMulti && sns.uniqueLevel(0).has(glc.investment_period)) snsSel = snsForPeriod(sns, glc.investment_period);
    else continue;
    const vars = [];
    const coeffs = [];
    const constAcc = { value: 0 };
    const gc = n.c.generators;
    const gst = gc.static;
    const gens = gst.index.filter(gst.index.values.map((_, k) => gst.col("carrier")[k] === glc.carrier_attribute && gst.col("active")[k]));
    if (!gens.empty) {
      const w = weightingsFor(n, sns, snsSel, "generators");
      const v = labeler2(m.variables.get("Generator-p"), snsSel, gens);
      for (let s = 0; s < snsSel.length; s++) {
        for (let j = 0; j < gens.length; j++) {
          vars.push(v(s, j));
          coeffs.push(w[s]);
        }
      }
    }
    const em = new Map([[glc.carrier_attribute, 1]]);
    for (const [comp, varName, initAttr, cyclicAttr, ppAttr, kind] of [
      ["StorageUnit", "StorageUnit-state_of_charge", "state_of_charge_initial", "cyclic_state_of_charge", "state_of_charge_initial_per_period", "storage units"],
      ["Store", "Store-e", "e_initial", "e_cyclic", "e_initial_per_period", "stores"],
    ]) {
      const c = n.c.get(comp);
      const st = c.static;
      const sel = st.index.filter(
        st.index.values.map((_, k) => st.col("carrier")[k] === glc.carrier_attribute && !st.col(cyclicAttr)[k] && st.col("active")[k]),
      );
      if (sel.empty) continue;
      const v = labeler2(m.variables.get(varName), snsSel, sel);
      const init = staticValues(c, initAttr, sel);
      const nS = snsSel.length;
      const lastLabel = (j) => {
        let lab = -1;
        for (let s = 0; s < nS; s++) {
          const l = v(s, j);
          if (l !== -1) lab = l;
        }
        return lab;
      };
      if (n._multi_invest) {
        const periodWeighting = n.investment_period_weightings.series("years").reindex(snsSel.uniqueLevel(0).values);
        const ppFlag = staticValues(c, ppAttr, sel);
        const cont = sel.values.map((_, j) => !ppFlag[j]);
        if (cont.some(Boolean) && Array.from(periodWeighting.values).some((x) => x !== 1)) {
          throw new Error(`Found non-cyclic ${kind} with continuous depletion over multiple investment periods combined with investment period year weightings != 1.`);
        }
        if (cont.some(Boolean) && Array.from(periodWeighting.values).every((x) => x === 1)) {
          const inits = [];
          sel.values.forEach((_, j) => {
            if (!cont[j]) return;
            vars.push(lastLabel(j));
            coeffs.push(-1);
            inits.push(init[j]);
          });
          constAcc.value += pandasSum(inits);
        }
        const pp = sel.values.map((_, j) => j).filter((j) => ppFlag[j]);
        if (pp.length) {
          const vfull = labeler2(m.variables.get(varName), sns, sel);
          for (const t of periodLastSnapshots(snsSel)) {
            const s = sns.getLoc(t);
            const w = periodWeighting.get(t[0]);
            for (const j of pp) {
              vars.push(vfull(s, j));
              coeffs.push(-1 * w);
              constAcc.value += init[j] * w;
            }
          }
        }
      } else {
        sel.values.forEach((_, j) => {
          vars.push(lastLabel(j));
          coeffs.push(-1);
        });
        constAcc.value += pandasSum(Array.from(sel.values, (_, j) => init[j]));
      }
      void em;
    }
    if (!vars.length) continue;
    addScalarConstraint(m, `GlobalConstraint-${name}`, vars, coeffs, glc.sense === "==" ? "=" : glc.sense, glc.constant, constAcc.value);
  }
}

function parseCarriers(attr) {
  return String(attr)
    .split(",")
    .map((c) => c.trim().replace(/[[\]()]/g, ""));
}

export function define_transmission_volume_expansion_limit(n, sns) {
  const m = n.model;
  const glcs = glcsOfType(n, "transmission_volume_expansion_limit");
  for (const [name, i] of glcs) {
    const glc = glcRow(n, i);
    const car = parseCarriers(glc.carrier_attribute);
    const period = glc.investment_period;
    let periodFilter;
    if (!Number.isNaN(period)) periodFilter = period;
    else if (sns.isMulti) periodFilter = sns.uniqueLevel(0).values;
    else periodFilter = null;
    const vars = [];
    const coeffs = [];
    for (const cName of ["Line", "Link"]) {
      const c = n.c.get(cName);
      const attr = NOMINAL_ATTRS[cName];
      const eligible = c.static.index.filter(c.static.col("carrier").map((x) => car.includes(x)));
      let extI = c.extendables.intersection(eligible);
      extI = c.filter_by_active_assets(extI, periodFilter);
      if (extI.empty) continue;
      const length = staticValues(c, "length", extI);
      const v = labeler1(m.variables.get(`${cName}-${attr}`), extI);
      extI.values.forEach((_, j) => {
        vars.push(v(j));
        coeffs.push(length[j]);
      });
    }
    if (!vars.length) continue;
    addScalarConstraint(m, `GlobalConstraint-${name}`, vars, coeffs, glc.sense === "==" ? "=" : glc.sense, glc.constant);
  }
}

export function define_transmission_expansion_cost_limit(n, sns) {
  const m = n.model;
  const glcs = glcsOfType(n, "transmission_expansion_cost_limit");
  for (const [name, i] of glcs) {
    const glc = glcRow(n, i);
    const car = parseCarriers(glc.carrier_attribute);
    const period = glc.investment_period;
    let periodFilter;
    let weights;
    if (!Number.isNaN(period)) {
      periodFilter = period;
      weights = 1;
    } else if (sns.isMulti) {
      periodFilter = sns.uniqueLevel(0).values;
      weights = null;
    } else {
      periodFilter = null;
      weights = 1;
    }
    const vars = [];
    const coeffs = [];
    for (const cName of ["Line", "Link"]) {
      const c = n.c.get(cName);
      const attr = NOMINAL_ATTRS[cName];
      const eligible = c.static.index.filter(c.static.col("carrier").map((x) => car.includes(x)));
      let extI = c.extendables.intersection(eligible);
      extI = c.filter_by_active_assets(extI, periodFilter);
      if (extI.empty) continue;
      let compWeights;
      if (weights === null) {
        const pw = n.investment_period_weightings;
        compWeights = extI.values.map((nm) => {
          let w = 0;
          for (const p of periodFilter) if (c.get_active_assets(p).get(nm)) w += pw.at(p, "objective");
          return w;
        });
      } else compWeights = extI.values.map(() => weights);
      // annuitised investment cost (`c.capital_cost`, without fixed O&M)
      const ccAll = c.capital_cost;
      const cc = extI.values.map((nm) => ccAll[c.static.index.getLoc(nm)]);
      const v = labeler1(m.variables.get(`${cName}-${attr}`), extI);
      extI.values.forEach((_, j) => {
        vars.push(v(j));
        coeffs.push(cc[j] * compWeights[j]);
      });
    }
    if (!vars.length) continue;
    addScalarConstraint(m, `GlobalConstraint-${name}`, vars, coeffs, glc.sense === "==" ? "=" : glc.sense, glc.constant);
  }
}

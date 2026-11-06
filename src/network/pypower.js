// SPDX-License-Identifier: MIT
/**
 * Import from PYPOWER's PPC format version 2 (mirrors PyPSA's
 * `import_from_pypower_ppc`): `ppc` is `{version, baseMVA, bus, gen, branch}`
 * with the matrices as arrays of rows (or anything indexable as `m[i][j]`).
 */

import { Network } from "./network.js";
import { logger } from "../logger.js";

const BUS_COLUMNS = ["type", "Pd", "Qd", "Gs", "Bs", "area", "v_mag_pu_set", "v_ang_set", "v_nom", "zone", "v_mag_pu_max", "v_mag_pu_min"];
const GEN_COLUMNS = ["bus", "p_set", "q_set", "q_max", "q_min", "v_set_pu", "mva_base", "status", "p_nom", "p_min", "Pc1", "Pc2", "Qc1min", "Qc1max", "Qc2min", "Qc2max", "ramp_agc", "ramp_10", "ramp_30", "ramp_q", "apf"];
const BRANCH_COLUMNS = ["bus0", "bus1", "r", "x", "b", "s_nom", "rateB", "rateC", "tap_ratio", "phase_shift", "status", "v_ang_min", "v_ang_max"];
const CONTROLS = ["", "PQ", "PV", "Slack"];

const rowsOf = (m) => Array.from(m, (r) => Array.from(r, Number));
const column = (rows, j) => rows.map((r) => r[j]);

/** `{col: values}` of the first `columns.length` columns of a matrix. */
function frame(rows, columns, offset = 0) {
  return Object.fromEntries(columns.map((c, j) => [c, column(rows, j + offset)]));
}

function pick(df, idx) {
  return Object.fromEntries(Object.entries(df).map(([k, v]) => [k, idx.map((i) => v[i])]));
}

/**
 * Import a PYPOWER case (`{version, baseMVA, bus, gen, branch, ...}` with matrices as arrays), like PyPSA's importer.
 */
Network.prototype.import_from_pypower_ppc = function importFromPypowerPpc(ppc, { overwrite_zero_s_nom = null } = {}) {
  if (Math.trunc(Number(ppc.version)) !== 2) logger.warning("Warning, importing from PYPOWER may not work if PPC version is not 2!");
  logger.warning("Warning: Note that when importing from PYPOWER, some PYPOWER features not supported: areas, gencosts, component status");
  const baseMVA = Number(ppc.baseMVA);

  // buses
  const busRows = rowsOf(ppc.bus);
  const busNames = busRows.map((r) => Math.trunc(r[0]));
  const buses = frame(busRows, BUS_COLUMNS, 1);
  if (buses.v_nom.some((v) => v === 0)) {
    logger.warning("Warning, some buses have nominal voltage of 0., setting the nominal voltage of these to 1.");
    buses.v_nom = buses.v_nom.map((v) => (v === 0 ? 1 : v));
  }
  const control = buses.type.map((t) => CONTROLS[Math.trunc(t)]);
  delete buses.type;
  buses.control = control;
  const vNomOf = new Map(busNames.map((b, i) => [b, buses.v_nom[i]]));

  // loads and shunt impedances at buses with demand / shunts
  const nonzero = (...cols) => busNames.map((_, i) => i).filter((i) => cols.some((c) => buses[c][i] !== 0));
  const li = nonzero("Pd", "Qd");
  const loads = { p_set: li.map((i) => buses.Pd[i]), q_set: li.map((i) => buses.Qd[i]), bus: li.map((i) => busNames[i]) };
  const si = nonzero("Gs", "Bs");
  const shunts = {
    g: si.map((i) => buses.Gs[i] / buses.v_nom[i] ** 2),
    b: si.map((i) => buses.Bs[i] / buses.v_nom[i] ** 2),
    bus: si.map((i) => busNames[i]),
  };

  // generators
  const genRows = rowsOf(ppc.gen);
  const gens = frame(genRows, GEN_COLUMNS);
  gens.bus = genRows.map((r) => Math.trunc(r[0]));

  // branches, split into lines and transformers
  const brRows = rowsOf(ppc.branch);
  const br = frame(brRows, BRANCH_COLUMNS);
  br.original_index = brRows.map((_, i) => i);
  br.bus0 = br.bus0.map(Math.trunc);
  br.bus1 = br.bus1.map(Math.trunc);
  const zero = br.s_nom.filter((s) => s === 0).length;
  if (zero) {
    if (overwrite_zero_s_nom !== null) br.s_nom = br.s_nom.map((s) => (s === 0 ? overwrite_zero_s_nom : s));
    else {
      logger.warning(
        `Warning: there are ${zero} branches with s_nom equal to zero, they will probably lead to infeasibilities and should be replaced with a high value using the \`overwrite_zero_s_nom\` argument.`,
      );
    }
  }
  const v0 = br.bus0.map((b) => vNomOf.get(b) ?? NaN);
  const v1 = br.bus1.map((b) => vNomOf.get(b) ?? NaN);
  const isTrafo = brRows.map((_, i) => v0[i] !== v1[i] || (br.tap_ratio[i] !== 0 && br.tap_ratio[i] !== 1) || br.phase_shift[i] !== 0);
  const ti = brRows.map((_, i) => i).filter((i) => isTrafo[i]);
  const lj = brRows.map((_, i) => i).filter((i) => !isTrafo[i]);
  const trafos = pick(br, ti);
  const lines = pick(br, lj);
  delete lines.tap_ratio;
  delete lines.phase_shift;
  trafos.r = trafos.r.map((r, k) => (r * trafos.s_nom[k]) / baseMVA);
  trafos.x = trafos.x.map((x, k) => (x * trafos.s_nom[k]) / baseMVA);
  trafos.b = trafos.b.map((b, k) => (b * baseMVA) / trafos.s_nom[k]);
  const lv = lj.map((i) => v0[i]);
  lines.r = lines.r.map((r, k) => (lv[k] ** 2 * r) / baseMVA);
  lines.x = lines.x.map((x, k) => (lv[k] ** 2 * x) / baseMVA);
  lines.b = lines.b.map((b, k) => (b * baseMVA) / lv[k] ** 2);
  if (trafos.tap_ratio.some((t) => t === 0)) {
    logger.warning("Warning, some transformers have a tap ratio of 0., setting the tap ratio of these to 1.");
    trafos.tap_ratio = trafos.tap_ratio.map((t) => (t === 0 ? 1 : t));
  }

  const names = (prefix, k) => Array.from({ length: k }, (_, i) => `${prefix}${i}`);
  this.add("Bus", busNames, buses);
  this.add("Load", names("L", li.length), loads);
  this.add("Generator", names("G", genRows.length), gens);
  this.add("Line", names("L", lj.length), lines);
  this.add("Transformer", names("T", ti.length), trafos);
  this.add("ShuntImpedance", names("S", si.length), shunts);

  // generators take the control of their bus; buses the generators' voltage set points
  const bs = this.c.buses.static;
  const gs = this.c.generators.static;
  const busControl = bs.col("control");
  gs.set(
    "control",
    Array.from(gs.col("bus"), (b) => busControl[bs.index.getLoc(b)]),
  );
  const vset = bs.col("v_mag_pu_set");
  Array.from(gs.col("bus")).forEach((b, i) => (vset[bs.index.getLoc(b)] = gs.col("v_set_pu")[i]));
  return this;
};

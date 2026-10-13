// SPDX-License-Identifier: MIT
/**
 * Power flow (mirrors `pypsa.network.power_flow`): dependent values,
 * network topology, sub-networks, linear (DC) and non-linear (AC
 * Newton-Raphson) power flow, PTDF/BODF.
 */

import { DataFrame, Series } from "../core/frame.js";
import { Index, labelKey } from "../core/index.js";
import { CSC, diag, sparseLU, normInf } from "../linalg/sparse.js";
import { Network, updatePortsComponentAttrs } from "./network.js";
import { GraphMixin, connectedComponents, cycleBasis, bfsRefinedCycleBasis } from "./graph.js";
import { as_index, isOptions } from "../common.js";
import { logger } from "../logger.js";

// ----------------------------------------------------------------------
// complex helpers (arrays of [re, im])
// ----------------------------------------------------------------------

function cdiv(ar, ai, br, bi) {
  const d = br * br + bi * bi;
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
}

function cmul(ar, ai, br, bi) {
  return [ar * br - ai * bi, ar * bi + ai * br];
}

// ----------------------------------------------------------------------
// dependent values
// ----------------------------------------------------------------------

function seriesMap(values, mapping) {
  // mapping: Series; returns array (NaN when missing)
  return Array.from(values, (v) => mapping.getOr(v, NaN));
}

function warnTypeParamOverride(component, current, newVals, attrs, names) {
  const overridden = [];
  names.forEach((nm, i) => {
    for (const a of attrs) {
      const cur = current[a][i];
      const nv = newVals[a][i];
      if (cur !== 0 && !(Math.abs(cur - nv) <= 1e-8 + 1e-5 * Math.abs(nv))) {
        overridden.push(nm);
        break;
      }
    }
  });
  if (overridden.length) {
    logger.warning(
      `${component} ${JSON.stringify(overridden)} have a 'type' set; the manually provided values for ${attrs.join(", ")} are overridden by the standard type. Set 'type' to "" to keep manual values.`,
    );
  }
}

export function apply_line_types(n) {
  const lines = n.c.lines.static;
  const types = lines.col("type");
  const sel = [];
  types.forEach((t, i) => t !== "" && sel.push(i));
  if (!sel.length) return;
  const lt = n.c.line_types.static;
  const missing = [...new Set(sel.map((i) => types[i]))].filter((t) => !lt.index.has(t));
  if (missing.length) throw new Error(`The type(s) ${missing.join(", ")} do(es) not exist in n.c.line_types.static`);
  const length = lines.col("length");
  const np = lines.col("num_parallel");
  const newVals = { r: [], x: [], b: [] };
  const cur = { r: [], x: [], b: [] };
  for (const i of sel) {
    const t = lt.row(types[i]);
    newVals.r.push((t.r_per_length * length[i]) / np[i]);
    newVals.x.push((t.x_per_length * length[i]) / np[i]);
    newVals.b.push(2 * Math.PI * 1e-9 * t.f_nom * t.c_per_length * length[i] * np[i]);
    for (const a of ["r", "x", "b"]) cur[a].push(lines.col(a)[i]);
  }
  warnTypeParamOverride("Line(s)", cur, newVals, ["r", "x", "b"], sel.map((i) => lines.index.at(i)));
  for (const a of ["r", "x", "b"]) {
    const col = lines.col(a);
    sel.forEach((i, k) => (col[i] = newVals[a][k]));
  }
}

export function apply_transformer_types(n) {
  const tr = n.c.transformers.static;
  const types = tr.col("type");
  const sel = [];
  types.forEach((t, i) => t !== "" && sel.push(i));
  if (!sel.length) return;
  const tt = n.c.transformer_types.static;
  const missing = [...new Set(sel.map((i) => types[i]))].filter((t) => !tt.index.has(t));
  if (missing.length) throw new Error(`The type(s) ${missing.join(", ")} do(es) not exist in n.transformer_types`);
  const attrs = ["r", "x", "g", "b", "phase_shift", "s_nom", "tap_side", "tap_ratio"];
  const vals = Object.fromEntries(attrs.map((a) => [a, []]));
  const cur = Object.fromEntries(["r", "x", "g", "b", "s_nom"].map((a) => [a, []]));
  for (const i of sel) {
    const t = tt.row(types[i]);
    const np = tr.col("num_parallel")[i];
    let r = t.vscr / 100.0;
    let x = Math.sqrt((t.vsc / 100.0) ** 2 - r ** 2);
    let g = t.pfe / (1000.0 * t.s_nom);
    let b = -Math.sqrt(Math.max((t.i0 / 100.0) ** 2 - g ** 2, 0));
    r /= np;
    x /= np;
    b *= np;
    g *= np;
    const tapRatio = 1.0 + (tr.col("tap_position")[i] - t.tap_neutral) * (t.tap_step / 100.0);
    vals.r.push(r);
    vals.x.push(x);
    vals.g.push(g);
    vals.b.push(b);
    vals.phase_shift.push(t.phase_shift);
    vals.s_nom.push(t.s_nom);
    vals.tap_side.push(Math.trunc(t.tap_side));
    vals.tap_ratio.push(tapRatio);
    for (const a of Object.keys(cur)) cur[a].push(tr.col(a)[i]);
  }
  warnTypeParamOverride("Transformer(s)", cur, vals, ["r", "x", "g", "b", "s_nom"], sel.map((i) => tr.index.at(i)));
  for (const a of attrs) {
    const col = tr.col(a);
    sel.forEach((i, k) => (col[i] = vals[a][k]));
  }
}

function wyeToDelta(z1, z2, z3) {
  // complex numbers as [re, im]
  const s = [
    cmul(...z1, ...z2)[0] + cmul(...z2, ...z3)[0] + cmul(...z3, ...z1)[0],
    cmul(...z1, ...z2)[1] + cmul(...z2, ...z3)[1] + cmul(...z3, ...z1)[1],
  ];
  return [cdiv(...s, ...z2), cdiv(...s, ...z1), cdiv(...s, ...z3)];
}

export function apply_transformer_t_model(n) {
  const tr = n.c.transformers.static;
  const model = tr.col("model");
  const r = tr.col("r_pu");
  const x = tr.col("x_pu");
  const g = tr.col("g_pu");
  const b = tr.col("b_pu");
  for (let i = 0; i < tr.index.length; i++) {
    if (model[i] !== "t" || (g[i] === 0 && b[i] === 0)) continue;
    const zHalf = [r[i] / 2, x[i] / 2];
    const yInv = cdiv(1, 0, g[i], b[i]);
    const [za, , zc] = wyeToDelta(zHalf, zHalf, yInv);
    r[i] = zc[0];
    x[i] = zc[1];
    const y2 = cdiv(2, 0, ...za);
    g[i] = y2[0];
    b[i] = y2[1];
  }
}

function calculate_dependent_values() {
  apply_line_types(this);
  apply_transformer_types(this);
  const buses = this.c.buses.static;
  const vnom = buses.series("v_nom");
  const bcarrier = buses.series("carrier");

  const lines = this.c.lines.static;
  const lv = Float64Array.from(seriesMap(lines.col("bus0"), vnom));
  lines.set("v_nom", lv);
  lines.dtypes.v_nom = "float";
  const lc = lines.col("carrier");
  const lb0 = lines.col("bus0");
  for (let i = 0; i < lc.length; i++) if (lc[i] === "") lc[i] = bcarrier.getOr(lb0[i], NaN);
  const calc = (df, out, fn) => {
    df.set(out, Float64Array.from({ length: df.index.length }, (_, i) => fn(i)));
    df.dtypes[out] = "float";
  };
  const lx = lines.col("x");
  const lr = lines.col("r");
  const lbb = lines.col("b");
  const lg = lines.col("g");
  calc(lines, "x_pu", (i) => lx[i] / lv[i] ** 2);
  calc(lines, "r_pu", (i) => lr[i] / lv[i] ** 2);
  calc(lines, "b_pu", (i) => lbb[i] * lv[i] ** 2);
  calc(lines, "g_pu", (i) => lg[i] * lv[i] ** 2);
  lines.set("x_pu_eff", lines.col("x_pu").slice());
  lines.set("r_pu_eff", lines.col("r_pu").slice());

  const tr = this.c.transformers.static;
  const sn = tr.col("s_nom");
  const tx = tr.col("x");
  const trr = tr.col("r");
  const tb = tr.col("b");
  const tg = tr.col("g");
  calc(tr, "x_pu", (i) => tx[i] / sn[i]);
  calc(tr, "r_pu", (i) => trr[i] / sn[i]);
  calc(tr, "b_pu", (i) => tb[i] * sn[i]);
  calc(tr, "g_pu", (i) => tg[i] * sn[i]);
  const tap = tr.col("tap_ratio");
  const txpu = tr.col("x_pu");
  const trpu = tr.col("r_pu");
  calc(tr, "x_pu_eff", (i) => txpu[i] * tap[i]);
  calc(tr, "r_pu_eff", (i) => trpu[i] * tap[i]);
  apply_transformer_t_model(this);

  const sh = this.c.shunt_impedances.static;
  const sv = Float64Array.from(seriesMap(sh.col("bus"), vnom));
  sh.set("v_nom", sv);
  sh.dtypes.v_nom = "float";
  const sb = sh.col("b");
  const sg = sh.col("g");
  calc(sh, "b_pu", (i) => sb[i] * sv[i] ** 2);
  calc(sh, "g_pu", (i) => sg[i] * sv[i] ** 2);

  const links = this.c.links.static;
  const lkc = links.col("carrier");
  const lkb0 = links.col("bus0");
  for (let i = 0; i < lkc.length; i++) if (lkc[i] === "") lkc[i] = bcarrier.getOr(lkb0[i], NaN);
  const stores = this.c.stores.static;
  const stc = stores.col("carrier");
  const stb = stores.col("bus");
  for (let i = 0; i < stc.length; i++) if (stc[i] === "") stc[i] = bcarrier.getOr(stb[i], NaN);

  updatePortsComponentAttrs(this);
}

// ----------------------------------------------------------------------
// SubNetwork
// ----------------------------------------------------------------------

class SubNetworkComponents {
  constructor(sub, comp) {
    this._sub = sub;
    this._c = comp;
  }

  get name() {
    return this._c.name;
  }

  get list_name() {
    return this._c.list_name;
  }

  get empty() {
    return this._c.empty;
  }

  get defaults() {
    return this._c.defaults;
  }

  get ctype() {
    return this._c.ctype;
  }

  get ports() {
    return this._c.ports;
  }

  get static() {
    const c = this._c;
    const n = this._sub.n;
    const st = c.static;
    if (c.name === "Bus" || n.passive_branch_components.has(c.name)) {
      const sn = st.col("sub_network");
      return st.filter(sn.map((s) => s === this._sub.name));
    }
    if (n.one_port_components.has(c.name)) {
      const buses = this._sub.c.get("buses").static.index;
      return st.filter(st.col("bus").map((b) => buses.has(b)));
    }
    throw new Error(`Component ${c.name} not supported for sub-networks`);
  }

  get dynamic() {
    return this._c.dynamic;
  }

  get_active_assets(period = null) {
    const st = this.static;
    const act = this._c.get_active_assets(period);
    return new Series(
      st.index.values.map((nm) => act.get(nm)),
      st.index,
    );
  }
}

class SubNetworkStore extends Map {
  get(key) {
    if (super.has(key)) return super.get(key);
    for (const v of this.values()) if (v.name === key) return v;
    throw new Error(`No component ${key}`);
  }
}

export class SubNetwork {
  constructor(n, name) {
    this._n = n;
    this.name = name;
  }

  get n() {
    return this._n;
  }

  get list_name() {
    return "sub_networks";
  }

  get components() {
    const store = new SubNetworkStore();
    for (const [ln, c] of this.n.components) store.set(ln, new SubNetworkComponents(this, c));
    return store;
  }

  get c() {
    if (!this._cCache) this._cCache = this.components;
    return this._cCache;
  }

  get snapshots() {
    return this.n.snapshots;
  }

  get snapshot_weightings() {
    return this.n.snapshot_weightings;
  }

  get investment_periods() {
    return this.n.investment_periods;
  }

  get has_scenarios() {
    return false;
  }

  toString() {
    return this.name;
  }

  _defaultBranchComponents() {
    return this.n.passive_branch_components;
  }

  /** (type, name) tuples of passive branches in this sub-network. */
  branches_i(active_only = false) {
    const out = [];
    for (const cname of [...this.n.passive_branch_components].sort()) {
      const st = this.c.get(cname).static;
      const active = st.col("active");
      st.index.values.forEach((nm, i) => {
        if (!active_only || active[i]) out.push([cname, nm]);
      });
    }
    return new Index(out, ["type", "name"]);
  }

  branches() {
    const b = this.n.passive_branches();
    if (b.index.length === 0) return b;
    return b.filter(b.col("sub_network").map((s) => s === this.name));
  }

  find_slack_bus() {
    const n = this.n;
    const gens = this.c.get("generators").static;
    if (gens.index.length === 0) {
      this.slack_generator = null;
      this.slack_bus = this.c.get("buses").static.index.at(0);
    } else {
      const control = gens.col("control");
      const slacks = gens.index.values.filter((_, i) => control[i] === "Slack");
      const ng = n.c.generators.static;
      const ngControl = ng.col("control");
      if (slacks.length === 0) {
        this.slack_generator = gens.index.at(0);
        ngControl[ng.index.getLoc(this.slack_generator)] = "Slack";
      } else if (slacks.length === 1) {
        this.slack_generator = slacks[0];
      } else {
        this.slack_generator = slacks[0];
        for (const s of slacks.slice(1)) ngControl[ng.index.getLoc(s)] = "PV";
      }
      this.slack_bus = gens.at(this.slack_generator, "bus");
    }
    n.c.sub_networks.static.setAt(this.name, "slack_bus", this.slack_bus);
  }

  find_bus_controls() {
    const n = this.n;
    this.find_slack_bus();
    const gens = this.c.get("generators").static;
    const busesI = this.c.get("buses").static.index;
    const nb = n.c.buses.static;
    const control = nb.col("control");
    const generator = nb.col("generator");
    for (const b of busesI) control[nb.index.getLoc(b)] = "PQ";
    // PV generators: first per bus
    const gControl = gens.col("control");
    const gBus = gens.col("bus");
    const pvFirst = new Map();
    gens.index.values.forEach((g, i) => {
      if (gControl[i] === "PV" && !pvFirst.has(gBus[i])) pvFirst.set(gBus[i], g);
    });
    // groupby sorts the bus keys
    for (const bus of [...pvFirst.keys()].sort()) {
      const i = nb.index.getLoc(bus);
      control[i] = "PV";
      generator[i] = pvFirst.get(bus);
    }
    const si = nb.index.getLoc(this.slack_bus);
    control[si] = "Slack";
    generator[si] = this.slack_generator !== null ? this.slack_generator : "";
    const pvs = [];
    const pqs = [];
    for (const b of busesI) {
      const c = control[nb.index.getLoc(b)];
      if (c === "PV") pvs.push(b);
      else if (c === "PQ") pqs.push(b);
    }
    this.pvs = new Index(pvs, "name");
    this.pqs = new Index(pqs, "name");
    this.pvpqs = new Index([...pvs, ...pqs], "name");
    this.buses_o = new Index([this.slack_bus, ...pvs, ...pqs], "name");
  }

  /** Active passive branch attribute values in component order (Line, Transformer). */
  _branchValues(attr, fallback = null) {
    const out = [];
    for (const cname of ["Line", "Transformer"]) {
      const st = this.c.get(cname).static;
      const active = st.col("active");
      const col = st.colOr(attr, null);
      for (let i = 0; i < st.index.length; i++) {
        if (!active[i]) continue;
        out.push(col ? col[i] : fallback);
      }
    }
    return out;
  }

  calculate_B_H({ skip_pre = false } = {}) {
    const n = this.n;
    if (!skip_pre) {
      n.calculate_dependent_values();
      this.find_bus_controls();
    }
    const carrier = n.c.sub_networks.static.at(this.name, "carrier");
    const attribute = carrier === "DC" ? "r_pu_eff" : "x_pu_eff";
    const z = this._branchValues(attribute);
    const b = z.map((v) => (v !== 0 ? 1.0 / v : Infinity));
    if (b.some((v) => Number.isNaN(v))) logger.warning("Warning! Some series impedances are zero - this will cause a singularity in LPF!");
    this.K = this.incidence_matrix({ busorder: this.buses_o });
    this.H = diag(b).mul(this.K.transpose());
    this.B = this.K.mul(this.H);
    const phase = [];
    for (const cname of ["Line", "Transformer"]) {
      const st = this.c.get(cname).static;
      const active = st.col("active");
      const ps = cname === "Transformer" ? st.col("phase_shift") : null;
      for (let i = 0; i < st.index.length; i++) {
        if (!active[i]) continue;
        phase.push(ps ? (ps[i] * Math.PI) / 180.0 : 0);
      }
    }
    this.p_branch_shift = Float64Array.from(b, (bv, i) => (bv !== Infinity ? -bv * phase[i] : 0));
    this.p_bus_shift = this.K.matvec(this.p_branch_shift);
  }

  calculate_PTDF({ skip_pre = false } = {}) {
    if (!skip_pre) this.calculate_B_H();
    const npvpq = this.pvpqs.length;
    const nb = npvpq + 1;
    const idx = Array.from({ length: npvpq }, (_, i) => i + 1);
    // B_inverse (dense), padded with zero row/column for the slack
    const Binv = Array.from({ length: nb }, () => new Float64Array(nb));
    if (npvpq > 0) {
      const lu = sparseLU(this.B.sub(idx, idx));
      for (let j = 0; j < npvpq; j++) {
        const e = new Float64Array(npvpq);
        e[j] = 1;
        const col = lu.solve(e);
        for (let i = 0; i < npvpq; i++) Binv[i + 1][j + 1] = col[i];
      }
    }
    // PTDF = H * B_inverse  (branches x buses)
    const H = this.H;
    const nbr = H.m;
    const ptdf = Array.from({ length: nbr }, () => new Float64Array(nb));
    for (let k = 0; k < H.n; k++) {
      for (let p = H.colptr[k]; p < H.colptr[k + 1]; p++) {
        const r = H.rowind[p];
        const v = H.values[p];
        const row = Binv[k];
        const out = ptdf[r];
        for (let j = 0; j < nb; j++) out[j] += v * row[j];
      }
    }
    this.PTDF = ptdf;
  }

  calculate_BODF({ skip_pre = false } = {}) {
    if (!skip_pre) this.calculate_PTDF();
    const ptdf = this.PTDF;
    const nbr = ptdf.length;
    const K = this.K;
    // branch_PTDF = PTDF * K (branches x branches)
    const bp = Array.from({ length: nbr }, () => new Float64Array(nbr));
    for (let j = 0; j < K.n; j++) {
      for (let p = K.colptr[j]; p < K.colptr[j + 1]; p++) {
        const busi = K.rowind[p];
        const v = K.values[p];
        for (let r = 0; r < nbr; r++) bp[r][j] += ptdf[r][busi] * v;
      }
    }
    const denom = Float64Array.from({ length: nbr }, (_, i) => 1 / (1 - bp[i][i]));
    const bodf = bp.map((row) => Float64Array.from(row, (v, j) => v * denom[j]));
    for (let i = 0; i < nbr; i++) bodf[i][i] = -1;
    this.BODF = bodf;
  }

  calculate_Y({ skip_pre = false, active_branches_only = true } = {}) {
    const n = this.n;
    if (!skip_pre) n.calculate_dependent_values();
    if (n.c.sub_networks.static.at(this.name, "carrier") !== "AC") {
      logger.warning("Non-AC networks not supported for Y!");
      return;
    }
    let branches = this.branches();
    if (active_branches_only && branches.index.length) branches = branches.filter(branches.col("active").map(Boolean));
    const busesO = this.buses_o;
    const nbr = branches.index.length;
    const nbus = busesO.length;
    const col = (c, fill = NaN) => (branches.has(c) ? branches.col(c) : new Float64Array(nbr).fill(fill));
    const r = col("r_pu");
    const x = col("x_pu");
    const g = col("g_pu");
    const b = col("b_pu");
    const tapRatio = col("tap_ratio");
    const tapSide = col("tap_side");
    const phaseShift = col("phase_shift");
    const b0 = branches.col("bus0");
    const b1 = branches.col("bus1");
    const Y0 = { r: [], c: [], re: [], im: [] };
    const Y1 = { r: [], c: [], re: [], im: [] };
    for (let k = 0; k < nbr; k++) {
      const yse = cdiv(1, 0, r[k], x[k]);
      const ysh = [g[k], b[k]];
      let tau = Number.isNaN(tapRatio[k]) ? 1.0 : tapRatio[k];
      if (tau === 0) tau = 1.0;
      const tauHv = tapSide[k] === 0 ? tau : 1.0;
      const tauLv = tapSide[k] === 1 ? tau : 1.0;
      const ps = Number.isNaN(phaseShift[k]) ? 0 : phaseShift[k];
      const ang = (ps * Math.PI) / 180.0;
      const sh = [Math.cos(ang), Math.sin(ang)];
      const base = [yse[0] + 0.5 * ysh[0], yse[1] + 0.5 * ysh[1]];
      const Y11 = [base[0] / tauLv ** 2, base[1] / tauLv ** 2];
      const Y10 = cdiv(-yse[0] / tauLv / tauHv, -yse[1] / tauLv / tauHv, sh[0], sh[1]);
      const Y01 = cdiv(-yse[0] / tauLv / tauHv, -yse[1] / tauLv / tauHv, sh[0], -sh[1]);
      const Y00 = [base[0] / tauHv ** 2, base[1] / tauHv ** 2];
      const i0 = busesO.getLoc(b0[k]);
      const i1 = busesO.getLoc(b1[k]);
      Y0.r.push(k, k);
      Y0.c.push(i0, i1);
      Y0.re.push(Y00[0], Y01[0]);
      Y0.im.push(Y00[1], Y01[1]);
      Y1.r.push(k, k);
      Y1.c.push(i0, i1);
      Y1.re.push(Y10[0], Y11[0]);
      Y1.im.push(Y10[1], Y11[1]);
    }
    const mk = (Y) => ({
      re: CSC.fromTriplets(nbr, nbus, Y.r, Y.c, Y.re),
      im: CSC.fromTriplets(nbr, nbus, Y.r, Y.c, Y.im),
    });
    this.Y0 = mk(Y0);
    this.Y1 = mk(Y1);
    // shunts
    const sh = n.c.shunt_impedances.static;
    const shB = new Float64Array(nbus);
    const shG = new Float64Array(nbus);
    sh.col("bus").forEach((bus, i) => {
      const p = busesO.getLoc(bus);
      if (p >= 0) {
        shB[p] += sh.col("b_pu")[i];
        shG[p] += sh.col("g_pu")[i];
      }
    });
    // Y = C0^T Y0 + C1^T Y1 + diag(Y_sh)
    const rows = [];
    const cols = [];
    const re = [];
    const im = [];
    for (let k = 0; k < nbr; k++) {
      const i0 = busesO.getLoc(b0[k]);
      const i1 = busesO.getLoc(b1[k]);
      // row i0 gets Y0[k,:], row i1 gets Y1[k,:]
      for (const [Y, row] of [
        [Y0, i0],
        [Y1, i1],
      ]) {
        for (let t = 0; t < 2; t++) {
          rows.push(row);
          cols.push(Y.c[2 * k + t]);
          re.push(Y.re[2 * k + t]);
          im.push(Y.im[2 * k + t]);
        }
      }
    }
    for (let i = 0; i < nbus; i++) {
      rows.push(i);
      cols.push(i);
      re.push(shG[i]);
      im.push(shB[i]);
    }
    this.Y = {
      re: CSC.fromTriplets(nbus, nbus, rows, cols, re),
      im: CSC.fromTriplets(nbus, nbus, rows, cols, im),
    };
  }
}
Object.assign(SubNetwork.prototype, GraphMixin);
Network._makeSubNetwork = (n, name) => new SubNetwork(n, name);

// complex sparse matrix-vector product: (Yre + i Yim)(vr + i vi)
function cmatvec(Y, vr, vi) {
  const a = Y.re.matvec(vr);
  const b = Y.im.matvec(vi);
  const c = Y.re.matvec(vi);
  const d = Y.im.matvec(vr);
  const outR = new Float64Array(a.length);
  const outI = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    outR[i] = a[i] - b[i];
    outI[i] = c[i] + d[i];
  }
  return [outR, outI];
}

// ----------------------------------------------------------------------
// cycles
// ----------------------------------------------------------------------

export function find_cycles(sub, weight = "x_pu", cycle_basis_method = "bfs-refined") {
  if (cycle_basis_method !== "bfs-refined" && cycle_basis_method !== "paton") {
    throw new Error('cycle_basis_method must be one of "bfs-refined" or "paton"');
  }
  const branches = sub.branches();
  const bus0 = branches.index.length ? branches.col("bus0") : [];
  const branchesI = branches.index;
  const mgraph = sub.graph({ weight, inf_weight: false, include_inactive: false });
  const graph = mgraph.toSimple();
  const cycles = cycle_basis_method === "paton" ? cycleBasis(graph) : bfsRefinedCycleBasis(graph);
  let numSimpleEdges = 0;
  for (const _ of graph.edges()) numSimpleEdges++;
  const numMulti = mgraph.numberOfEdges - numSimpleEdges;
  const ncols = cycles.length + numMulti;
  const entries = new Map(); // "row,col" -> value
  const add = (r, c, v) => {
    const k = `${r},${c}`;
    entries.set(k, (entries.get(k) ?? 0) + v);
  };
  const set = (r, c, v) => entries.set(`${r},${c}`, v);
  cycles.forEach((cycle, j) => {
    for (let i = 0; i < cycle.length; i++) {
      const branch = mgraph.edgeKeys(cycle[i], cycle[(i + 1) % cycle.length])[0];
      const bi = branchesI.getLoc(branch);
      const sign = bus0[bi] === cycle[i] ? 1 : -1;
      add(bi, j, sign);
    }
  });
  let c = cycles.length;
  for (const [u, v] of graph.edges()) {
    const bs = mgraph.edgeKeys(u, v);
    if (bs.length > 1) {
      const firstI = branchesI.getLoc(bs[0]);
      for (const b of bs.slice(1)) {
        const bI = branchesI.getLoc(b);
        const sign = bus0[bI] === bus0[firstI] ? -1 : 1;
        set(firstI, c, 1);
        set(bI, c, sign);
        c++;
      }
    }
  }
  const rows = [];
  const cols = [];
  const vals = [];
  for (const [k, v] of entries) {
    const [r, cc] = k.split(",").map(Number);
    rows.push(r);
    cols.push(cc);
    vals.push(v);
  }
  sub.C = CSC.fromTriplets(branchesI.length, ncols, rows, cols, vals);
}

// ----------------------------------------------------------------------
// Network topology
// ----------------------------------------------------------------------

function determine_network_topology({ investment_period = null, skip_isolated_buses = false, cycle_basis_method = "bfs-refined" } = {}) {
  const n = this;
  const buses = n.c.buses.static.index;
  const adj = n.adjacency_matrix({ branch_components: n.passive_branch_components, investment_period, return_dataframe: false });
  const edges = [];
  for (let j = 0; j < adj.length; j++) for (let i = 0; i < adj.length; i++) if (adj[j][i] !== 0) edges.push([i, j]);
  const [ncomp, labels] = connectedComponents(buses.length, edges);
  const subMap = new Map(buses.values.map((b, i) => [b, String(labels[i])]));

  // reset sub networks
  const sn = n.c.sub_networks;
  sn.static = sn.static.takeRows([]);
  if (sn.static.has("obj")) sn.static.deleteCol("obj");
  for (const k of Object.keys(sn.dynamic)) sn.dynamic[k] = new DataFrame({ index: n.snapshots, columns: [] });

  const carriers = n.c.buses.static.col("carrier");
  const newSubs = [];
  for (let i = 0; i < ncomp; i++) {
    const members = [];
    labels.forEach((l, k) => l === i && members.push(k));
    if (skip_isolated_buses && members.length === 1) continue;
    const carrier = carriers[members[0]];
    if (carrier !== "AC" && carrier !== "DC" && members.length > 1) {
      logger.warning(
        `Warning, sub network ${i} is not electric but contains multiple buses\nand branches. Passive flows are not allowed for non-electric networks! Use "AC" or "DC" as carrier ("electricity" will not work).`,
      );
    }
    if (members.some((k) => carriers[k] !== carrier)) {
      logger.warning(`Warning, sub network ${i} contains buses with mixed carriers!`);
    }
    newSubs.push([String(i), carrier]);
  }
  if (newSubs.length) {
    n.add(
      "SubNetwork",
      newSubs.map((s) => s[0]),
      { carrier: newSubs.map((s) => s[1]) },
    );
  }
  sn.static.set(
    "obj",
    sn.static.index.values.map((name) => new SubNetwork(n, name)),
  );
  sn.static.dtypes.obj = "object";

  const bst = n.c.buses.static;
  bst.set(
    "sub_network",
    bst.index.values.map((b) => subMap.get(b)),
  );

  for (const cname of ["Line", "Transformer"]) {
    const c = n.c.get(cname);
    const st = c.static;
    st.set(
      "sub_network",
      st.col("bus0").map((b) => (subMap.has(b) ? subMap.get(b) : NaN)),
    );
    if (investment_period !== null) {
      const active = c.get_active_assets(investment_period).values;
      const col = st.col("sub_network");
      active.forEach((a, i) => {
        if (!a) col[i] = NaN;
      });
    }
  }
  for (const sub of sn.static.col("obj")) {
    find_cycles(sub, "x_pu", cycle_basis_method);
    sub.find_bus_controls();
  }
  return n;
}

/** Cycle matrix of passive branches (branches x cycles) as DataFrame. */
function cycle_matrix({ investment_period = null, apply_weights = false, cycle_basis_method = "bfs-refined" } = {}) {
  const n = this;
  n.determine_network_topology({ investment_period, skip_isolated_buses: true, cycle_basis_method });
  n.calculate_dependent_values();
  const blocks = [];
  for (const sub of n.c.sub_networks.static.col("obj")) {
    const branches = sub.branches();
    if (!sub.C || sub.C.n === 0) continue;
    blocks.push({ index: branches.index, C: sub.C });
  }
  if (!blocks.length) return new DataFrame();
  const allBranches = n.branches();
  const existingTypes = new Set();
  for (const b of blocks) for (const [t] of b.index.values) existingTypes.add(t);
  const rowsIdx = new Index(
    allBranches.index.values.filter(([t]) => existingTypes.has(t)),
    ["type", "name"],
  );
  let ncols = 0;
  for (const b of blocks) ncols += b.C.n;
  const data = new Map();
  let offset = 0;
  const colData = Array.from({ length: ncols }, () => new Float64Array(rowsIdx.length));
  for (const b of blocks) {
    const C = b.C;
    for (let j = 0; j < C.n; j++) {
      for (let p = C.colptr[j]; p < C.colptr[j + 1]; p++) {
        const lab = b.index.at(C.rowind[p]);
        const r = rowsIdx.getLoc(lab);
        colData[offset + j][r] = C.values[p];
      }
    }
    offset += C.n;
  }
  if (apply_weights) {
    const subCarrier = n.c.sub_networks.static.series("carrier");
    const sns = allBranches.col("sub_network");
    const xe = allBranches.col("x_pu_eff");
    const re = allBranches.col("r_pu_eff");
    const w = rowsIdx.values.map((lab) => {
      const i = allBranches.index.getLoc(lab);
      return subCarrier.getOr(sns[i], NaN) === "AC" ? xe[i] : re[i];
    });
    for (const col of colData) for (let r = 0; r < col.length; r++) if (col[r] !== 0) col[r] = col[r] * w[r];
  }
  colData.forEach((a, j) => data.set(j, a));
  return new DataFrame({ index: rowsIdx, columns: new Index([...data.keys()], "cycle"), data });
}

// ----------------------------------------------------------------------
// power flow
// ----------------------------------------------------------------------

function allocateSeriesDataframes(n, series) {
  for (const [component, attrs] of Object.entries(series)) {
    const c = n.c.get(component);
    for (const attr of attrs) {
      const def = c.defaults.get(attr);
      c.dynamic[attr] = c.dynamic[attr].reindex({ columns: c.static.index, fill: def ? def.default : NaN });
    }
  }
}

function allocatePfOutputs(n, linear = false) {
  const toAllocate = {
    Generator: ["p"],
    Load: ["p"],
    StorageUnit: ["p"],
    Store: ["p"],
    ShuntImpedance: ["p"],
    Bus: ["p", "v_ang", "v_mag_pu"],
  };
  for (const c of n.branch_components) toAllocate[c] = n.c.get(c).ports.map((p) => `p${p}`);
  if (!linear) {
    for (const [component, attrs] of Object.entries(toAllocate)) {
      if (attrs.includes("p")) attrs.push("q");
      if (attrs.includes("p0") && n.passive_branch_components.has(component)) attrs.push("q0", "q1");
    }
  }
  allocateSeriesDataframes(n, toAllocate);
}

/** Write values (snapshots x cols) into dynamic frame for given snapshot positions. */
function setDyn(df, snsPos, col, values) {
  const a = df.col(col);
  for (let i = 0; i < snsPos.length; i++) a[snsPos[i]] = values[i];
}

function activeIndex(st) {
  const act = st.col("active");
  return st.index.filter(act.map(Boolean));
}

function controllableNodalBalance(sub, n, sns, snsPos, busesO) {
  for (const power of ["q", "p"]) {
    for (const cname of ["Load", "Generator", "Store", "StorageUnit"]) {
      const sc = sub.c.get(cname);
      if (sc.empty) continue;
      const idx = activeIndex(sc.static);
      const set = n.get_switchable_as_dense(cname, `${power}_set`, sns, idx);
      const dyn = n.c.get(cname).dynamic[power];
      for (const g of idx) setDyn(dyn, snsPos, g, set.col(g));
    }
    const busDyn = n.c.buses.dynamic[power];
    const totals = busesO.values.map(() => new Float64Array(sns.length));
    for (const cname of ["Generator", "Load", "StorageUnit", "Store"]) {
      const sc = sub.c.get(cname);
      if (sc.empty) continue;
      const st = sc.static;
      const idx = activeIndex(st);
      const dyn = n.c.get(cname).dynamic[power];
      for (const g of idx) {
        const bi = busesO.getLoc(st.at(g, "bus"));
        if (bi < 0) continue;
        const sign = st.at(g, "sign");
        const a = dyn.col(g);
        for (let t = 0; t < sns.length; t++) {
          const v = a[snsPos[t]] * sign;
          if (!Number.isNaN(v)) totals[bi][t] += v;
        }
      }
    }
    if (power === "p") {
      for (const cname of ["Link", "Process"]) {
        const c = n.c.get(cname);
        if (c.empty) continue;
        for (const col of c.static.columns) {
          if (!col.startsWith("bus")) continue;
          const i = col.slice(3);
          const dyn = c.dynamic[`p${i}`];
          const busCol = c.static.col(col);
          c.static.index.values.forEach((nm, k) => {
            const bi = busesO.getLoc(busCol[k]);
            if (bi < 0 || !dyn.has(nm)) return;
            const a = dyn.col(nm);
            for (let t = 0; t < sns.length; t++) {
              const v = -a[snsPos[t]];
              if (!Number.isNaN(v)) totals[bi][t] += v;
            }
          });
        }
      }
    }
    busesO.values.forEach((b, i) => setDyn(busDyn, snsPos, b, totals[i]));
  }
}

function prepareAndRunPf(n, snapshots, skipPre, linear, opts = {}) {
  if (!skipPre) {
    n.determine_network_topology();
    n.calculate_dependent_values();
    allocatePfOutputs(n, linear);
  }
  const sns = as_index(n, snapshots, "snapshots");
  const snsPos = n.snapshots.getIndexer(sns);

  if (!n.c.links.empty) {
    const links = n.c.links;
    const pSet = n.get_switchable_as_dense("Link", "p_set", sns);
    for (const l of links.static.index) setDyn(links.dynamic.p0, snsPos, l, pSet.col(l));
    for (const i of ["1", ...links.additional_ports]) {
      const effName = i === "1" ? "efficiency" : `efficiency${i}`;
      const eff = n.get_switchable_as_dense("Link", effName, sns);
      const busCol = links.static.col(`bus${i}`);
      links.static.index.values.forEach((l, k) => {
        if (busCol[k] === "") return;
        const p0 = links.dynamic.p0.col(l);
        const e = eff.col(l);
        setDyn(
          links.dynamic[`p${i}`],
          snsPos,
          l,
          Array.from(snsPos, (sp, t) => -p0[sp] * e[t]),
        );
      });
    }
  }
  if (!n.c.processes.empty) {
    const pr = n.c.processes;
    const pSet = n.get_switchable_as_dense("Process", "p_set", sns);
    for (const i of pr.ports) {
      const rate = n.get_switchable_as_dense("Process", `rate${i}`, sns);
      const busCol = pr.static.col(`bus${i}`);
      pr.static.index.values.forEach((p, k) => {
        if (busCol[k] === "") return;
        const ps = pSet.col(p);
        const r = rate.col(p);
        setDyn(
          pr.dynamic[`p${i}`],
          snsPos,
          p,
          Array.from(snsPos, (_, t) => -ps[t] * r[t]),
        );
      });
    }
  }

  const subs = n.c.sub_networks.static;
  const names = subs.index;
  const itdf = DataFrame.empty(sns, names, NaN);
  const difdf = DataFrame.empty(sns, names, NaN);
  const cnvdf = new DataFrame({ index: sns, columns: names, data: new Map(names.values.map((nm) => [nm, new Array(sns.length).fill(false)])) });
  for (const sub of subs.col("obj")) {
    if (!skipPre) {
      sub.find_bus_controls();
      if (sub.branches_i(true).length > 0) {
        if (linear) sub.calculate_B_H({ skip_pre: true });
        else sub.calculate_Y({ skip_pre: true });
      }
    }
    let sw = opts.slack_weights ?? "p_set";
    if (sw && typeof sw === "object" && !(sw instanceof Series) && sw[sub.name] !== undefined) sw = sw[sub.name];
    if (linear) {
      subLpf(sub, sns, true);
    } else {
      let res;
      if (sub.c.get("buses").static.index.length <= 1) {
        res = subPfSinglebus(sub, sns, true, opts.distribute_slack ?? false, sw);
      } else {
        res = subPf(sub, sns, { skip_pre: true, x_tol: opts.x_tol ?? 1e-6, use_seed: opts.use_seed ?? false, distribute_slack: opts.distribute_slack ?? false, slack_weights: sw });
      }
      const [it, dif, cnv] = res;
      itdf.set(sub.name, it);
      difdf.set(sub.name, dif);
      cnvdf.set(sub.name, cnv);
    }
  }
  if (!linear) return { n_iter: itdf, error: difdf, converged: cnvdf };
  return null;
}

function subLpf(sub, sns, skipPre = false) {
  const n = sub.n;
  if (!skipPre) {
    n.calculate_dependent_values();
    sub.find_bus_controls();
    allocatePfOutputs(n, true);
  }
  const snsPos = n.snapshots.getIndexer(sns);
  const busesO = sub.buses_o;
  const branchesI = sub.branches_i(true);

  const shunts = sub.c.get("shunt_impedances").static;
  for (const s of shunts.index) {
    const g = shunts.at(s, "g_pu");
    setDyn(n.c.shunt_impedances.dynamic.p, snsPos, s, new Float64Array(sns.length).fill(g));
  }
  for (const cname of ["Load", "Generator", "Store", "StorageUnit"]) {
    const sc = sub.c.get(cname);
    if (sc.empty) continue;
    const idx = activeIndex(sc.static);
    const pSet = n.get_switchable_as_dense(cname, "p_set", sns, idx);
    const dyn = n.c.get(cname).dynamic.p;
    for (const g of idx) setDyn(dyn, snsPos, g, Array.from(pSet.col(g), (v) => (Number.isNaN(v) ? 0 : v)));
  }
  const totals = busesO.values.map(() => new Float64Array(sns.length));
  for (const cname of ["Generator", "Load", "StorageUnit", "Store", "ShuntImpedance"]) {
    const sc = sub.c.get(cname);
    if (sc.empty) continue;
    const st = sc.static;
    const idx = activeIndex(st);
    const dyn = n.c.get(cname).dynamic.p;
    for (const g of idx) {
      const bi = busesO.getLoc(st.at(g, "bus"));
      if (bi < 0) continue;
      const sign = st.at(g, "sign");
      const a = dyn.col(g);
      for (let t = 0; t < sns.length; t++) {
        const v = a[snsPos[t]] * sign;
        if (!Number.isNaN(v)) totals[bi][t] += v;
      }
    }
  }
  for (const cname of ["Link", "Process"]) {
    const c = n.c.get(cname);
    if (c.empty) continue;
    for (const col of c.static.columns) {
      if (!col.startsWith("bus")) continue;
      const i = col.slice(3);
      const dyn = c.dynamic[`p${i}`];
      const busCol = c.static.col(col);
      c.static.index.values.forEach((nm, k) => {
        const bi = busesO.getLoc(busCol[k]);
        if (bi < 0 || !dyn.has(nm)) return;
        const a = dyn.col(nm);
        for (let t = 0; t < sns.length; t++) {
          const v = -a[snsPos[t]];
          if (!Number.isNaN(v)) totals[bi][t] += v;
        }
      });
    }
  }
  const busP = n.c.buses.dynamic.p;
  busesO.values.forEach((b, i) => setDyn(busP, snsPos, b, totals[i]));

  if (!skipPre && branchesI.length > 0) sub.calculate_B_H({ skip_pre: true });

  const nb = busesO.length;
  const vdiff = Array.from({ length: sns.length }, () => new Float64Array(nb));
  if (branchesI.length > 0) {
    const idx = Array.from({ length: nb - 1 }, (_, i) => i + 1);
    const lu = sparseLU(sub.B.sub(idx, idx));
    const Ht = sub.H; // branches x buses
    const flows = Array.from({ length: sns.length }, () => new Float64Array(branchesI.length));
    for (let t = 0; t < sns.length; t++) {
      const rhs = new Float64Array(nb - 1);
      for (let i = 1; i < nb; i++) rhs[i - 1] = totals[i][t] - sub.p_bus_shift[i];
      const sol = lu.solve(rhs);
      for (let i = 1; i < nb; i++) vdiff[t][i] = sol[i - 1];
      const f = Ht.matvec(vdiff[t]);
      for (let k = 0; k < f.length; k++) flows[t][k] = f[k] + sub.p_branch_shift[k];
    }
    branchesI.values.forEach(([type, name], k) => {
      const dyn = n.c.get(type).dynamic;
      setDyn(dyn.p0, snsPos, name, flows.map((f) => f[k]));
      setDyn(dyn.p1, snsPos, name, flows.map((f) => -f[k]));
    });
  }
  const isDC = n.c.sub_networks.static.at(sub.name, "carrier") === "DC";
  busesO.values.forEach((b, i) => {
    if (isDC) {
      setDyn(n.c.buses.dynamic.v_mag_pu, snsPos, b, vdiff.map((v) => 1 + v[i]));
      setDyn(n.c.buses.dynamic.v_ang, snsPos, b, new Float64Array(sns.length));
    } else {
      setDyn(n.c.buses.dynamic.v_ang, snsPos, b, vdiff.map((v) => v[i]));
      setDyn(n.c.buses.dynamic.v_mag_pu, snsPos, b, new Float64Array(sns.length).fill(1));
    }
  });
  // slack adjustment
  const slackAdj = new Float64Array(sns.length);
  const pcol0 = busP.col(busesO.at(0));
  for (let t = 0; t < sns.length; t++) {
    let s = 0;
    for (let i = 1; i < nb; i++) {
      const v = busP.col(busesO.at(i))[snsPos[t]];
      if (!Number.isNaN(v)) s += v;
    }
    slackAdj[t] = -s - pcol0[snsPos[t]];
  }
  for (let t = 0; t < sns.length; t++) pcol0[snsPos[t]] += slackAdj[t];
  if (sub.slack_generator !== null && sub.slack_generator !== undefined) {
    const gp = n.c.generators.dynamic.p.col(sub.slack_generator);
    for (let t = 0; t < sns.length; t++) gp[snsPos[t]] += slackAdj[t];
  }
}

function normed(arr) {
  let s = 0;
  for (const v of arr) if (!Number.isNaN(v)) s += v;
  return Array.from(arr, (v) => (s === 0 ? NaN : v / s)).map((v) => (Number.isNaN(v) ? 0 : v));
}

function subPfSinglebus(sub, sns, skipPre, distributeSlack, slackWeights) {
  const n = sub.n;
  logger.info(`Balancing power on single-bus sub-network ${sub.name}`);
  if (!skipPre) {
    sub.find_bus_controls();
    allocatePfOutputs(n, false);
  }
  const snsPos = n.snapshots.getIndexer(sns);
  const busesO = sub.buses_o;
  controllableNodalBalance(sub, n, sns, snsPos, busesO);
  const vset = n.get_switchable_as_dense("Bus", "v_mag_pu_set", sns);
  setDyn(n.c.buses.dynamic.v_mag_pu, snsPos, sub.slack_bus, vset.col(sub.slack_bus));
  setDyn(n.c.buses.dynamic.v_ang, snsPos, sub.slack_bus, new Float64Array(sns.length));
  const busP = n.c.buses.dynamic.p;
  const busQ = n.c.buses.dynamic.q;
  const gp = n.c.generators.dynamic.p;
  if (distributeSlack) {
    const gens = sub.c.get("generators").static;
    const byBus = new Map();
    gens.index.values.forEach((g, i) => {
      const b = gens.col("bus")[i];
      if (!byBus.has(b)) byBus.set(b, []);
      byBus.get(b).push(g);
    });
    for (const bus of [...byBus.keys()].sort()) {
      const group = byBus.get(bus);
      const bp = busP.col(bus);
      if (slackWeights === "p_nom" || slackWeights === "p_nom_opt") {
        if (Array.from(n.c.generators.static.col(slackWeights)).every((v) => v === 0)) {
          throw new Error(`Invalid slack weights! Generator attribute ${slackWeights} is always zero.`);
        }
        const shares = normed(group.map((g) => n.c.generators.static.at(g, slackWeights)));
        group.forEach((g, k) => {
          const a = gp.col(g);
          for (let t = 0; t < sns.length; t++) a[snsPos[t]] += shares[k] * -bp[snsPos[t]];
        });
      } else if (slackWeights === "p_set") {
        const choice = n.get_switchable_as_dense("Generator", "p_set", sns);
        const all = choice.columns.values.flatMap((c) => Array.from(choice.col(c)));
        if (all.every((v) => Number.isNaN(v))) throw new Error("Invalid slack weights! Generator attribute p_set is always NaN.");
        if (all.every((v) => v === 0)) throw new Error("Invalid slack weights! Generator attribute p_set is always zero.");
        for (let t = 0; t < sns.length; t++) {
          const shares = normed(group.map((g) => choice.col(g)[t]));
          group.forEach((g, k) => (gp.col(g)[snsPos[t]] += shares[k] * -bp[snsPos[t]]));
        }
      } else {
        const sw = slackWeights instanceof Series ? slackWeights : Series.fromObject(slackWeights);
        const shares = normed(sw.values);
        sw.index.values.forEach((g, k) => {
          if (!group.includes(g)) return;
          const a = gp.col(g);
          for (let t = 0; t < sns.length; t++) a[snsPos[t]] += shares[k] * -bp[snsPos[t]];
        });
      }
    }
  } else if (sub.slack_generator !== null) {
    const a = gp.col(sub.slack_generator);
    const bp = busP.col(sub.slack_bus);
    for (let t = 0; t < sns.length; t++) a[snsPos[t]] -= bp[snsPos[t]];
  }
  if (sub.slack_generator !== null) {
    const a = n.c.generators.dynamic.q.col(sub.slack_generator);
    const bq = busQ.col(sub.slack_bus);
    for (let t = 0; t < sns.length; t++) a[snsPos[t]] -= bq[snsPos[t]];
  }
  const bp = busP.col(sub.slack_bus);
  const bq = busQ.col(sub.slack_bus);
  for (let t = 0; t < sns.length; t++) {
    bp[snsPos[t]] = 0;
    bq[snsPos[t]] = 0;
  }
  return [new Float64Array(sns.length), new Float64Array(sns.length), new Array(sns.length).fill(true)];
}

/**
 * Newton-Raphson iteration (mirrors `newton_raphson_sparse`).
 */
function newtonRaphson(f, guess, dfdx, xTol = 1e-10, limIter = 100) {
  let converged = false;
  let nIter = 0;
  let F = f(guess);
  let diff = normInf(F);
  while (diff > xTol && nIter < limIter) {
    nIter++;
    const J = dfdx(guess);
    const step = sparseLU(J).solve(F);
    for (let i = 0; i < guess.length; i++) guess[i] -= step[i];
    F = f(guess);
    diff = normInf(F);
  }
  if (diff > xTol) {
    logger.warning(
      `Warning, we didn't reach the required tolerance within ${nIter} iterations, error is at ${diff}. See the section "Troubleshooting" in the documentation for tips to fix this. `,
    );
  } else if (!Number.isNaN(diff)) converged = true;
  return [guess, nIter, diff, converged];
}

function subPf(sub, sns, { skip_pre = false, x_tol = 1e-6, use_seed = false, distribute_slack = false, slack_weights = "p_set" } = {}) {
  const n = sub.n;
  let slackWeights = slack_weights;
  if (slackWeights && typeof slackWeights === "object" && !(slackWeights instanceof Series)) slackWeights = Series.fromObject(slackWeights);
  else if (typeof slackWeights === "string" && !["p_nom", "p_nom_opt", "p_set"].includes(slackWeights)) {
    throw new Error(`String value for 'slack_weights' must be one of ["p_nom", "p_nom_opt", "p_set"]. Is ${slackWeights}.`);
  }
  if (!skip_pre) {
    n.calculate_dependent_values();
    sub.find_bus_controls();
    allocatePfOutputs(n, false);
  }
  const snsPos = n.snapshots.getIndexer(sns);
  const branchesI = sub.branches_i(true);
  const busesO = sub.buses_o;
  const snBuses = sub.c.get("buses").static.index;
  const snGens = sub.c.get("generators").static.index;
  let genWeights = false;
  let busWeights = false;
  if (slackWeights instanceof Series) {
    if (slackWeights.index.values.every((i) => snGens.has(i))) genWeights = true;
    else if (slackWeights.index.values.every((i) => snBuses.has(i))) busWeights = true;
    else throw new Error("Custom slack weights pd.Series/dict must only have the generators or buses of the sub-network as index/keys.");
  }
  if (!skip_pre && branchesI.length > 0) sub.calculate_Y({ skip_pre: true });
  controllableNodalBalance(sub, n, sns, snsPos, busesO);

  const npv = sub.pvs.length;
  const npq = sub.pqs.length;
  const npvpq = sub.pvpqs.length;
  const nb = busesO.length;
  const Y = sub.Y;

  const vset = n.get_switchable_as_dense("Bus", "v_mag_pu_set", sns);
  const vmag = n.c.buses.dynamic.v_mag_pu;
  const vang = n.c.buses.dynamic.v_ang;
  for (const b of [...sub.pvs.values, sub.slack_bus]) setDyn(vmag, snsPos, b, vset.col(b));
  setDyn(vang, snsPos, sub.slack_bus, new Float64Array(sns.length));
  if (!use_seed) {
    for (const b of sub.pqs) setDyn(vmag, snsPos, b, new Float64Array(sns.length).fill(1));
    for (const b of sub.pvpqs) setDyn(vang, snsPos, b, new Float64Array(sns.length));
  }

  // slack weights per bus (buses_o order)
  let slackWeightsCalc = null;
  if (distribute_slack) {
    if (slackWeights === "p_set") {
      const choice = n.get_switchable_as_dense("Generator", "p_set", sns);
      const gbus = n.c.generators.static.series("bus");
      slackWeightsCalc = sns.values.map((_, t) => {
        const perBus = new Map();
        for (const g of choice.columns) {
          const b = gbus.get(g);
          const v = choice.col(g)[t];
          perBus.set(b, (perBus.get(b) ?? 0) + (Number.isNaN(v) ? 0 : v));
        }
        return normed(busesO.values.map((b) => (perBus.has(b) ? perBus.get(b) : NaN)));
      });
    } else if (slackWeights === "p_nom" || slackWeights === "p_nom_opt") {
      const gst = n.c.generators.static;
      if (Array.from(gst.col(slackWeights)).every((v) => v === 0)) {
        throw new Error(`Invalid slack weights! Generator attribute ${slackWeights} is always zero.`);
      }
      const perBus = new Map();
      gst.index.values.forEach((g, i) => {
        const b = gst.col("bus")[i];
        perBus.set(b, (perBus.get(b) ?? 0) + gst.col(slackWeights)[i]);
      });
      const w = normed(busesO.values.map((b) => (perBus.has(b) ? perBus.get(b) : NaN)));
      slackWeightsCalc = sns.values.map(() => w);
    } else if (genWeights) {
      const gbus = n.c.generators.static.series("bus");
      const perBus = new Map();
      slackWeights.index.values.forEach((g, i) => {
        const b = gbus.get(g);
        perBus.set(b, (perBus.get(b) ?? 0) + slackWeights.values[i]);
      });
      const w = normed(busesO.values.map((b) => (perBus.has(b) ? perBus.get(b) : NaN)));
      slackWeightsCalc = sns.values.map(() => w);
    } else if (busWeights) {
      const w = normed(busesO.values.map((b) => slackWeights.getOr(b, NaN)));
      slackWeightsCalc = sns.values.map(() => w);
    }
  }

  const iters = new Float64Array(sns.length);
  const diffs = new Float64Array(sns.length);
  const convs = new Array(sns.length).fill(false);
  const ss = [];
  const vmR = new Float64Array(nb);
  const vaR = new Float64Array(nb);
  const busP = n.c.buses.dynamic.p;
  const busQ = n.c.buses.dynamic.q;

  for (let t = 0; t < sns.length; t++) {
    const sp = snsPos[t];
    const sRe = busesO.values.map((b) => busP.col(b)[sp]);
    const sIm = busesO.values.map((b) => busQ.col(b)[sp]);
    ss.push([sRe, sIm]);
    for (let i = 0; i < nb; i++) {
      vmR[i] = vmag.col(busesO.at(i))[sp];
      vaR[i] = vang.col(busesO.at(i))[sp];
    }
    const sw = distribute_slack ? slackWeightsCalc[t] : null;
    const guess0 = [];
    for (let i = 0; i < npvpq; i++) guess0.push(vaR[1 + i]);
    for (let i = 0; i < npq; i++) guess0.push(vmR[1 + npv + i]);
    if (distribute_slack) guess0.push(0);
    const guess = Float64Array.from(guess0);

    const unpack = (g) => {
      for (let i = 0; i < npvpq; i++) vaR[1 + i] = g[i];
      for (let i = 0; i < npq; i++) vmR[1 + npv + i] = g[npvpq + i];
    };
    const voltages = () => {
      const vr = new Float64Array(nb);
      const vi = new Float64Array(nb);
      for (let i = 0; i < nb; i++) {
        vr[i] = vmR[i] * Math.cos(vaR[i]);
        vi[i] = vmR[i] * Math.sin(vaR[i]);
      }
      return [vr, vi];
    };
    const f = (g) => {
      unpack(g);
      const [vr, vi] = voltages();
      const [ir, ii] = cmatvec(Y, vr, vi);
      // mismatch = V * conj(I) - s (+ slack)
      const mr = new Float64Array(nb);
      const mi = new Float64Array(nb);
      for (let i = 0; i < nb; i++) {
        mr[i] = vr[i] * ir[i] + vi[i] * ii[i] - sRe[i];
        mi[i] = vi[i] * ir[i] - vr[i] * ii[i] - sIm[i];
        if (distribute_slack) mr[i] += sw[i] * g[g.length - 1];
      }
      const F = [];
      if (distribute_slack) for (let i = 0; i < nb; i++) F.push(mr[i]);
      else for (let i = 1; i < nb; i++) F.push(mr[i]);
      for (let i = 1 + npv; i < nb; i++) F.push(mi[i]);
      return Float64Array.from(F);
    };
    const dfdx = (g) => {
      unpack(g);
      const [vr, vi] = voltages();
      const [ir, ii] = cmatvec(Y, vr, vi);
      // build dS/dVa and dS/dVm entries over sparsity of Y + diagonal
      const rows = [];
      const cols = [];
      const vals = [];
      const nProw = distribute_slack ? nb : nb - 1;
      const pRow = (i) => (distribute_slack ? i : i - 1); // P rows
      const qRow = (i) => nProw + (i - 1 - npv); // Q rows for i >= 1+npv
      const vaCol = (k) => k - 1; // k >= 1
      const vmCol = (k) => npvpq + (k - 1 - npv); // k >= 1+npv
      const emit = (i, k, dSaR, dSaI, dSmR, dSmI) => {
        const isP = distribute_slack ? true : i >= 1;
        const isQ = i >= 1 + npv;
        if (k >= 1) {
          if (isP) {
            rows.push(pRow(i));
            cols.push(vaCol(k));
            vals.push(dSaR);
          }
          if (isQ) {
            rows.push(qRow(i));
            cols.push(vaCol(k));
            vals.push(dSaI);
          }
        }
        if (k >= 1 + npv) {
          if (isP) {
            rows.push(pRow(i));
            cols.push(vmCol(k));
            vals.push(dSmR);
          }
          if (isQ) {
            rows.push(qRow(i));
            cols.push(vmCol(k));
            vals.push(dSmI);
          }
        }
      };
      const absV = Float64Array.from(vmR);
      const diagSeen = new Uint8Array(nb);
      // off-diagonal and diagonal contributions from Y entries
      for (let k = 0; k < nb; k++) {
        for (let p = Y.re.colptr[k]; p < Y.re.colptr[k + 1]; p++) {
          const i = Y.re.rowind[p];
          const yr = Y.re.values[p];
          const yi = Y.im.values[p];
          // Y_ik * V_k
          const yvR = yr * vr[k] - yi * vi[k];
          const yvI = yr * vi[k] + yi * vr[k];
          // dS_dVa_ik = 1j * V_i * conj(delta_ik I_i - Y_ik V_k)
          let aR = -yvR;
          let aI = -yvI;
          if (i === k) {
            aR += ir[i];
            aI += ii[i];
          }
          // conj(a) = (aR, -aI); V_i * conj(a)
          const pR = vr[i] * aR + vi[i] * aI;
          const pI = vi[i] * aR - vr[i] * aI;
          // times 1j
          const dSaR = -pI;
          const dSaI = pR;
          // dS_dVm_ik = delta_ik * (V_i/|V_i|) * conj(I_i) + V_i * conj(Y_ik V_k / |V_k|)
          const nkR = yvR / absV[k];
          const nkI = yvI / absV[k];
          let dSmR = vr[i] * nkR + vi[i] * nkI;
          let dSmI = vi[i] * nkR - vr[i] * nkI;
          if (i === k) {
            const unR = vr[i] / absV[i];
            const unI = vi[i] / absV[i];
            dSmR += unR * ir[i] + unI * ii[i];
            dSmI += unI * ir[i] - unR * ii[i];
            diagSeen[i] = 1;
          }
          emit(i, k, dSaR, dSaI, dSmR, dSmI);
        }
      }
      for (let i = 0; i < nb; i++) {
        if (diagSeen[i]) continue;
        const unR = vr[i] / absV[i];
        const unI = vi[i] / absV[i];
        // diagonal with Y_ii = 0
        const pR = vr[i] * ir[i] + vi[i] * ii[i];
        const pI = vi[i] * ir[i] - vr[i] * ii[i];
        emit(i, i, -pI, pR, unR * ir[i] + unI * ii[i], unI * ir[i] - unR * ii[i]);
      }
      const ncols = npvpq + npq + (distribute_slack ? 1 : 0);
      if (distribute_slack) {
        for (let i = 0; i < nb; i++) {
          if (sw[i] !== 0) {
            rows.push(i);
            cols.push(ncols - 1);
            vals.push(sw[i]);
          }
        }
      }
      const nrows = nProw + npq;
      return CSC.fromTriplets(nrows, ncols, rows, cols, vals);
    };
    const [root, nIter, diff, conv] = newtonRaphson(f, guess, dfdx, x_tol);
    unpack(root);
    for (let i = 0; i < npvpq; i++) vang.col(busesO.at(1 + i))[sp] = root[i];
    for (let i = 0; i < npq; i++) vmag.col(busesO.at(1 + npv + i))[sp] = root[npvpq + i];
    iters[t] = nIter;
    diffs[t] = diff;
    convs[t] = conv;
  }
  const nc = convs.filter((c) => !c);
  if (nc.length) logger.warning(`Power flow did not converge for ${sns.values.filter((_, i) => !convs[i])}.`);

  // branch flows
  const Vr = [];
  const Vi = [];
  for (let t = 0; t < sns.length; t++) {
    const sp = snsPos[t];
    const vr = new Float64Array(nb);
    const vi = new Float64Array(nb);
    for (let i = 0; i < nb; i++) {
      const m = vmag.col(busesO.at(i))[sp];
      const a = vang.col(busesO.at(i))[sp];
      vr[i] = m * Math.cos(a);
      vi[i] = m * Math.sin(a);
    }
    Vr.push(vr);
    Vi.push(vi);
  }
  if (branchesI.length) {
    const b0 = [];
    const b1 = [];
    for (const cname of ["Line", "Transformer"]) {
      const st = sub.c.get(cname).static;
      const act = st.col("active");
      st.index.values.forEach((_, i) => {
        if (!act[i]) return;
        b0.push(busesO.getLoc(st.col("bus0")[i]));
        b1.push(busesO.getLoc(st.col("bus1")[i]));
      });
    }
    for (let t = 0; t < sns.length; t++) {
      const sp = snsPos[t];
      const [i0r, i0i] = cmatvec(sub.Y0, Vr[t], Vi[t]);
      const [i1r, i1i] = cmatvec(sub.Y1, Vr[t], Vi[t]);
      branchesI.values.forEach(([type, name], k) => {
        const dyn = n.c.get(type).dynamic;
        const v0r = Vr[t][b0[k]];
        const v0i = Vi[t][b0[k]];
        const v1r = Vr[t][b1[k]];
        const v1i = Vi[t][b1[k]];
        dyn.p0.col(name)[sp] = v0r * i0r[k] + v0i * i0i[k];
        dyn.q0.col(name)[sp] = v0i * i0r[k] - v0r * i0i[k];
        dyn.p1.col(name)[sp] = v1r * i1r[k] + v1i * i1i[k];
        dyn.q1.col(name)[sp] = v1i * i1r[k] - v1r * i1i[k];
      });
    }
  }
  const sCalc = [];
  for (let t = 0; t < sns.length; t++) {
    const [ir, ii] = cmatvec(Y, Vr[t], Vi[t]);
    const re = new Float64Array(nb);
    const im = new Float64Array(nb);
    for (let i = 0; i < nb; i++) {
      re[i] = Vr[t][i] * ir[i] + Vi[t][i] * ii[i];
      im[i] = Vi[t][i] * ir[i] - Vr[t][i] * ii[i];
    }
    sCalc.push([re, im]);
  }
  const slackIndex = 0;
  for (let t = 0; t < sns.length; t++) {
    const sp = snsPos[t];
    if (distribute_slack) {
      for (const b of snBuses) busP.col(b)[sp] = sCalc[t][0][busesO.getLoc(b)];
    } else busP.col(sub.slack_bus)[sp] = sCalc[t][0][slackIndex];
    busQ.col(sub.slack_bus)[sp] = sCalc[t][1][slackIndex];
    for (const b of sub.pvs) busQ.col(b)[sp] = sCalc[t][1][busesO.getLoc(b)];
  }
  // shunt impedances
  const shunts = sub.c.get("shunt_impedances").static;
  for (const s of shunts.index) {
    const bi = busesO.getLoc(shunts.at(s, "bus"));
    const g = shunts.at(s, "g_pu");
    const b = shunts.at(s, "b_pu");
    const pcol = n.c.shunt_impedances.dynamic.p.col(s);
    const qcol = n.c.shunt_impedances.dynamic.q.col(s);
    for (let t = 0; t < sns.length; t++) {
      const sp = snsPos[t];
      const vm = vmag.col(busesO.at(bi))[sp];
      pcol[sp] = vm ** 2 * g;
      qcol[sp] = vm ** 2 * b;
    }
  }
  const gp = n.c.generators.dynamic.p;
  const gq = n.c.generators.dynamic.q;
  if (distribute_slack) {
    const gens = sub.c.get("generators").static;
    const byBus = new Map();
    gens.index.values.forEach((g, i) => {
      const b = gens.col("bus")[i];
      if (!byBus.has(b)) byBus.set(b, []);
      byBus.get(b).push(g);
    });
    for (const bus of [...byBus.keys()].sort()) {
      const group = byBus.get(bus);
      const bi = busesO.getLoc(bus);
      const dsp = sns.values.map((_, t) => busP.col(bus)[snsPos[t]] - ss[t][0][bi]);
      if (slackWeights === "p_set") {
        const choice = n.get_switchable_as_dense("Generator", "p_set", sns);
        for (let t = 0; t < sns.length; t++) {
          const shares = normed(group.map((g) => choice.col(g)[t]));
          group.forEach((g, k) => (gp.col(g)[snsPos[t]] += shares[k] * dsp[t]));
        }
      } else {
        let shares;
        if (genWeights) shares = normed(group.map((g) => slackWeights.getOr(g, NaN)));
        else {
          let pn = group.map((g) => n.c.generators.static.at(g, "p_nom"));
          // mirrors `if all(bus_generators_p_nom) == 0`
          if (pn.every((v) => v !== 0) === false) pn = group.map(() => 1);
          shares = normed(pn);
        }
        group.forEach((g, k) => {
          for (let t = 0; t < sns.length; t++) gp.col(g)[snsPos[t]] += dsp[t] * shares[k];
        });
      }
    }
  } else if (sub.slack_generator !== null) {
    for (let t = 0; t < sns.length; t++) {
      const sp = snsPos[t];
      gp.col(sub.slack_generator)[sp] += busP.col(sub.slack_bus)[sp] - ss[t][0][slackIndex];
    }
  }
  if (sub.slack_generator !== null) {
    for (let t = 0; t < sns.length; t++) {
      const sp = snsPos[t];
      gq.col(sub.slack_generator)[sp] += busQ.col(sub.slack_bus)[sp] - ss[t][1][slackIndex];
    }
  }
  const nbst = n.c.buses.static;
  for (const b of sub.pvs) {
    const g = nbst.at(b, "generator");
    const bi = busesO.getLoc(b);
    for (let t = 0; t < sns.length; t++) {
      const sp = snsPos[t];
      gq.col(g)[sp] += busQ.col(b)[sp] - ss[t][1][bi];
    }
  }
  return [iters, diffs, convs];
}

// ----------------------------------------------------------------------
// Network methods
// ----------------------------------------------------------------------

Object.assign(Network.prototype, GraphMixin, {
  _defaultBranchComponents() {
    return this.branch_components;
  },
  calculate_dependent_values,
  determine_network_topology,
  cycle_matrix,

  /** Linear (DC) power flow. */
  lpf(snapshots = null, opts = {}) {
    if (isOptions(snapshots)) [snapshots, opts] = [snapshots.snapshots ?? null, snapshots];
    const { skip_pre = false } = opts;
    const sns = as_index(this, snapshots, "snapshots");
    prepareAndRunPf(this, sns, skip_pre, true);
  },

  /** Full non-linear (AC) power flow with Newton-Raphson. */
  pf(snapshots = null, opts = {}) {
    if (isOptions(snapshots)) [snapshots, opts] = [snapshots.snapshots ?? null, snapshots];
    const { skip_pre = false, x_tol = 1e-6, use_seed = false, distribute_slack = false, slack_weights = "p_set" } = opts;
    return prepareAndRunPf(this, snapshots, skip_pre, false, { x_tol, use_seed, distribute_slack, slack_weights });
  },

  /** Linear power flow for outages of individual branches (single snapshot). */
  lpf_contingency(snapshots = null, branch_outages = null) {
    if (isOptions(snapshots)) [snapshots, branch_outages] = [snapshots.snapshots ?? null, snapshots.branch_outages ?? null];
    if (isOptions(branch_outages)) branch_outages = branch_outages.branch_outages ?? null;
    let snapshot = snapshots ?? this.snapshots.at(0);
    if (Array.isArray(snapshot) || snapshot instanceof Index) {
      logger.warning("Apologies LPF contingency, this only works for single snapshots at the moment, taking the first snapshot.");
      snapshot = snapshot instanceof Index ? snapshot.at(0) : snapshot[0];
    }
    this.lpf([snapshot]);
    const pb = this.passive_branches();
    const outages = branch_outages ?? pb.index.values;
    const sp = this.snapshots.getLoc(snapshot);
    const baseIdx = [];
    const base = [];
    for (const c of ["Line", "Transformer"]) {
      const p0 = this.c.get(c).dynamic.p0;
      for (const nm of p0.columns) {
        baseIdx.push([c, nm]);
        base.push(p0.col(nm)[sp]);
      }
    }
    const index = new Index(baseIdx, ["component", "name"]);
    const data = new Map([["base", Float64Array.from(base)]]);
    const subsBranches = new Map();
    for (const sub of this.c.sub_networks.static.col("obj")) {
      sub._branches = sub.branches();
      sub.calculate_BODF();
      subsBranches.set(sub.name, sub);
    }
    const columns = ["base"];
    for (let branch of outages) {
      if (!Array.isArray(branch)) {
        logger.warning(`No type given for ${branch}, assuming it is a line`);
        branch = ["Line", branch];
      }
      const sub = subsBranches.get(pb.at(branch, "sub_network"));
      const bi = sub._branches.index.getLoc(branch);
      const p0b = base[index.getLoc(branch)];
      const out = Float64Array.from(base);
      sub._branches.index.values.forEach((lab, k) => {
        const r = index.getLoc(lab);
        out[r] = base[r] + sub.BODF[k][bi] * p0b;
      });
      const key = [branch[0], branch[1]];
      columns.push(key);
      data.set(key, out);
    }
    return new DataFrame({ index, columns, data });
  },
});

Network.prototype.determine_network_topology = function determineTopologyWrapper(opts = {}) {
  return determine_network_topology.call(this, opts);
};

export { prepareAndRunPf, allocatePfOutputs, subLpf, subPf };

// SPDX-License-Identifier: MIT
/**
 * A small linopy-compatible optimisation model.
 *
 * Labels for variables and constraints are allocated exactly like linopy
 * (one label per array element in C order, masked elements become -1 but
 * still consume a label) and the LP file is written in linopy's format.
 * Solving the identical LP text with HiGHS (WebAssembly build of the same
 * solver PyPSA uses by default) reproduces PyPSA's solutions.
 */

import { Index } from "../core/index.js";
import { polarsFloat } from "./format.js";

function shapeOf(coords) {
  return coords.map((c) => c.length);
}

function sizeOf(shape) {
  return shape.reduce((a, b) => a * b, 1);
}

function stridesOf(shape) {
  const s = new Array(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    s[i] = acc;
    acc *= shape[i];
  }
  return s;
}

/** Expand a value (scalar, flat array or function of position tuple) to a Float64Array. */
function fillArray(size, shape, value, fallback) {
  const out = new Float64Array(size);
  if (value === undefined || value === null) {
    out.fill(fallback);
  } else if (typeof value === "number") {
    out.fill(value);
  } else if (typeof value === "function") {
    const strides = stridesOf(shape);
    for (let k = 0; k < size; k++) out[k] = value(...unravel(k, shape, strides));
  } else {
    if (value.length !== size) throw new Error(`Bound array has length ${value.length}, expected ${size}`);
    for (let k = 0; k < size; k++) out[k] = value[k];
  }
  return out;
}

export function unravel(k, shape, strides) {
  const out = new Array(shape.length);
  for (let d = 0; d < shape.length; d++) {
    out[d] = Math.floor(k / strides[d]) % shape[d];
  }
  return out;
}

export class Variable {
  constructor(model, { name, dims, coords, start, lower, upper, mask, binary = false, integer = false }) {
    this.model = model;
    this.name = name;
    this.dims = dims;
    this.coords = coords;
    this.shape = shapeOf(coords);
    this.size = sizeOf(this.shape);
    this.strides = stridesOf(this.shape);
    this.start = start;
    this.binary = binary;
    this.integer = integer;
    this.labels = new Int32Array(this.size);
    for (let k = 0; k < this.size; k++) this.labels[k] = start + k;
    if (mask) {
      if (typeof mask === "function") {
        for (let k = 0; k < this.size; k++) if (!mask(...unravel(k, this.shape, this.strides))) this.labels[k] = -1;
      } else {
        for (let k = 0; k < this.size; k++) if (!mask[k]) this.labels[k] = -1;
      }
    }
    this.lower = fillArray(this.size, this.shape, lower, binary ? 0 : -Infinity);
    this.upper = fillArray(this.size, this.shape, upper, binary ? 1 : Infinity);
    this.solution = null;
  }

  get kind() {
    return this.binary ? "binary" : this.integer ? "integer" : "continuous";
  }

  /** Flat position from positional indices. */
  flat(...idx) {
    let k = 0;
    for (let d = 0; d < idx.length; d++) k += idx[d] * this.strides[d];
    return k;
  }

  /** Label at positional indices (or -1). */
  at(...idx) {
    return this.labels[this.flat(...idx)];
  }

  /** Label for coordinate labels (one per dim), -1 if missing. */
  get(...labels) {
    let k = 0;
    for (let d = 0; d < labels.length; d++) {
      const p = this.coords[d].getLoc(labels[d]);
      if (p < 0) return -1;
      k += p * this.strides[d];
    }
    return this.labels[k];
  }

  /** Position of a coordinate label along a dimension. */
  pos(dim, label) {
    return this.coords[this.dims.indexOf(dim)].getLoc(label);
  }

  /** Solution value for a label array element. */
  value(...idx) {
    return this.solution ? this.solution[this.flat(...idx)] : NaN;
  }

  get labelRange() {
    return [this.start, this.start + this.size];
  }
}

/**
 * Constraint array. Rows are stored in C order over `dims`; each row has a
 * list of terms (variable labels and coefficients), a sign and a rhs.
 */
export class Constraint {
  constructor(model, { name, dims, coords, start }) {
    this.model = model;
    this.name = name;
    this.dims = dims;
    this.coords = coords;
    this.shape = shapeOf(coords);
    this.size = sizeOf(this.shape);
    this.strides = stridesOf(this.shape);
    this.start = start;
    this.labels = new Int32Array(this.size).fill(-1);
    this.termPtr = new Int32Array(this.size + 1);
    this.vars = [];
    this.coeffs = [];
    this.sign = new Array(this.size).fill("=");
    this.rhs = new Float64Array(this.size);
    this.dual = null;
    this._n = 0;
  }

  /**
   * Append the next row in C order.
   * @param {number[]} vars variable labels (-1 entries are ignored)
   * @param {number[]} coeffs coefficients
   * @param {string} sign "=", "<=" or ">="
   * @param {number} rhs right-hand side (NaN masks the row like linopy)
   * @param {boolean} active mask value
   */
  push(vars, coeffs, sign, rhs, active = true) {
    const k = this._n++;
    if (k >= this.size) throw new Error(`Too many rows pushed to constraint ${this.name}`);
    for (let t = 0; t < vars.length; t++) {
      this.vars.push(vars[t]);
      this.coeffs.push(coeffs[t]);
    }
    this.termPtr[k + 1] = this.vars.length;
    this.sign[k] = normalizeSign(sign);
    let r = rhs;
    let act = active;
    if (Number.isNaN(r)) {
      r = 0;
      act = false;
    }
    this.rhs[k] = r;
    this.labels[k] = act ? this.start + k : -1;
  }

  finalize() {
    if (this._n !== this.size) throw new Error(`Constraint ${this.name}: ${this._n} rows pushed, expected ${this.size}`);
    this.vars = Int32Array.from(this.vars);
    this.coeffs = Float64Array.from(this.coeffs);
    return this;
  }

  /** Terms of a row after linopy's filtering (vars != -1, coeffs != 0) and duplicate grouping. */
  rowTerms(k) {
    const vs = [];
    const cs = [];
    const seen = new Map();
    for (let p = this.termPtr[k]; p < this.termPtr[k + 1]; p++) {
      const v = this.vars[p];
      const c = this.coeffs[p];
      if (v === -1 || c === 0) continue;
      const prev = seen.get(v);
      if (prev !== undefined) cs[prev] += c;
      else {
        seen.set(v, vs.length);
        vs.push(v);
        cs.push(c);
      }
    }
    return [vs, cs];
  }

  get labelRange() {
    return [this.start, this.start + this.size];
  }

  flat(...idx) {
    let k = 0;
    for (let d = 0; d < idx.length; d++) k += idx[d] * this.strides[d];
    return k;
  }
}

export function normalizeSign(sign) {
  if (sign === "==") return "=";
  if (sign === "=<") return "<=";
  if (sign === "=>") return ">=";
  return sign;
}

export class Model {
  constructor() {
    this._xCounter = 0;
    this._cCounter = 0;
    this.variables = new Map();
    this.constraints = new Map();
    this.objective = { vars: [], coeffs: [], q1: [], q2: [], qcoeffs: [], const: 0, sense: "min" };
    this.parameters = {};
    this.status = null;
    this.termination_condition = null;
    this.objectiveValue = null;
  }

  /**
   * Add a variable array.
   * @param {object} spec
   * @param {string} spec.name
   * @param {string[]} [spec.dims]
   * @param {Index[]} [spec.coords]
   */
  add_variables({ name, dims = [], coords = [], lower = -Infinity, upper = Infinity, mask = null, binary = false, integer = false }) {
    if (this.variables.has(name)) throw new Error(`Variable '${name}' already assigned to model`);
    const v = new Variable(this, { name, dims, coords: coords.map((c) => (c instanceof Index ? c : new Index(c))), start: this._xCounter, lower, upper, mask, binary, integer });
    this._xCounter += v.size;
    this.variables.set(name, v);
    return v;
  }

  /** Create an empty constraint array; rows are then pushed in C order. */
  new_constraint(name, dims = [], coords = []) {
    if (this.constraints.has(name)) throw new Error(`Constraint '${name}' already assigned to model`);
    const c = new Constraint(this, { name, dims, coords: coords.map((x) => (x instanceof Index ? x : new Index(x))), start: this._cCounter });
    this._cCounter += c.size;
    return c;
  }

  /** Register a finished constraint. */
  add_constraint(con) {
    con.finalize();
    this.constraints.set(con.name, con);
    return con;
  }

  /**
   * Convenience: build a constraint from a row function called for each
   * C-ordered position; it returns [vars, coeffs, sign, rhs, active] or null
   * for a masked row without terms.
   */
  add_constraints(name, dims, coords, rowFn) {
    const con = this.new_constraint(name, dims, coords);
    for (let k = 0; k < con.size; k++) {
      const idx = unravel(k, con.shape, con.strides);
      const r = rowFn(...idx);
      if (r === null || r === undefined) con.push([], [], "=", 0, false);
      else con.push(r[0], r[1], r[2], r[3], r.length > 4 ? r[4] : true);
    }
    return this.add_constraint(con);
  }

  /** Append linear objective terms. */
  add_objective_terms(vars, coeffs) {
    for (let t = 0; t < vars.length; t++) {
      this.objective.vars.push(vars[t]);
      this.objective.coeffs.push(coeffs[t]);
    }
  }

  add_quadratic_objective_terms(v1, v2, coeffs) {
    for (let t = 0; t < v1.length; t++) {
      this.objective.q1.push(v1[t]);
      this.objective.q2.push(v2[t]);
      this.objective.qcoeffs.push(coeffs[t]);
    }
  }

  get is_quadratic() {
    return this.objective.q1.length > 0;
  }

  get type() {
    const mip = [...this.variables.values()].some((v) => v.binary || v.integer);
    if (this.is_quadratic) return mip ? "MIQP" : "QP";
    return mip ? "MILP" : "LP";
  }

  /** Objective terms after linopy filtering and grouping. */
  objectiveTerms() {
    const vs = [];
    const cs = [];
    const seen = new Map();
    const o = this.objective;
    for (let t = 0; t < o.vars.length; t++) {
      const v = o.vars[t];
      const c = o.coeffs[t];
      if (v === -1 || c === 0) continue;
      const p = seen.get(v);
      if (p !== undefined) cs[p] += c;
      else {
        seen.set(v, vs.length);
        vs.push(v);
        cs.push(c);
      }
    }
    return [vs, cs];
  }

  quadraticTerms() {
    const o = this.objective;
    const v1 = [];
    const v2 = [];
    const cs = [];
    const seen = new Map();
    for (let t = 0; t < o.q1.length; t++) {
      const a = o.q1[t];
      const b = o.q2[t];
      const c = o.qcoeffs[t];
      if (a === -1 || b === -1 || c === 0) continue;
      const key = `${a},${b}`;
      const p = seen.get(key);
      if (p !== undefined) cs[p] += c;
      else {
        seen.set(key, v1.length);
        v1.push(a);
        v2.push(b);
        cs.push(c);
      }
    }
    return [v1, v2, cs];
  }

  /** Write the model as LP text identical to linopy's `to_file(io_api="lp")`. */
  to_lp() {
    const out = [];
    const signed = (x) => (x >= 0 ? "+" : "") + (x === 0 ? "0.0" : polarsFloat(x));
    out.push(`${this.objective.sense}\n\nobj:\n\n`);
    const [ov, oc] = this.objectiveTerms();
    for (let t = 0; t < ov.length; t++) out.push(`${signed(oc[t])} x${ov[t]}\n`);
    if (this.is_quadratic) {
      const [q1, q2, qc] = this.quadraticTerms();
      out.push("+ [\n");
      for (let t = 0; t < q1.length; t++) out.push(`${signed(qc[t] * 2)} x${q1[t]} * x${q2[t]}\n`);
      out.push("] / 2\n");
    }
    if (this.constraints.size) {
      out.push("\n\ns.t.\n\n");
      for (const con of this.constraints.values()) {
        for (let k = 0; k < con.size; k++) {
          const label = con.labels[k];
          if (label === -1) continue;
          const [vs, cs] = con.rowTerms(k);
          if (!vs.length) continue;
          let s = `c${label}:\n`;
          for (let t = 0; t < vs.length; t++) s += `${signed(cs[t])} x${vs[t]}\n`;
          s += `${con.sign[k]} ${polarsFloat(con.rhs[k])}\n`;
          out.push(s);
        }
      }
    }
    const vars = [...this.variables.values()];
    const bounded = [
      ...vars.filter((v) => !v.binary && !v.integer),
      ...vars.filter((v) => v.integer),
      ...vars.filter((v) => v.binary && (v.lower.some((x) => x !== 0) || v.upper.some((x) => x !== 1))),
    ];
    if (bounded.length) {
      out.push("\n\nbounds\n\n");
      for (const v of bounded) {
        for (let k = 0; k < v.size; k++) {
          const l = v.labels[k];
          if (l === -1) continue;
          out.push(`${signed(v.lower[k])} <=  x${l} <= ${signed(v.upper[k])}\n`);
        }
      }
    }
    const binaries = vars.filter((v) => v.binary);
    if (binaries.length) {
      out.push("\n\nbinary\n\n");
      for (const v of binaries) for (const l of v.labels) if (l !== -1) out.push(` x${l}\n`);
    }
    const integers = vars.filter((v) => v.integer);
    if (integers.length) {
      out.push("\n\ngeneral\n\n");
      for (const v of integers) for (const l of v.labels) if (l !== -1) out.push(` x${l}\n`);
    }
    out.push("end\n");
    return out.join("");
  }

  /**
   * Solve with HiGHS (highs-js). Returns [status, termination_condition].
   */
  async solve({ solver_name = "highs", solver_options = {}, log_to_console = false } = {}) {
    if (solver_name !== "highs") throw new Error(`Solver ${solver_name} is not available in PSA.js (only 'highs').`);
    const highs = await getHighs();
    const lp = this.to_lp();
    this._lp = lp;
    const model = highs.createModel({ format: "lp", data: lp });
    try {
      model.options.set({ output_flag: Boolean(log_to_console), log_to_console: Boolean(log_to_console), ...solver_options });
      model.run();
      const status = model.getModelStatus();
      const C = highs.constants.modelStatus;
      const sol = model.getSolution();
      if (status === C.optimal) {
        this.status = "ok";
        this.termination_condition = "optimal";
      } else {
        this.status = "warning";
        const map = {
          [C.infeasible]: "infeasible",
          [C.unboundedOrInfeasible]: "infeasible_or_unbounded",
          [C.unbounded]: "unbounded",
          [C.timeLimit]: "time_limit",
          [C.iterationLimit]: "iteration_limit",
        };
        this.termination_condition = map[status] ?? "unknown";
      }
      if (this.status === "ok") {
        // map solution by column/row names (x<label>, c<label>)
        const xsol = new Map();
        for (let j = 0; j < sol.colValue.length; j++) xsol.set(Number(model.getColName(j).slice(1)), sol.colValue[j]);
        for (const v of this.variables.values()) {
          v.solution = new Float64Array(v.size);
          for (let k = 0; k < v.size; k++) {
            const l = v.labels[k];
            v.solution[k] = l === -1 ? NaN : xsol.get(l) ?? NaN;
          }
        }
        const isMip = this.type.startsWith("MI") || this.type === "MILP";
        const dualValid = !isMip && sol.rowDual && sol.rowDual.length === model.getNumRow?.() ? true : !isMip;
        if (dualValid && sol.rowDual) {
          const dsol = new Map();
          for (let i = 0; i < sol.rowDual.length; i++) dsol.set(Number(model.getRowName(i).slice(1)), sol.rowDual[i]);
          for (const c of this.constraints.values()) {
            c.dual = new Float64Array(c.size);
            for (let k = 0; k < c.size; k++) {
              const l = c.labels[k];
              c.dual[k] = l === -1 ? NaN : dsol.has(l) ? dsol.get(l) : NaN;
            }
          }
        } else {
          for (const c of this.constraints.values()) c.dual = null;
        }
        this.objectiveValue = model.getObjectiveValue() + (this.objective.const || 0);
      }
      return [this.status, this.termination_condition];
    } finally {
      model.dispose();
    }
  }

  toString() {
    const lines = ["Linopy-compatible model", "=======================", "", "Variables:", "----------"];
    for (const v of this.variables.values()) lines.push(` * ${v.name} (${v.dims.join(", ")})`);
    lines.push("", "Constraints:", "------------");
    for (const c of this.constraints.values()) lines.push(` * ${c.name} (${c.dims.join(", ")})`);
    lines.push("", "Status:", "-------", String(this.status ?? "initialized"));
    return lines.join("\n");
  }
}

let highsPromise = null;
/** Load the HiGHS WebAssembly solver once. */
export function getHighs() {
  if (!highsPromise) {
    highsPromise = import("highs").then((mod) => (mod.default ?? mod)());
  }
  return highsPromise;
}

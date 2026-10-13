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

import { installExpressions } from "./expressions.js";
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
    /** SOS constraint attributes (`sos_type`, `sos_dim`, `big_m_upper`) or null */
    this.sos = null;
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
    // NaN rhs masks the row (linopy) but is kept so that derived constraints
    // (e.g. security constraints) see the same data as in linopy.
    this.rhs[k] = rhs;
    this.labels[k] = active && !Number.isNaN(rhs) ? this.start + k : -1;
  }

  /** Raw (unfiltered) terms of a row, like `con.lhs` in linopy. */
  rawTerms(k) {
    return [Array.from(this.vars.subarray(this.termPtr[k], this.termPtr[k + 1])), Array.from(this.coeffs.subarray(this.termPtr[k], this.termPtr[k + 1]))];
  }

  finalize() {
    if (this._n !== this.size) throw new Error(`Constraint ${this.name}: ${this._n} rows pushed, expected ${this.size}`);
    this.vars = Int32Array.from(this.vars);
    this.coeffs = Float64Array.from(this.coeffs);
    return this;
  }

  /** Remove terms with zero or near-zero coefficients (linopy `sanitize_zeros`). */
  sanitize_zeros() {
    for (let p = 0; p < this.vars.length; p++) {
      if (!(Math.abs(this.coeffs[p]) > 1e-10)) {
        this.vars[p] = -1;
        this.coeffs[p] = NaN;
      }
    }
    return this;
  }

  /** Mask rows with `<= inf` or `>= -inf` right-hand sides (linopy `sanitize_infinities`). */
  sanitize_infinities() {
    for (let k = 0; k < this.size; k++) {
      if ((this.sign[k] === "<=" && this.rhs[k] === Infinity) || (this.sign[k] === ">=" && this.rhs[k] === -Infinity)) this.labels[k] = -1;
    }
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

function reformulateSos1(m, v, d, M, prefix) {
  const yName = `${prefix}${v.name}_y`;
  const y = m.add_variables({ name: yName, dims: v.dims, coords: v.coords, binary: true });
  const upper = `${prefix}${v.name}_upper`;
  m.add_constraints(upper, v.dims, v.coords, (...idx) => {
    const k = v.flat(...idx);
    return [[v.labels[k], y.labels[k]], [1, -M[k]], "<=", -0];
  });
  const other = v.dims.map((_, i) => i).filter((i) => i !== d);
  const card = `${prefix}${v.name}_card`;
  m.add_constraints(card, other.map((i) => v.dims[i]), other.map((i) => v.coords[i]), (...oidx) => {
    const vars = [];
    for (let b = 0; b < v.shape[d]; b++) {
      const idx = new Array(v.dims.length);
      other.forEach((i, t) => (idx[i] = oidx[t]));
      idx[d] = b;
      vars.push(y.labels[y.flat(...idx)]);
    }
    return [vars, vars.map(() => 1), "<=", 1];
  });
  return [[yName], [upper, card]];
}

function reformulateSos2(m, v, d, M, prefix) {
  const n = v.shape[d];
  const zName = `${prefix}${v.name}_z`;
  const zCoords = v.coords.map((c, i) => (i === d ? c.slice(0, n - 1) : c));
  const z = m.add_variables({ name: zName, dims: v.dims, coords: zCoords, binary: true });
  const other = v.dims.map((_, i) => i).filter((i) => i !== d);
  const odims = other.map((i) => v.dims[i]);
  const ocoords = other.map((i) => v.coords[i]);
  const at = (arr, obj, oidx, b) => {
    const idx = new Array(v.dims.length);
    other.forEach((i, t) => (idx[i] = oidx[t]));
    idx[d] = b;
    return arr === "M" ? M[v.flat(...idx)] : obj.labels[obj.flat(...idx)];
  };
  // `x <= M * z` rows become `x - M z <= -0.0` in linopy
  const first = `${prefix}${v.name}_upper_first`;
  m.add_constraints(first, odims, ocoords, (...oidx) => [[at(null, v, oidx, 0), at(null, z, oidx, 0)], [1, -at("M", null, oidx, 0)], "<=", -0]);
  const cons = [first];
  if (n > 2) {
    const mid = `${prefix}${v.name}_upper_mid`;
    m.add_constraints(mid, v.dims, v.coords.map((c, i) => (i === d ? c.slice(1, n - 1) : c)), (...idx) => {
      const b = idx[d] + 1;
      const oidx = other.map((i) => idx[i]);
      const Mi = at("M", null, oidx, b);
      return [[at(null, v, oidx, b), at(null, z, oidx, b - 1), at(null, z, oidx, b)], [1, -Mi, -Mi], "<=", -0];
    });
    cons.push(mid);
  }
  const last = `${prefix}${v.name}_upper_last`;
  m.add_constraints(last, odims, ocoords, (...oidx) => [[at(null, v, oidx, n - 1), at(null, z, oidx, n - 2)], [1, -at("M", null, oidx, n - 1)], "<=", -0]);
  const card = `${prefix}${v.name}_card`;
  m.add_constraints(card, odims, ocoords, (...oidx) => {
    const vars = [];
    for (let b = 0; b < n - 1; b++) vars.push(at(null, z, oidx, b));
    return [vars, vars.map(() => 1), "<=", 1];
  });
  cons.push(last, card);
  return [[zName], cons];
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
    if (binary) {
      // linopy: binaries cannot carry bounds and are stored with [0, 1]
      lower = 0;
      upper = 1;
    }
    const v = new Variable(this, { name, dims, coords: coords.map((c) => (c instanceof Index ? c : new Index(c))), start: this._xCounter, lower, upper, mask, binary, integer });
    this._xCounter += v.size;
    this.variables.set(name, v);
    return v;
  }

  /**
   * Add an SOS1 or SOS2 constraint along one dimension of a variable
   * (`Model.add_sos_constraints`).
   */
  add_sos_constraints(variable, sos_type, sos_dim, big_m = null) {
    if (sos_type !== 1 && sos_type !== 2) throw new Error(`ValueError: sos_type must be 1 or 2, got ${sos_type}`);
    if (!variable.dims.includes(sos_dim)) throw new Error(`ValueError: sos_dim must name a variable dimension, got ${sos_dim}`);
    if (variable.sos) {
      throw new Error(
        `ValueError: variable already has an sos${variable.sos.sos_type} constraint on dimension ${variable.sos.sos_dim}; remove it first`,
      );
    }
    variable.sos = { sos_type, sos_dim, big_m_upper: big_m };
  }

  /** Names of variables carrying SOS constraints (`m.variables.sos`). */
  get sosVariables() {
    return [...this.variables.values()].filter((v) => v.sos).map((v) => v.name);
  }

  /**
   * Reformulate SOS constraints as binary + linear constraints with big-M
   * values from the variable bounds (`linopy.sos_reformulation`). Returns a
   * token for `undo_sos_reformulation`.
   */
  reformulate_sos_constraints(prefix = "_sos_reform_") {
    const result = { reformulated: [], savedAttrs: new Map(), addedVariables: [], addedConstraints: [] };
    for (const name of this.sosVariables) {
      const v = this.variables.get(name);
      const { sos_type, sos_dim, big_m_upper } = v.sos;
      const d = v.dims.indexOf(sos_dim);
      result.savedAttrs.set(name, v.sos);
      if (v.shape[d] <= 1) {
        v.sos = null;
        result.reformulated.push(name);
        continue;
      }
      if (v.lower.some((x) => x < 0)) {
        throw new Error(`ValueError: Variable '${name}' has negative lower bounds. SOS reformulation requires non-negative variables (lower >= 0).`);
      }
      const M = Float64Array.from(v.upper, (u) => (big_m_upper === null || big_m_upper === undefined ? u : Math.min(u, big_m_upper)));
      if (M.some((x) => x === Infinity)) {
        throw new Error(`ValueError: Variable '${name}' has infinite upper bounds. Set finite bounds or specify big_m in add_sos_constraints().`);
      }
      if (M.every((x) => x === 0)) {
        v.sos = null;
        result.reformulated.push(name);
        continue;
      }
      const [vars, cons] = sos_type === 1 ? reformulateSos1(this, v, d, M, prefix) : reformulateSos2(this, v, d, M, prefix);
      result.addedVariables.push(...vars);
      result.addedConstraints.push(...cons);
      v.sos = null;
      result.reformulated.push(name);
    }
    return result;
  }

  /** Undo `reformulate_sos_constraints`. */
  undo_sos_reformulation(result) {
    for (const c of result.addedConstraints) this.constraints.delete(c);
    for (const v of result.addedVariables) this.variables.delete(v);
    for (const [name, attrs] of result.savedAttrs) {
      const v = this.variables.get(name);
      if (v) v.sos = attrs;
    }
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
    const sosVars = vars.filter((v) => v.sos);
    if (sosVars.length) {
      // one set per slice along `sos_dim`, identified by its largest member label
      // (linopy emits the sets in polars group order; PSA.js sorts them)
      out.push("\n\nsos\n\n");
      for (const v of sosVars) {
        const d = v.dims.indexOf(v.sos.sos_dim);
        const coords = v.coords[d].values;
        const ascending = coords.every((c, i) => i === 0 || (typeof c === "number" && c > coords[i - 1])) && typeof coords[0] === "number";
        const weights = coords.map((c, i) => (ascending ? c : i));
        const sets = new Map();
        for (let k = 0; k < v.size; k++) {
          const idx = unravel(k, v.shape, v.strides);
          const b = idx[d];
          idx[d] = 0;
          const key = v.flat(...idx);
          if (!sets.has(key)) sets.set(key, []);
          sets.get(key).push([v.labels[k], weights[b]]);
        }
        const lines = [];
        for (const members of sets.values()) {
          const id = Math.max(...members.map(([l]) => l));
          const kept = members.filter(([l]) => l !== -1);
          if (id === -1 || !kept.length) continue;
          lines.push([id, `s${id}: S${v.sos.sos_type} :: ${kept.map(([l, w]) => ` x${l}:${w}`).join(" ")}\n`]);
        }
        lines.sort((a, b) => a[0] - b[0]);
        for (const [, line] of lines) out.push(line);
      }
    }
    out.push("end\n");
    return out.join("");
  }

  /**
   * Solve with HiGHS (highs-js). Returns [status, termination_condition].
   */
  async solve({ solver_name = "highs", solver_options = {}, log_to_console = false, reformulate_sos = false } = {}) {
    if (solver_name !== "highs") throw new Error(`Solver ${solver_name} is not available in PSA.js (only 'highs').`);
    if (reformulate_sos !== true && reformulate_sos !== false && reformulate_sos !== "auto") {
      throw new Error(`ValueError: Invalid value for reformulate_sos: ${reformulate_sos}. Must be True, False, or 'auto'.`);
    }
    if (this.sosVariables.length) {
      // HiGHS does not support SOS constraints
      if (reformulate_sos === false) {
        throw new Error(
          `ValueError: Solver ${solver_name} does not support SOS constraints. Reformulate first via \`Model.solve(reformulate_sos=True)\` or \`model.apply_sos_reformulation()\`, or use a solver that supports SOS.`,
        );
      }
      const state = this.reformulate_sos_constraints();
      try {
        return await this.solve({ solver_name, solver_options, log_to_console, reformulate_sos: false });
      } finally {
        this.undo_sos_reformulation(state);
      }
    }
    const highs = await getHighs();
    // linopy sanitizes the constraints in place before writing the problem
    for (const con of this.constraints.values()) con.sanitize_zeros().sanitize_infinities();
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
        // HiGHS reports an all-zero row dual for MIPs (dual_valid false), which
        // linopy passes through unchanged.
        const isMip = this.type === "MILP" || this.type === "MIQP";
        const dsol = new Map();
        if (!isMip && sol.rowDual) for (let i = 0; i < sol.rowDual.length; i++) dsol.set(Number(model.getRowName(i).slice(1)), sol.rowDual[i]);
        for (const c of this.constraints.values()) {
          c.dual = new Float64Array(c.size);
          for (let k = 0; k < c.size; k++) {
            const l = c.labels[k];
            c.dual[k] = l === -1 ? NaN : isMip ? 0 : dsol.has(l) ? dsol.get(l) : NaN;
          }
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

installExpressions(Variable, Model);

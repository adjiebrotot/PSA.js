// SPDX-License-Identifier: MIT
/**
 * A small subset of linopy's expression API, enough to write custom
 * constraints (`extra_functionality`) and objectives (MGA):
 *
 *   const p = m.variables.get("Link-p");
 *   m.add_constraints(p.sum().le(30000), { name: "GlobalConstraint-limit" });
 *   m.add_constraints(p.sum("name").le(5000), { name: "GlobalConstraint-limit_t" });
 *
 * Term ordering follows linopy so that LP files match: `sum()` ravels cells in
 * C order (terms innermost), `sum(dims)` stacks the old terms outermost.
 */

import { Index } from "../core/index.js";
import { DataFrame, Series } from "../core/frame.js";

function shapeOf(coords) {
  return coords.map((c) => c.length);
}

function sizeOf(shape) {
  return shape.reduce((a, b) => a * b, 1);
}

function stridesOf(shape) {
  const s = new Array(shape.length).fill(1);
  for (let i = shape.length - 2; i >= 0; i--) s[i] = s[i + 1] * shape[i + 1];
  return s;
}

function unravel(k, shape, strides) {
  return shape.map((_, d) => Math.floor(k / strides[d]) % shape[d]);
}

function asIndexList(labels) {
  if (labels instanceof Index) return labels.values;
  return Array.isArray(labels) ? labels : [labels];
}

/** Coordinates of a constant operand: {dims, coords, get(idxByDim)}. */
function constantOperand(c, expr) {
  if (typeof c === "number") return { dims: [], coords: [], at: () => c };
  if (c instanceof Series) {
    const dim = c.index.name ?? (expr.dims.length === 1 ? expr.dims[0] : "name");
    return { dims: [dim], coords: [c.index], at: (pos) => c.values[pos[0]] };
  }
  if (c instanceof DataFrame) {
    const rowDim = c.index.name ?? "snapshot";
    const colDim = c.columns.name ?? "name";
    return { dims: [rowDim, colDim], coords: [c.index, c.columns], at: (pos) => c.col(c.columns.at(pos[1]))[pos[0]] };
  }
  if (Array.isArray(c) || ArrayBuffer.isView(c)) {
    if (c.length !== expr.size) throw new Error("Array operand must match the expression size");
    return { dims: expr.dims.slice(), coords: expr.coords.slice(), at: (pos) => c[pos.reduce((k, p, d) => k + p * expr.strides[d], 0)], flat: true };
  }
  throw new TypeError(`Unsupported operand ${c}`);
}

export class LinearExpression {
  /**
   * @param {object} model linopy-like model
   * @param {string[]} dims
   * @param {Index[]} coords
   * @param {number} nterm terms per cell
   * @param {Int32Array} vars size * nterm
   * @param {Float64Array} coeffs size * nterm
   * @param {Float64Array} consts size
   */
  constructor(model, dims, coords, nterm, vars, coeffs, consts) {
    this.model = model;
    this.dims = dims;
    this.coords = coords;
    this.shape = shapeOf(coords);
    this.size = sizeOf(this.shape);
    this.strides = stridesOf(this.shape);
    this.nterm = nterm;
    this.vars = vars;
    this.coeffs = coeffs;
    this.consts = consts;
  }

  static fromVariable(v) {
    const size = v.size;
    return new LinearExpression(v.model, v.dims.slice(), v.coords.slice(), 1, Int32Array.from(v.labels), new Float64Array(size).fill(1), new Float64Array(size));
  }

  static constant(model, value) {
    return new LinearExpression(model, [], [], 0, new Int32Array(0), new Float64Array(0), Float64Array.of(value));
  }

  _cellIndex(pos) {
    let k = 0;
    for (let d = 0; d < pos.length; d++) k += pos[d] * this.strides[d];
    return k;
  }

  /** Select coordinates (`{dim: labels}`); a scalar label drops the dimension. */
  sel(selectors) {
    let out = this;
    for (const [dim, labels] of Object.entries(selectors)) {
      const d = out.dims.indexOf(dim);
      if (d < 0) throw new Error(`Dimension ${dim} not in expression`);
      const scalar = !(labels instanceof Index) && !Array.isArray(labels);
      const lab = asIndexList(labels);
      const pos = lab.map((l) => {
        const p = out.coords[d].getLoc(l);
        if (p < 0) throw new Error(`KeyError: ${l} not in ${dim}`);
        return p;
      });
      out = out._take(d, pos, scalar ? null : new Index(lab, out.coords[d].names.length > 1 ? out.coords[d].names : dim));
    }
    return out;
  }

  _take(d, positions, newCoord) {
    const dims = this.dims.slice();
    const coords = this.coords.slice();
    if (newCoord === null) {
      dims.splice(d, 1);
      coords.splice(d, 1);
    } else coords[d] = newCoord;
    const shape = shapeOf(coords);
    const size = sizeOf(shape);
    const strides = stridesOf(shape);
    const vars = new Int32Array(size * this.nterm);
    const coeffs = new Float64Array(size * this.nterm);
    const consts = new Float64Array(size);
    for (let k = 0; k < size; k++) {
      const pos = unravel(k, shape, strides);
      const src = newCoord === null ? [...pos.slice(0, d), positions[0], ...pos.slice(d)] : pos.map((p, i) => (i === d ? positions[p] : p));
      const sk = this._cellIndex(src);
      for (let t = 0; t < this.nterm; t++) {
        vars[k * this.nterm + t] = this.vars[sk * this.nterm + t];
        coeffs[k * this.nterm + t] = this.coeffs[sk * this.nterm + t];
      }
      consts[k] = this.consts[sk];
    }
    return new LinearExpression(this.model, dims, coords, this.nterm, vars, coeffs, consts);
  }

  /** Multiply by a number, Series, DataFrame or flat array (aligned on coordinates). */
  mul(c) {
    if (typeof c === "number") {
      return new LinearExpression(
        this.model,
        this.dims,
        this.coords,
        this.nterm,
        this.vars,
        this.coeffs.map((x) => x * c),
        this.consts.map((x) => x * c),
      );
    }
    const op = constantOperand(c, this);
    if (op.flat) {
      const coeffs = new Float64Array(this.coeffs.length);
      const consts = new Float64Array(this.size);
      for (let k = 0; k < this.size; k++) {
        const v = c[k];
        for (let t = 0; t < this.nterm; t++) coeffs[k * this.nterm + t] = this.coeffs[k * this.nterm + t] * v;
        consts[k] = this.consts[k] * v;
      }
      return new LinearExpression(this.model, this.dims, this.coords, this.nterm, this.vars, coeffs, consts);
    }
    // left join on the expression's coordinates (missing factors give 0); a
    // size mismatch moves the operand's dimensions first (xarray reindexing)
    let mismatch = false;
    for (let i = 0; i < op.dims.length; i++) {
      const d = this.dims.indexOf(op.dims[i]);
      if (d >= 0 && this.coords[d].length !== op.coords[i].length) mismatch = true;
    }
    const newDims = op.dims.filter((d) => !this.dims.includes(d));
    let dims = [...this.dims, ...newDims];
    if (mismatch) dims = [...op.dims, ...this.dims.filter((d) => !op.dims.includes(d))];
    const coordOf = (dim) => {
      const d = this.dims.indexOf(dim);
      return d >= 0 ? this.coords[d] : op.coords[op.dims.indexOf(dim)];
    };
    const coords = dims.map(coordOf);
    const shape = shapeOf(coords);
    const size = sizeOf(shape);
    const strides = stridesOf(shape);
    const vars = new Int32Array(size * this.nterm);
    const coeffs = new Float64Array(size * this.nterm);
    const consts = new Float64Array(size);
    for (let k = 0; k < size; k++) {
      const pos = unravel(k, shape, strides);
      const src = this.dims.map((dim) => pos[dims.indexOf(dim)]);
      const sk = this._cellIndex(src);
      const opPos = op.dims.map((dim) => op.coords[op.dims.indexOf(dim)].getLoc(coords[dims.indexOf(dim)].at(pos[dims.indexOf(dim)])));
      let f = opPos.some((p) => p < 0) ? 0 : op.at(opPos);
      if (Number.isNaN(f)) f = 0;
      for (let t = 0; t < this.nterm; t++) {
        vars[k * this.nterm + t] = this.vars[sk * this.nterm + t];
        coeffs[k * this.nterm + t] = this.coeffs[sk * this.nterm + t] * f;
      }
      consts[k] = this.consts[sk] * f;
    }
    return new LinearExpression(this.model, dims, coords, this.nterm, vars, coeffs, consts);
  }

  neg() {
    return this.mul(-1);
  }

  /** Add an expression, variable, number or Series (terms are concatenated). */
  add(other) {
    if (typeof other === "number") {
      return new LinearExpression(
        this.model,
        this.dims,
        this.coords,
        this.nterm,
        this.vars,
        this.coeffs,
        this.consts.map((x) => x + other),
      );
    }
    const o = toExpr(other, this.model);
    const dims = [...this.dims, ...o.dims.filter((d) => !this.dims.includes(d))];
    const coords = dims.map((dim) => {
      const a = this.dims.indexOf(dim);
      const b = o.dims.indexOf(dim);
      if (a < 0) return o.coords[b];
      if (b < 0) return this.coords[a];
      const ca = this.coords[a];
      const cb = o.coords[b];
      if (ca.equals(cb) || ca.length === cb.length) return ca; // positional when sizes match (linopy legacy)
      return ca.union(cb);
    });
    const shape = shapeOf(coords);
    const size = sizeOf(shape);
    const strides = stridesOf(shape);
    const nterm = this.nterm + o.nterm;
    const vars = new Int32Array(size * nterm).fill(-1);
    const coeffs = new Float64Array(size * nterm).fill(NaN);
    const consts = new Float64Array(size);
    const locate = (expr, pos) => {
      const src = [];
      for (let d = 0; d < expr.dims.length; d++) {
        const dd = dims.indexOf(expr.dims[d]);
        const c = expr.coords[d];
        const p = c.length === coords[dd].length ? pos[dd] : c.getLoc(coords[dd].at(pos[dd]));
        if (p < 0) return -1;
        src.push(p);
      }
      return expr._cellIndex(src);
    };
    for (let k = 0; k < size; k++) {
      const pos = unravel(k, shape, strides);
      const ka = locate(this, pos);
      const kb = locate(o, pos);
      if (ka >= 0) {
        for (let t = 0; t < this.nterm; t++) {
          vars[k * nterm + t] = this.vars[ka * this.nterm + t];
          coeffs[k * nterm + t] = this.coeffs[ka * this.nterm + t];
        }
        consts[k] += this.consts[ka];
      }
      if (kb >= 0) {
        for (let t = 0; t < o.nterm; t++) {
          vars[k * nterm + this.nterm + t] = o.vars[kb * o.nterm + t];
          coeffs[k * nterm + this.nterm + t] = o.coeffs[kb * o.nterm + t];
        }
        consts[k] += o.consts[kb];
      }
    }
    return new LinearExpression(this.model, dims, coords, nterm, vars, coeffs, consts);
  }

  sub(other) {
    if (typeof other === "number") return this.add(-other);
    return this.add(toExpr(other, this.model).neg());
  }

  /**
   * Sum over dimensions (all when omitted). Without dims cells are raveled in
   * C order (terms innermost); with dims the old terms become the outermost
   * stacking level, followed by the summed dims in the given order.
   */
  sum(dims = null) {
    const sumDims = dims === null || dims === undefined ? this.dims.slice() : Array.isArray(dims) ? dims : [dims];
    for (const d of sumDims) if (!this.dims.includes(d)) throw new Error(`Dimension ${d} not in expression`);
    const keep = this.dims.filter((d) => !sumDims.includes(d));
    const keepCoords = keep.map((d) => this.coords[this.dims.indexOf(d)]);
    const kshape = shapeOf(keepCoords);
    const ksize = sizeOf(kshape);
    const kstrides = stridesOf(kshape);
    const sCoords = sumDims.map((d) => this.coords[this.dims.indexOf(d)]);
    const sshape = shapeOf(sCoords);
    const ssize = sizeOf(sshape);
    const sstrides = stridesOf(sshape);
    const nterm = this.nterm * ssize;
    const vars = new Int32Array(ksize * nterm);
    const coeffs = new Float64Array(ksize * nterm);
    const consts = new Float64Array(ksize);
    const raveled = dims === null || dims === undefined;
    for (let k = 0; k < ksize; k++) {
      const kpos = unravel(k, kshape, kstrides);
      let t = 0;
      const cell = (spos) => {
        const pos = this.dims.map((d) => (keep.includes(d) ? kpos[keep.indexOf(d)] : spos[sumDims.indexOf(d)]));
        return this._cellIndex(pos);
      };
      if (raveled) {
        for (let s = 0; s < ssize; s++) {
          const c = cell(unravel(s, sshape, sstrides));
          for (let tt = 0; tt < this.nterm; tt++) {
            vars[k * nterm + t] = this.vars[c * this.nterm + tt];
            coeffs[k * nterm + t] = this.coeffs[c * this.nterm + tt];
            t++;
          }
          consts[k] += this.consts[c];
        }
      } else {
        for (let tt = 0; tt < this.nterm; tt++) {
          for (let s = 0; s < ssize; s++) {
            const c = cell(unravel(s, sshape, sstrides));
            vars[k * nterm + t] = this.vars[c * this.nterm + tt];
            coeffs[k * nterm + t] = this.coeffs[c * this.nterm + tt];
            t++;
            if (tt === 0) consts[k] += this.consts[c];
          }
        }
      }
    }
    return new LinearExpression(this.model, keep, keepCoords, nterm, vars, coeffs, consts);
  }

  le(rhs) {
    return new ConstraintSpec(this, "<=", rhs);
  }

  ge(rhs) {
    return new ConstraintSpec(this, ">=", rhs);
  }

  eq(rhs) {
    return new ConstraintSpec(this, "=", rhs);
  }

  /** Solution values of the expression (after solving). */
  get solution() {
    const out = new Float64Array(this.size);
    const sol = this.model._labelSolution();
    for (let k = 0; k < this.size; k++) {
      let s = this.consts[k];
      for (let t = 0; t < this.nterm; t++) {
        const v = this.vars[k * this.nterm + t];
        if (v >= 0) s += this.coeffs[k * this.nterm + t] * sol.get(v);
      }
      out[k] = s;
    }
    return out;
  }
}

/** Convert a variable / expression / number to a LinearExpression. */
export function toExpr(x, model) {
  if (x instanceof LinearExpression) return x;
  if (typeof x === "number") return LinearExpression.constant(model, x);
  if (x && typeof x.labels !== "undefined" && x.dims) return LinearExpression.fromVariable(x);
  throw new TypeError(`Cannot convert ${x} to a linear expression`);
}

/** Merge expressions along the term dimension (linopy `merge`). */
export function merge(exprs) {
  if (!exprs.length) throw new Error("Nothing to merge");
  return exprs.slice(1).reduce((a, b) => a.add(b), toExpr(exprs[0]));
}

export class ConstraintSpec {
  constructor(lhs, sign, rhs) {
    this.lhs = lhs;
    this.sign = sign;
    this.rhs = rhs;
  }

  /** rhs value for a cell (rhs - lhs constant). */
  rhsAt(k) {
    const lhs = this.lhs;
    let r;
    if (typeof this.rhs === "number") r = this.rhs;
    else if (ArrayBuffer.isView(this.rhs) || Array.isArray(this.rhs)) r = this.rhs[k];
    else {
      const op = constantOperand(this.rhs, lhs);
      const pos = unravel(k, lhs.shape, lhs.strides);
      const opPos = op.dims.map((dim) => {
        const d = lhs.dims.indexOf(dim);
        return op.coords[op.dims.indexOf(dim)].getLoc(lhs.coords[d].at(pos[d]));
      });
      r = opPos.some((p) => p < 0) ? NaN : op.at(opPos);
    }
    return r - lhs.consts[k];
  }
}

/** Install expression helpers on the Variable and Model classes. */
export function installExpressions(Variable, Model) {
  for (const name of ["sel", "mul", "neg", "add", "sub", "sum", "le", "ge", "eq"]) {
    Variable.prototype[name] = function exprMethod(...args) {
      return LinearExpression.fromVariable(this)[name](...args);
    };
  }
  Variable.prototype.toExpr = function toExprMethod() {
    return LinearExpression.fromVariable(this);
  };

  const baseAdd = Model.prototype.add_constraints;
  /**
   * `add_constraints(spec, {name, mask})` with a ConstraintSpec, or
   * `add_constraints(lhs, sign, rhs, {name})`, besides the internal
   * row-function form.
   */
  Model.prototype.add_constraints = function addConstraints(a, b, c, d) {
    let spec = null;
    let opts = {};
    if (a instanceof ConstraintSpec) {
      spec = a;
      opts = b ?? {};
    } else if (a instanceof LinearExpression || (a && a.labels && a.dims && typeof b === "string" && !Array.isArray(c))) {
      spec = new ConstraintSpec(toExpr(a, this), b, c);
      opts = d ?? {};
    }
    if (!spec) return baseAdd.call(this, a, b, c, d);
    const { name, mask = null } = opts;
    if (!name) throw new Error("A constraint name is required");
    const lhs = spec.lhs;
    const con = this.new_constraint(name, lhs.dims, lhs.coords);
    for (let k = 0; k < lhs.size; k++) {
      const vars = Array.from(lhs.vars.subarray(k * lhs.nterm, (k + 1) * lhs.nterm));
      const coeffs = Array.from(lhs.coeffs.subarray(k * lhs.nterm, (k + 1) * lhs.nterm), (x) => (Number.isNaN(x) ? 0 : x));
      const active = mask === null ? true : typeof mask === "function" ? mask(...unravel(k, lhs.shape, lhs.strides)) : Boolean(mask[k]);
      con.push(vars, coeffs, spec.sign, spec.rhsAt(k), active);
    }
    return this.add_constraint(con);
  };

  /** Replace the objective by a (scalar or summed) linear expression. */
  Model.prototype.set_objective = function setObjective(expr, sense = "min") {
    let e = toExpr(expr, this);
    if (e.dims.length) e = e.sum();
    this.objective = { vars: Array.from(e.vars), coeffs: Array.from(e.coeffs, (x) => (Number.isNaN(x) ? 0 : x)), q1: [], q2: [], qcoeffs: [], const: e.consts[0] ?? 0, sense };
  };

  /** Linear part of the objective as an expression. */
  Model.prototype.objective_expression = function objectiveExpression() {
    const o = this.objective;
    return new LinearExpression(this, [], [], o.vars.length, Int32Array.from(o.vars), Float64Array.from(o.coeffs), Float64Array.of(o.const || 0));
  };

  Model.prototype._labelSolution = function labelSolution() {
    const map = new Map();
    for (const v of this.variables.values()) {
      if (!v.solution) continue;
      for (let k = 0; k < v.size; k++) if (v.labels[k] >= 0) map.set(v.labels[k], v.solution[k]);
    }
    return map;
  };
}

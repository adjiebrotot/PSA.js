// SPDX-License-Identifier: MIT
/**
 * A subset of linopy's expression API, enough to write custom constraints
 * (`extra_functionality`) and objectives (MGA):
 *
 *   const p = m.variables.get("Link-p");
 *   m.add_constraints(p.sum().le(30000), { name: "GlobalConstraint-limit" });
 *   m.add_constraints(p.sum("name").le(5000), { name: "GlobalConstraint-limit_t" });
 *   m.add_constraints(p.diff("snapshot").le(100), { name: "ramp" });
 *   m.add_constraints(p.groupby(busOf).sum().le(3000), { name: "bus-limit" });
 *
 * Term ordering follows linopy so that LP files match: `sum()` ravels cells in
 * C order (terms innermost), `sum(dims)` stacks the old terms outermost.
 * Missing slots (from `shift`, `where`, rolling windows or groups) hold
 * variable -1 and a NaN coefficient, like linopy's fill values.
 */

import { Index, compareLabels, labelKey } from "../core/index.js";
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
    return this._like(new LinearExpression(this.model, dims, coords, this.nterm, vars, coeffs, consts));
  }

  /**
   * The result of an operation that linopy performs on a Variable (which then
   * stays a Variable: absent slots have coefficient 1 and constant 0).
   */
  _like(e) {
    if (this._variableLike) e._variableLike = true;
    return e;
  }

  /** Select by position (`{dim: int | int[]}`); an integer drops the dimension. */
  isel(indexers) {
    let out = this;
    for (const [dim, p] of Object.entries(indexers)) {
      const d = out.dims.indexOf(dim);
      if (d < 0) throw new Error(`Dimension ${dim} not in expression`);
      const len = out.coords[d].length;
      const norm = (i) => {
        const q = i < 0 ? i + len : i;
        if (!(q >= 0 && q < len)) throw new Error(`IndexError: index ${i} is out of bounds for dimension ${dim} with size ${len}`);
        return q;
      };
      if (typeof p === "number") out = out._take(d, [norm(p)], null);
      else {
        const pos = asIndexList(p).map(norm);
        out = out._take(d, pos, out.coords[d].take(pos));
      }
    }
    return out;
  }

  /**
   * Shift along dimensions (`{dim: n}`, positive moves values forward). The
   * shifted-in cells are missing: no terms and a NaN constant.
   */
  shift(shifts) {
    return this._shifted(shifts, false, this._variableLike ? { coeff: 1, const: 0 } : { coeff: NaN, const: NaN });
  }

  /** Roll along dimensions (`{dim: n}`, circular shift). */
  roll(shifts) {
    return this._shifted(shifts, true, null);
  }

  _shifted(shifts, circular, fill) {
    const by = this.dims.map((d) => shifts[d] ?? 0);
    for (const d of Object.keys(shifts)) if (!this.dims.includes(d)) throw new Error(`Dimension ${d} not in expression`);
    const nt = this.nterm;
    const vars = new Int32Array(this.size * nt);
    const coeffs = new Float64Array(this.size * nt);
    const consts = new Float64Array(this.size);
    for (let k = 0; k < this.size; k++) {
      const pos = unravel(k, this.shape, this.strides);
      let src = 0;
      for (let d = 0; d < pos.length; d++) {
        let p = pos[d] - by[d];
        if (circular) p = ((p % this.shape[d]) + this.shape[d]) % this.shape[d];
        if (p < 0 || p >= this.shape[d]) {
          src = -1;
          break;
        }
        src += p * this.strides[d];
      }
      for (let t = 0; t < nt; t++) {
        vars[k * nt + t] = src < 0 ? -1 : this.vars[src * nt + t];
        coeffs[k * nt + t] = src < 0 ? fill.coeff : this.coeffs[src * nt + t];
      }
      consts[k] = src < 0 ? fill.const : this.consts[src];
    }
    return this._like(new LinearExpression(this.model, this.dims, this.coords, nt, vars, coeffs, consts));
  }

  /** n-th order difference along `dim` (`expr - expr.shift({dim: n})`). */
  diff(dim, n = 1) {
    if (typeof n === "object" && n !== null) n = n.n ?? 1;
    return this.sub(this.shift({ [dim]: n }));
  }

  /**
   * Rolling window along one dimension (`{dim: window}`); `.sum()` stacks the
   * window (oldest first) into the terms, padding the first cells (with
   * `center`, a bool or `{dim: bool}`, xarray's centred windows).
   */
  rolling(dims, opts = {}) {
    const spec = { ...dims };
    for (const k of ["min_periods", "center"]) delete spec[k];
    const entries = Object.entries(spec);
    if (entries.length !== 1) throw new Error("ValueError: Mapping argument is necessary for 2d-rolling.");
    const [dim, window] = entries[0];
    if (!this.dims.includes(dim)) throw new Error(`Dimension ${dim} not in expression`);
    const centerSpec = dims.center ?? opts.center ?? false;
    const center = centerSpec !== null && typeof centerSpec === "object" ? Boolean(centerSpec[dim]) : Boolean(centerSpec);
    return new LinearExpressionRolling(this, dim, window, center);
  }

  /** Cumulative sum along `dim` (a rolling window over the whole dimension). */
  cumsum(dim = null) {
    const dims = dim === null || dim === undefined ? this.dims.slice() : Array.isArray(dim) ? dim : [dim];
    return this.rolling(Object.fromEntries(dims.map((d) => [d, this.coords[this.dims.indexOf(d)].length]))).sum();
  }

  /**
   * Keep cells where `cond` holds (a boolean Series, DataFrame, flat array or
   * a function of the expression). Other cells lose their terms; their
   * constant becomes `other` (NaN by default).
   */
  where(cond, other = null) {
    if (other !== null && typeof other === "object" && !(other instanceof LinearExpression)) other = other.other ?? null;
    if (other !== null && typeof other !== "number") throw new TypeError("where: `other` must be a number");
    if (this._variableLike) {
      if (other !== null) throw new Error("NotImplementedError: Variable.where with `other`");
      return this._masked(cond, { coeff: 1, const: 0 });
    }
    return this._masked(cond, { coeff: NaN, const: other ?? NaN });
  }

  _masked(cond, fill) {
    if (typeof cond === "function") cond = cond(this);
    const keep = this._condition(cond);
    const nt = this.nterm;
    const vars = Int32Array.from(this.vars);
    const coeffs = Float64Array.from(this.coeffs);
    const consts = Float64Array.from(this.consts);
    for (let k = 0; k < this.size; k++) {
      if (keep(k)) continue;
      for (let t = 0; t < nt; t++) {
        vars[k * nt + t] = -1;
        coeffs[k * nt + t] = fill.coeff;
      }
      consts[k] = fill.const;
    }
    return this._like(new LinearExpression(this.model, this.dims, this.coords, nt, vars, coeffs, consts));
  }

  /** Cell predicate of a boolean condition over (a subset of) the dims. */
  _condition(cond) {
    if (typeof cond === "boolean") return () => cond;
    const op = constantOperand(cond, this);
    if (op.flat) return (k) => Boolean(cond[k]);
    for (let i = 0; i < op.dims.length; i++) {
      const d = this.dims.indexOf(op.dims[i]);
      if (d < 0) throw new Error(`NotImplementedError: condition dimension ${op.dims[i]} not in expression`);
      if (!this.coords[d].equals(op.coords[i])) throw new Error(`AlignmentError: coordinates of ${op.dims[i]} differ between condition and expression`);
    }
    const where = op.dims.map((dim) => this.dims.indexOf(dim));
    return (k) => {
      const pos = unravel(k, this.shape, this.strides);
      return Boolean(op.at(where.map((d) => pos[d])));
    };
  }

  /**
   * Replace missing (NaN) constants by `value`. On the result of a Variable's
   * `shift` / `where` (linopy keeps those Variables) the absent slots get it.
   */
  fillna(value) {
    if (typeof value !== "number") throw new TypeError("fillna: value must be a number");
    if (this._variableLike) {
      const consts = Float64Array.from(this.consts);
      for (let k = 0; k < this.size; k++) if (this.vars[k] < 0) consts[k] = value;
      return new LinearExpression(this.model, this.dims, this.coords, this.nterm, this.vars, this.coeffs, consts);
    }
    return new LinearExpression(
      this.model,
      this.dims,
      this.coords,
      this.nterm,
      this.vars,
      this.coeffs,
      this.consts.map((x) => (Number.isNaN(x) ? value : x)),
    );
  }

  /**
   * Group cells along a dimension by a Series indexed like that dimension;
   * `.sum()` replaces the dimension by the sorted group labels (named after
   * the Series, else `group`).
   */
  groupby(group) {
    return new LinearExpressionGroupby(this, group);
  }

  /**
   * Multiply by a number, Series, DataFrame or flat array (aligned on
   * coordinates), or by a variable / single-term expression, which gives a
   * QuadraticExpression.
   */
  mul(c) {
    if (c instanceof LinearExpression || (c && typeof c.labels !== "undefined" && c.dims)) return quadraticProduct(this, toExpr(c, this.model));
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

  /** `expr ** 2` (a single-term expression times itself). */
  pow(exponent) {
    if (exponent !== 2) throw new Error("ValueError: Power must be 2.");
    return this.mul(this);
  }

  /** Add an expression, variable, number or Series (terms are concatenated). */
  add(other) {
    if (other instanceof QuadraticExpression) return other.add(this);
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
      // missing constants count as zero when merging (linopy)
      if (ka >= 0) {
        for (let t = 0; t < this.nterm; t++) {
          vars[k * nterm + t] = this.vars[ka * this.nterm + t];
          coeffs[k * nterm + t] = this.coeffs[ka * this.nterm + t];
        }
        if (!Number.isNaN(this.consts[ka])) consts[k] += this.consts[ka];
      }
      if (kb >= 0) {
        for (let t = 0; t < o.nterm; t++) {
          vars[k * nterm + this.nterm + t] = o.vars[kb * o.nterm + t];
          coeffs[k * nterm + this.nterm + t] = o.coeffs[kb * o.nterm + t];
        }
        if (!Number.isNaN(o.consts[kb])) consts[k] += o.consts[kb];
      }
    }
    return new LinearExpression(this.model, dims, coords, nterm, vars, coeffs, consts);
  }

  sub(other) {
    if (typeof other === "number") return this.add(-other);
    if (other instanceof QuadraticExpression) return other.neg().add(this);
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

/**
 * A quadratic expression (linopy `QuadraticExpression`): every term holds a
 * pair of variables (`vars` interleaved, the second -1 for a linear term), a
 * coefficient, and each cell a constant.
 */
export class QuadraticExpression {
  constructor(model, dims, coords, nterm, vars, coeffs, consts) {
    this.model = model;
    this.dims = dims;
    this.coords = coords;
    this.shape = shapeOf(coords);
    this.size = sizeOf(this.shape);
    this.strides = stridesOf(this.shape);
    this.nterm = nterm;
    this.vars = vars; // size * nterm * 2
    this.coeffs = coeffs; // size * nterm
    this.consts = consts; // size
  }

  /** The quadratic expression of a linear one (all terms linear). */
  static fromLinear(e) {
    const vars = new Int32Array(e.size * e.nterm * 2).fill(-1);
    for (let i = 0; i < e.vars.length; i++) vars[2 * i] = e.vars[i];
    return new QuadraticExpression(e.model, e.dims, e.coords, e.nterm, vars, e.coeffs, e.consts);
  }

  /** A linear expression per factor (`[first, second]`) sharing coefficients and constants. */
  _factors() {
    const a = new Int32Array(this.size * this.nterm);
    const b = new Int32Array(this.size * this.nterm);
    for (let i = 0; i < a.length; i++) {
      a[i] = this.vars[2 * i];
      b[i] = this.vars[2 * i + 1];
    }
    const mk = (v) => new LinearExpression(this.model, this.dims, this.coords, this.nterm, v, this.coeffs, this.consts);
    return [mk(a), mk(b)];
  }

  /** Rebuild from two linear expressions with the same layout (see `_factors`). */
  static _fromFactors(a, b) {
    const vars = new Int32Array(a.vars.length * 2);
    for (let i = 0; i < a.vars.length; i++) {
      vars[2 * i] = a.vars[i];
      vars[2 * i + 1] = b.vars[i];
    }
    return new QuadraticExpression(a.model, a.dims, a.coords, a.nterm, vars, a.coeffs, a.consts);
  }

  /** Apply a layout-only linear operation (sum, sel, shift...) to both factors. */
  _map(fn) {
    const [a, b] = this._factors();
    return QuadraticExpression._fromFactors(fn(a), fn(b));
  }

  sum(dims = null) {
    return this._map((e) => e.sum(dims));
  }

  sel(selectors) {
    return this._map((e) => e.sel(selectors));
  }

  isel(indexers) {
    return this._map((e) => e.isel(indexers));
  }

  /** Multiply by a constant (number, Series, DataFrame or flat array). */
  mul(c) {
    if (c instanceof LinearExpression || c instanceof QuadraticExpression || (c && typeof c.labels !== "undefined")) {
      throw new TypeError("unsupported operand type(s) for *: 'QuadraticExpression' and an expression");
    }
    return this._map((e) => e.mul(c));
  }

  neg() {
    return this.mul(-1);
  }

  /** Add a quadratic or linear expression, variable or number (terms concatenated, quadratic first). */
  add(other) {
    if (typeof other === "number") {
      return new QuadraticExpression(this.model, this.dims, this.coords, this.nterm, this.vars, this.coeffs, this.consts.map((x) => x + other));
    }
    const o = other instanceof QuadraticExpression ? other : QuadraticExpression.fromLinear(toExpr(other, this.model));
    const [a1, a2] = this._factors();
    const [b1, b2] = o._factors();
    return QuadraticExpression._fromFactors(a1.add(b1), a2.add(b2));
  }

  sub(other) {
    if (typeof other === "number") return this.add(-other);
    if (other instanceof QuadraticExpression) return this.add(other.neg());
    return this.add(toExpr(other, this.model).neg());
  }

  le() {
    throw new Error("NotImplementedError: quadratic constraints are not supported");
  }

  ge() {
    return this.le();
  }

  eq() {
    return this.le();
  }

  /** Solution values (after solving). */
  get solution() {
    const out = new Float64Array(this.size);
    const sol = this.model._labelSolution();
    for (let k = 0; k < this.size; k++) {
      let s = this.consts[k];
      for (let t = 0; t < this.nterm; t++) {
        const i = k * this.nterm + t;
        const v1 = this.vars[2 * i];
        const v2 = this.vars[2 * i + 1];
        if (v1 < 0) continue;
        s += this.coeffs[i] * sol.get(v1) * (v2 < 0 ? 1 : sol.get(v2));
      }
      out[k] = s;
    }
    return out;
  }
}

/**
 * `a * b` of two linear expressions, `b` with a single term (linopy):
 * `(v1 + c1) * (v2 + c2) = v1 * v2 + c1 * v2 + c2 * v1 + c1 * c2`, with the
 * cross terms appended as linear terms.
 */
function quadraticProduct(a, b) {
  if (b.nterm > 1) throw new TypeError("Multiplication of multiple terms is not supported.");
  const constant = (e) => e.nterm === 0 || Array.from(e.vars).every((v) => v < 0);
  if (constant(b)) return a.mul(Array.from(broadcastTo(b, a).consts));
  if (constant(a)) return b.mul(Array.from(broadcastTo(a, b).consts));
  const dims = [...a.dims, ...b.dims.filter((d) => !a.dims.includes(d))];
  for (const d of b.dims) {
    const i = a.dims.indexOf(d);
    if (i >= 0 && a.coords[i].length !== b.coords[b.dims.indexOf(d)].length) {
      throw new Error(`NotImplementedError: product of expressions with different ${d} coordinates`);
    }
  }
  const coords = dims.map((d) => (a.dims.includes(d) ? a.coords[a.dims.indexOf(d)] : b.coords[b.dims.indexOf(d)]));
  const shape = shapeOf(coords);
  const size = sizeOf(shape);
  const strides = stridesOf(shape);
  const nt = a.nterm;
  const vars = new Int32Array(size * nt * 2);
  const coeffs = new Float64Array(size * nt);
  const consts = new Float64Array(size);
  const ac = new Float64Array(size);
  const bc = new Float64Array(size);
  const cellOf = (e, pos) => e.dims.reduce((k, d, i) => k + pos[dims.indexOf(d)] * e.strides[i], 0);
  for (let k = 0; k < size; k++) {
    const pos = unravel(k, shape, strides);
    const ka = cellOf(a, pos);
    const kb = cellOf(b, pos);
    for (let t = 0; t < nt; t++) {
      vars[2 * (k * nt + t)] = a.vars[ka * nt + t];
      vars[2 * (k * nt + t) + 1] = b.vars[kb];
      coeffs[k * nt + t] = a.coeffs[ka * nt + t] * b.coeffs[kb];
    }
    ac[k] = a.consts[ka];
    bc[k] = b.consts[kb];
    consts[k] = a.consts[ka] * b.consts[kb];
  }
  let res = new QuadraticExpression(a.model, dims, coords, nt, vars, coeffs, consts);
  const fill0 = (x) => (Number.isNaN(x) ? 0 : x);
  const resetConst = (e) => new LinearExpression(e.model, e.dims, e.coords, e.nterm, e.vars, e.coeffs, new Float64Array(e.size));
  if (Array.from(ac).some((x) => x !== 0)) res = res.add(resetConst(broadcastTo(b, res)).mul(Array.from(ac, fill0)));
  if (Array.from(bc).some((x) => x !== 0)) res = res.add(resetConst(broadcastTo(a, res)).mul(Array.from(bc, fill0)));
  return res;
}

/** `e` broadcast to the dims and coordinates of `target` (terms repeated). */
function broadcastTo(e, target) {
  if (e.dims.length === target.dims.length && e.dims.every((d, i) => d === target.dims[i])) return e;
  const shape = target.shape;
  const size = target.size;
  const nt = e.nterm;
  const vars = new Int32Array(size * nt);
  const coeffs = new Float64Array(size * nt);
  const consts = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const pos = unravel(k, shape, target.strides);
    const src = e.dims.reduce((s, d, i) => s + pos[target.dims.indexOf(d)] * e.strides[i], 0);
    for (let t = 0; t < nt; t++) {
      vars[k * nt + t] = e.vars[src * nt + t];
      coeffs[k * nt + t] = e.coeffs[src * nt + t];
    }
    consts[k] = e.consts[src];
  }
  return new LinearExpression(e.model, target.dims, target.coords, nt, vars, coeffs, consts);
}

/** `expr.rolling({dim: window})`: windows along one dimension. */
export class LinearExpressionRolling {
  constructor(expr, dim, window, center = false) {
    this.expr = expr;
    this.dim = dim;
    this.window = window;
    this.center = center;
  }

  /** Window terms stacked into each cell (old term outermost), constants summed skipping NaN. */
  sum() {
    const e = this.expr;
    const w = this.window;
    const d = e.dims.indexOf(this.dim);
    const nt = e.nterm;
    const nterm = nt * w;
    const vars = new Int32Array(e.size * nterm).fill(-1);
    const coeffs = new Float64Array(e.size * nterm).fill(NaN);
    const consts = new Float64Array(e.size);
    // centred windows reach (w - 1) // 2 cells ahead
    const ahead = this.center ? Math.floor((w - 1) / 2) : 0;
    for (let k = 0; k < e.size; k++) {
      const p = Math.floor(k / e.strides[d]) % e.shape[d];
      for (let r = 0; r < w; r++) {
        const q = p - (w - 1) + r + ahead;
        if (q < 0 || q >= e.shape[d]) continue;
        const src = k + (q - p) * e.strides[d];
        for (let t = 0; t < nt; t++) {
          vars[k * nterm + t * w + r] = e.vars[src * nt + t];
          coeffs[k * nterm + t * w + r] = e.coeffs[src * nt + t];
        }
        if (!Number.isNaN(e.consts[src])) consts[k] += e.consts[src];
      }
    }
    return new LinearExpression(e.model, e.dims, e.coords, nterm, vars, coeffs, consts);
  }
}

/**
 * `expr.groupby(grouper)`: groups along the dimension the grouper is indexed
 * by, a Series (one key) or a DataFrame (one key per column).
 */
export class LinearExpressionGroupby {
  constructor(expr, group) {
    if (!(group instanceof Series) && !(group instanceof DataFrame)) throw new TypeError("groupby: the grouper must be a Series or DataFrame indexed by a dimension");
    this.expr = expr;
    this.group = group;
  }

  /**
   * Sum each group: the grouped dimension is replaced (in place) by the
   * sorted group labels; members are stacked innermost in the terms and
   * padded to the largest group.
   */
  sum() {
    const e = this.expr;
    const g = this.group;
    const dim = g.index.name ?? (e.dims.length === 1 ? e.dims[0] : null);
    const d = e.dims.indexOf(dim);
    if (d < 0) throw new Error(`ValueError: the grouper must be indexed by a dimension of the expression (${e.dims})`);
    if (!g.index.equals(e.coords[d])) {
      throw new Error(`ValueError: the grouper's labels along dimension '${dim}' do not match the expression's coordinates. linopy matches groupers by position and does not reindex.`);
    }
    const frame = g instanceof DataFrame;
    const keys = frame ? g.index.values.map((_, i) => g.columns.values.map((c) => g.col(c)[i])) : Array.from(g.values);
    const missing = (k) => k === null || k === undefined || (typeof k === "number" && Number.isNaN(k));
    if (keys.some((k) => (frame ? k.some(missing) : missing(k)))) {
      throw new Error("ValueError: Cannot group by a pandas object containing NaN values. Drop or fill the corresponding entries before grouping.");
    }
    // a frame gives a `group` dimension labelled by key tuples (legacy MultiIndex)
    return groupSum(e, dim, keys, frame ? g.columns.values.map(String) : (g.name ?? "group"), { inPlace: true });
  }
}

/**
 * Sum `e` over the groups of dimension `dim` (`keys[i]` labels the i-th cell;
 * null drops it). Groups are sorted; the new dimension `name` (labels named
 * `names` if given as a list) replaces `dim` in place or comes last. Terms:
 * old term outermost, group member innermost (padded with -1 / NaN).
 */
export function groupSum(e, dim, keys, names, { inPlace = false, compare = compareLabels } = {}) {
  const d = e.dims.indexOf(dim);
  if (d < 0) throw new Error(`Dimension ${dim} not in expression`);
  const groups = new Map();
  const labels = [];
  keys.forEach((k, i) => {
    if (k === null) return;
    const lk = labelKey(k);
    let grp = groups.get(lk);
    if (!grp) {
      grp = [];
      groups.set(lk, grp);
      labels.push(k);
    }
    grp.push(i);
  });
  labels.sort(compare);
  const members = labels.map((l) => groups.get(labelKey(l)));
  const M = members.reduce((m, grp) => Math.max(m, grp.length), 0);
  const g0 = inPlace ? d : e.dims.length - 1;
  const groupDim = Array.isArray(names) ? "group" : names;
  const dims = e.dims.filter((x) => x !== dim);
  const coords = e.coords.filter((_, i) => i !== d);
  dims.splice(g0, 0, groupDim);
  coords.splice(g0, 0, new Index(labels, names));
  const shape = shapeOf(coords);
  const size = sizeOf(shape);
  const strides = stridesOf(shape);
  const nt = e.nterm;
  const nterm = nt * M;
  const vars = new Int32Array(size * nterm).fill(-1);
  const coeffs = new Float64Array(size * nterm).fill(NaN);
  const consts = new Float64Array(size);
  for (let c = 0; c < size; c++) {
    const pos = unravel(c, shape, strides);
    const grp = members[pos[g0]];
    let base = 0;
    for (let i = 0; i < dims.length; i++) {
      if (i === g0) continue;
      const j = i < g0 ? i : i - 1; // position among the kept dims
      base += pos[i] * e.strides[j < d ? j : j + 1];
    }
    let sum = 0;
    for (let j = 0; j < grp.length; j++) {
      const ec = base + grp[j] * e.strides[d];
      for (let t = 0; t < nt; t++) {
        vars[c * nterm + t * M + j] = e.vars[ec * nt + t];
        coeffs[c * nterm + t * M + j] = e.coeffs[ec * nt + t];
      }
      if (!Number.isNaN(e.consts[ec])) sum += e.consts[ec];
    }
    consts[c] = sum;
  }
  return new LinearExpression(e.model, dims, coords, nterm, vars, coeffs, consts);
}

/** Convert a variable / expression / number to a LinearExpression. */
export function toExpr(x, model) {
  if (x instanceof LinearExpression || x instanceof QuadraticExpression) return x;
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
  for (const name of ["mul", "neg", "pow", "add", "sub", "sum", "diff", "rolling", "cumsum", "groupby", "le", "ge", "eq"]) {
    Variable.prototype[name] = function exprMethod(...args) {
      return LinearExpression.fromVariable(this)[name](...args);
    };
  }
  // linopy keeps these on the Variable: missing labels are -1 while the
  // expression of a variable has coefficient 1 and constant 0 everywhere
  const variableLike = (v) => {
    const e = LinearExpression.fromVariable(v);
    e._variableLike = true;
    return e;
  };
  for (const name of ["shift", "where", "roll", "sel", "isel"]) {
    Variable.prototype[name] = function variableMethod(...args) {
      return variableLike(this)[name](...args);
    };
  }
  /** A constant for the absent slots (labels -1); the result is an expression. */
  Variable.prototype.fillna = function fillna(value) {
    const e = LinearExpression.fromVariable(this);
    e._variableLike = true;
    return e.fillna(value);
  };
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

  /**
   * Replace the objective by a (scalar or summed) linear or quadratic
   * expression (`sense` "min" or "max", or `{sense}`).
   */
  Model.prototype.set_objective = function setObjective(expr, sense = "min") {
    if (sense && typeof sense === "object") sense = sense.sense ?? "min";
    let e = toExpr(expr, this);
    if (e.dims.length) e = e.sum();
    const coeff = (x) => (Number.isNaN(x) ? 0 : x);
    const o = { vars: [], coeffs: [], q1: [], q2: [], qcoeffs: [], const: e.consts[0] ?? 0, sense };
    if (e instanceof QuadraticExpression) {
      for (let t = 0; t < e.nterm; t++) {
        const [v1, v2] = [e.vars[2 * t], e.vars[2 * t + 1]];
        if (v2 < 0) {
          o.vars.push(v1);
          o.coeffs.push(coeff(e.coeffs[t]));
        } else {
          o.q1.push(v1);
          o.q2.push(v2);
          o.qcoeffs.push(coeff(e.coeffs[t]));
        }
      }
    } else {
      o.vars = Array.from(e.vars);
      o.coeffs = Array.from(e.coeffs, coeff);
    }
    this.objective = o;
  };

  /** linopy's `add_objective(expr, overwrite, sense)`. */
  Model.prototype.add_objective = function addObjective(expr, { overwrite = false, sense = "min" } = {}) {
    const o = this.objective;
    if (!overwrite && (o.vars.length || o.q1.length)) throw new Error("ValueError: Objective already defined. Set `overwrite` to True to force overwriting.");
    this.set_objective(expr, sense);
  };

  /** The objective as an expression (quadratic if it has quadratic terms). */
  Model.prototype.objective_expression = function objectiveExpression() {
    const o = this.objective;
    const lin = new LinearExpression(this, [], [], o.vars.length, Int32Array.from(o.vars), Float64Array.from(o.coeffs), Float64Array.of(o.const || 0));
    if (!o.q1.length) return lin;
    const vars = new Int32Array(o.q1.length * 2);
    o.q1.forEach((v, t) => {
      vars[2 * t] = v;
      vars[2 * t + 1] = o.q2[t];
    });
    return new QuadraticExpression(this, [], [], o.q1.length, vars, Float64Array.from(o.qcoeffs), Float64Array.of(0)).add(lin);
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

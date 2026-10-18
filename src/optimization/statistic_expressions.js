// SPDX-License-Identifier: MIT
/**
 * Statistics as linear expressions of the optimisation model (mirrors
 * `pypsa.optimization.expressions.StatisticExpressionsAccessor`, reached as
 * `n.optimize.expressions` once a model exists):
 *
 *   n.optimize.create_model();
 *   const capex = n.optimize.expressions.capex();          // dims ["group"]
 *   n.model.add_constraints(capex.sum().le(1e9), { name: "capex_budget" });
 *
 * The expressions have linopy's layout (dims, coordinates and `_term` slots,
 * including the -1 padding), so constraints built from them write the same
 * LP rows as in PyPSA. The helpers below reproduce the linopy operations
 * PyPSA uses: aligned products with constants, outer additions, `@`
 * (weighted time sums), `groupby(...).sum()` and `merge`.
 */

import { isSnapshotMajor } from "../network/scenario_frames.js";
import { Index, compareLabels, labelKey } from "../core/index.js";
import { LinearExpression, groupSum } from "./expressions.js";
import { LOOKUP, denseValues } from "./common.js";
import { groupers, resolve_at_port, get_transmission_branches, statisticsOptions, normalizeCarrierNiceNames, contains, isNa } from "../statistics/accessor.js";
import { scenarioView } from "../network/scenarios.js";
import { logger } from "../logger.js";

// ----------------------------------------------------------------------
// constant arrays (the xarray DataArrays PyPSA multiplies with)
// ----------------------------------------------------------------------

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

/** A dense constant array with named dimensions (C order). */
export class Const {
  constructor(dims, coords, values) {
    this.dims = dims;
    this.coords = coords;
    this.values = values;
    this.shape = shapeOf(coords);
    this.strides = stridesOf(this.shape);
  }

  /** Values per name (`dims = ["name"]`). */
  static names(names, values) {
    return new Const(["name"], [asNameIndex(names)], Float64Array.from(values));
  }

  /** Snapshot-major values over (snapshot, name). */
  static dense(sns, names, values) {
    return new Const(["snapshot", "name"], [sns, asNameIndex(names)], Float64Array.from(values));
  }

  static scalar(v) {
    return new Const([], [], Float64Array.of(v));
  }

  map(fn) {
    return new Const(this.dims, this.coords, this.values.map(fn));
  }

  /** Select labels along `dim` (an Index or array). */
  sel(dim, labels) {
    const d = this.dims.indexOf(dim);
    if (d < 0) return this;
    const lab = labels instanceof Index ? labels : new Index(labels, dim);
    const pos = this.coords[d].getIndexer(lab);
    for (let i = 0; i < pos.length; i++) if (pos[i] < 0) throw new Error(`KeyError: ${lab.at(i)} not in ${dim}`);
    const coords = this.coords.slice();
    coords[d] = lab;
    const shape = shapeOf(coords);
    const strides = stridesOf(shape);
    const out = new Float64Array(sizeOf(shape));
    for (let k = 0; k < out.length; k++) {
      const p = unravel(k, shape, strides);
      p[d] = pos[p[d]];
      out[k] = this.values[p.reduce((s, x, i) => s + x * this.strides[i], 0)];
    }
    return new Const(this.dims, coords, out);
  }
}

function asNameIndex(names) {
  if (names instanceof Index) return names.isMulti || names.name === "name" ? names : names.rename("name");
  return new Index(names, "name");
}

/**
 * For each dimension of a source (`srcDims`, `srcCoords`), where its positions
 * come from in a result over (`dims`, `coords`): `{r, map}` with `map` null
 * when the coordinates are identical, else result position -> source
 * position (-1 when missing).
 */
function positionMaps(dims, coords, srcDims, srcCoords) {
  return srcDims.map((d, i) => {
    const r = dims.indexOf(d);
    if (r < 0) throw new Error(`Dimension ${d} missing in result`);
    const rc = coords[r];
    const sc = srcCoords[i];
    return { r, map: rc === sc || rc.equals(sc) ? null : sc.getIndexer(rc) };
  });
}

function srcCell(pos, maps, strides) {
  let k = 0;
  for (let i = 0; i < maps.length; i++) {
    const { r, map } = maps[i];
    const p = map === null ? pos[r] : map[pos[r]];
    if (p < 0) return -1;
    k += p * strides[i];
  }
  return k;
}

function expr(model, dims, coords, nterm, vars, coeffs, consts) {
  return new LinearExpression(model, dims, coords, nterm, vars, coeffs, consts);
}

// ----------------------------------------------------------------------
// linopy operations
// ----------------------------------------------------------------------

/** `LinearExpression.from_constant(model, constant)`: no terms. */
export function fromConstant(model, k) {
  const c = k instanceof Const ? k : Const.scalar(k);
  return expr(model, c.dims.slice(), c.coords.slice(), 0, new Int32Array(0), new Float64Array(0), Float64Array.from(c.values));
}

const fill0 = (x) => (Number.isNaN(x) ? 0 : x);

/**
 * `expr * constant` with linopy's (legacy) semantics: broadcast over the union
 * of dimensions (constant dims appended); NaN coefficients and constants count
 * as 0, a NaN or missing factor as 0.
 */
export function mulConst(e, k) {
  return constOp(e, k, (x, f) => fill0(x) * f, 0);
}

/** `expr / constant` (true division; a NaN or missing divisor counts as 1). */
export function divConst(e, k) {
  return constOp(e, k, (x, f) => fill0(x) / f, 1);
}

/** `-expr` (signs flipped, NaN kept). */
export function negExpr(e) {
  return expr(e.model, e.dims, e.coords, e.nterm, e.vars, e.coeffs.map((x) => -x), e.consts.map((x) => -x));
}

function constOp(e, k, op, factorFill) {
  const extra = k.dims.filter((d) => !e.dims.includes(d));
  const dims = [...e.dims, ...extra];
  const coords = [...e.coords, ...extra.map((d) => k.coords[k.dims.indexOf(d)])];
  const shape = shapeOf(coords);
  const size = sizeOf(shape);
  const strides = stridesOf(shape);
  const em = positionMaps(dims, coords, e.dims, e.coords);
  const km = positionMaps(dims, coords, k.dims, k.coords);
  const nt = e.nterm;
  const vars = new Int32Array(size * nt);
  const coeffs = new Float64Array(size * nt);
  const consts = new Float64Array(size);
  for (let c = 0; c < size; c++) {
    const pos = unravel(c, shape, strides);
    const ec = srcCell(pos, em, e.strides);
    const kc = srcCell(pos, km, k.strides);
    const raw = kc < 0 ? NaN : k.values[kc];
    const f = Number.isNaN(raw) ? factorFill : raw;
    for (let t = 0; t < nt; t++) {
      vars[c * nt + t] = ec < 0 ? -1 : e.vars[ec * nt + t];
      coeffs[c * nt + t] = ec < 0 ? NaN : op(e.coeffs[ec * nt + t], f);
    }
    consts[c] = ec < 0 ? NaN : op(e.consts[ec], f);
  }
  return expr(e.model, dims, coords, nt, vars, coeffs, consts);
}

/**
 * `expr.where(cond)`: masked cells lose their terms (vars -1, coeffs NaN) and
 * constant. Shared coordinates must be identical (xarray `join="exact"`).
 */
export function whereConst(e, k) {
  k.dims.forEach((d, i) => {
    const j = e.dims.indexOf(d);
    if (j >= 0 && !e.coords[j].equals(k.coords[i])) {
      throw new Error(`AlignmentError: cannot align objects with join='exact' where index/labels/sizes are not equal along these coordinates (dimensions): '${d}'`);
    }
  });
  const km = positionMaps(e.dims, e.coords, k.dims, k.coords);
  const nt = e.nterm;
  const vars = Int32Array.from(e.vars);
  const coeffs = Float64Array.from(e.coeffs);
  const consts = Float64Array.from(e.consts);
  for (let c = 0; c < e.size; c++) {
    const pos = unravel(c, e.shape, e.strides);
    const kc = srcCell(pos, km, k.strides);
    if (kc >= 0 && k.values[kc]) continue;
    for (let t = 0; t < nt; t++) {
      vars[c * nt + t] = -1;
      coeffs[c * nt + t] = NaN;
    }
    consts[c] = NaN;
  }
  return expr(e.model, e.dims, e.coords, nt, vars, coeffs, consts);
}

/** Map coefficients and constants (`expr.assign(coeffs=f(coeffs), const=g(const))`). */
export function assignValues(e, coeffFn, constFn) {
  return expr(e.model, e.dims, e.coords, e.nterm, e.vars, e.coeffs.map(coeffFn), e.consts.map(constFn));
}

/** Union of coordinates for an outer join (pandas `Index.union`). */
function outerCoord(a, b) {
  if (a === b || a.equals(b)) return a;
  return a.union(b);
}

/**
 * Merge expressions along `_term` with an outer join on the coordinates
 * (`linopy.merge(exprs, join="outer")`, `expr.add(other, join="outer")`):
 * terms are concatenated, constants added (missing cells count as 0).
 */
export function mergeTerms(exprs) {
  if (exprs.length === 1) return exprs[0];
  const dims = [];
  for (const e of exprs) for (const d of e.dims) if (!dims.includes(d)) dims.push(d);
  const coords = dims.map((d) => {
    let c = null;
    for (const e of exprs) {
      const i = e.dims.indexOf(d);
      if (i >= 0) c = c === null ? e.coords[i] : outerCoord(c, e.coords[i]);
    }
    return c;
  });
  const shape = shapeOf(coords);
  const size = sizeOf(shape);
  const strides = stridesOf(shape);
  const nterm = exprs.reduce((s, e) => s + e.nterm, 0);
  const vars = new Int32Array(size * nterm).fill(-1);
  const coeffs = new Float64Array(size * nterm).fill(NaN);
  const consts = new Float64Array(size);
  let offset = 0;
  for (const e of exprs) {
    const em = positionMaps(dims, coords, e.dims, e.coords);
    for (let c = 0; c < size; c++) {
      const ec = srcCell(unravel(c, shape, strides), em, e.strides);
      if (ec < 0) continue;
      for (let t = 0; t < e.nterm; t++) {
        vars[c * nterm + offset + t] = e.vars[ec * e.nterm + t];
        coeffs[c * nterm + offset + t] = e.coeffs[ec * e.nterm + t];
      }
      consts[c] += fill0(e.consts[ec]);
    }
    offset += e.nterm;
  }
  return expr(exprs[0].model, dims, coords, nterm, vars, coeffs, consts);
}

/** PyPSA `_add_optional`: outer-add `other` (expression or constant) if given. */
export function addOptional(e, other) {
  if (other === null || other === undefined) return e;
  return mergeTerms([e, other instanceof Const ? fromConstant(e.model, other) : other]);
}

/**
 * Concatenate expressions along an existing dimension `dim`
 * (`linopy.merge(exprs, dim=dim)`); terms are padded to the largest count.
 */
export function mergeAlong(exprs, dim) {
  if (exprs.length === 1) return exprs[0];
  const first = exprs[0];
  const d = first.dims.indexOf(dim);
  const dims = first.dims.slice();
  const coords = first.coords.slice();
  const labels = [];
  for (const e of exprs) {
    if (e.dims.length !== dims.length || e.dims.some((x) => !dims.includes(x))) throw new Error(`Cannot merge expressions with dims ${e.dims} and ${dims} along ${dim}`);
    labels.push(...e.coords[e.dims.indexOf(dim)].values);
  }
  const names = first.coords[d].isMulti ? first.coords[d].names : first.coords[d].name ?? dim;
  coords[d] = new Index(labels, names);
  for (let i = 0; i < dims.length; i++) {
    if (i === d) continue;
    for (const e of exprs) {
      const c = e.coords[e.dims.indexOf(dims[i])];
      if (!c.equals(coords[i])) coords[i] = outerCoord(coords[i], c);
    }
  }
  const shape = shapeOf(coords);
  const size = sizeOf(shape);
  const strides = stridesOf(shape);
  const nterm = Math.max(...exprs.map((e) => e.nterm));
  const vars = new Int32Array(size * nterm).fill(-1);
  const coeffs = new Float64Array(size * nterm).fill(NaN);
  const consts = new Float64Array(size);
  let offset = 0;
  for (const e of exprs) {
    const ed = e.dims.indexOf(dim);
    const len = e.coords[ed].length;
    const ecoords = e.dims.map((x) => coords[dims.indexOf(x)]);
    // positions of e's cells in the result: along `dim` shifted by the offset
    const maps = e.dims.map((x, i) => {
      if (x === dim) return null;
      const rc = coords[dims.indexOf(x)];
      return rc.equals(e.coords[i]) ? null : e.coords[i].getIndexer(rc);
    });
    for (let c = 0; c < size; c++) {
      const pos = unravel(c, shape, strides);
      const p = pos[d] - offset;
      if (p < 0 || p >= len) continue;
      let ec = 0;
      let ok = true;
      for (let i = 0; i < e.dims.length; i++) {
        const r = dims.indexOf(e.dims[i]);
        const q = e.dims[i] === dim ? p : maps[i] === null ? pos[r] : maps[i][pos[r]];
        if (q < 0) {
          ok = false;
          break;
        }
        ec += q * e.strides[i];
      }
      if (!ok) continue;
      for (let t = 0; t < e.nterm; t++) {
        vars[c * nterm + t] = e.vars[ec * e.nterm + t];
        coeffs[c * nterm + t] = e.coeffs[ec * e.nterm + t];
      }
      consts[c] = e.consts[ec];
    }
    void ecoords;
    offset += len;
  }
  return expr(first.model, dims, coords, nterm, vars, coeffs, consts);
}

/**
 * `expr.groupby(keys).sum()` over dimension `dim`: `keys[i]` is the key tuple
 * of the i-th label (null drops it). Groups are sorted; the dimension is
 * replaced by `group` (coordinates: key tuples named `names`). Terms are laid
 * out old term outermost and group member innermost, members padded with -1
 * to the largest group.
 *
 * Dimension order (`position`): "inPlace" replaces `dim` (grouping by one of
 * its coordinates, e.g. `period`); otherwise linopy re-derives the order from
 * its coordinates, which puts dimensions with a MultiIndex (multi-period
 * snapshots) first, then a single grouping key ("first") or the other
 * dimensions with `group` last ("last", key frames).
 */
export function groupbySum(e, dim, keys, names, { position = "last" } = {}) {
  const res = groupbySumLast(e, dim, keys, names, { inPlace: position === "inPlace" });
  if (position === "inPlace") return res;
  const multi = res.dims.filter((d, i) => d !== "group" && res.coords[i].isMulti);
  const rest = res.dims.filter((d) => d !== "group" && !multi.includes(d));
  return transposeExpr(res, position === "first" ? [...multi, "group", ...rest] : [...multi, ...rest, "group"]);
}

/** Expression with its dimensions permuted to `dims` (terms per cell unchanged). */
export function transposeExpr(e, dims) {
  if (dims.every((d, i) => d === e.dims[i])) return e;
  const coords = dims.map((d) => e.coords[e.dims.indexOf(d)]);
  const shape = shapeOf(coords);
  const size = sizeOf(shape);
  const strides = stridesOf(shape);
  const src = dims.map((d) => e.strides[e.dims.indexOf(d)]);
  const nt = e.nterm;
  const vars = new Int32Array(size * nt);
  const coeffs = new Float64Array(size * nt);
  const consts = new Float64Array(size);
  for (let c = 0; c < size; c++) {
    const pos = unravel(c, shape, strides);
    let k = 0;
    for (let i = 0; i < pos.length; i++) k += pos[i] * src[i];
    for (let t = 0; t < nt; t++) {
      vars[c * nt + t] = e.vars[k * nt + t];
      coeffs[c * nt + t] = e.coeffs[k * nt + t];
    }
    consts[c] = e.consts[k];
  }
  return expr(e.model, dims, coords, nt, vars, coeffs, consts);
}

function groupbySumLast(e, dim, keys, names, { inPlace = false } = {}) {
  return groupSum(e, dim, keys, names, { inPlace, compare: compareGroupKeys });
}

/** Sort order of group keys: per level, missing (NaN) keys last. */
function compareGroupKeys(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareGroupKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  const na = isNa(a);
  const nb = isNa(b);
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  return compareLabels(a, b);
}

/**
 * Stack expressions along a new last dimension `dim` labelled `labels`
 * (`linopy.merge(exprs, dim=dim)` with an outer join of the other coordinates).
 */
export function mergeNewDim(exprs, dim, labels) {
  const first = exprs[0];
  const dims = [...first.dims, dim];
  const coords = first.dims.map((d) => {
    let c = null;
    for (const e of exprs) {
      const x = e.coords[e.dims.indexOf(d)];
      c = c === null ? x : outerCoord(c, x);
    }
    return c;
  });
  coords.push(labels);
  const shape = shapeOf(coords);
  const size = sizeOf(shape);
  const strides = stridesOf(shape);
  const nterm = Math.max(...exprs.map((e) => e.nterm));
  const vars = new Int32Array(size * nterm).fill(-1);
  const coeffs = new Float64Array(size * nterm).fill(NaN);
  const consts = new Float64Array(size);
  const last = dims.length - 1;
  const maps = exprs.map((e) => positionMaps(dims, coords, e.dims, e.coords));
  for (let c = 0; c < size; c++) {
    const pos = unravel(c, shape, strides);
    const e = exprs[pos[last]];
    const ec = srcCell(pos, maps[pos[last]], e.strides);
    if (ec < 0) continue;
    for (let t = 0; t < e.nterm; t++) {
      vars[c * nterm + t] = e.vars[ec * e.nterm + t];
      coeffs[c * nterm + t] = e.coeffs[ec * e.nterm + t];
    }
    consts[c] = e.consts[ec];
  }
  return expr(first.model, dims, coords, nterm, vars, coeffs, consts);
}

/** `expr.fillna(0)`: missing coefficients and constants become 0. */
export function fillna0(e) {
  return assignValues(e, fill0, fill0);
}

/** Key level names carried by the `group` dimension. */
function groupKeys(e) {
  const d = e.dims.indexOf("group");
  return d < 0 ? [] : e.coords[d].names;
}

/** Sum a grouped expression over the subset `keys` of its grouping keys (PyPSA `_regroup`). */
export function regroup(e, keys) {
  const d = e.dims.indexOf("group");
  const all = e.coords[d].names;
  const idx = keys.map((k) => all.indexOf(k));
  const tuples = e.coords[d].values.map((t) => idx.map((i) => t[i]));
  return groupbySum(e, "group", tuples, keys, { position: keys.length === 1 ? "first" : "last" });
}

/** PyPSA `_restack_flat_groups`: a single grouping key names the dimension. */
export function restack(e) {
  const d = e.dims.indexOf("group");
  if (d < 0) return e;
  const names = e.coords[d].names;
  if (names.length !== 1) return e;
  const dims = e.dims.slice();
  const coords = e.coords.slice();
  dims[d] = names[0];
  coords[d] = new Index(
    e.coords[d].values.map((t) => t[0]),
    names[0],
  );
  return expr(e.model, dims, coords, e.nterm, e.vars, e.coeffs, e.consts);
}

/**
 * Sum over `dims` (old terms outermost, then the summed cells); constants are
 * summed skipping NaN like xarray.
 */
export function sumDims(e, dims) {
  const out = e.sum(dims);
  const keep = e.dims.filter((x) => !dims.includes(x));
  const kc = keep.map((x) => e.coords[e.dims.indexOf(x)]);
  const kshape = shapeOf(kc);
  const kstrides = stridesOf(kshape);
  const consts = new Float64Array(sizeOf(kshape));
  for (let c = 0; c < e.size; c++) {
    const pos = unravel(c, e.shape, e.strides);
    let k = 0;
    keep.forEach((x, i) => (k += pos[e.dims.indexOf(x)] * kstrides[i]));
    consts[k] += fill0(e.consts[c]);
  }
  return expr(e.model, out.dims, out.coords, out.nterm, out.vars, out.coeffs, consts);
}

/** `expr @ weights`: multiply and sum over the weights' dimensions. */
export function dot(e, w) {
  return sumDims(mulConst(e, w), w.dims.slice());
}

function nameIndex(e) {
  const d = e.dims.indexOf("name");
  return d < 0 ? null : e.coords[d];
}

function selName(e, names) {
  return e.sel({ name: names instanceof Index ? names : new Index(names, "name") });
}

function isSkipped(vals) {
  return vals === null || vals === undefined || (vals.size * vals.nterm === 0 && vals.consts.every((x) => x === 0));
}

/**
 * PyPSA `_split_piecewise`: drop the names handled by the piecewise curve of
 * `attr` from `e` and return them as the curve's auxiliary variable.
 */
function splitPiecewise(e, m, c, attr) {
  if (!c.has_piecewise(attr)) return [e, null];
  const aux = m.variables.get(c._piecewise_aux_var(attr));
  const auxNames = aux.coords[aux.dims.indexOf("name")];
  const keep = nameIndex(e).values.filter((nm) => !auxNames.has(nm));
  return [selName(e, keep), LinearExpression.fromVariable(aux)];
}

// ----------------------------------------------------------------------
// accessor
// ----------------------------------------------------------------------

const OPERATIONAL = LOOKUP.filter((r) => !r.nominal && !r.handle_separately);
// dict(lookup.query("not nominal and marginal_cost").index): the last variable wins
const COST_VARS = Object.fromEntries(LOOKUP.filter((r) => !r.nominal && r.marginal_cost).map((r) => [r.component, r.variable]));

const DEFAULTS = {
  components: null,
  groupby_method: "sum",
  aggregate_across_components: false,
  groupby: "carrier",
  at_port: null,
  bus_carrier: null,
  carrier: null,
  nice_names: null,
};

// keyword arguments deprecated in PyPSA 1.0 / 1.1
const DEPRECATED_KWARGS = { comps: "components", aggregate_groups: "groupby_method", aggregate_time: "groupby_time", kind: "direction" };

function withDefaults(name, opts, extra = {}) {
  const o = { ...DEFAULTS, ...extra };
  for (const [k, v] of Object.entries(opts ?? {})) {
    const key = DEPRECATED_KWARGS[k] ?? k;
    if (key !== k) {
      if (key in (opts ?? {})) throw new Error(`TypeError: ${name} received both ${k} and ${key}`);
      logger.warning(`\`${k}\` is deprecated as an argument to \`${name}\`; use \`${key}\` instead.`);
    }
    o[key] = v;
  }
  return o;
}

function requireSum(agg) {
  if (agg !== "sum") throw new Error(`ValueError: Aggregation method ${agg} not supported.`);
}

export class StatisticExpressionsAccessor {
  constructor(n) {
    this._n = n;
  }

  get _model() {
    const m = this._n.model;
    if (!m) throw new Error("No model: call `n.optimize.create_model()` first.");
    return m;
  }

  /** Scenarios of a stochastic network (the `scenario` coordinate), else null. */
  get _scenarios() {
    const n = this._n;
    return n.has_scenarios ? n.scenarios : null;
  }

  /** Deterministic views of the scenarios (cached for one statistic call). */
  _views() {
    if (!this._viewCache) this._viewCache = this._scenarios.values.map((sc) => scenarioView(this._n, sc));
    return this._viewCache;
  }

  /**
   * Static column of `c` by name. On stochastic networks the values must be
   * identical across scenarios (`pypsa.components.common.invariant`).
   */
  _invariant(c, values, attr) {
    const st = c.static;
    const out = new Map();
    if (!st.index.isMulti) {
      st.index.values.forEach((nm, i) => out.set(nm, values[i]));
      return out;
    }
    const varies = [];
    st.index.values.forEach((t, i) => {
      const nm = t[t.length - 1];
      const v = values[i];
      if (!out.has(nm)) out.set(nm, v);
      else if (!sameValue(out.get(nm), v) && !varies.includes(nm)) varies.push(nm);
    });
    if (varies.length) {
      throw new Error(`ValueError: Expected static data which is identical across scenarios, got differing values for ${pyList(varies)} in '${attr}'.`);
    }
    return out;
  }

  get is_multi_indexed() {
    return this._n.snapshots.isMulti;
  }

  // -------------------------------------------------------------- data
  /**
   * Static attribute values of `names` as a constant over `name` (`c.da[attr]`;
   * over `(scenario, name)` on stochastic networks).
   */
  _staticConst(c, attr, names, values = null) {
    const st = c.static;
    const col = values ?? st.col(attr);
    const num = (i) => {
      const v = i < 0 ? NaN : col[i];
      return typeof v === "boolean" ? Number(v) : v;
    };
    const sc = this._scenarios;
    if (sc === null) return Const.names(names, names.values.map((nm) => num(st.index.getLoc(nm))));
    const nm = asNameIndex(names);
    const out = new Float64Array(sc.length * nm.length);
    sc.values.forEach((s, i) => {
      for (let j = 0; j < nm.length; j++) out[i * nm.length + j] = num(st.index.getLoc([s, nm.at(j)]));
    });
    return new Const(["scenario", "name"], [sc, nm], out);
  }

  /**
   * Time-varying attribute over (snapshot, name). On stochastic networks over
   * `(scenario, name, snapshot)` or `(snapshot, scenario, name)`, the
   * dimension order of PyPSA's `c.da[attr]` (see `scenarioMajor`).
   */
  _dynamicConst(c, attr, sns, names) {
    const sc = this._scenarios;
    if (sc === null) return Const.dense(sns, names, denseValues(c, attr, sns, names));
    const nm = asNameIndex(names);
    const S = sc.length;
    const N = nm.length;
    const T = sns.length;
    const major = scenarioMajor(c, attr, sc);
    const out = new Float64Array(S * N * T);
    sc.values.forEach((s, i) => {
      const v = denseValues(scenarioData(c, s), attr, sns, nm); // (snapshot, name)
      for (let t = 0; t < T; t++) {
        for (let j = 0; j < N; j++) out[major ? (i * N + j) * T + t : (t * S + i) * N + j] = v[t * N + j];
      }
    });
    if (major) return new Const(["scenario", "name", "snapshot"], [sc, nm, sns], out);
    return new Const(["snapshot", "scenario", "name"], [sns, sc, nm], out);
  }

  /** Snapshot weightings `column` at the snapshots of `e`. */
  _weightsFor(e, column) {
    const sns = e.coords[e.dims.indexOf("snapshot")];
    const w = this._n.snapshot_weightings;
    const col = w.col(column);
    return new Const(
      ["snapshot"],
      [sns],
      Float64Array.from(sns.values, (s) => col[w.index.getLoc(s)]),
    );
  }

  /** Port efficiency of `c` at `port` (static, or time-varying over `sns`). */
  _portEfficiency(cName, port, sns = null) {
    const n = this._n;
    const c = n.c.get(cName);
    const p = c._as_port(port);
    const names = c.names;
    const ones = () => this._staticConst(c, null, names, new Float64Array(c.static.index.length).fill(1));
    if (n.one_port_components.has(cName)) return ones();
    if (n.passive_branch_components.has(cName)) return p === 0 ? ones().map(() => -1) : ones();
    if (cName === "Link" && p === 0) return ones().map(() => -1);
    if (cName === "Link" || cName === "Process") {
      const key = cName === "Process" ? `rate${p}` : p === 1 ? "efficiency" : `efficiency${p}`;
      if (!c.static.has(key)) return ones();
      if (sns !== null) return this._dynamicConst(c, key, sns, names);
      return this._staticConst(c, key, names);
    }
    throw new Error(`NotImplementedError: port_efficiency has not been implemented for: ${cName}`);
  }

  /** Nominal capacity as an expression (variables and fixed capacities), or null. */
  _capacityExpression(cName, includeNonExtendable = true) {
    const n = this._n;
    const m = this._model;
    const c = n.c.get(cName);
    const nomAttr = c._operational_attrs.nom;
    if (!c.static.has(nomAttr)) return null;
    const varName = `${cName}-${nomAttr}`;
    const fixed = c.fixed;
    let fixedCapacity = null;
    if (includeNonExtendable && fixed.length) fixedCapacity = this._staticConst(c, nomAttr, fixed);
    if (m.variables.has(varName)) return addOptional(LinearExpression.fromVariable(m.variables.get(varName)), fixedCapacity);
    if (fixedCapacity === null) return null;
    return fromConstant(m, fixedCapacity);
  }

  /** Operational variable of a component as an expression. */
  _operationalExpression(cName) {
    const n = this._n;
    const m = this._model;
    if (cName === "Load") {
      const c = n.c.get(cName);
      const sns = m.parameters.snapshots;
      return fromConstant(m, this._dynamicConst(c, "p_set", sns, c.names));
    }
    if (cName === "StorageUnit") {
      return LinearExpression.fromVariable(m.variables.get(`${cName}-p_dispatch`)).sub(m.variables.get(`${cName}-p_store`));
    }
    const attrs = OPERATIONAL.filter((r) => r.component === cName);
    if (attrs.length !== 1) throw new Error(`ValueError: can only convert an array of size 1 to a Python scalar (${cName})`);
    return LinearExpression.fromVariable(m.variables.get(`${cName}-${attrs[0].variable}`));
  }

  // -------------------------------------------------------------- time
  _aggregate_timeseries(e, column, agg = "sum") {
    if (!agg) return e;
    if (agg === true) agg = "sum";
    let w = this._weightsFor(e, column);
    const sns = w.coords[0];
    const periodOf = sns.isMulti ? sns.values.map((t) => t[0]) : null;
    if (agg === "mean") {
      // normalised to sum to one, per investment period if there are periods
      if (periodOf === null) {
        const total = w.values.reduce((a, b) => a + b, 0);
        w = w.map((x) => x / total);
      } else {
        const totals = new Map();
        periodOf.forEach((p, i) => totals.set(p, (totals.get(p) ?? 0) + w.values[i]));
        w = new Const(w.dims, w.coords, w.values.map((x, i) => x * (1 / totals.get(periodOf[i]))));
      }
      agg = "sum";
    }
    requireSum(agg);
    if (periodOf === null) return dot(e, w);
    // expr.mul(weights, join="left").groupby("period").sum()
    const grouped = groupbySum(
      mulConst(e, w),
      "snapshot",
      periodOf.map((p) => [p]),
      ["period"],
      { position: "inPlace" },
    );
    return restack(grouped);
  }

  // -------------------------------------------------------------- filters
  _filter_active_assets(cName, e) {
    if (e.dims.includes("snapshot") || e.dims.includes("period")) return e;
    const c = this._n.c.get(cName);
    const idx = nameIndex(e);
    const activeIn = (p) => {
      const active = this._invariant(c, c.get_active_assets(p).values, "active");
      return new Index(
        [...active].filter(([, a]) => a).map(([nm]) => nm),
        "name",
      ).intersection(idx);
    };
    if (!this.is_multi_indexed) return selName(e, activeIn(null));
    const periods = this._n.investment_periods;
    return mergeNewDim(
      periods.values.map((p) => selName(e, activeIn(p))),
      "period",
      new Index(periods.values, "period"),
    );
  }

  _filter_bus_carrier(cName, port, bus_carrier, e) {
    if (bus_carrier === null || bus_carrier === undefined) return e;
    const n = this._n;
    const c = n.c.get(cName);
    const idx = nameIndex(e);
    const busOf = this._invariant(c, c.static.col(`bus${port}`), `bus${port}`);
    // bus carriers by name (first row per bus on stochastic networks)
    const bs = n.c.buses.static;
    const carrierOf = new Map();
    bs.index.values.forEach((b, i) => {
      const nm = bs.index.isMulti ? b[b.length - 1] : b;
      if (!carrierOf.has(nm)) carrierOf.set(nm, bs.col("carrier")[i]);
    });
    const unique = new Set(carrierOf.values());
    const keep = idx.values.filter((nm) => {
      const bus = busOf.get(nm);
      const pc = carrierOf.has(bus) ? carrierOf.get(bus) : NaN;
      if (isNa(pc)) return false;
      if (typeof bus_carrier === "string") return unique.has(bus_carrier) ? pc === bus_carrier : contains(pc, bus_carrier);
      if (Array.isArray(bus_carrier)) return bus_carrier.includes(pc);
      throw new TypeError(`Argument \`bus_carrier\` must be a string or list-like, got ${typeof bus_carrier}`);
    });
    return selName(e, keep);
  }

  _filter_carrier(cName, carrier, e) {
    const c = this._n.c.get(cName);
    if (carrier === null || carrier === undefined || !c.static.has("carrier")) return e;
    const idx = nameIndex(e);
    const carrierOf = this._invariant(c, c.static.col("carrier"), "carrier");
    const carriers = idx.values.map((nm) => carrierOf.get(nm));
    const unique = new Set(carriers);
    const keep = idx.values.filter((_, i) => {
      const cc = carriers[i];
      if (typeof carrier === "string") return unique.has(carrier) ? cc === carrier : contains(cc, carrier);
      if (Array.isArray(carrier)) return carrier.includes(cc);
      throw new TypeError(`Argument \`carrier\` must be a string or list-like, got ${typeof carrier}`);
    });
    return selName(e, keep);
  }

  // -------------------------------------------------------------- grouping
  /**
   * Grouping keys of `cName`: `{names, keys}` with the key names (component
   * first) and a map from asset name to its key values. Stochastic networks
   * resolve the groupers per scenario; the keys must agree across scenarios.
   */
  _get_grouping(cName, groupby, port, nice_names) {
    if (typeof groupby !== "function" && typeof groupby !== "string" && !Array.isArray(groupby)) {
      throw new Error(`ValueError: Argument \`groupby\` must be a string, list-like, callable, or False, got ${groupby}.`);
    }
    const spec = Array.isArray(groupby) ? groupby : [groupby];
    const resolve = (n) => {
      const by = groupers.resolve(n, cName, spec, { port, nice_names });
      const idx = n.c.get(cName).static.index;
      const keys = new Map(idx.values.map((nm, i) => [nm, by.map((g) => g.values[i])]));
      return { names: ["component", ...by.map((g) => g.name)], keys };
    };
    if (this._scenarios === null) return resolve(this._n);
    const per = this._views().map(resolve);
    const first = per[0];
    const varies = [];
    for (const g of per.slice(1)) {
      for (const [nm, k] of g.keys) {
        const k0 = first.keys.get(nm);
        if (!k.every((v, i) => sameValue(v, k0[i])) && !varies.includes(nm)) varies.push(nm);
      }
    }
    if (varies.length) {
      throw new Error(`ValueError: Expected static data which is identical across scenarios, got differing values for ${pyList(varies)} in columns ${pyList(first.names.slice(1))}.`);
    }
    return first;
  }

  _groupby(e, grouping, cName) {
    const keys = nameIndex(e).values.map((nm) => {
      const k = grouping.keys.get(nm);
      // missing keys (e.g. unconnected ports) form their own group, like linopy
      return [cName, ...(k === undefined ? grouping.names.slice(1).map(() => NaN) : k.map((v) => (isNa(v) ? NaN : v)))];
    });
    return groupbySum(e, "name", keys, grouping.names);
  }

  _concat_values(exprs, agg) {
    if (exprs[0].dims.includes("group") && exprs.length > 1) {
      requireSum(agg);
      const merged = mergeAlong(exprs, "group");
      return regroup(merged, groupKeys(merged));
    }
    return mergeTerms(exprs);
  }

  _concat_data(res, isOne) {
    if (!res.length) return fromConstant(this._model, 0);
    const first = res[0][1];
    if (first.dims.includes("group")) {
      if (isOne) {
        const keys = groupKeys(first).filter((k) => k !== "component");
        return keys.length ? regroup(first, keys) : first;
      }
      return mergeAlong(
        res.map(([, e]) => e),
        "group",
      );
    }
    if (isOne) return first;
    return mergeAlong(
      res.map(([, e]) => e),
      "name",
    );
  }

  _aggregate_across_components(e, agg) {
    requireSum(agg);
    if (e.size * e.nterm === 0 && !e.dims.includes("group")) return e;
    const keys = groupKeys(e).filter((k) => k !== "component");
    return keys.length ? regroup(e, keys) : e;
  }

  /** Evaluate `func(n, c, port)` for components and ports, filter, group and concatenate. */
  _aggregate_components(func, opts) {
    this._viewCache = null;
    try {
      return this._aggregate_components_impl(func, opts);
    } finally {
      this._viewCache = null;
    }
  }

  _aggregate_components_impl(func, opts) {
    const n = this._n;
    let { components, groupby_method: agg, groupby, aggregate_across_components, at_port, bus_carrier, carrier, nice_names } = opts;
    const isOne = typeof components === "string";
    if (isOne) components = [components];
    if (components === null || components === undefined) components = [...new Set([...n.branch_components, ...n.one_port_components])].sort();
    if (nice_names === null || nice_names === undefined) nice_names = statisticsOptions.nice_names;
    if (nice_names) {
      bus_carrier = normalizeCarrierNiceNames(n, bus_carrier);
      carrier = normalizeCarrierNiceNames(n, carrier);
    }
    at_port = resolve_at_port(at_port, bus_carrier);
    const d = [];
    for (const cn of components) {
      const c = n.c.get(cn);
      if (c.static.index.length === 0) continue;
      const values = [];
      for (const port of c._as_ports(at_port)) {
        const portSuffix = c.ports[port];
        if (portSuffix === undefined) continue;
        let vals = func(n, cn, portSuffix);
        if (isSkipped(vals)) continue;
        // a plain linopy Variable (operation without time aggregation) has no
        // constant, so `linopy.merge` of ungrouped values fails in PyPSA
        if (vals._isVariable && groupby === false) {
          throw new Error("KeyError: \"No variable named 'const'. Variables on the dataset include ['lower', 'upper', 'scaling', 'labels', ...]\"");
        }
        vals = this._filter_active_assets(cn, vals);
        vals = this._filter_bus_carrier(cn, portSuffix, bus_carrier, vals);
        vals = this._filter_carrier(cn, carrier, vals);
        if (isSkipped(vals)) continue;
        if (groupby !== false) vals = this._groupby(vals, this._get_grouping(cn, groupby, portSuffix, nice_names), cn);
        values.push(vals);
      }
      if (!values.length) continue;
      d.push([cn, this._concat_values(values, agg)]);
    }
    let res = this._concat_data(d, isOne);
    if (aggregate_across_components) res = this._aggregate_across_components(res, agg);
    return restack(res);
  }

  // -------------------------------------------------------------- statistics
  /** Capital expenditure (`capacity * capital_cost`). */
  capex(opts = {}) {
    const o = withDefaults("capex", opts, { cost_attribute: "capital_cost", include_non_extendable: true });
    o.at_port = resolve_at_port(o.at_port, o.bus_carrier);
    const func = (n, cName) => {
      const c = n.c.get(cName);
      let capacity = this._capacityExpression(cName, o.include_non_extendable);
      if (capacity === null) return null;
      let addCapex;
      [capacity, addCapex] = splitPiecewise(capacity, this._model, c, o.cost_attribute);
      const names = nameIndex(capacity);
      const costs = o.cost_attribute === "capital_cost" ? this._staticConst(c, null, names, c.capital_cost) : this._staticConst(c, o.cost_attribute, names);
      return addOptional(mulConst(capacity, costs), addCapex);
    };
    return this._aggregate_components(func, o);
  }

  /** Optimal capacity (weighted by the port efficiency). */
  capacity(opts = {}) {
    const o = withDefaults("capacity", opts, { storage: false, include_non_extendable: true });
    if (o.storage) o.components = ["Store", "StorageUnit"];
    o.at_port = resolve_at_port(o.at_port, o.bus_carrier);
    const func = (n, cName, port) => {
      const c = n.c.get(cName);
      const capacity = this._capacityExpression(cName, o.include_non_extendable);
      if (capacity === null) return null;
      const names = nameIndex(capacity);
      let eff = this._portEfficiency(cName, port).sel("name", names);
      const ports = c._as_ports(o.at_port);
      if (ports.length === 1 && ports[0] === 0) eff = eff.map(Math.abs);
      let res = mulConst(capacity, eff);
      if (o.storage && cName === "StorageUnit") res = mulConst(res, this._staticConst(c, "max_hours", names));
      return res;
    };
    return this._aggregate_components(func, o);
  }

  /** Operational expenditure (`marginal_cost * p`, weighted over time). */
  opex(opts = {}) {
    const o = withDefaults("opex", opts, { groupby_time: "sum" });
    o.at_port = resolve_at_port(o.at_port, o.bus_carrier);
    const func = (n, cName) => {
      if (!(cName in COST_VARS)) return null;
      const v = this._model.variables.get(`${cName}-${COST_VARS[cName]}`);
      const sns = v.coords[v.dims.indexOf("snapshot")];
      const [ve, addOpex] = splitPiecewise(LinearExpression.fromVariable(v), this._model, n.c.get(cName), "marginal_cost");
      const cost = this._dynamicConst(n.c.get(cName), "marginal_cost", sns, nameIndex(ve));
      const opex = addOptional(mulConst(ve, cost), addOpex);
      return this._aggregate_timeseries(opex, "objective", o.groupby_time);
    };
    return this._aggregate_components(func, o);
  }

  /** Flows of branches between buses of the same carrier. */
  transmission(opts = {}) {
    const o = withDefaults("transmission", opts, { groupby_time: "sum" });
    o.at_port = resolve_at_port(o.at_port, o.bus_carrier);
    if (o.components === null || o.components === undefined) o.components = [...this._n.branch_components];
    const branches = get_transmission_branches(this._n, o.bus_carrier);
    const func = (n, cName, port) => {
      const v = this._operationalExpression(cName);
      const sns = v.coords[v.dims.indexOf("snapshot")];
      const ci = branches.names.indexOf("component");
      const ni = branches.names.indexOf("name");
      const idx = new Index([...new Set(branches.values.filter((t) => t[ci] === cName).map((t) => t[ni]))], "name");
      const eff = this._portEfficiency(cName, port, sns).sel("name", idx);
      const p = mulConst(selName(v, idx), eff);
      return this._aggregate_timeseries(p, "generators", o.groupby_time);
    };
    return this._aggregate_components(func, o);
  }

  /** Energy balance (supply positive, withdrawal negative). */
  energy_balance(opts = {}) {
    const o = withDefaults("energy_balance", opts, { groupby_time: "sum", groupby: null, at_port: "all", direction: "both" });
    if (o.groupby === null || o.groupby === undefined) o.groupby = ["carrier", "bus_carrier"];
    let direction = o.direction;
    if (direction === null || direction === undefined) {
      logger.warning("Passing `direction=None` is deprecated. Use `direction='both'` instead.");
      direction = "both";
    }
    const func = (n, cName, port) => {
      const c = n.c.get(cName);
      const v = this._operationalExpression(cName);
      const sns = v.coords[v.dims.indexOf("snapshot")];
      let coeffs = this._portEfficiency(cName, port, sns);
      if (c.static.has("sign")) {
        const sign = this._staticConst(c, "sign", c.names);
        coeffs = combineConst(coeffs, sign, (a, b) => a * b);
      } else coeffs = coeffs.map((x) => x * 1.0);
      let pwVar = null;
      if (cName === "Link" || cName === "Process") {
        const yAttr = `${c._coefficient_attr}${c._port_suffix(port)}`;
        if (c.has_piecewise(yAttr)) {
          // the curve's auxiliary variable replaces the linear coefficient
          const aux = this._model.variables.get(c._piecewise_aux_var(yAttr));
          const pw = mulConst(LinearExpression.fromVariable(aux), Const.scalar(1));
          const names = aux.coords[aux.dims.indexOf("name")];
          const d = coeffs.dims.indexOf("name");
          coeffs = new Const(
            coeffs.dims,
            coeffs.coords,
            coeffs.values.map((x, k) => (names.has(coeffs.coords[d].at(unravel(k, coeffs.shape, coeffs.strides)[d])) ? 0 : x)),
          );
          pwVar = directPiecewise(c, yAttr, pw, names, direction);
        }
      }
      let e = mulConst(whereConst(v, coeffs.map((x) => (x !== 0 ? 1 : 0))), coeffs);
      if (direction === "supply" || direction === "withdrawal") {
        if (direction === "withdrawal") logger.warning("The sign convention for withdrawal has changed: withdrawal values are now reported as positive numbers instead of negative numbers.");
        const s = direction === "supply" ? 1 : -1;
        const clip = (x) => (Number.isNaN(x) ? x : Math.max(s * x, 0));
        e = assignValues(e, clip, clip);
      } else if (direction !== "both") {
        throw new Error(`ValueError: Got unexpected argument direction=${direction}. Must be 'supply', 'withdrawal' or 'both'.`);
      }
      if (pwVar !== null) e = fillna0(e);
      return this._aggregate_timeseries(addOptional(e, pwVar), "generators", o.groupby_time);
    };
    return this._aggregate_components(func, o);
  }

  supply(opts = {}) {
    const o = { ...(opts ?? {}) };
    if (o.groupby === null || o.groupby === undefined) o.groupby = ["carrier", "bus_carrier"];
    return this.energy_balance({ ...o, direction: "supply" });
  }

  withdrawal(opts = {}) {
    const o = { ...(opts ?? {}) };
    if (o.groupby === null || o.groupby === undefined) o.groupby = ["carrier", "bus_carrier"];
    return this.energy_balance({ ...o, direction: "withdrawal" });
  }

  /** Curtailment of assets with a `p_max_pu` (available minus dispatched energy). */
  curtailment(opts = {}) {
    const o = withDefaults("curtailment", opts, { groupby_time: "sum" });
    o.at_port = resolve_at_port(o.at_port, o.bus_carrier);
    const func = (n, cName) => {
      const c = n.c.get(cName);
      if (!c.static.has("p_max_pu")) return null;
      const capacity = this._capacityExpression(cName);
      if (capacity === null) return null;
      const idx = nameIndex(capacity);
      const operation = selName(this._operationalExpression(cName), idx);
      const sns = operation.coords[operation.dims.indexOf("snapshot")];
      const pMaxPu = this._dynamicConst(c, "p_max_pu", sns, idx);
      // (capacity - operation / p_max_pu) * p_max_pu
      const curtailment = mulConst(mergeTerms([capacity, negExpr(divConst(operation, pMaxPu))]), pMaxPu);
      return this._aggregate_timeseries(curtailment, "generators", o.groupby_time);
    };
    return this._aggregate_components(func, o);
  }

  /** Operation of the components (mean over time by default). */
  operation(opts = {}) {
    const o = withDefaults("operation", opts, { groupby_time: "mean" });
    o.at_port = resolve_at_port(o.at_port, o.bus_carrier);
    const func = (n, cName) => {
      const op = this._operationalExpression(cName);
      const res = this._aggregate_timeseries(op, "generators", o.groupby_time);
      if (res === op && cName !== "Load" && cName !== "StorageUnit") res._isVariable = true;
      return res;
    };
    return this._aggregate_components(func, o);
  }
}

/**
 * PyPSA `_direct_piecewise`: a port supplies or withdraws by the sign of its
 * breakpoints; withdrawing curves count (negated) only for `withdrawal`.
 */
function directPiecewise(c, yAttr, pw, names, direction) {
  if (direction === "both") return pw;
  const table = c.piecewise[yAttr];
  const withdraws = names.values.map((nm) => Array.from(table.col([nm, yAttr])).some((y) => y < 0));
  if (direction === "withdrawal") return mulConst(selName(pw, names.values.filter((_, i) => withdraws[i])), Const.scalar(-1));
  return selName(
    pw,
    names.values.filter((_, i) => !withdraws[i]),
  );
}

/** Elementwise combination of two constants over the union of their dims. */
function combineConst(a, b, fn) {
  const extra = b.dims.filter((d) => !a.dims.includes(d));
  const dims = [...a.dims, ...extra];
  const coords = [...a.coords, ...extra.map((d) => b.coords[b.dims.indexOf(d)])];
  const shape = shapeOf(coords);
  const strides = stridesOf(shape);
  const am = positionMaps(dims, coords, a.dims, a.coords);
  const bm = positionMaps(dims, coords, b.dims, b.coords);
  const out = new Float64Array(sizeOf(shape));
  for (let k = 0; k < out.length; k++) {
    const pos = unravel(k, shape, strides);
    const ia = srcCell(pos, am, a.strides);
    const ib = srcCell(pos, bm, b.strides);
    out[k] = fn(ia < 0 ? NaN : a.values[ia], ib < 0 ? NaN : b.values[ib]);
  }
  return new Const(dims, coords, out);
}

/** Equality of static values (NaN equals NaN, like `nunique(dropna=False)`). */
function sameValue(a, b) {
  return a === b || (isNa(a) && isNa(b));
}

function pyList(xs) {
  return `[${xs.map((x) => `'${x}'`).join(", ")}]`;
}

/** Data of one scenario of a component (static rows and dynamic columns). */
function scenarioData(c, scenario) {
  const st = c.static;
  const pos = st.index.locLevel("scenario", scenario);
  const rows = new Index(
    pos.map((i) => st.index.at(i)[1]),
    "name",
  );
  const view = {
    static: {
      index: rows,
      colOr: (attr, dflt) => {
        const col = st.colOr(attr, null);
        return col === null ? dflt : pos.map((i) => col[i]);
      },
    },
    dynamic: {},
  };
  for (const [k, df] of Object.entries(c.dynamic)) {
    if (!df.columns.isMulti) continue;
    view.dynamic[k] = {
      index: df.index,
      has: (nm) => df.has([scenario, nm]),
      col: (nm) => df.col([scenario, nm]),
    };
  }
  return view;
}

/**
 * Whether PyPSA's `c.da[attr]` of a stochastic network is laid out
 * `(scenario, name, snapshot)` (true) or `(snapshot, scenario, name)`.
 *
 * `_to_xarray` unstacks the `(scenario, name)` columns, which puts the new
 * coordinates first, and transposes to the coordinate order. The following
 * `reindex(name=c.names).reindex(scenario=n.scenarios)` moves the coordinates
 * back into dimension order unless the unstacked levels already match. They
 * do when no or every column is time-varying; with some time-varying columns
 * pandas concatenates the time-varying and static parts, whose level union is
 * sorted.
 */
function scenarioMajor(c, attr, scenarios) {
  const dyn = c.dynamic[attr];
  // without static fill-ins the columns carry the levels of the static index
  if (!dyn || dyn.columns.length === 0) return !isSnapshotMajor(c);
  const have = new Set(dyn.columns.values.map(labelKey));
  const diff = c.static.index.values.filter((t) => !have.has(labelKey(t)));
  if (diff.length === 0) return !isSnapshotMajor(c);
  const ordered = (tuples, i) => [...new Map(tuples.map((t) => [labelKey(t[i]), t[i]])).values()];
  const sorted = (xs) => xs.slice().sort(compareLabels);
  const same = (a, b) => a.length === b.length && a.every((x, i) => labelKey(x) === labelKey(b[i]));
  const union = (a, b) => (same(a, b) ? a : sorted(ordered([...a, ...b].map((x) => [x]), 0)));
  const level = (i) => union(ordered(dyn.columns.values, i), sorted(ordered(diff, i)));
  return same(level(0), scenarios.values) && same(level(1), c.names.values);
}

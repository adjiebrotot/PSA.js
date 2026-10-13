// SPDX-License-Identifier: MIT
/**
 * Piecewise linear constraints (mirrors `pypsa.optimization.piecewise` and
 * the parts of linopy's `add_piecewise_formulation` it relies on: the LP
 * tangent-line and the incremental formulations; SOS2 is not supported).
 */

import { Index, compareLabels, labelKey } from "../core/index.js";
import { NOMINAL_ATTRS } from "./common.js";

const BREAKPOINT_DIM = "_breakpoint";
const LP_PIECE_DIM = `${BREAKPOINT_DIM}_piece`;
const PWL_LINK_DIM = "_pwl_var";
const PWL_METHODS = new Set(["sos2", "lp", "incremental", "auto"]);

// rhs of `lhs_expr <sign> rhs` once everything is moved to the lhs (linopy semantics)
const r = (lc, rc) => -(lc - rc);

/** Options for a piecewise constraint formulation (`PiecewiseOptions`). */
export class PiecewiseOptions {
  constructor({ component, attribute, sign, name = [], method = "auto", cumulative_attr = false } = {}) {
    this.component = component;
    this.attribute = attribute;
    this.sign = sign;
    this.name = name === null || name === undefined ? [] : typeof name === "string" ? [name] : [...name];
    this.method = method;
    this.cumulative_attr = cumulative_attr;
  }
}

/** Normalise a list of PiecewiseOptions or plain option objects. */
export function asPiecewiseOptions(list) {
  return (list ?? []).map((o) => (o instanceof PiecewiseOptions ? o : new PiecewiseOptions(o)));
}

/** Options for one component attribute. */
export function optionsFor(options, component, attribute) {
  return options.filter((p) => p.component === component && p.attribute === attribute);
}

const isNaNv = (v) => typeof v !== "number" || Number.isNaN(v);

/** Component names with piecewise data for `pwAttr` among `activeNames` (`get_piecewise_names`). */
export function getPiecewiseNames(c, pwAttr, activeNames) {
  const df = c.piecewise[pwAttr];
  if (!df || df.empty) return new Index([], "name");
  const names = [];
  const seen = new Set();
  for (const t of df.columns.values) {
    const col = df.col(t);
    if (!Array.from(col).some((v) => !isNaNv(v))) continue;
    const k = labelKey(t[0]);
    if (!seen.has(k)) {
      seen.add(k);
      names.push(t[0]);
    }
  }
  return new Index(names, "name").intersection(activeNames);
}

function pyList(values) {
  return `[${values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ")}]`;
}

/** Breakpoints per name (`_get_breakpoints`): {x, y, valid} arrays indexed [j][b]. */
function getBreakpoints(c, pwAttr, pwNames, cumulativeAttr, invertAttr) {
  const df = c.piecewise[pwAttr];
  const schema = c._piecewise_schema(pwAttr);
  const nB = df.index.length;
  const col = (nm, a) => {
    if (!df.has([nm, a])) throw new Error(`KeyError: ('${nm}', '${a}')`);
    return Float64Array.from(df.col([nm, a]), (v) => (isNaNv(v) ? NaN : v));
  };
  let x = pwNames.values.map((nm) => col(nm, schema.x));
  let y = pwNames.values.map((nm) => col(nm, pwAttr));
  const valid = x.map((xa, j) => Array.from(xa, (v, b) => !Number.isNaN(v) && !Number.isNaN(y[j][b])));
  if (invertAttr) y = y.map((ya) => ya.map((v) => 1 / v));

  // per-unit x-axes (p_pu, e_pu) are scaled to absolute values; extendables are rejected
  const nomAttr = NOMINAL_ATTRS[c.name];
  if (!schema.allow_extendable) {
    const bad = pwNames.intersection(c.extendables);
    if (!bad.empty) {
      throw new Error(
        `ValueError: Piecewise '${pwAttr}' breakpoints on a per-unit x-axis are not supported for extendable components (fixed ${nomAttr} required). Extendable components: ${pyList(bad.values)}.`,
      );
    }
    const pos = c.static.index.getIndexer(pwNames);
    const nomCol = c.static.col(nomAttr);
    const nom = Array.from(pos, (p) => Number(nomCol[p]));
    const badNom = pwNames.values.filter((_, j) => nom[j] === 0 || Number.isNaN(nom[j]) || nom[j] === Infinity);
    if (badNom.length) {
      throw new Error(
        `ValueError: Piecewise '${pwAttr}' breakpoints on a per-unit x-axis cannot be scaled to absolute values for components with non-positive, non-finite or missing ${nomAttr}. Problematic components: ${pyList(badNom)}.`,
      );
    }
    x = x.map((xa, j) => xa.map((v) => v * nom[j]));
  }
  x = x.map((xa, j) => xa.map((v, b) => (valid[j][b] ? v : NaN)));

  let yBp;
  if (cumulativeAttr) {
    // linopy `Slopes(y.shift(-1), y0=0).to_breakpoints(x)`
    const computed = y.map((ya, j) => {
      const sl = [];
      for (let b = 0; b < nB - 1; b++) if (!Number.isNaN(ya[b + 1])) sl.push(ya[b + 1]);
      const xp = Array.from(x[j]).filter((v) => !Number.isNaN(v));
      if (sl.length !== xp.length - 1) {
        throw new Error(`ValueError: len(slopes) must be len(x_points) - 1, got ${sl.length} slopes and ${xp.length} x_points`);
      }
      const pts = [0];
      for (let i = 0; i < sl.length; i++) pts.push(pts[pts.length - 1] + sl[i] * (xp[i + 1] - xp[i]));
      return pts;
    });
    const maxLen = Math.max(...computed.map((p) => p.length));
    yBp = computed.map((p) => Float64Array.from({ length: maxLen }, (_, b) => (b < p.length ? p[b] : NaN)));
  } else {
    yBp = y.map((ya, j) =>
      Float64Array.from(ya, (v, b) => {
        let w = v * x[j][b];
        if (Number.isNaN(w)) w = 0;
        return valid[j][b] ? w : NaN;
      }),
    );
  }
  return { x, y: yBp, valid };
}

// ----------------------------------------------------------------------
// linopy add_piecewise_formulation (continuous breakpoints)
// ----------------------------------------------------------------------

function strictlyMonotonic(rows) {
  // `_check_strict_monotonicity`: every slice is strictly increasing or
  // decreasing (ignoring NaN differences) and has at least one valid difference
  for (const a of rows) {
    let pos = true;
    let neg = true;
    let any = false;
    for (let b = 0; b + 1 < a.length; b++) {
      const d = a[b + 1] - a[b];
      if (Number.isNaN(d)) continue;
      any = true;
      if (!(d > 0)) pos = false;
      if (!(d < 0)) neg = false;
    }
    if (!((pos || neg) && any)) return false;
  }
  return true;
}

function trailingNanOnly(rows) {
  for (const a of rows) {
    let ended = false;
    for (let b = 0; b < a.length; b++) {
      if (Number.isNaN(a[b])) ended = true;
      else if (ended) return false;
    }
  }
  return true;
}

function detectConvexity(xRows, yRows) {
  const tol = 1e-10;
  let count = 0;
  let nonneg = true;
  let nonpos = true;
  xRows.forEach((xa, j) => {
    const ya = yRows[j];
    const nP = xa.length - 1;
    let dxSum = 0;
    const slopes = [];
    for (let p = 0; p < nP; p++) {
      const dx = xa[p + 1] - xa[p];
      if (!Number.isNaN(dx)) dxSum += dx;
      slopes.push((ya[p + 1] - ya[p]) / dx);
    }
    const sgn = Math.sign(dxSum);
    for (let p = 0; p + 1 < nP; p++) {
      const sd = (slopes[p + 1] - slopes[p]) * sgn;
      if (Number.isNaN(sd)) continue;
      count++;
      if (!(sd >= -tol)) nonneg = false;
      if (!(sd <= tol)) nonpos = false;
    }
  });
  if (count === 0) return "linear";
  if (nonneg && nonpos) return "linear";
  if (nonneg) return "convex";
  if (nonpos) return "concave";
  return "mixed";
}

/**
 * Add a two-tuple piecewise formulation `y <sign> f(x)`.
 *
 * @param {Model} m
 * @param {object} spec
 * @param {string} spec.name base name of the generated variables/constraints
 * @param {string[]} spec.extraDims dims besides "name" (e.g. ["snapshot"] or [])
 * @param {Index[]} spec.extraCoords coordinates of the extra dims
 * @param {Index} spec.names component names
 * @param {Function} spec.yLab label of the y expression at (e, j)
 * @param {Function} spec.xLab label of the x expression at (e, j)
 * @param {string} spec.yVarName / spec.xVarName link coordinates
 * @param {Float64Array[]} spec.yBp / spec.xBp breakpoints per name
 * @param {boolean[][]} spec.mask breakpoint presence per name
 * @param {string} spec.sign "=", "<=" or ">="
 * @param {string} spec.method
 * @param {Function|null} spec.active (e, j) -> {label, const} or null
 */
function addPiecewiseFormulation(m, spec) {
  const { name, extraDims, extraCoords, names, yLab, xLab, yVarName, xVarName, sign, method, active } = spec;
  if (!PWL_METHODS.has(method)) throw new Error(`ValueError: method must be one of ['auto', 'incremental', 'lp', 'sos2'], got '${method}'`);
  const isEq = sign === "=" || sign === "==";
  if (method === "lp" && isEq) throw new Error("ValueError: method='lp' requires exactly one tuple with sign='<=' or '>='.");
  const nN = names.length;
  if (spec.yBp.some((a) => a.length !== spec.xBp[0].length) || spec.xBp.some((a) => a.length !== spec.xBp[0].length)) {
    throw new Error(`ValueError: Breakpoints must have same size along '${BREAKPOINT_DIM}'`);
  }
  const nB = nN ? spec.xBp[0].length : 0;
  // `_resolve_breakpoint_mask`
  for (let j = 0; j < nN; j++) {
    for (let b = 0; b < nB; b++) {
      if (spec.mask[j][b] && (Number.isNaN(spec.yBp[j][b]) || Number.isNaN(spec.xBp[j][b]))) {
        throw new Error("ValueError: NaN at a breakpoint slot that `mask` marks as present.");
      }
    }
  }
  const yBp = spec.yBp.map((a, j) => a.map((v, b) => (spec.mask[j][b] ? v : NaN)));
  const xBp = spec.xBp.map((a, j) => a.map((v, b) => (spec.mask[j][b] ? v : NaN)));

  const nE = extraCoords.length ? extraCoords[0].length : 1;
  const dims = [...extraDims, "name"];
  const coords = [...extraCoords, names];

  // LP tangent lines
  if ((method === "lp" || method === "auto") && !isEq) {
    let reason = null;
    if (active) reason = "active=... is not supported by LP";
    else {
      const paired = xBp.map((a, j) => a.map((v, b) => (Number.isNaN(yBp[j][b]) ? NaN : v)));
      if (!strictlyMonotonic(paired)) reason = "paired x breakpoints are not strictly monotonic";
      else if (!trailingNanOnly(paired)) reason = "paired breakpoints contain non-trailing NaN";
      else {
        const convexity = detectConvexity(xBp, yBp);
        if (sign === "<=" && convexity !== "concave" && convexity !== "linear") reason = `sign='<=' needs concave/linear curvature, got '${convexity}'`;
        if (sign === ">=" && convexity !== "convex" && convexity !== "linear") reason = `sign='>=' needs convex/linear curvature, got '${convexity}'`;
      }
    }
    if (reason === null) {
      addLp(m, name, { dims, coords, nE, nN, nB, xLab, yLab, xBp, yBp, sign });
      return "lp";
    }
    if (method === "lp") throw new Error(`ValueError: method='lp' is not applicable: ${reason}. Use method='auto'.`);
  }

  // links: pinned (equality) tuples and the optional bounded tuple
  const pinned = isEq
    ? [
        { lab: yLab, bp: yBp, coord: yVarName },
        { lab: xLab, bp: xBp, coord: xVarName },
      ]
    : [{ lab: xLab, bp: xBp, coord: xVarName }];
  const bounded = isEq ? null : { lab: yLab, bp: yBp };
  const stacked = [...(bounded ? [bounded.bp] : []), ...pinned.map((p) => p.bp)].flat();
  const trailing = trailingNanOnly(stacked);
  const monotonic = strictlyMonotonic(stacked);
  let resolved;
  if (method === "auto") {
    if (!trailing) throw new Error("ValueError: SOS2 method does not support non-trailing NaN breakpoints.");
    resolved = monotonic ? "incremental" : "sos2";
  } else if (method === "incremental") {
    if (!monotonic) throw new Error("ValueError: Incremental method requires strictly monotonic breakpoints.");
    if (!trailing) throw new Error("ValueError: Incremental method does not support non-trailing NaN breakpoints.");
    resolved = "incremental";
  } else {
    resolved = "sos2";
  }
  if (resolved === "sos2") {
    throw new Error(
      `NotImplementedError: The SOS2 piecewise formulation ('${name}') is not supported in PSA.js; use strictly monotonic breakpoints (incremental formulation) instead.`,
    );
  }
  addIncremental(m, name, { dims, coords, extraDims, nE, nN, nB, pinned, bounded, sign: isEq ? "=" : sign, active, mask: spec.mask });
  return "incremental";
}

function addLp(m, name, { dims, coords, nE, nN, nB, xLab, yLab, xBp, yBp, sign }) {
  const nP = nB - 1;
  const pieceValid = xBp.map((xa, j) => Array.from({ length: nP }, (_, p) => !Number.isNaN(xa[p]) && !Number.isNaN(yBp[j][p]) && !Number.isNaN(xa[p + 1]) && !Number.isNaN(yBp[j][p + 1])));
  const hasMask = pieceValid.some((a) => a.some((v) => !v));
  const slopes = xBp.map((xa, j) =>
    Array.from({ length: nP }, (_, p) => {
      const s = (yBp[j][p + 1] - yBp[j][p]) / (xa[p + 1] - xa[p]);
      return hasMask && !pieceValid[j][p] ? 0 : s;
    }),
  );
  const intercepts = xBp.map((xa, j) =>
    Array.from({ length: nP }, (_, p) => {
      const v = yBp[j][p] - slopes[j][p] * xa[p];
      return hasMask && !pieceValid[j][p] ? 0 : v;
    }),
  );
  const pieceIdx = new Index(Array.from({ length: nP }, (_, p) => p), LP_PIECE_DIM);
  m.add_constraints(`${name}_chord`, [...dims, LP_PIECE_DIM], [...coords, pieceIdx], (...idx) => {
    const p = idx[idx.length - 1];
    const j = idx[idx.length - 2];
    const e = idx.length > 2 ? idx[0] : 0;
    return [[yLab(e, j), xLab(e, j)], [1, -slopes[j][p]], sign, r(0, intercepts[j][p]), !hasMask || pieceValid[j][p]];
  });
  const xMin = xBp.map((xa, j) => {
    let v = NaN;
    for (let b = 0; b < nB; b++) if (!Number.isNaN(xa[b]) && !Number.isNaN(yBp[j][b]) && !(xa[b] >= v)) v = xa[b];
    return v;
  });
  const xMax = xBp.map((xa, j) => {
    let v = NaN;
    for (let b = 0; b < nB; b++) if (!Number.isNaN(xa[b]) && !Number.isNaN(yBp[j][b]) && !(xa[b] <= v)) v = xa[b];
    return v;
  });
  const row = (bound, s) => (...idx) => {
    const j = idx[idx.length - 1];
    const e = idx.length > 1 ? idx[0] : 0;
    return [[xLab(e, j)], [1], s, r(0, bound[j])];
  };
  m.add_constraints(`${name}_domain_lo`, dims, coords, row(xMin, ">="));
  m.add_constraints(`${name}_domain_hi`, dims, coords, row(xMax, "<="));
}

function addIncremental(m, name, { dims, coords, extraDims, nN, nB, pinned, bounded, sign, active, mask }) {
  const nP = nB - 1;
  const pieceIdx = new Index(Array.from({ length: nP }, (_, p) => p), LP_PIECE_DIM);
  const deltaMask = mask.map((a) => Array.from({ length: nP }, (_, p) => Boolean(a[p] && a[p + 1])));
  const vDims = [...dims, LP_PIECE_DIM];
  const vCoords = [...coords, pieceIdx];
  const flatMask = (...idx) => deltaMask[idx[idx.length - 2]][idx[idx.length - 1]];
  const delta = m.add_variables({ name: `${name}_delta`, dims: vDims, coords: vCoords, lower: 0, upper: 1, mask: flatMask });
  const hasE = extraDims.length > 0;
  const dl = (e, j, p) => (hasE ? delta.at(e, j, p) : delta.at(j, p));
  const split = (idx) => (hasE ? [idx[0], idx[1], idx[2]] : [0, idx[0], idx[1]]);

  if (active) {
    m.add_constraints(`${name}_active_bound`, vDims, vCoords, (...idx) => {
      const [e, j, p] = split(idx);
      const a = active(e, j);
      return [[dl(e, j, p), a.label], [1, -1], "<=", r(0, a.const)];
    });
  }
  const binary = m.add_variables({ name: `${name}_order_binary`, dims: vDims, coords: vCoords, binary: true, mask: flatMask });
  const bl = (e, j, p) => (hasE ? binary.at(e, j, p) : binary.at(j, p));
  m.add_constraints(`${name}_delta_bound`, vDims, vCoords, (...idx) => {
    const [e, j, p] = split(idx);
    return [[dl(e, j, p), bl(e, j, p)], [1, -1], "<=", r(0, 0)];
  });
  if (nP >= 2) {
    const loIdx = new Index(Array.from({ length: nP - 1 }, (_, p) => p), LP_PIECE_DIM);
    m.add_constraints(`${name}_fill_order`, vDims, [...coords, loIdx], (...idx) => {
      const [e, j, p] = split(idx);
      return [[dl(e, j, p + 1), dl(e, j, p)], [1, -1], "<=", r(0, 0)];
    });
    m.add_constraints(`${name}_binary_order`, vDims, [...coords, loIdx], (...idx) => {
      const [e, j, p] = split(idx);
      return [[bl(e, j, p + 1), dl(e, j, p)], [1, -1], "<=", r(0, 0)];
    });
  }

  // `_incremental_weighted`: Σ delta * steps + bp0 (* active)
  const weighted = (bp, e, j) => {
    const vars = [];
    const coeffs = [];
    for (let p = 0; p < nP; p++) {
      const step = deltaMask[j][p] ? bp[j][p + 1] - bp[j][p] : 0;
      vars.push(dl(e, j, p));
      coeffs.push(-step);
    }
    const bp0 = bp[j][0];
    let c0 = bp0;
    if (active) {
      const a = active(e, j);
      vars.push(a.label);
      coeffs.push(a.label === -1 ? NaN : -bp0);
      c0 = 0 + bp0 * a.const;
    }
    return [vars, coeffs, c0];
  };
  const linkRow = (lab, bp, s) => (...idx) => {
    const e = hasE ? idx[0] : 0;
    const j = idx[idx.length - 1];
    const [vs, cs, c0] = weighted(bp, e, j);
    return [[lab(e, j), ...vs], [1, ...cs], s, r(0, c0)];
  };
  if (pinned.length) {
    const linkIdx = new Index(
      pinned.map((p) => p.coord),
      PWL_LINK_DIM,
    );
    m.add_constraints(`${name}_link`, [PWL_LINK_DIM, ...dims], [linkIdx, ...coords], (l, ...rest) => linkRow(pinned[l].lab, pinned[l].bp, "=")(...rest));
  }
  if (bounded) m.add_constraints(`${name}_output_link`, dims, coords, linkRow(bounded.lab, bounded.bp, sign));
}

/**
 * Add the variables and constraints of a piecewise linear curve (`define_piecewise`).
 *
 * @returns {{variable: Variable, names: Index}|null} the y variable and the
 *   names it covers, or null if no piecewise data applies
 */
export function define_piecewise(
  n,
  c,
  { xVar, sns, pwAttr, auxVarName, activeNames, sign, cumulativeAttr, extraOptions = [], status = null, invertAttr = false, method = "auto" },
) {
  const m = n.model;
  let pwNames = getPiecewiseNames(c, pwAttr, activeNames);
  if (pwNames.empty) return null;
  const allNames = pwNames;
  const bps = getBreakpoints(c, pwAttr, pwNames, cumulativeAttr, invertAttr);

  const hasSns = xVar.dims[0] === "snapshot";
  const extraDims = hasSns ? ["snapshot"] : [];
  const extraCoords = hasSns ? [sns] : [];
  const yVar = m.add_variables({ name: auxVarName, dims: [...extraDims, "name"], coords: [...extraCoords, pwNames] });
  const xSnsPos = hasSns ? xVar.coords[0].getIndexer(sns) : null;
  const xNamePos = xVar.coords[hasSns ? 1 : 0].getIndexer(pwNames);
  const nX = hasSns ? xVar.shape[1] : 0;
  const xLabAll = (e, jj) => {
    if (xNamePos[jj] < 0) return -1;
    if (!hasSns) return xVar.labels[xNamePos[jj]];
    return xSnsPos[e] < 0 ? -1 : xVar.labels[xSnsPos[e] * nX + xNamePos[jj]];
  };
  const yLabAll = (e, jj) => (hasSns ? yVar.at(e, jj) : yVar.at(jj));
  const bpPos = (nm) => allNames.getLoc(nm);

  let statusLab = null;
  if (status) {
    const sp = status.coords[0].getIndexer(sns);
    const np = status.coords[1].getIndexer(allNames);
    statusLab = (e, jj) => (sp[e] < 0 || np[jj] < 0 ? -1 : status.labels[sp[e] * status.shape[1] + np[jj]]);
  }

  // sorted(extra_options, key=lambda x: x.name, reverse=True) (stable)
  const sorted = extraOptions
    .map((o, i) => [o, i])
    .sort((a, b) => compareLabels(b[0].name, a[0].name) || a[1] - b[1])
    .map(([o]) => o);
  for (const option of [...sorted, null]) {
    let names;
    let aux;
    let optMethod;
    let optSign;
    if (option === null) {
      [names, aux, optMethod, optSign] = [pwNames, auxVarName, method, sign];
    } else if (option.name.length) {
      names = new Index(option.name, "name").intersection(pwNames);
      const suffix = names.length <= 3 ? names.values.join("_") : `${names.at(0)}_..._${names.at(names.length - 1)}`;
      aux = `${auxVarName}_${suffix}`;
      [optMethod, optSign] = [option.method, option.sign];
    } else {
      [names, aux, optMethod, optSign] = [pwNames, auxVarName, option.method, option.sign];
    }
    if (names.empty) continue;
    const pos = names.values.map(bpPos);

    let active = null;
    if (statusLab) {
      const nE = hasSns ? sns.length : 1;
      let allMasked = true;
      for (let e = 0; e < nE && allMasked; e++) for (const jj of pos) if (statusLab(e, jj) !== -1) allMasked = false;
      if (!allMasked) {
        active = (e, j) => {
          const l = statusLab(e, pos[j]);
          return l === -1 ? { label: -1, const: 1 } : { label: l, const: 0 };
        };
      }
    }
    addPiecewiseFormulation(m, {
      name: aux,
      extraDims,
      extraCoords,
      names,
      yLab: (e, j) => yLabAll(e, pos[j]),
      xLab: (e, j) => xLabAll(e, pos[j]),
      yVarName: auxVarName,
      xVarName: xVar.name,
      yBp: pos.map((jj) => bps.y[jj]),
      xBp: pos.map((jj) => bps.x[jj]),
      mask: pos.map((jj) => bps.valid[jj]),
      sign: optSign,
      method: optMethod,
      active,
    });
    pwNames = pwNames.difference(names);
  }
  return { variable: yVar, names: allNames };
}

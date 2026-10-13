// SPDX-License-Identifier: MIT
/**
 * Modelling to generate alternatives (mirrors `pypsa.optimization.mga`):
 * near-optimal solutions within a cost slack, optimised along weighted
 * capacity / dispatch dimensions.
 */

import { Index } from "../core/index.js";
import { DataFrame, Series } from "../core/frame.js";
import { NOMINAL_ATTRS } from "./common.js";
import { merge } from "./expressions.js";

/** numpy's MT19937 (RandomState) for reproducible random directions. */
class MT19937 {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.idx = 624;
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
  }

  next() {
    if (this.idx >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = (this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff);
        this.mt[i] = this.mt[(i + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.idx = 0;
    }
    let y = this.mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `random_sample` with 53-bit resolution. */
  random() {
    const a = this.next() >>> 5;
    const b = this.next() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }
}

function directionsFrame(rows, keys) {
  const df = new DataFrame({ index: new Index(rows.map((_, i) => i)) });
  keys.forEach((k, j) => df.set(k, Float64Array.from(rows, (r) => r[j])));
  return df;
}

/** Random unit directions (numpy `RandomState(seed).uniform() - 0.5`, normalised). */
export function generate_directions_random(keys, n_directions, seed = null) {
  const rng = new MT19937(seed ?? Math.floor(Math.random() * 2 ** 32));
  const rows = [];
  for (let i = 0; i < n_directions; i++) {
    const r = keys.map(() => rng.random() - 0.5);
    const norm = Math.sqrt(r.reduce((s, x) => s + x * x, 0));
    rows.push(r.map((x) => x / norm));
  }
  return directionsFrame(rows, keys);
}

/** Evenly spaced unit directions on the circle (two keys only). */
export function generate_directions_evenly_spaced(keys, n_directions) {
  if (keys.length !== 2) throw new Error("This function only supports two keys for 2D space.");
  const rows = [];
  for (let i = 0; i < n_directions; i++) {
    const a = (2 * Math.PI * i) / n_directions;
    rows.push([Math.cos(a), Math.sin(a)]);
  }
  return directionsFrame(rows, keys);
}

function radicalInverse(i, base) {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * Quasi-random unit directions from a Halton sequence (unscrambled; PyPSA
 * uses scipy's scrambled sequence so the points differ).
 */
export function generate_directions_halton(keys, n_directions, seed = null) {
  void seed;
  const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
  const rows = [];
  let i = 1;
  while (rows.length < n_directions) {
    const d = keys.map((_, j) => 2 * radicalInverse(i, primes[j]) - 1);
    i++;
    const norm = Math.sqrt(d.reduce((s, x) => s + x * x, 0));
    if (norm <= 1 && norm > 0) rows.push(d.map((x) => x / norm));
  }
  return directionsFrame(rows, keys);
}

function toPlain(obj) {
  if (obj instanceof Series) return Object.fromEntries(obj.index.values.map((k, i) => [k, obj.values[i]]));
  if (obj instanceof DataFrame) return Object.fromEntries(obj.columns.values.map((c) => [c, Array.from(obj.col(c))]));
  if (obj && typeof obj === "object" && !Array.isArray(obj)) return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toPlain(v)]));
  return obj;
}

function sumSeriesOrFrame(x) {
  if (x instanceof Series) {
    let s = 0;
    for (const v of x.values) if (!Number.isNaN(v)) s += v;
    return s;
  }
  // DataFrame: column sums (pandas skipna) keyed by column
  return Object.fromEntries(
    x.columns.values.map((c) => {
      let s = 0;
      for (const v of x.col(c)) if (!Number.isNaN(v)) s += v;
      return [c, s];
    }),
  );
}

/** Install the MGA methods on the optimisation accessor. */
export function installMGA(Accessor) {
  const proto = Accessor.prototype;

  /** Linear expression `sum(weights * variables)` for {component: {attr: coeffs}}. */
  proto.build_linexpr_from_weights = function buildLinexprFromWeights(weights, model = null) {
    const n = this._n;
    const m = model ?? n.model;
    const exprs = [];
    for (const [c, attrs] of Object.entries(weights)) {
      for (const [attr, coeffsIn] of Object.entries(attrs)) {
        let coeffs = coeffsIn;
        if (coeffs && !(coeffs instanceof Series) && !(coeffs instanceof DataFrame) && typeof coeffs === "object") coeffs = Series.fromObject(coeffs);
        const comp = n.c.get(c);
        if (attr === NOMINAL_ATTRS[c] && coeffs instanceof Series) {
          const ext = comp.extendables;
          coeffs = new Series(Float64Array.from(ext.values, (nm) => coeffs.getOr(nm, 0)), new Index(ext.values, "name"));
        } else if (coeffs instanceof Series) {
          throw new TypeError("Series weights are only supported for nominal attributes; use a DataFrame for dispatch attributes");
        } else if (coeffs instanceof DataFrame) {
          const df = new DataFrame({ index: n.snapshots });
          for (const nm of comp.static.index) {
            const col = coeffs.has(nm) ? coeffs.col(nm) : null;
            df.set(
              nm,
              Float64Array.from(n.snapshots.values, (s) => {
                if (!col) return NaN;
                const i = coeffs.index.getLoc(s);
                return i < 0 ? NaN : col[i];
              }),
            );
          }
          df.index = new Index(n.snapshots.values, "snapshot");
          df.columns = new Index(df.columns.values, "name");
          coeffs = df;
        }
        const v = m.variables.get(`${c}-${attr}`);
        if (!v) throw new Error(`KeyError: variable ${c}-${attr}`);
        exprs.push(v.toExpr().mul(coeffs));
      }
    }
    return merge(exprs);
  };

  proto._add_near_opt_constraint = function addNearOptConstraint(multi_investment_periods = false, slack = 0.05) {
    const n = this._n;
    if (!n.is_solved) throw new Error("Network needs to be solved with `n.optimize()` before adding near-optimal constraint.");
    const st = n.statistics;
    let optimal_cost;
    let fixed_cost;
    if (!multi_investment_periods) {
      optimal_cost = sumSeriesOrFrame(st.capex()) + sumSeriesOrFrame(st.opex());
      fixed_cost = sumSeriesOrFrame(st.installed_capex());
    } else {
      const w = n.investment_period_weightings;
      const weighted = (x) => {
        const sums = sumSeriesOrFrame(x);
        if (typeof sums === "number") return sums;
        return Object.entries(sums).reduce((acc, [p, v]) => acc + v * w.at(Number(p), "objective"), 0);
      };
      optimal_cost = weighted(st.capex()) + weighted(st.opex());
      fixed_cost = weighted(st.installed_capex());
    }
    const objective = n.model.objective_expression();
    n.model.add_constraints(objective.add(fixed_cost).le((1 + slack) * optimal_cost), { name: "budget" });
  };

  /** Optimise along `weights` within `slack` of the optimal system cost. */
  proto.optimize_mga = async function optimizeMga(opts = {}) {
    const { snapshots = null, multi_investment_periods = false, weights: weightsIn = null, sense: senseIn = "min", slack = 0.05, model_kwargs = {}, ...kwargs } = opts;
    const n = this._n;
    const weights = weightsIn ?? { Generator: { p_nom: Object.fromEntries(n.c.generators.static.index.values.map((g) => [g, 1])) } };
    if (!n.is_solved) throw new Error("Network needs to be solved with `n.optimize()` before running MGA.");
    const m = this.create_model({ snapshots, multi_investment_periods, ...model_kwargs });
    this._add_near_opt_constraint(multi_investment_periods, slack);
    let sense;
    if ((typeof senseIn === "string" && senseIn.startsWith("min")) || (typeof senseIn === "number" && senseIn > 0)) sense = 1;
    else if ((typeof senseIn === "string" && senseIn.startsWith("max")) || (typeof senseIn === "number" && senseIn < 0)) sense = -1;
    else throw new Error(`Could not parse optimization sense ${senseIn}`);
    m.set_objective(this.build_linexpr_from_weights(weights, m).mul(sense));
    const [status, condition] = await this.solve_model(kwargs);
    n.meta.slack = slack;
    n.meta.sense = sense;
    n.meta.weights = toPlain(weights);
    return [status, condition];
  };

  /** Evaluate solved dimensions {key: weights} as a Series. */
  proto.project_solved = function projectSolved(dimensions) {
    const n = this._n;
    if (!n.is_solved) throw new Error("Network needs to be solved with `n.optimize()` before projecting result.");
    const keys = Object.keys(dimensions);
    return new Series(
      Float64Array.from(keys, (k) => this.build_linexpr_from_weights(dimensions[k], n.model).solution.reduce((s, x) => s + x, 0)),
      new Index(keys),
    );
  };

  /** Optimise in a direction of the space spanned by `dimensions`. */
  proto.optimize_mga_in_direction = async function optimizeMgaInDirection(opts = {}) {
    const { direction, dimensions, snapshots = null, multi_investment_periods = false, slack = 0.05, model_kwargs = {}, ...kwargs } = opts;
    const n = this._n;
    const dir = direction instanceof Series ? Object.fromEntries(direction.index.values.map((k, i) => [k, direction.values[i]])) : direction;
    const a = Object.keys(dir).sort();
    const b = Object.keys(dimensions).sort();
    if (a.length !== b.length || a.some((k, i) => k !== b[i])) {
      throw new Error(`Keys of \`direction\` and \`dimensions\` arguments must match. Got ${a} and ${b}.`);
    }
    if (!n.is_solved) throw new Error("Network needs to be solved with `n.optimize()` before running MGA.");
    const m = this.create_model({ snapshots, multi_investment_periods, ...model_kwargs });
    this._add_near_opt_constraint(multi_investment_periods, slack);
    const terms = Object.keys(dir).map((key) => this.build_linexpr_from_weights(dimensions[key], m).mul(dir[key]));
    // -sum(direction[key] * expr)
    m.set_objective(terms.reduce((acc, t) => acc.add(t)).mul(-1));
    const [status, condition] = await this.solve_model(kwargs);
    const coordinates = status === "ok" ? this.project_solved(dimensions) : null;
    n.meta.slack = slack;
    n.meta.dimensions = toPlain(dimensions);
    n.meta.direction = dir;
    return [status, condition, coordinates];
  };

  /**
   * Optimise in several directions (sequentially, each on a copy of the
   * network). Returns [directions, coordinates] DataFrames of the successful runs.
   */
  proto.optimize_mga_in_multiple_directions = async function optimizeMgaInMultipleDirections(opts = {}) {
    const { directions, dimensions, max_parallel = 1, ...rest } = opts;
    void max_parallel;
    const n = this._n;
    const list = directions instanceof DataFrame ? directions.index.values.map((_, i) => Object.fromEntries(directions.columns.values.map((c) => [c, directions.col(c)[i]]))) : directions;
    const ok = [];
    for (const d of list) {
      try {
        const nc = n.copy();
        const [, , coords] = await nc.optimize.optimize_mga_in_direction({ direction: d, dimensions, ...rest });
        if (coords) ok.push([d, coords]);
      } catch {
        // failed directions are skipped like in PyPSA
      }
    }
    if (!ok.length) return [new DataFrame(), new DataFrame()];
    const dkeys = Object.keys(ok[0][0]);
    const dirs = new DataFrame({ index: new Index(ok.map((_, i) => i)) });
    for (const k of dkeys) dirs.set(k, Float64Array.from(ok, ([d]) => d[k]));
    const ckeys = ok[0][1].index.values;
    const coords = new DataFrame({ index: new Index(ok.map((_, i) => i)) });
    for (const k of ckeys) coords.set(k, Float64Array.from(ok, ([, c]) => c.get(k)));
    return [dirs, coords];
  };
}

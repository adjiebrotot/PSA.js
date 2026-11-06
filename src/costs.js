// SPDX-License-Identifier: MIT
/** Cost helpers (mirrors `pypsa.costs`). */

import { Series } from "./core/frame.js";

/** Annuity factor for one asset. */
export function annuityScalar(discountRate, lifetime) {
  if (lifetime <= 0) throw new Error(`lifetime must be positive, got ${lifetime}`);
  if (discountRate === 0) {
    if (!Number.isFinite(lifetime)) return 0.0;
    return 1.0 / lifetime;
  }
  if (!Number.isFinite(lifetime)) return Math.max(discountRate, 0.0);
  return discountRate / (1.0 - 1.0 / (1.0 + discountRate) ** lifetime);
}

/**
 * Annuity factor; arguments may be scalars or arrays (element-wise).
 * NaN discount rates propagate as NaN like pandas.
 */
export function annuity(discountRate, lifetime) {
  const isArr = (x) => typeof x === "object" && x !== null && "length" in x;
  if (!isArr(discountRate) && !isArr(lifetime)) return annuityScalar(discountRate, lifetime);
  const n = isArr(discountRate) ? discountRate.length : lifetime.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = isArr(discountRate) ? discountRate[i] : discountRate;
    const l = isArr(lifetime) ? lifetime[i] : lifetime;
    if (Number.isNaN(r)) {
      out[i] = NaN;
      continue;
    }
    if (r === 0) out[i] = 1.0 / l;
    else if (!Number.isFinite(l)) out[i] = Math.max(r, 0);
    else out[i] = r / (1.0 - 1.0 / (1.0 + r) ** l);
  }
  return out;
}

/**
 * Periodized cost per asset (array version of `pypsa.costs.periodized_cost`).
 * @param {object} p
 * @param {ArrayLike<number>} p.capital_cost
 * @param {ArrayLike<number>} p.overnight_cost
 * @param {ArrayLike<number>} p.discount_rate
 * @param {ArrayLike<number>} p.lifetime
 * @param {ArrayLike<number>|null} [p.fom_cost]
 * @param {number|number[]} [p.nyears]
 */
export function periodizedCost({ capital_cost, overnight_cost, discount_rate, lifetime, fom_cost = null, nyears = 1.0 }) {
  const n = capital_cost.length;
  let useOvernight = false;
  for (let i = 0; i < n; i++) if (!Number.isNaN(overnight_cost[i])) useOvernight = true;
  let ny = nyears;
  if (Array.isArray(nyears) || nyears instanceof Float64Array) {
    const uniq = [...new Set(Array.from(nyears))];
    if (uniq.length === 1) ny = uniq[0];
    else if (useOvernight) {
      throw new Error(
        "overnight_cost cannot be used when investment periods have different durations (nyears). " +
          "Provide capital_cost instead, or use investment periods with equal duration.",
      );
    } else ny = 1; // unused
  }
  const out = new Float64Array(n);
  const ann = useOvernight ? annuity(discount_rate, lifetime) : null;
  for (let i = 0; i < n; i++) {
    let base = capital_cost[i];
    if (useOvernight && !Number.isNaN(overnight_cost[i])) base = overnight_cost[i] * ann[i] * ny;
    if (fom_cost !== null) {
      const f = fom_cost[i];
      base += Number.isNaN(f) ? 0 : f;
    }
    out[i] = base;
  }
  return out;
}

const isSeries = (x) => x instanceof Series;
const isArr = (x) => !isSeries(x) && typeof x === "object" && x !== null && "length" in x;

/**
 * Apply `fn` element-wise to scalars, arrays and Series. Series are aligned
 * on the union of their indexes (pandas arithmetic); the result is a Series
 * when any argument is one, an array for arrays and a number otherwise.
 */
function elementwise(fn, ...args) {
  const series = args.filter(isSeries);
  if (series.length) {
    let index = series[0].index;
    for (const s of series.slice(1)) index = index.union(s.index);
    const vals = args.map((a) => (isSeries(a) ? (a.index.equals(index) ? a.values : a.reindex(index).values) : a));
    const names = new Set(series.map((s) => s.name));
    const out = Float64Array.from({ length: index.length }, (_, i) => fn(...vals.map((v) => (isArr(v) ? v[i] : v))));
    return new Series(out, index, names.size === 1 ? series[0].name : null);
  }
  const arr = args.find(isArr);
  if (arr) return Float64Array.from({ length: arr.length }, (_, i) => fn(...args.map((v) => (isArr(v) ? v[i] : v))));
  return fn(...args);
}

const annuityElement = (r, l) => (Number.isNaN(r) ? NaN : r === 0 ? 1.0 / l : !Number.isFinite(l) ? Math.max(r, 0) : r / (1.0 - 1.0 / (1.0 + r) ** l));

/**
 * `pypsa.costs.annuity(discount_rate, lifetime)`: annuity factor
 * r / (1 - (1 + r)^-n) for numbers, arrays or Series (1/n for r = 0, max(r, 0)
 * for an infinite lifetime). A scalar lifetime must be positive.
 */
function annuityFactor(discount_rate, lifetime) {
  if (!isSeries(discount_rate) && !isSeries(lifetime)) return annuity(discount_rate, lifetime);
  if (typeof lifetime === "number" && lifetime <= 0) throw new Error(`ValueError: lifetime must be positive, got ${lifetime}`);
  return elementwise(annuityElement, discount_rate, lifetime);
}

const anyNotNa = (x) => (isSeries(x) ? Array.from(x.values).some((v) => !Number.isNaN(v)) : isArr(x) ? Array.from(x).some((v) => !Number.isNaN(v)) : !Number.isNaN(x));

/**
 * `pypsa.costs.periodized_cost(capital_cost, overnight_cost, discount_rate,
 * lifetime, fom_cost, nyears)`: fixed cost per unit of capacity for the
 * modelled horizon. Where `overnight_cost` is given (not NaN) it is
 * annuitised and scaled by `nyears`, otherwise `capital_cost` is used; NaN
 * `fom_cost` counts as 0. Arguments are numbers, arrays or Series; keyword
 * arguments go in a trailing options object (`{ fom_cost, nyears }`, or all
 * of them as the only argument).
 */
export function periodized_cost(capital_cost, overnight_cost, discount_rate, lifetime, fom_cost = null, nyears = 1.0) {
  const isKwargs = (x) => x !== null && typeof x === "object" && !isSeries(x) && !isArr(x);
  if (isKwargs(capital_cost)) ({ capital_cost, overnight_cost, discount_rate, lifetime, fom_cost = null, nyears = 1.0 } = capital_cost);
  else if (isKwargs(fom_cost)) ({ fom_cost = null, nyears = 1.0 } = fom_cost);
  const useOvernight = anyNotNa(overnight_cost);
  if (isSeries(nyears) || isArr(nyears)) {
    const uniq = [...new Set(Array.from(isSeries(nyears) ? nyears.values : nyears))];
    if (uniq.length === 1) nyears = Number(uniq[0]);
    else if (useOvernight) {
      throw new Error(
        "ValueError: overnight_cost cannot be used when investment periods have different durations (nyears). " +
          "Provide capital_cost instead, or use investment periods with equal duration.",
      );
    }
  }
  let base = capital_cost;
  if (useOvernight) {
    const ann = annuityFactor(discount_rate, lifetime);
    if (isSeries(overnight_cost) || isArr(overnight_cost)) {
      base = elementwise((o, a, ny, c) => (Number.isNaN(o) ? c : o * a * ny), overnight_cost, ann, nyears, capital_cost);
    } else base = elementwise((a, ny) => overnight_cost * a * ny, ann, nyears);
  }
  if (fom_cost === null || fom_cost === undefined) return base;
  return elementwise((b, f) => b + (Number.isNaN(f) ? 0.0 : f), base, fom_cost);
}

/** `pypsa.costs`: `annuity` and `periodized_cost` on numbers, arrays and Series. */
export const costs = { annuity: annuityFactor, periodized_cost };

// SPDX-License-Identifier: MIT
/** Cost helpers (mirrors `pypsa.costs`). Vectorised over plain arrays. */

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

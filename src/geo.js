// SPDX-License-Identifier: MIT
/**
 * Distances and bounding boxes (mirrors `pypsa.geo`). The cartopy helpers
 * `get_projection_from_crs` and `get_projected_area_factor` belong to
 * plotting and are not ported.
 */

import { Series } from "./core/frame.js";
import { haversinePts } from "./components/components.js";

const values = (x) => (x instanceof Series ? Array.from(x.values) : Array.from(x));
const isPair = (a) => a.length === 2 && typeof a[0] === "number";

/**
 * Crow-flies distance in km between the points of `a` and `b` (pairwise),
 * given as `[lon, lat]` pairs or lists of them; a single pair broadcasts
 * against a list. Two single pairs give a number.
 */
export function haversine_pts(a, b) {
  const pa = isPair(a);
  const pb = isPair(b);
  if (pa && pb) return haversinePts(a[0], a[1], b[0], b[1]);
  const n = pa ? b.length : a.length;
  if (!pa && !pb && a.length !== b.length) throw new Error(`ValueError: operands could not be broadcast together with shapes (${a.length},) (${b.length},)`);
  return Float64Array.from({ length: n }, (_, i) => {
    const p = pa ? a : a[i];
    const q = pb ? b : b[i];
    return haversinePts(p[0], p[1], q[0], q[1]);
  });
}

function ensureDimensions(a) {
  const rows = isPair(a) || a.length === 0 || typeof a[0] === "number" ? [a] : Array.from(a);
  for (const r of rows) if (r.length !== 2) throw new Error("ValueError: Array must have shape (N, 2)");
  return rows;
}

/**
 * Distances in km between every point of `a` and every point of `b`
 * (`[lon, lat]` pairs or lists of them): `result[i][j]` is the distance from
 * `a[i]` to `b[j]`.
 */
export function haversine(a, b) {
  const ra = ensureDimensions(a);
  const rb = ensureDimensions(b);
  return ra.map((p) => Float64Array.from(rb, (q) => haversinePts(p[0], p[1], q[0], q[1])));
}

function nanExtent(xs) {
  let lo = NaN;
  let hi = NaN;
  for (const v of xs) {
    if (Number.isNaN(v)) continue;
    if (!(v >= lo)) lo = v;
    if (!(v <= hi)) hi = v;
  }
  return [lo, hi];
}

/**
 * Bounding box `[[x1, y1], [x2, y2]]` of the coordinates `x`, `y` (arrays or
 * Series; NaN ignored), widened on each side by `margin` times its extent
 * (`compute_bbox(x, y, { margin: 0.1 })`).
 */
export function compute_bbox(x, y, opts = {}) {
  const { margin = 0 } = typeof opts === "number" ? { margin: opts } : opts;
  const [x0, x1] = nanExtent(values(x));
  const [y0, y1] = nanExtent(values(y));
  return [
    [x0 - margin * (x1 - x0), y0 - margin * (y1 - y0)],
    [x1 + margin * (x1 - x0), y1 + margin * (y1 - y0)],
  ];
}

/** `pypsa.geo`. */
export const geo = { haversine_pts, haversine, compute_bbox };

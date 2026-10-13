// SPDX-License-Identifier: MIT
/**
 * Floating point helpers reproducing CPython/numpy results bit-for-bit where
 * JavaScript's built-ins differ.
 */

const SPLITTER = 134217729; // 2^27 + 1

function twoProd(a, b) {
  const p = a * b;
  let t = SPLITTER * a;
  const ah = t - (t - a);
  const al = a - ah;
  t = SPLITTER * b;
  const bh = t - (t - b);
  const bl = b - bh;
  const err = ah * bh - p + ah * bl + al * bh + al * bl;
  return [p, err];
}

function fastTwoSum(a, b) {
  const s = a + b;
  return [s, b - (s - a)];
}

function ddMul(a, b) {
  const [p, e] = twoProd(a[0], b[0]);
  return fastTwoSum(p, e + (a[0] * b[1] + a[1] * b[0]));
}

function ddDivOne(a) {
  // 1 / (a0 + a1) in double-double
  const q1 = 1 / a[0];
  const [p, e] = twoProd(q1, a[0]);
  const r = 1 - p - e - q1 * a[1];
  const q2 = r / a[0];
  return fastTwoSum(q1, q2);
}

/**
 * `x ** y` as computed by C `pow` (glibc, correctly rounded in practice).
 * Integer exponents are evaluated in double-double precision and rounded
 * once; other exponents fall back to Math.pow.
 */
export function pyPow(x, y) {
  if (!Number.isInteger(y) || Math.abs(y) > 1024 || !Number.isFinite(x) || x === 0) return x ** y;
  if (y === 0) return 1;
  if (y === 1) return x;
  let e = Math.abs(y);
  let result = [1, 0];
  let base = [x, 0];
  while (e > 0) {
    if (e & 1) result = ddMul(result, base);
    e = Math.floor(e / 2);
    if (e > 0) base = ddMul(base, base);
  }
  if (y < 0) result = ddDivOne(result);
  return result[0] + result[1];
}

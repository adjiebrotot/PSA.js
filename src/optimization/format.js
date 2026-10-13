// SPDX-License-Identifier: MIT
/** Number formatting compatible with polars' Float64 -> String cast (used by linopy's LP writer). */

export function polarsFloat(x) {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const e = x.toExponential();
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
  const sign = m[1];
  const digits = m[2] + (m[3] || "");
  const exp = parseInt(m[4], 10);
  if (exp < -5 || exp >= 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${Math.abs(exp)}`;
  }
  if (exp >= 0) {
    if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
    return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  }
  return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
}

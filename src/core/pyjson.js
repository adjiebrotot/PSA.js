// SPDX-License-Identifier: MIT
/**
 * JSON like Python's `json` module (the metadata of PyPSA's files): `NaN` /
 * `Infinity` literals, Python's separators, ASCII escapes and float repr.
 */

import { pyFloatRepr } from "./csv.js";

// Numbers written as floats (`1.0`, `1e3`) in JSON read by `pyJsonLoads`, per
// holder and key, so integral ones are written back in Python's float form.
const PY_JSON_FLOATS = new WeakMap();

function pyJsonNumber(v, holder, key) {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(v) && !Object.is(v, -0) && PY_JSON_FLOATS.get(holder)?.get(key) !== v) return BigInt(v).toString();
  return pyFloatRepr(v);
}

/**
 * JSON text like Python's `json.dumps` (", " / ": " separators, ASCII
 * escapes, float repr), so exported metadata files match PyPSA byte for byte.
 */
export function pyJsonDumps(v, holder = null, key = null) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyJsonNumber(v, holder, key);
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (Array.isArray(v)) return `[${v.map((x, i) => pyJsonDumps(x, v, String(i))).join(", ")}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${pyJsonDumps(String(k))}: ${pyJsonDumps(x, v, k)}`)
    .join(", ")}}`;
}

const PY_JSON_CONST = { NaN: "\u0000psajs:NaN", Infinity: "\u0000psajs:Infinity", "-Infinity": "\u0000psajs:-Infinity" };
const PY_JSON_VALUE = { [PY_JSON_CONST.NaN]: NaN, [PY_JSON_CONST.Infinity]: Infinity, [PY_JSON_CONST["-Infinity"]]: -Infinity };

/**
 * Parse JSON like Python's `json.loads`, which accepts `NaN`, `Infinity` and
 * `-Infinity`; integral numbers written as floats are remembered for
 * `pyJsonDumps` (where the runtime exposes the source text to revivers).
 */
export function pyJsonLoads(text) {
  const src = text.replace(/"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g, (t) => (t[0] === '"' ? t : JSON.stringify(PY_JSON_CONST[t])));
  return JSON.parse(src, function revive(k, v, ctx) {
    if (typeof v === "string" && v[0] === "\u0000" && v in PY_JSON_VALUE) return PY_JSON_VALUE[v];
    if (typeof v === "number" && Number.isInteger(v) && /[.eE]/.test(ctx?.source ?? "")) {
      if (!PY_JSON_FLOATS.has(this)) PY_JSON_FLOATS.set(this, new Map());
      PY_JSON_FLOATS.get(this).set(k, v);
    }
    return v;
  });
}

/** Deep copy (`structuredClone`) that keeps the float form of integral numbers read by `pyJsonLoads`. */
export function pyJsonClone(v) {
  const out = structuredClone(v);
  const seen = new Set();
  const walk = (src, dst) => {
    if (src === null || typeof src !== "object" || dst === null || typeof dst !== "object" || seen.has(src)) return;
    seen.add(src);
    const marks = PY_JSON_FLOATS.get(src);
    if (marks) PY_JSON_FLOATS.set(dst, new Map(marks));
    for (const k of Object.keys(src)) walk(src[k], dst[k]);
  };
  walk(v, out);
  return out;
}

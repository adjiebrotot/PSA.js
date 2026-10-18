// SPDX-License-Identifier: MIT
/**
 * Well-known text (WKT) geometries as shapely/GEOS writes them: shapes keep
 * their geometry as WKT strings in PSA.js, in shapely's canonical form
 * (`str(geometry)`: shortest round-trip digits), and are written to files
 * like `GeoSeries.to_wkt()` (6 decimals, trailing zeros trimmed).
 *
 * Numbers follow GEOS' WKTWriter: positional notation for 1e-4 <= |x| < 1e17,
 * otherwise scientific notation (`1e-5`, `1.234568e+19`); rounding is exact
 * with ties to even (GEOS uses ryu).
 */

const TYPES = ["POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON", "GEOMETRYCOLLECTION"];

// ----------------------------------------------------------------------
// parsing
// ----------------------------------------------------------------------

function tokenize(s) {
  const out = [];
  const re = /\s*([A-Za-z]+|\(|\)|,|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|nan|inf)/gy;
  let m;
  let last = 0;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1]);
    last = re.lastIndex;
  }
  if (s.slice(last).trim() !== "") throw new Error(`Invalid WKT near '${s.slice(last, last + 20)}'`);
  return out;
}

/** Parse WKT into `{type, dim, parts}` (coordinates as arrays of numbers). */
export function parseWkt(s) {
  const tok = tokenize(String(s));
  let i = 0;
  const peek = () => tok[i];
  const take = (t) => {
    if (t !== undefined && tok[i]?.toUpperCase() !== t) throw new Error(`Invalid WKT: expected ${t}, got ${tok[i]}`);
    return tok[i++];
  };
  const coord = () => {
    const xs = [];
    while (peek() !== undefined && peek() !== "," && peek() !== ")") xs.push(Number(take()));
    return xs;
  };
  const list = (item) => {
    take("(");
    const out = [item()];
    while (peek() === ",") {
      take(",");
      out.push(item());
    }
    take(")");
    return out;
  };
  const geometry = () => {
    const type = take().toUpperCase();
    if (!TYPES.includes(type)) throw new Error(`Invalid WKT geometry type ${type}`);
    let dim = "";
    if (["Z", "M", "ZM"].includes(peek()?.toUpperCase())) dim = take().toUpperCase();
    if (peek()?.toUpperCase() === "EMPTY") {
      take();
      return { type, dim, parts: null };
    }
    const point = () => (peek() === "(" ? list(coord)[0] : coord());
    let parts;
    if (type === "POINT") parts = list(coord)[0];
    else if (type === "LINESTRING") parts = list(coord);
    else if (type === "POLYGON") parts = list(() => list(coord));
    else if (type === "MULTIPOINT") parts = list(point);
    else if (type === "MULTILINESTRING") parts = list(() => list(coord));
    else if (type === "MULTIPOLYGON") parts = list(() => list(() => list(coord)));
    else parts = list(geometry);
    return { type, dim, parts };
  };
  const g = geometry();
  if (i !== tok.length) throw new Error("Invalid WKT: trailing tokens");
  return g;
}

// ----------------------------------------------------------------------
// number formatting
// ----------------------------------------------------------------------

/** x = m * 2^e with integer m (BigInt), for finite non-zero x. */
function decompose(x) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = exp - 1075;
  }
  return { m, e };
}

/** round(|x| * 10^k) to an integer, ties to even (exact). */
function scaledRound(x, k) {
  const { m, e } = decompose(x);
  // |x| * 10^k = m * 2^e * 10^k = num / den
  let num = m;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den <<= BigInt(-e);
  if (k >= 0) num *= 10n ** BigInt(k);
  else den *= 10n ** BigInt(-k);
  const q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) return q + 1n;
  return q;
}

function trimFraction(intPart, frac) {
  const f = frac.replace(/0+$/, "");
  return f ? `${intPart}.${f}` : intPart;
}

/** Positional notation with `p` decimals (ties to even), trailing zeros trimmed. */
function fixed(x, p) {
  const n = scaledRound(x, p).toString().padStart(p + 1, "0");
  return trimFraction(n.slice(0, n.length - p), n.slice(n.length - p));
}

/** Scientific notation with `p` mantissa decimals (ties to even), trimmed. */
function scientific(x, p) {
  let E = Math.floor(Math.log10(Math.abs(x)));
  let M = scaledRound(x, p - E);
  const lo = 10n ** BigInt(p);
  if (M < lo) M = scaledRound(x, p - --E);
  else if (M >= lo * 10n) M = scaledRound(x, p - ++E);
  if (M >= lo * 10n) {
    M /= 10n;
    E++;
  }
  const s = M.toString();
  return `${trimFraction(s[0], s.slice(1))}e${E < 0 ? "-" : "+"}${Math.abs(E)}`;
}

/**
 * A coordinate as GEOS writes it: `precision` decimals (rounded, trimmed),
 * or with `precision < 0` the shortest round-trip digits.
 */
export function formatCoordinate(x, precision = -1) {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Inf" : "-Inf";
  if (x === 0) return "0";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e17 || a < 1e-4) {
    if (precision < 0) return sign + a.toExponential().replace(/\.?0*e/, "e");
    return sign + scientific(a, precision);
  }
  if (precision < 0) return sign + String(a);
  return sign + fixed(a, precision);
}

// ----------------------------------------------------------------------
// writing
// ----------------------------------------------------------------------

/** WKT text of a parsed geometry, numbers by `formatCoordinate`. */
export function writeWkt(g, precision = -1) {
  const num = (x) => formatCoordinate(x, precision);
  const pt = (c) => c.map(num).join(" ");
  const seq = (cs) => `(${cs.map(pt).join(", ")})`;
  const rings = (rs) => `(${rs.map(seq).join(", ")})`;
  const head = g.dim ? `${g.type} ${g.dim}` : g.type;
  if (g.parts === null) return `${head} EMPTY`;
  let body;
  switch (g.type) {
    case "POINT":
      body = `(${pt(g.parts)})`;
      break;
    case "LINESTRING":
      body = seq(g.parts);
      break;
    case "POLYGON":
    case "MULTILINESTRING":
      body = rings(g.parts);
      break;
    case "MULTIPOINT":
      body = `(${g.parts.map((c) => `(${pt(c)})`).join(", ")})`;
      break;
    case "MULTIPOLYGON":
      body = `(${g.parts.map(rings).join(", ")})`;
      break;
    default:
      body = `(${g.parts.map((p) => writeWkt(p, precision)).join(", ")})`;
  }
  return `${head} ${body}`;
}

/**
 * A WKT string in shapely's form: `precision < 0` keeps full precision
 * (`str(geometry)`), `precision >= 0` rounds (`GeoSeries.to_wkt()` uses 6).
 * Empty or non-string values pass through; invalid WKT raises.
 */
export function canonicalWkt(s, precision = -1) {
  if (typeof s !== "string" || s.trim() === "") return s;
  return writeWkt(parseWkt(s), precision);
}

// SPDX-License-Identifier: MIT
/**
 * Minimal Python pickle support for reading and writing PyTables/pandas HDF5
 * files: `pickleLoads` reads protocols 0-5 (the subset used for plain data
 * and numpy arrays), `pickleDumps` writes protocol 0 like Python does for
 * the attributes PyTables stores as pickled strings.
 *
 * Python values map to JS as: None -> null, bool -> boolean, int -> number
 * (BigInt beyond 2^53), float -> number, str -> string, bytes -> Uint8Array,
 * list -> Array, tuple -> PyTuple (an Array subclass), dict -> Map, numpy
 * arrays -> NdArray (shape, dtype, flat data).
 */

/** A Python tuple (an Array, told apart from a list when pickling). */
export class PyTuple extends Array {
  static of(...items) {
    const t = new PyTuple();
    t.push(...items);
    return t;
  }
}

export const tuple = (...items) => PyTuple.of(...items);

/** A reconstructed numpy array: `shape`, `dtype` (numpy's `str`, e.g. "|O", "<f8") and flat `data`. */
export class NdArray {
  constructor() {
    this.shape = [];
    this.dtype = null;
    this.data = [];
  }
}

class NpDtype {
  constructor(spec) {
    this.spec = spec;
    this.order = "|";
  }
  get str() {
    const m = /^([a-zA-Z])(\d*)$/.exec(this.spec);
    if (!m) return this.spec;
    return `${this.order}${m[1]}${m[2]}`;
  }
}

class PyGlobal {
  constructor(module, name) {
    this.module = module;
    this.name = name;
  }
  get qualname() {
    return `${this.module}.${this.name}`;
  }
}

const NP_RECONSTRUCT = new Set(["numpy.core.multiarray._reconstruct", "numpy._core.multiarray._reconstruct"]);
const NP_DTYPE = new Set(["numpy.dtype"]);
const NP_SCALAR = new Set(["numpy.core.multiarray.scalar", "numpy._core.multiarray.scalar"]);

function decodeRaw(bytes, dtype, count) {
  const m = /^([<>|=]?)([a-zA-Z])(\d*)$/.exec(dtype);
  if (!m) throw new Error(`pickle: unsupported numpy dtype ${dtype}`);
  const [, order, kind, sz] = m;
  const size = Number(sz);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = order !== ">";
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = i * size;
    if (kind === "f" && size === 8) out.push(view.getFloat64(o, le));
    else if (kind === "f" && size === 4) out.push(view.getFloat32(o, le));
    else if (kind === "i" && size === 8) out.push(Number(view.getBigInt64(o, le)));
    else if (kind === "i" && size === 4) out.push(view.getInt32(o, le));
    else if (kind === "u" && size === 8) out.push(Number(view.getBigUint64(o, le)));
    else if (kind === "u" && size === 4) out.push(view.getUint32(o, le));
    else if ((kind === "i" || kind === "u") && size === 1) out.push(kind === "i" ? view.getInt8(o) : view.getUint8(o));
    else if (kind === "b" && size === 1) out.push(view.getUint8(o) !== 0);
    else if (kind === "S") out.push(new TextDecoder("latin1").decode(bytes.subarray(o, o + size)).replace(/\0+$/, ""));
    else if (kind === "U") {
      let s = "";
      for (let k = 0; k < size; k++) {
        const cp = view.getUint32(o * 4 + k * 4, le);
        if (cp === 0) break;
        s += String.fromCodePoint(cp);
      }
      out.push(s);
    } else throw new Error(`pickle: unsupported numpy dtype ${dtype}`);
  }
  return out;
}

const MARK = Symbol("mark");

function callGlobal(fn, args) {
  if (!(fn instanceof PyGlobal)) throw new Error("pickle: REDUCE on a non-global");
  const q = fn.qualname;
  if (NP_RECONSTRUCT.has(q)) return new NdArray();
  if (NP_DTYPE.has(q)) return new NpDtype(args[0]);
  if (NP_SCALAR.has(q)) {
    const [dt, raw] = args;
    if (dt.spec === "O8") return raw;
    return decodeRaw(raw instanceof Uint8Array ? raw : latin1Bytes(raw), dt.str, 1)[0];
  }
  if (q === "numpy.core.numeric._frombuffer" || q === "numpy._core.numeric._frombuffer") {
    const [buf, dt, shape] = args;
    const arr = new NdArray();
    arr.shape = Array.from(shape);
    arr.dtype = dt.str;
    arr.data = decodeRaw(buf, arr.dtype, arr.shape.reduce((x, y) => x * y, 1));
    return arr;
  }
  if (q === "builtins.set" || q === "__builtin__.set" || q === "builtins.frozenset") return new Set(args[0] ?? []);
  if (q === "_codecs.encode") return latin1Bytes(args[0]);
  if (q === "builtins.bytearray" || q === "__builtin__.bytearray") return args.length ? latin1Bytes(args[0]) : new Uint8Array();
  if (q === "copy_reg._reconstructor" || q === "copyreg._reconstructor") return { __class__: args[0].qualname };
  throw new Error(`pickle: unsupported global ${q}`);
}

function build(obj, state) {
  if (obj instanceof NdArray) {
    // (version, shape, dtype, is_fortran, rawdata | list)
    const st = state.length === 5 ? state.slice(1) : state;
    const [shape, dtype, , raw] = st;
    obj.shape = Array.from(shape);
    obj.dtype = dtype.str;
    const count = obj.shape.reduce((a, b) => a * b, 1);
    if (Array.isArray(raw)) obj.data = raw.slice();
    else obj.data = decodeRaw(raw instanceof Uint8Array ? raw : latin1Bytes(raw), obj.dtype, count);
    return;
  }
  if (obj instanceof NpDtype) {
    if (state && state[1]) obj.order = state[1];
    return;
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj) && state instanceof Map) {
    for (const [k, v] of state) obj[k] = v;
    return;
  }
  throw new Error("pickle: unsupported BUILD");
}

const latin1Bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** `str(data, "raw-unicode-escape")`. */
function rawUnicodeEscape(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x5c && (bytes[i + 1] === 0x75 || bytes[i + 1] === 0x55)) {
      const n = bytes[i + 1] === 0x75 ? 4 : 8;
      const hex = String.fromCharCode(...bytes.subarray(i + 2, i + 2 + n));
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === n) {
        s += String.fromCodePoint(parseInt(hex, 16));
        i += 1 + n;
        continue;
      }
    }
    s += String.fromCharCode(b);
  }
  return s;
}

/** Python's `repr`-style string literal (protocol 0 STRING opcode). */
function unquote(lit) {
  const q = lit[0];
  const body = lit.slice(1, lit.lastIndexOf(q));
  return body.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_, e) => {
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v" }[e] ?? `\\${e}`;
  });
}

function toNumber(big) {
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

function decodeLong(bytes) {
  if (!bytes.length) return 0;
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  if (bytes[bytes.length - 1] & 0x80) v -= 1n << BigInt(8 * bytes.length);
  return toNumber(v);
}

/** Unpickle `bytes` (a Uint8Array or a latin-1 string). */
export function pickleLoads(input) {
  const bytes = typeof input === "string" ? latin1Bytes(input) : input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder("utf-8");
  let pos = 0;
  let stack = [];
  const metastack = [];
  const memo = new Map();
  const readLine = () => {
    const end = bytes.indexOf(0x0a, pos);
    const line = String.fromCharCode(...bytes.subarray(pos, end));
    pos = end + 1;
    return line;
  };
  const take = (n) => {
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const u8 = () => bytes[pos++];
  const u32 = () => {
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const u64 = () => {
    const v = Number(view.getBigUint64(pos, true));
    pos += 8;
    return v;
  };
  const popMark = () => {
    const items = stack;
    stack = metastack.pop();
    return items;
  };
  const top = () => stack[stack.length - 1];
  for (;;) {
    const op = String.fromCharCode(u8());
    switch (op) {
      case "\x80": // PROTO
        pos += 1;
        break;
      case "\x95": // FRAME
        pos += 8;
        break;
      case ".":
        return stack.pop();
      case "(":
        metastack.push(stack);
        stack = [];
        break;
      case "0":
        stack.pop();
        break;
      case "1":
        popMark();
        break;
      case "2":
        stack.push(top());
        break;
      case "N":
        stack.push(null);
        break;
      case "\x88":
        stack.push(true);
        break;
      case "\x89":
        stack.push(false);
        break;
      case "I": {
        const line = readLine();
        if (line === "01") stack.push(true);
        else if (line === "00") stack.push(false);
        else stack.push(toNumber(BigInt(line)));
        break;
      }
      case "L":
        stack.push(toNumber(BigInt(readLine().replace(/L$/, ""))));
        break;
      case "F":
        stack.push(Number(readLine()));
        break;
      case "J":
        stack.push(view.getInt32(pos, true));
        pos += 4;
        break;
      case "K":
        stack.push(u8());
        break;
      case "M":
        stack.push(view.getUint16(pos, true));
        pos += 2;
        break;
      case "\x8a": // LONG1
        stack.push(decodeLong(take(u8())));
        break;
      case "\x8b": // LONG4
        stack.push(decodeLong(take(u32())));
        break;
      case "G":
        stack.push(view.getFloat64(pos, false));
        pos += 8;
        break;
      case "S":
        stack.push(unquote(readLine()));
        break;
      case "T":
        stack.push(String.fromCharCode(...take(u32())));
        break;
      case "U":
        stack.push(String.fromCharCode(...take(u8())));
        break;
      case "V":
        stack.push(rawUnicodeEscape(latin1Bytes(readLine())));
        break;
      case "X":
        stack.push(utf8.decode(take(u32())));
        break;
      case "\x8c":
        stack.push(utf8.decode(take(u8())));
        break;
      case "\x8d":
        stack.push(utf8.decode(take(u64())));
        break;
      case "B":
        stack.push(take(u32()).slice());
        break;
      case "C":
        stack.push(take(u8()).slice());
        break;
      case "\x8e":
        stack.push(take(u64()).slice());
        break;
      case "\x96":
        stack.push(take(u64()).slice());
        break;
      case "\x98": // READONLY_BUFFER
        break;
      case "]":
        stack.push([]);
        break;
      case "l": {
        const items = popMark();
        stack.push(items);
        break;
      }
      case ")":
        stack.push(new PyTuple());
        break;
      case "t": {
        const items = popMark();
        stack.push(PyTuple.of(...items));
        break;
      }
      case "\x85":
        stack.push(PyTuple.of(stack.pop()));
        break;
      case "\x86": {
        const b = stack.pop();
        stack.push(PyTuple.of(stack.pop(), b));
        break;
      }
      case "\x87": {
        const c = stack.pop();
        const b = stack.pop();
        stack.push(PyTuple.of(stack.pop(), b, c));
        break;
      }
      case "}":
        stack.push(new Map());
        break;
      case "d": {
        const items = popMark();
        const m = new Map();
        for (let i = 0; i < items.length; i += 2) m.set(items[i], items[i + 1]);
        stack.push(m);
        break;
      }
      case "\x8f":
        stack.push(new Set());
        break;
      case "\x90": {
        const items = popMark();
        for (const x of items) top().add(x);
        break;
      }
      case "\x91": {
        const items = popMark();
        stack.push(new Set(items));
        break;
      }
      case "a": {
        const v = stack.pop();
        top().push(v);
        break;
      }
      case "e": {
        const items = popMark();
        top().push(...items);
        break;
      }
      case "s": {
        const v = stack.pop();
        const k = stack.pop();
        top().set(k, v);
        break;
      }
      case "u": {
        const items = popMark();
        for (let i = 0; i < items.length; i += 2) top().set(items[i], items[i + 1]);
        break;
      }
      case "p":
        memo.set(Number(readLine()), top());
        break;
      case "q":
        memo.set(u8(), top());
        break;
      case "r":
        memo.set(u32(), top());
        break;
      case "\x94":
        memo.set(memo.size, top());
        break;
      case "g":
        stack.push(memo.get(Number(readLine())));
        break;
      case "h":
        stack.push(memo.get(u8()));
        break;
      case "j":
        stack.push(memo.get(u32()));
        break;
      case "c": {
        const module = readLine();
        stack.push(new PyGlobal(module, readLine()));
        break;
      }
      case "\x93": {
        const name = stack.pop();
        stack.push(new PyGlobal(stack.pop(), name));
        break;
      }
      case "R": {
        const args = stack.pop();
        stack.push(callGlobal(stack.pop(), args));
        break;
      }
      case "\x81": {
        // NEWOBJ: cls.__new__(cls, *args)
        const args = stack.pop();
        stack.push(callGlobal(stack.pop(), args));
        break;
      }
      case "b": {
        const state = stack.pop();
        build(top(), state);
        break;
      }
      default:
        throw new Error(`pickle: unsupported opcode 0x${op.charCodeAt(0).toString(16)} at ${pos - 1}`);
    }
  }
}

/** `obj.encode("raw-unicode-escape")` after pickle's escapes, all non-ASCII as \uXXXX. */
function escapeUnicode(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x5c || cp === 0 || cp === 0x0a || cp === 0x0d || cp === 0x1a || cp > 0x7e) {
      out += cp > 0xffff ? `\\U${cp.toString(16).padStart(8, "0")}` : `\\u${cp.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

/** Python `repr(float)` (shortest round trip). */
function floatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`;
  const s = String(x);
  return s.replace(/e([+-])(\d)$/, "e$10$2");
}

/**
 * `pickle.dumps(obj, protocol=0)` for None, booleans, integers, floats
 * (`{float: x}` or a non-integer number), strings, Arrays (lists), PyTuples
 * and Maps / plain objects (dicts). The result is ASCII (non-ASCII
 * characters are \u-escaped, which Python reads back identically).
 */
export function pickleDumps(obj) {
  let out = "";
  let memo = 0;
  const put = () => {
    out += `p${memo++}\n`;
  };
  const save = (v) => {
    if (v === null || v === undefined) out += "N";
    else if (typeof v === "boolean") out += v ? "I01\n" : "I00\n";
    else if (typeof v === "bigint") out += v >= -(2n ** 31n) && v < 2n ** 31n ? `I${v}\n` : `L${v}L\n`;
    else if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) out += `I${v}\n`;
      else if (Number.isInteger(v) && Number.isSafeInteger(v)) out += `L${v}L\n`;
      else out += `F${floatRepr(v)}\n`;
    } else if (typeof v === "object" && "float" in v && Object.keys(v).length === 1) out += `F${floatRepr(v.float)}\n`;
    else if (typeof v === "string") {
      out += `V${escapeUnicode(v)}\n`;
      put();
    } else if (v instanceof PyTuple) {
      if (v.length === 0) {
        out += "(t";
        put();
        return;
      }
      out += "(";
      for (const x of v) save(x);
      out += "t";
      put();
    } else if (Array.isArray(v)) {
      out += "(l";
      put();
      for (const x of v) {
        save(x);
        out += "a";
      }
    } else if (v instanceof Map || typeof v === "object") {
      out += "(d";
      put();
      for (const [k, x] of v instanceof Map ? v : Object.entries(v)) {
        save(k);
        save(x);
        out += "s";
      }
    } else throw new Error(`pickle: cannot pickle ${typeof v}`);
  };
  save(obj);
  return `${out}.`;
}

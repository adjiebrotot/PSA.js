// SPDX-License-Identifier: MIT
/**
 * HDF5 import/export in PyPSA's layout (mirrors `_ImporterHDF5` /
 * `_ExporterHDF5` of `pypsa.network.io`, which go through
 * `pandas.HDFStore`), implemented with the optional `h5wasm` dependency.
 *
 * pandas stores every frame as a PyTables "table" (`/<key>/table`, a
 * compound dataset with an `index` column and `values_block_<k>` columns)
 * whose layout is described by attributes holding protocol-0 pickles
 * (`non_index_axes`, `values_cols`, `<block>_kind`, ...): `/network`,
 * `/snapshots`, `/investment_periods`, `/<list_name>` (static data, reset
 * index), `/<list_name>_t/<attr>` (time series, columns are positions in
 * the static index) and `/<list_name>_p/<attr>` (piecewise data stacked
 * to a (breakpoint, name, attribute) series). `/meta` and `/crs` are JSON
 * strings in pandas' fixed series format.
 *
 * h5wasm cannot write HDF5 array types, so PSA.js writes one column per
 * block (scalar members, as pandas does for data columns); pandas reads
 * either layout. `/meta` and `/crs` are written as fixed-length strings
 * instead of pickled object arrays (pandas reads both).
 */

import { DataFrame } from "../core/frame.js";
import { Index } from "../core/index.js";
import { Network } from "./network.js";
import { collectExport, importFromImporter, pyJsonDumps, pyJsonLoads, isUrl, retrieveFromUrl } from "./io.js";
import { getH5, withScratchFile, isBytes } from "./netcdf.js";
import { pickleLoads, pickleDumps, tuple, NdArray } from "../core/pickle.js";

// ----------------------------------------------------------------------
// strings: h5wasm decodes ASCII-tagged strings as windows-1252
// ----------------------------------------------------------------------

const CP1252 = new Map(
  [
    [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
    [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
    [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
    [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
  ],
);

/** The raw bytes behind a string h5wasm decoded as windows-1252. */
function rawBytes(s) {
  return Uint8Array.from(s, (ch) => {
    const c = ch.charCodeAt(0);
    return c < 0x100 ? c : (CP1252.get(c) ?? 0x3f);
  });
}

const utf8Decoder = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();
/** UTF-8 text stored in an ASCII-tagged string. */
const fromAscii = (s) => (/[^\x00-\x7f]/.test(s) ? utf8Decoder.decode(rawBytes(s)) : s);
const utf8Length = (s) => utf8Encoder.encode(s).length;

// ----------------------------------------------------------------------
// reading
// ----------------------------------------------------------------------

const STRING = 3; // H5T_STRING

/** Attributes of a node; pickled ones (ASCII strings ending in ".") unpickled. */
function readAttrs(obj) {
  const out = {};
  for (const [name, a] of Object.entries(obj.attrs)) {
    let v;
    try {
      v = a.value;
    } catch {
      continue; // types h5wasm cannot decode (PyTables' boolean enums)
    }
    const md = a.metadata;
    if (md.type === STRING && !md.vlen && md.cset === 0 && typeof v === "string") {
      if (v.endsWith(".") && v !== "0." && !/^FIELD_\d+_FILL$/.test(name)) {
        try {
          v = pickleLoads(rawBytes(v));
        } catch {
          v = fromAscii(v);
        }
      } else v = fromAscii(v);
    } else if (typeof v === "bigint") v = Number(v);
    else if (ArrayBuffer.isView(v) && v.length === 1) v = typeof v[0] === "bigint" ? Number(v[0]) : v[0];
    out[name] = v;
  }
  return out;
}

const DT_UNITS = { s: 1e3, ms: 1, us: 1e-3, ns: 1e-6 };

function fmtTimestamp(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** `DataCol.convert`: stored values -> JS values by pandas' dtype name. */
function convertValues(values, dtype, nanRep, isAsciiString) {
  const dt = String(dtype ?? "");
  if (dt.startsWith("datetime64")) {
    const unit = /\[(\w+)\]/.exec(dt)?.[1] ?? "ns";
    const big = BigInt(Math.round(1 / Math.min(DT_UNITS[unit] ?? 1e-6, 1)));
    return values.map((v) => {
      const b = BigInt(v);
      return fmtTimestamp(DT_UNITS[unit] >= 1 ? Number(b) * DT_UNITS[unit] : Number(b / big));
    });
  }
  if (dt.startsWith("float")) return Float64Array.from(values, Number);
  if (dt.startsWith("int") || dt.startsWith("uint")) return values.map(Number);
  if (dt === "bool") return values.map((v) => Boolean(Number(v)));
  if (dt.startsWith("bytes") || dt.startsWith("string") || dt === "str") {
    return values.map((v) => {
      const s = isAsciiString ? fromAscii(String(v)) : String(v);
      return s === nanRep ? NaN : s;
    });
  }
  throw new Error(`HDF5: unsupported column dtype '${dt}'`);
}

/** Columns of a compound dataset: Map member -> per-row values (arrays for array members). */
function readCompound(ds) {
  const members = ds.metadata.compound_type.members;
  const rows = ds.shape[0] === 0 ? [] : ds.value;
  const out = new Map();
  members.forEach((m, k) => {
    const isArray = m.type === 10; // H5T_ARRAY
    const base = isArray ? m.array_type : m;
    out.set(m.name, {
      rows: rows.map((r) => (isArray ? Array.from(r[k]) : ArrayBuffer.isView(r[k]) ? r[k][0] : r[k])),
      isArray,
      ascii: base.type === STRING && base.cset === 0,
    });
  });
  return out;
}

/** `AppendableFrameTable.read` (and the multi-index variants) of a pandas table group. */
function readTable(group) {
  const g = readAttrs(group);
  const ds = group.get("table");
  const t = readAttrs(ds);
  const cols = readCompound(ds);
  const nanRep = g.nan_rep ?? "nan";
  const info = g.info instanceof Map ? g.info : new Map();
  const [[, idxCol]] = g.index_cols;
  const idx = cols.get(idxCol);
  const idxKind = String(t[`${idxCol}_kind`] ?? "integer");
  const idxDtype = idxKind === "string" ? "bytes" : idxKind === "integer" ? "int64" : idxKind === "float" ? "float64" : idxKind;
  const index = Array.from(convertValues(idx.rows, idxDtype, null, idx.ascii));
  const indexName = info.get("index")?.get?.("index_name") ?? null;
  const data = new Map();
  const dtypes = {};
  for (const c of g.values_cols) {
    const names = t[`${c}_kind`];
    const dtype = t[`${c}_dtype`];
    const col = cols.get(c);
    names.forEach((nm, k) => {
      const vals = col.isArray ? col.rows.map((r) => r[k]) : col.rows;
      data.set(nm, convertValues(vals, dtype, nanRep, col.ascii));
      const dt = String(dtype);
      dtypes[nm] = dt.startsWith("float") ? "float" : dt.startsWith("int") || dt.startsWith("uint") ? "int" : dt === "bool" ? "bool" : "object";
    });
  }
  const order = g.non_index_axes?.[0]?.[1] ?? [...data.keys()];
  return { index, indexName, columns: Array.from(order), data, dtypes, levels: Array.isArray(g.levels) ? g.levels : null };
}

/** `SeriesFixed.read(...)[0]` of `/meta` and `/crs`. */
function readFixedFirst(group) {
  const ds = group.get("values");
  const md = ds.metadata;
  const v = ds.value;
  if (md.type !== STRING && Array.isArray(v) && v[0] instanceof Uint8Array) {
    // a PyTables VLArray of pickled objects (ObjectAtom)
    const obj = pickleLoads(v[0]);
    const first = obj instanceof NdArray ? obj.data[0] : Array.isArray(obj) ? obj[0] : obj;
    return first instanceof Uint8Array ? utf8Decoder.decode(first) : first;
  }
  const first = Array.isArray(v) || ArrayBuffer.isView(v) ? v[0] : v;
  return md.type === STRING && md.cset === 0 ? fromAscii(first) : first;
}

class ImporterHDF5 {
  constructor(file) {
    this.f = file;
    this.index = {};
    this.keys = new Set();
    const walk = (grp, prefix) => {
      for (const k of grp.keys()) {
        const obj = grp.get(k);
        if (!obj || obj.type !== "Group") continue;
        const path = `${prefix}/${k}`;
        if ("pandas_type" in obj.attrs) this.keys.add(path);
        walk(obj, path);
      }
    };
    walk(file, "");
  }

  _frame(key) {
    if (!this.keys.has(key)) return null;
    const t = readTable(this.f.get(key));
    const df = new DataFrame({
      index: new Index(t.index, t.indexName),
      columns: t.columns,
      data: Object.fromEntries(t.columns.map((c) => [c, t.data.get(c)])),
      dtypes: Object.fromEntries(t.columns.map((c) => [c, t.dtypes[c]])),
    });
    return df;
  }

  getAttributes() {
    const df = this._frame("/network");
    if (df === null) return {};
    const out = { [df.index.name ?? "index"]: df.index.at(0) };
    for (const c of df.columns) out[c] = df.col(c)[0];
    return out;
  }

  getMeta() {
    return this.keys.has("/meta") ? pyJsonLoads(readFixedFirst(this.f.get("/meta"))) : {};
  }

  getCrs() {
    return this.keys.has("/crs") ? pyJsonLoads(readFixedFirst(this.f.get("/crs"))) : {};
  }

  getSnapshots() {
    return this._frame("/snapshots");
  }

  getInvestmentPeriods() {
    return this._frame("/investment_periods");
  }

  getStatic(listName) {
    const df = this._frame(`/${listName}`);
    if (df === null) return null;
    const names = Array.from(df.col("name"), (v) => (typeof v === "number" && Number.isNaN(v) ? "nan" : String(v)));
    const cols = df.columns.values.filter((c) => c !== "name");
    const out = new DataFrame({
      index: new Index(names, "name"),
      columns: cols,
      data: Object.fromEntries(cols.map((c) => [c, df.col(c)])),
      dtypes: Object.fromEntries(cols.map((c) => [c, df.dtypes[c]])),
    });
    this.index[listName] = names;
    return out;
  }

  *getSeries(listName) {
    const prefix = `/${listName}_t/`;
    for (const key of this.keys) {
      if (!key.startsWith(prefix)) continue;
      const df = this._frame(key);
      const names = this.index[listName];
      const cols = df.columns.values.map((p) => names[p]);
      yield [
        key.slice(prefix.length),
        new DataFrame({
          index: new Index(df.index.values),
          columns: cols,
          data: Object.fromEntries(df.columns.values.map((p, j) => [cols[j], Float64Array.from(df.col(p), Number)])),
        }),
      ];
    }
  }

  *getPiecewise(listName) {
    const prefix = `/${listName}_p/`;
    for (const key of this.keys) {
      if (!key.startsWith(prefix)) continue;
      // series indexed by (breakpoint, name, attribute), unstacked to (name, attribute) columns
      const t = readTable(this.f.get(key));
      const [bpL, nameL, attrL] = t.levels;
      const valueCol = t.columns.find((c) => !t.levels.includes(c));
      const bp = t.data.get(bpL);
      const nm = t.data.get(nameL);
      const at = t.data.get(attrL);
      const vals = t.data.get(valueCol);
      const breakpoints = [...new Set(bp)].sort((a, b) => a - b);
      const tuples = [];
      const seen = new Map();
      for (let i = 0; i < bp.length; i++) {
        const k = `${nm[i]}\u0000${at[i]}`;
        if (!seen.has(k)) {
          const tup = [String(nm[i]), String(at[i])];
          seen.set(k, tup);
          tuples.push(tup);
        }
      }
      // unstacking several levels keeps the (name, attribute) pairs in order of appearance
      const data = new Map(tuples.map((tup) => [tup, new Float64Array(breakpoints.length).fill(NaN)]));
      for (let i = 0; i < bp.length; i++) data.get(seen.get(`${nm[i]}\u0000${at[i]}`))[breakpoints.indexOf(bp[i])] = Number(vals[i]);
      yield [key.slice(prefix.length), new DataFrame({ index: new Index(breakpoints, "breakpoint"), columns: new Index(tuples, ["name", "attribute"]), data })];
    }
  }
}

// ----------------------------------------------------------------------
// writing
// ----------------------------------------------------------------------

const TS_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const isNull = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

/**
 * A column to write: `{ dtype, data, h5 }` with pandas' dtype name, the
 * stored values and the HDF5 member type.
 */
function columnSpec(values, kind, nanRep = "nan") {
  if (kind === "float") return { dtype: "float64", h5: "<d", data: Float64Array.from(values, (v) => (isNull(v) ? NaN : Number(v))) };
  if (kind === "int") return { dtype: "int64", h5: "<q", data: BigInt64Array.from(values, (v) => BigInt(Math.trunc(Number(v)))) };
  if (kind === "bool") return { dtype: "bool", h5: "<B", data: Uint8Array.from(values, (v) => (v === true || v === 1 || v === "True" ? 1 : 0)) };
  if (kind === "datetime") {
    // datetime64[us]
    return {
      dtype: "datetime64[us]",
      h5: "<q",
      data: BigInt64Array.from(values, (v) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(String(v));
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
        const frac = m[7] ? Number(`0.${m[7]}`.slice(0, 8)) * 1e6 : 0;
        return BigInt(ms) * 1000n + BigInt(Math.round(frac));
      }),
    };
  }
  const strs = values.map((v) => (isNull(v) ? nanRep : String(v)));
  const size = Math.max(1, ...strs.map(utf8Length));
  return { dtype: `bytes${8 * size}`, h5: `A${size}`, data: strs };
}

/** The pandas dtype kind of a frame column. */
function columnKind(df, col) {
  const dt = df.dtypes?.[col];
  const arr = df.col(col);
  if (dt === "float" || dt === "float64" || arr instanceof Float64Array) return "float";
  if (dt === "int" || dt === "int64") return "int";
  if (dt === "bool") return "bool";
  const vals = Array.from(arr);
  if (vals.length && vals.every((v) => typeof v === "boolean")) return "bool";
  if (vals.length && vals.every((v) => typeof v === "number")) return vals.every(Number.isInteger) ? "int" : "float";
  return "str";
}

/** Kind of snapshot-like labels (timestamps, integers, floats or strings). */
function labelKind(values) {
  if (values.length && values.every((v) => typeof v === "string" && TS_RE.test(v))) return "datetime";
  if (values.length && values.every((v) => typeof v === "number")) return values.every(Number.isInteger) ? "int" : "float";
  return "str";
}

class HDFStoreWriter {
  constructor(file, { complevel = 4 } = {}) {
    this.f = file;
    this.complevel = complevel;
    this._str(file, "CLASS", "GROUP");
    this._str(file, "PYTABLES_FORMAT_VERSION", "2.1");
    this._str(file, "VERSION", "1.0");
  }

  _str(obj, name, s) {
    obj.create_attribute(name, s, null, `S${Math.max(1, utf8Length(s))}`);
  }

  _pickle(obj, name, v) {
    const p = pickleDumps(v);
    obj.create_attribute(name, p, null, `A${p.length}`);
  }

  _int(obj, name, v) {
    obj.create_attribute(name, BigInt64Array.of(BigInt(v)), [], "<q");
  }

  _group(key) {
    let grp = this.f;
    for (const part of key.split("/").filter(Boolean)) {
      if (!grp.keys().includes(part)) {
        grp = grp.create_group(part);
        this._str(grp, "CLASS", "GROUP");
        this._str(grp, "VERSION", "1.0");
      } else grp = grp.get(part);
    }
    return grp;
  }

  _pandasAttrs(grp, pandasType) {
    this._str(grp, "pandas_type", pandasType);
    this._str(grp, "pandas_version", "0.15.2");
    this._str(grp, "encoding", "UTF-8");
    this._str(grp, "errors", "strict");
  }

  /**
   * `HDFStore.put(key, frame, format="table", index=False)`. `index` is
   * `{ values, kind, name }`, `columns` a list of `{ name, ...columnSpec,
   * meta }`. With `levels` (a multi-index series) the columns are data
   * columns named after themselves.
   */
  table(key, index, columns, { levels = null } = {}) {
    const grp = this._group(key);
    const multi = levels !== null;
    this._pandasAttrs(grp, multi ? "series_table" : "frame_table");
    this._str(grp, "table_type", multi ? "appendable_multiseries" : "appendable_frame");
    const blocks = columns.map((c, k) => ({ ...c, cname: multi ? c.name : `values_block_${k}` }));
    this._pickle(grp, "index_cols", [tuple(0, "index")]);
    this._pickle(grp, "values_cols", blocks.map((b) => b.cname));
    this._pickle(grp, "non_index_axes", [tuple(1, columns.map((c) => c.name))]);
    this._pickle(grp, "data_columns", multi ? columns.map((c) => c.name) : []);
    const info = new Map([[1, new Map([["names", [null]], ["type", "Index"]])], ["index", new Map(index.name ? [["index_name", index.name]] : [])]]);
    for (const b of blocks) info.set(b.cname, new Map());
    this._pickle(grp, "info", info);
    this._str(grp, "nan_rep", "nan");
    if (multi) this._pickle(grp, "levels", levels);
    else this._int(grp, "levels", 1);

    const idx = columnSpec(index.values, index.kind);
    const dtype = [["index", idx.h5], ...blocks.map((b) => [b.cname, b.h5])];
    const data = new Map([["index", idx.data], ...blocks.map((b) => [b.cname, b.data])]);
    const n = index.values.length;
    const rowSize = dtype.reduce((s, [, t]) => s + (t === "<d" || t === "<q" ? 8 : t === "<B" ? 1 : Number(t.slice(1))), 0);
    const chunk = Math.max(1, Math.min(Math.floor(65536 / rowSize), Math.max(n, 1)));
    const ds = grp.create_dataset({
      name: "table",
      data,
      shape: [n],
      dtype,
      maxshape: [null],
      chunks: [chunk],
      ...(this.complevel ? { compression: "gzip", compression_opts: this.complevel } : {}),
    });
    this._str(ds, "CLASS", "TABLE");
    this._str(ds, "VERSION", "2.7");
    dtype.forEach(([name], i) => this._str(ds, `FIELD_${i}_NAME`, name));
    this._int(ds, "NROWS", n);
    this._str(ds, "index_kind", index.kind === "str" ? "string" : index.kind === "float" ? "float" : "integer");
    for (const b of blocks) {
      this._pickle(ds, `${b.cname}_kind`, [b.name]);
      this._str(ds, `${b.cname}_dtype`, b.dtype);
      if (b.meta) this._str(ds, `${b.cname}_meta`, b.meta);
      else this._pickle(ds, `${b.cname}_meta`, null);
    }
  }

  /** `HDFStore.put(key, pd.Series([text]))` (fixed format). */
  fixedString(key, text) {
    const grp = this._group(key);
    this._pandasAttrs(grp, "series");
    this._str(grp, "index_variety", "regular");
    this._pickle(grp, "name", null);
    const index = grp.create_dataset({ name: "index", data: BigInt64Array.of(0n), shape: [1], dtype: "<q" });
    this._str(index, "CLASS", "ARRAY");
    this._str(index, "VERSION", "2.4");
    this._str(index, "kind", "integer");
    this._pickle(index, "name", null);
    const values = grp.create_dataset({ name: "values", data: [text], shape: [1], dtype: `A${Math.max(1, utf8Length(text))}` });
    this._str(values, "CLASS", "ARRAY");
    this._str(values, "VERSION", "2.4");
  }
}

const rangeIndex = (n) => ({ values: Array.from({ length: n }, (_, i) => i), kind: "int", name: null });

function frameColumns(df, { strMeta = new Set() } = {}) {
  return df.columns.values.map((c) => {
    const kind = columnKind(df, c);
    return { name: c, ...columnSpec(Array.from(df.col(c)), kind), meta: kind === "str" && strMeta.has(c) ? "str" : null };
  });
}

async function exportToHDF5(n, path, { export_standard_types = false, complevel = 4 } = {}) {
  if (n.has_scenarios) throw new Error("NotImplementedError: Stochastic networks are not supported in the HDF5 exporter. Use netcdf instead.");
  const ex = collectExport(n, { export_standard_types });
  const h5 = await getH5();
  const f = new h5.File(path, "w");
  try {
    const w = new HDFStoreWriter(f, { complevel });
    // network attributes: one row indexed by the network name
    const attrCols = Object.entries(ex.attrs).map(([k, v]) => {
      const kind = typeof v === "boolean" ? "bool" : typeof v === "number" ? (Number.isInteger(v) && !k.startsWith("_objective") ? "int" : "float") : "str";
      return { name: k, ...columnSpec([v], kind), meta: kind === "str" ? "str" : null };
    });
    w.table("/network", { values: [ex.name], kind: "str", name: "name" }, attrCols);
    w.fixedString("/meta", pyJsonDumps(ex.meta));
    w.fixedString("/crs", pyJsonDumps(ex.crs));

    const sns = ex.snapshots;
    w.table(
      "/snapshots",
      rangeIndex(sns.index.length),
      sns.columns.values.map((c) => {
        const vals = Array.from(sns.col(c));
        const kind = c === "snapshot" || c === "timestep" || c === "period" ? labelKind(vals) : columnKind(sns, c);
        return { name: c, ...columnSpec(vals, kind), meta: kind === "str" ? "str" : null };
      }),
    );
    if (ex.periods) {
      w.table("/investment_periods", { values: ex.periods.index.values.map(Number), kind: "int", name: "period" }, frameColumns(ex.periods));
    }

    const positions = new Map();
    for (const { listName, df } of ex.statics) {
      const names = df.index.values.map(String);
      positions.set(listName, new Map(names.map((nm, i) => [nm, i])));
      const nameCol = { name: "name", ...columnSpec(names, "str"), meta: "str" };
      w.table(`/${listName}`, rangeIndex(names.length), [nameCol, ...frameColumns(df)]);
    }
    for (const { listName, attr, df } of ex.series) {
      const pos = positions.get(listName);
      const cols = df.columns.values.map((c) => ({ name: pos.get(String(c)), ...columnSpec(Array.from(df.col(c)), "float"), meta: null }));
      w.table(`/${listName}_t/${attr}`, rangeIndex(df.index.length), cols);
    }
    for (const { listName, attr, df } of ex.piecewise) {
      // df.stack(["name", "attribute"], future_stack=True)
      const bps = [];
      const nms = [];
      const ats = [];
      const vals = [];
      df.index.values.forEach((b, i) => {
        for (const t of df.columns.values) {
          bps.push(b);
          nms.push(String(t[0]));
          ats.push(String(t[1]));
          vals.push(Number(df.col(t)[i]));
        }
      });
      const bpKind = bps.every(Number.isInteger) ? "int" : "float";
      w.table(
        `/${listName}_p/${attr}`,
        rangeIndex(bps.length),
        [
          { name: "breakpoint", ...columnSpec(bps, bpKind), meta: null },
          { name: "name", ...columnSpec(nms, "str"), meta: "str" },
          { name: "attribute", ...columnSpec(ats, "str"), meta: "str" },
          { name: "values", ...columnSpec(vals, "float"), meta: null },
        ],
        { levels: ["breakpoint", "name", "attribute"] },
      );
    }
  } finally {
    f.close();
  }
}

Object.assign(Network.prototype, {
  /**
   * Import from an HDF5 store written by PyPSA (pandas/PyTables) or PSA.js
   * (async): a path, an http(s) URL, or the file's bytes.
   */
  async import_from_hdf5(path, { skip_time = false } = {}) {
    const h5 = await getH5();
    const read = (file) => {
      const f = new h5.File(String(file), "r");
      try {
        importFromImporter(this, new ImporterHDF5(f), skip_time);
      } finally {
        f.close();
      }
    };
    if (isUrl(path)) path = await retrieveFromUrl(path);
    if (isBytes(path)) await withScratchFile(path instanceof ArrayBuffer ? new Uint8Array(path) : path, read);
    else read(path);
    return this;
  },

  /**
   * Export to an HDF5 store readable by PyPSA (async). `complevel` is the
   * zlib level (pandas' default in PyPSA: 4). With `path` null the file's
   * bytes are returned.
   */
  async export_to_hdf5(path = null, opts = {}) {
    if (path === null) return withScratchFile(null, (file) => exportToHDF5(this, file, opts), { readBack: true });
    await exportToHDF5(this, String(path), opts);
    return path;
  },
});

/** `await Network.from_hdf5(path)` */
Network.from_hdf5 = async function fromHdf5(path, opts = {}) {
  const n = new Network(opts);
  await n.import_from_hdf5(path, opts);
  return n;
};

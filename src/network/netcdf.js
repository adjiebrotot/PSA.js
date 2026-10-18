// SPDX-License-Identifier: MIT
/**
 * netCDF (HDF5) import/export in PyPSA's layout (mirrors the netCDF
 * importer/exporter of `pypsa.network.io`), implemented with the optional
 * `h5wasm` dependency.
 *
 * Layout: global attributes `network_<attr>`, `crs` and `meta` (JSON);
 * `snapshots_<col>` over dimension `snapshots`; `investment_periods_<col>`;
 * static data `<list_name>_<attr>` over `<list_name>_i`; time series
 * `<list_name>_t_<attr>` over (`snapshots`, `<list_name>_t_<attr>_i`).
 * Datetimes follow the CF convention (`<unit> since <date>`), booleans are
 * stored as int8 with attribute `dtype="bool"` like xarray does.
 */

import { DataFrame } from "../core/frame.js";
import { Index } from "../core/index.js";
import { Network } from "./network.js";
import { collectExport, importFromImporter } from "./io.js";

let h5Promise = null;
async function getH5() {
  if (!h5Promise) {
    h5Promise = import("h5wasm/node")
      .catch(() => {
        throw new Error("netCDF support requires the optional dependency 'h5wasm' (npm install h5wasm).");
      })
      .then(async (m) => {
        const h5 = m.default ?? m;
        await h5.ready;
        return h5;
      });
  }
  return h5Promise;
}

// ----------------------------------------------------------------------
// datetime (CF) helpers
// ----------------------------------------------------------------------

const UNIT_MS = { seconds: 1e3, second: 1e3, s: 1e3, minutes: 6e4, minute: 6e4, min: 6e4, hours: 36e5, hour: 36e5, h: 36e5, days: 864e5, day: 864e5, d: 864e5 };
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

function parseTs(s) {
  const m = TS_RE.exec(String(s).trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

function fmtTs(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function decodeTimes(values, units) {
  const m = /^\s*(\w+)\s+since\s+(.+?)\s*$/.exec(units);
  const step = UNIT_MS[m[1].toLowerCase()];
  const t0 = parseTs(m[2]);
  if (!step || t0 === null) throw new Error(`Unsupported time units '${units}'`);
  return values.map((v) => fmtTs(t0 + Number(v) * step));
}

/** CF encoding of timestamp strings: [int values, units]. */
function encodeTimes(labels) {
  const ms = labels.map(parseTs);
  const t0 = ms[0];
  for (const [unit, step] of [
    ["days", 864e5],
    ["hours", 36e5],
    ["minutes", 6e4],
    ["seconds", 1e3],
  ]) {
    if (ms.every((t) => (t - t0) % step === 0)) return [ms.map((t) => (t - t0) / step), `${unit} since ${fmtTs(t0)}`];
  }
  return [ms.map((t) => (t - t0) / 1e3), `seconds since ${fmtTs(t0)}`];
}

function isTimestampArray(a) {
  return a.length > 0 && a.every((v) => typeof v === "string" && TS_RE.test(v));
}

// ----------------------------------------------------------------------
// importer
// ----------------------------------------------------------------------

function attrValue(a) {
  let v = a.value;
  if (typeof v === "bigint") v = Number(v);
  if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    const arr = Array.from(v, (x) => (typeof x === "bigint" ? Number(x) : x));
    return arr.length === 1 ? arr[0] : arr;
  }
  return v;
}

function readDataset(ds) {
  const attrs = {};
  for (const [k, a] of Object.entries(ds.attrs)) {
    if (k === "DIMENSION_LIST" || k === "REFERENCE_LIST") continue;
    try {
      attrs[k] = attrValue(a);
    } catch {
      // ignore attributes h5wasm cannot decode (object references)
    }
  }
  let value = ds.value;
  if (value instanceof BigInt64Array || value instanceof BigUint64Array) value = Array.from(value, Number);
  else if (ArrayBuffer.isView(value)) value = Array.from(value);
  else if (!Array.isArray(value)) value = [value];
  if (typeof attrs.units === "string" && /\ssince\s/.test(attrs.units)) value = decodeTimes(value, attrs.units);
  else if (attrs.dtype === "bool") value = value.map((x) => Boolean(x));
  return { shape: ds.shape, value, attrs, isScale: attrs.CLASS === "DIMENSION_SCALE" };
}

class ImporterNetCDF {
  constructor(file) {
    this.vars = new Map();
    for (const k of file.keys()) {
      const obj = file.get(k);
      if (obj && obj.shape !== undefined) this.vars.set(k, readDataset(obj));
    }
    this.attrs = {};
    for (const [k, a] of Object.entries(file.attrs)) this.attrs[k] = attrValue(a);
  }

  getAttributes() {
    const out = {};
    for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith("network_")) out[k.slice(8)] = v;
    return out;
  }

  getMeta() {
    return JSON.parse(this.attrs.meta ?? "{}");
  }

  getCrs() {
    return JSON.parse(this.attrs.crs ?? "{}");
  }

  getSnapshots() {
    return this.getStatic("snapshots", "snapshots");
  }

  getInvestmentPeriods() {
    return this.getStatic("investment_periods", "investment_periods");
  }

  /** Scenario weightings of stochastic networks (`scenario_weight`), or null. */
  getScenarios() {
    const w = this.vars.get("scenario_weight");
    if (!w) return null;
    const names = this.vars.get("scenario").value.map(String);
    return new DataFrame({ index: new Index(names, "scenario"), columns: ["weight"], data: { weight: Float64Array.from(w.value) } });
  }

  get _scenarios() {
    return this.vars.has("scenario_weight") ? this.vars.get("scenario").value.map(String) : null;
  }

  _isCoordinate(name) {
    const v = this.vars.get(name);
    return v.isScale || name.endsWith("_i");
  }

  getStatic(listName, indexName = null) {
    const idxName = indexName ?? `${listName}_i`;
    const idx = this.vars.get(idxName);
    if (!idx) return null;
    const t = `${listName}_`;
    const names = idx.value.map((x) => (typeof x === "number" || typeof x === "string" ? x : String(x)));
    // stochastic networks: (scenario, <list>_i) variables, stacked scenario-major
    // (sub-networks are not broadcast to the scenarios)
    let scenarios = indexName === null ? this._scenarios : null;
    if (scenarios) {
      const own = [...this.vars].filter(([name]) => name.startsWith(t) && !name.slice(t.length).startsWith("t_") && !name.slice(t.length).startsWith("pw_") && name !== idxName && !this._isCoordinate(name));
      if (own.length && own.every(([, v]) => v.shape.length === 1)) scenarios = null;
    }
    const index = scenarios ? new Index(scenarios.flatMap((sc) => names.map((nm) => [sc, nm])), ["scenario", "name"]) : new Index(names, "name");
    const df = new DataFrame({ index });
    for (const [name, v] of this.vars) {
      const rest = name.slice(t.length, t.length + 3);
      if (!name.startsWith(t) || rest.startsWith("t_") || rest === "pw_" || name === idxName || this._isCoordinate(name)) continue;
      const attr = name.slice(t.length);
      const vals = v.value;
      df.set(attr, vals.every((x) => typeof x === "number") ? Float64Array.from(vals) : vals.map((x) => (x === null ? "" : x)));
    }
    return df;
  }

  *getSeries(listName) {
    const t = `${listName}_t_`;
    for (const [name, v] of this.vars) {
      if (!name.startsWith(t) || this._isCoordinate(name)) continue;
      const attr = name.slice(t.length);
      const cols = this.vars.get(`${name}_i`)?.value ?? [];
      const nS = v.shape[0];
      const df = new DataFrame({ index: new Index(Array.from({ length: nS }, (_, i) => i)) });
      if (v.shape.length === 3) {
        // (snapshots, scenario, name): columns stacked over (scenario, name)
        const scenarios = this.vars.get("scenario").value.map(String);
        const [, nSc, nC] = v.shape;
        const tuples = [];
        const data = new Map();
        scenarios.forEach((sc, k) => {
          cols.forEach((c, j) => {
            const tup = [sc, String(c)];
            tuples.push(tup);
            data.set(tup, Float64Array.from({ length: nS }, (_, i) => v.value[(i * nSc + k) * nC + j]));
          });
        });
        yield [attr, new DataFrame({ index: df.index, columns: new Index(tuples, ["scenario", "name"]), data })];
        continue;
      }
      const nC = v.shape[1];
      cols.forEach((c, j) => {
        df.set(
          String(c),
          Float64Array.from({ length: nS }, (_, i) => v.value[i * nC + j]),
        );
      });
      yield [attr, df];
    }
  }

  *getPiecewise(listName) {
    const t = `${listName}_pw_`;
    for (const [name, v] of this.vars) {
      if (!name.startsWith(t) || this._isCoordinate(name)) continue;
      const names = this.vars.get(`${name}_i`)?.value ?? [];
      const attrs = this.vars.get(`${name}_attr_i`)?.value ?? [];
      const [nB, nN, nA] = v.shape;
      const bps = this.vars.get("breakpoint")?.value ?? Array.from({ length: nB }, (_, i) => i);
      const tuples = [];
      const data = new Map();
      for (let j = 0; j < nN; j++) {
        for (let a = 0; a < nA; a++) {
          const tup = [String(names[j]), String(attrs[a])];
          tuples.push(tup);
          data.set(tup, Float64Array.from({ length: nB }, (_, i) => v.value[(i * nN + j) * nA + a]));
        }
      }
      yield [name.slice(t.length), new DataFrame({ index: new Index(bps.slice(0, nB), "breakpoint"), columns: new Index(tuples, ["name", "attribute"]), data })];
    }
  }
}

// ----------------------------------------------------------------------
// exporter
// ----------------------------------------------------------------------

function typedFor(values, floatHint = false) {
  if (values.every((v) => typeof v === "boolean")) return { kind: "bool", data: Int8Array.from(values, (v) => (v ? 1 : 0)) };
  if (values.every((v) => typeof v === "number" || v === null)) {
    if (!floatHint && values.every((v) => Number.isInteger(v))) return { kind: "int", data: BigInt64Array.from(values, (v) => BigInt(v)) };
    return { kind: "float", data: Float64Array.from(values, (v) => (v === null ? NaN : v)) };
  }
  if (isTimestampArray(values)) {
    const [ints, units] = encodeTimes(values);
    return { kind: "time", data: BigInt64Array.from(ints, (v) => BigInt(Math.round(v))), units };
  }
  return { kind: "str", data: values.map((v) => (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? "" : String(v))) };
}

function isFloatCol(df, col) {
  const dt = df.dtypes?.[col];
  if (dt) return dt === "float" || dt === "float64";
  return df.col(col) instanceof Float64Array;
}

class NetCDFWriter {
  constructor(h5, file, { compression = 4 } = {}) {
    this.h5 = h5;
    this.f = file;
    this.compression = compression;
    this.dims = new Map();
  }

  _create(name, values, shape, floatHint = false) {
    const t = typedFor(values, floatHint);
    const opts = { name, data: t.data, shape };
    if (this.compression && t.kind !== "str" && t.data.length > 0) {
      opts.compression = "gzip";
      opts.compression_opts = this.compression;
      opts.chunks = shape;
    }
    const ds = this.f.create_dataset(opts);
    if (t.kind === "float") ds.create_attribute("_FillValue", Float64Array.of(NaN), [], "<d");
    if (t.kind === "bool") ds.create_attribute("dtype", "bool");
    if (t.kind === "time") {
      ds.create_attribute("units", t.units);
      ds.create_attribute("calendar", "proleptic_gregorian");
    }
    return ds;
  }

  dimension(name, values) {
    if (this.dims.has(name)) return;
    const ds = this._create(name, values, [values.length]);
    ds.make_scale(name);
    this.dims.set(name, values.length);
  }

  variable(name, dims, values, floatHint = false) {
    const shape = dims.map((d) => this.dims.get(d));
    const ds = this._create(name, values, shape, floatHint);
    dims.forEach((d, i) => ds.attach_scale(i, d));
  }
}

/** Write the network to a netCDF file at `path`. */
async function exportToNetCDF(n, path, { export_standard_types = false, compression = 4, float32 = false } = {}) {
  const h5 = await getH5();
  const ex = collectExport(n, { export_standard_types });
  const f = new h5.File(path, "w", { track_order: true });
  try {
    const attrs = { name: ex.name, ...ex.attrs };
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === "boolean") f.create_attribute(`network_${k}`, Int8Array.of(v ? 1 : 0), [], "<b");
      else if (typeof v === "number" && Number.isInteger(v) && !k.startsWith("_objective")) f.create_attribute(`network_${k}`, BigInt64Array.of(BigInt(v)), [], "<q");
      else if (typeof v === "number") f.create_attribute(`network_${k}`, Float64Array.of(v), [], "<d");
      else f.create_attribute(`network_${k}`, String(v));
    }
    f.create_attribute("crs", JSON.stringify(ex.crs));
    f.create_attribute("meta", JSON.stringify(ex.meta));
    const w = new NetCDFWriter(h5, f, { compression });
    const toFloat = (a) => (float32 ? Array.from(Float32Array.from(a)) : Array.from(a));

    w.dimension(
      "snapshots",
      ex.snapshots.index.values.map((i) => i),
    );
    for (const col of ex.snapshots.columns) w.variable(`snapshots_${col}`, ["snapshots"], Array.from(ex.snapshots.col(col)), isFloatCol(ex.snapshots, col));
    if (ex.periods) {
      w.dimension("investment_periods", ex.periods.index.values);
      for (const col of ex.periods.columns) w.variable(`investment_periods_${col}`, ["investment_periods"], Array.from(ex.periods.col(col)), true);
    }
    // stochastic networks: scenario coordinate and weights
    const scenarios = n.has_scenarios ? n.scenarios.values.map(String) : null;
    if (scenarios) {
      w.dimension("scenario", scenarios);
      w.variable("scenario_weight", ["scenario"], Array.from(n.scenario_weightings.col("weight")), true);
    }
    for (const { listName, df } of ex.statics) {
      const dim = `${listName}_i`;
      if (df.index.isMulti) {
        // `df.to_xarray()` over (scenario, name)
        const names = df.index.uniqueLevel("name").values.map(String);
        w.dimension(dim, names);
        const pos = df.index.values.map(([sc, nm]) => scenarios.indexOf(String(sc)) * names.length + names.indexOf(String(nm)));
        for (const col of df.columns) {
          const src = df.col(col);
          const numeric = src instanceof Float64Array;
          const grid = new Array(scenarios.length * names.length).fill(numeric ? NaN : "");
          pos.forEach((p, i) => (grid[p] = src[i]));
          w.variable(`${listName}_${col}`, ["scenario", dim], numeric ? toFloat(grid) : grid, isFloatCol(df, col));
        }
        continue;
      }
      w.dimension(dim, df.index.values.map(String));
      for (const col of df.columns) {
        let vals = Array.from(df.col(col));
        if (df.col(col) instanceof Float64Array) vals = toFloat(vals);
        w.variable(`${listName}_${col}`, [dim], vals, isFloatCol(df, col));
      }
    }
    for (const { listName, attr, df } of ex.series) {
      const name = `${listName}_t_${attr}`;
      if (df.columns.isMulti) {
        // sorted names on a (scenario, name) grid, aligned to the scenario coordinate
        const names = [...new Set(df.columns.values.map((t) => String(t[1])))].sort();
        w.dimension(`${name}_i`, names);
        const nS = df.index.length;
        const nSc = scenarios.length;
        const flat = new Array(nS * nSc * names.length).fill(NaN);
        for (const t of df.columns.values) {
          const k = scenarios.indexOf(String(t[0]));
          const j = names.indexOf(String(t[1]));
          const a = df.col(t);
          for (let i = 0; i < nS; i++) flat[(i * nSc + k) * names.length + j] = Number(a[i]);
        }
        w.variable(name, ["snapshots", "scenario", `${name}_i`], float32 ? Array.from(Float32Array.from(flat)) : flat, true);
        continue;
      }
      w.dimension(`${name}_i`, df.columns.values.map(String));
      const nS = df.index.length;
      const cols = df.columns.values;
      const flat = new Array(nS * cols.length);
      cols.forEach((c, j) => {
        const a = df.col(c);
        for (let i = 0; i < nS; i++) flat[i * cols.length + j] = Number(a[i]);
      });
      w.variable(name, ["snapshots", `${name}_i`], float32 ? Array.from(Float32Array.from(flat)) : flat, true);
    }
    // piecewise data share one "breakpoint" dimension; shorter frames are
    // padded with NaN rows (dropped again on import)
    if (ex.piecewise.length) {
      const nB = Math.max(...ex.piecewise.map(({ df }) => df.index.length));
      w.dimension(
        "breakpoint",
        Array.from({ length: nB }, (_, i) => i),
      );
      for (const { listName, attr, df } of ex.piecewise) {
        const name = `${listName}_pw_${attr}`;
        const names = df.columns.uniqueLevel("name").values.map(String);
        const attrs = df.columns.uniqueLevel("attribute").values.map(String);
        w.dimension(`${name}_i`, names);
        w.dimension(`${name}_attr_i`, attrs);
        const flat = new Array(nB * names.length * attrs.length).fill(NaN);
        names.forEach((nm, j) => {
          attrs.forEach((a, k) => {
            if (!df.has([nm, a])) return;
            const col = df.col([nm, a]);
            for (let i = 0; i < df.index.length; i++) flat[(i * names.length + j) * attrs.length + k] = Number(col[i]);
          });
        });
        w.variable(name, ["breakpoint", `${name}_i`, `${name}_attr_i`], float32 ? Array.from(Float32Array.from(flat)) : flat, true);
      }
    }
  } finally {
    f.close();
  }
}

Object.assign(Network.prototype, {
  /** Import from a netCDF file written by PyPSA or PSA.js (async). */
  async import_from_netcdf(path, { skip_time = false } = {}) {
    const h5 = await getH5();
    const f = new h5.File(String(path), "r");
    try {
      importFromImporter(this, new ImporterNetCDF(f), skip_time);
    } finally {
      f.close();
    }
    return this;
  },

  /** Export to a netCDF file readable by PyPSA / xarray (async). */
  async export_to_netcdf(path, opts = {}) {
    await exportToNetCDF(this, String(path), opts);
    return path;
  },
});

/** `await Network.from_netcdf(path)` */
Network.from_netcdf = async function fromNetcdf(path, opts = {}) {
  const n = new Network(opts);
  await n.import_from_netcdf(path, opts);
  return n;
};

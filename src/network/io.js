// SPDX-License-Identifier: MIT
/**
 * Import/export of networks as folders of CSV files
 * (mirrors `pypsa.network.io` CSV importer/exporter).
 */

import { readCSV, writeCSV, readCSVMulti, writeCSVMulti } from "../core/csv.js";
import { importPiecewiseFromDf } from "../components/piecewise.js";
import { DataFrame } from "../core/frame.js";
import { Index } from "../core/index.js";
import { Network, updatePortsComponentAttrs } from "./network.js";
import { logger } from "../logger.js";
import { PYPSA_VERSION } from "../components/types.js";

export { PYPSA_VERSION };

export const DEFAULT_CRS_WKT =
  'GEOGCRS["WGS 84",ENSEMBLE["World Geodetic System 1984 ensemble",MEMBER["World Geodetic System 1984 (Transit)"],MEMBER["World Geodetic System 1984 (G730)"],MEMBER["World Geodetic System 1984 (G873)"],MEMBER["World Geodetic System 1984 (G1150)"],MEMBER["World Geodetic System 1984 (G1674)"],MEMBER["World Geodetic System 1984 (G1762)"],MEMBER["World Geodetic System 1984 (G2139)"],MEMBER["World Geodetic System 1984 (G2296)"],ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]],ENSEMBLEACCURACY[2.0]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],CS[ellipsoidal,2],AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],USAGE[SCOPE["Horizontal component of 3D system."],AREA["World."],BBOX[-90,-180,90,180]],ID["EPSG",4326]]';

/**
 * JSON text like Python's `json.dumps` (", " / ": " separators, ASCII
 * escapes), so exported metadata files match PyPSA byte for byte.
 */
export function pyJsonDumps(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(", ")}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${pyJsonDumps(String(k))}: ${pyJsonDumps(x)}`)
    .join(", ")}}`;
}

// ----------------------------------------------------------------------
// Folder abstractions
// ----------------------------------------------------------------------

function nodeFs() {
  const getBuiltin = globalThis.process?.getBuiltinModule;
  if (!getBuiltin) throw new Error("File system access requires Node.js >= 22.3; use a MemoryFolder instead.");
  return { fs: getBuiltin("node:fs"), path: getBuiltin("node:path") };
}

/** Folder on the local file system (Node.js). */
export class NodeFolder {
  constructor(dir) {
    this.dir = dir;
    const { fs, path } = nodeFs();
    this.fs = fs;
    this.path = path;
  }

  exists() {
    return this.fs.existsSync(this.dir) && this.fs.statSync(this.dir).isDirectory();
  }

  mkdir() {
    this.fs.mkdirSync(this.dir, { recursive: true });
  }

  list() {
    return this.fs.readdirSync(this.dir);
  }

  has(name) {
    return this.fs.existsSync(this.path.join(this.dir, name));
  }

  read(name) {
    return this.fs.readFileSync(this.path.join(this.dir, name), "utf8");
  }

  write(name, text) {
    this.fs.writeFileSync(this.path.join(this.dir, name), text);
  }

  remove(name) {
    const p = this.path.join(this.dir, name);
    if (this.fs.existsSync(p)) this.fs.unlinkSync(p);
  }

  get basename() {
    return this.path.basename(this.dir);
  }
}

/** In-memory folder: a Map of file name -> text (works in browsers). */
export class MemoryFolder {
  constructor(files = {}) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
  }

  exists() {
    return true;
  }

  mkdir() {}

  list() {
    return [...this.files.keys()];
  }

  has(name) {
    return this.files.has(name);
  }

  read(name) {
    return this.files.get(name);
  }

  write(name, text) {
    this.files.set(name, text);
  }

  remove(name) {
    this.files.delete(name);
  }

  get basename() {
    return "";
  }

  toObject() {
    return Object.fromEntries(this.files);
  }
}

function asFolder(pathOrFolder) {
  if (typeof pathOrFolder === "string") return new NodeFolder(pathOrFolder);
  if (pathOrFolder instanceof Map || (pathOrFolder && !pathOrFolder.read && typeof pathOrFolder === "object")) {
    return new MemoryFolder(pathOrFolder);
  }
  return pathOrFolder;
}

// ----------------------------------------------------------------------
// Importer
// ----------------------------------------------------------------------

class ImporterCSV {
  constructor(folder) {
    this.folder = folder;
    if (!folder.exists()) throw new Error(`Directory ${folder.dir ?? ""} does not exist.`);
  }

  getAttributes() {
    if (!this.folder.has("network.csv")) return null;
    const df = readCSV(this.folder.read("network.csv"), { indexCol: null, dtypes: { pypsa_version: "str", name: "str" } });
    if (df.index.length === 0) return {};
    return df.row(0);
  }

  getMeta() {
    return this.folder.has("meta.json") ? JSON.parse(this.folder.read("meta.json")) : {};
  }

  getCrs() {
    return this.folder.has("crs.json") ? JSON.parse(this.folder.read("crs.json")) : {};
  }

  getSnapshots() {
    if (!this.folder.has("snapshots.csv")) return null;
    return readCSV(this.folder.read("snapshots.csv"), { indexCol: 0 });
  }

  getInvestmentPeriods() {
    if (!this.folder.has("investment_periods.csv")) return null;
    return readCSV(this.folder.read("investment_periods.csv"), { indexCol: 0 });
  }

  getStatic(listName) {
    const fn = `${listName}.csv`;
    if (!this.folder.has(fn)) return null;
    const df = readCSV(this.folder.read(fn), { indexCol: 0, indexAsStr: true });
    for (const col of df.columns) {
      if (df.dtypes[col] === "object") {
        df.set(
          col,
          df.col(col).map((v) => (typeof v === "number" && Number.isNaN(v) ? "" : v)),
        );
      }
    }
    return df;
  }

  *getSeries(listName) {
    for (const fn of this.folder.list()) {
      if (fn.startsWith(`${listName}-`) && fn.endsWith(".csv") && !fn.endsWith("-pw.csv")) {
        const attr = fn.slice(listName.length + 1, -4);
        yield [attr, readCSV(this.folder.read(fn), { indexCol: 0 })];
      }
    }
  }

  *getPiecewise(listName) {
    for (const fn of this.folder.list()) {
      if (fn.startsWith(`${listName}-`) && fn.endsWith("-pw.csv") && fn.length > listName.length + 8) {
        const attr = fn.slice(listName.length + 1, -7);
        yield [attr, readCSVMulti(this.folder.read(fn))];
      }
    }
  }
}

function snapshotLabel(v) {
  return typeof v === "number" && Number.isNaN(v) ? "" : v;
}

/**
 * Import network data from an importer into `n`
 * (mirrors `NetworkIOMixin._import_from_importer`).
 */
function importFromImporter(n, importer, skipTime = false) {
  n._meta = importer.getMeta();
  const crs = importer.getCrs();
  if (crs._crs !== undefined && crs._crs !== null) {
    const m = /ID\["EPSG",(\d+)\]\]$/.exec(crs._crs);
    n._crs = { _crs: crs._crs, epsg: m ? Number(m[1]) : null };
  }
  const attrs = importer.getAttributes() || {};
  if ("name" in attrs) {
    const name = attrs.name;
    delete attrs.name;
    if (!(typeof name === "number" && Number.isNaN(name))) n.name = name;
  }
  let version = "0.0.0";
  if ("pypsa_version" in attrs) {
    version = String(attrs.pypsa_version);
    delete attrs.pypsa_version;
  }
  for (const [attr, val] of Object.entries(attrs)) {
    if (attr === "model" || attr === "objective" || attr === "objective_constant") n[`_${attr}`] = val;
    else if (attr === "srid") n.srid = val;
    else n[attr] = val;
    if (attr === "_linearized_uc") n._linearizedUcSet = true;
  }
  if (compareVersions(version, PYPSA_VERSION) < 0) {
    logger.info(
      `Importing network from PyPSA version v${version} while the mirrored version is v${PYPSA_VERSION}.`,
    );
  }
  if (compareVersions(version, "0.18.0") < 0) n._multi_invest = 0;

  const sdf = importer.getSnapshots();
  if (sdf !== null) {
    const levels = ["period", "timestep", "snapshot"].filter((l) => sdf.has(l)).sort();
    let index;
    if (levels.length === 2) {
      const a = sdf.col(levels[0]);
      const b = sdf.col(levels[1]);
      index = new Index(
        Array.from(a, (v, i) => [v, snapshotLabel(b[i])]),
        ["period", "timestep"],
      );
    } else if (levels.length === 1) {
      index = new Index(Array.from(sdf.col(levels[0]), snapshotLabel), "snapshot");
    } else {
      index = new Index(sdf.index.values, "snapshot");
    }
    n.set_snapshots(index);
    const cols = ["objective", "stores", "generators"].filter((c) => sdf.has(c));
    if (cols.length) {
      const w = new DataFrame({ index: n.snapshots });
      for (const c of cols) w.set(c, Float64Array.from(sdf.col(c)));
      n._snapshots_data = w;
    } else if (sdf.has("weightings")) {
      n.snapshot_weightings = Array.from(sdf.col("weightings"));
    }
  }

  const periods = importer.getInvestmentPeriods();
  if (periods !== null && periods.index.length > 0) {
    n.periods = periods.index.values;
    n._investment_periods_data = periods.reindex({ index: n.investment_periods });
  }

  const scenarios = typeof importer.getScenarios === "function" ? importer.getScenarios() : null;
  if (scenarios !== null) n.set_scenarios(scenarios);

  const imported = [];
  const others = [...n.all_components].filter((c) => c !== "Bus" && c !== "Carrier").sort();
  for (const component of ["Bus", "Carrier", ...others]) {
    const listName = n.c.get(component).list_name;
    const df = importer.getStatic(listName);
    if (df === null) {
      if (component === "Bus") {
        logger.error("Error, no buses found");
        return;
      }
      continue;
    }
    if (component === "Link" || component === "Process") updatePortsComponentAttrs(n, df.columns.values, component);
    n._import_components_from_df(df, component);
    if (!skipTime) {
      for (const [attr, sdf2] of importer.getSeries(listName)) {
        if (sdf2.index.length !== n.snapshots.length) {
          throw new Error(`Length of ${listName}-${attr} does not match the number of snapshots.`);
        }
        sdf2.index = n.snapshots;
        n._import_series_from_df(sdf2, component, attr);
      }
    }
    if (typeof importer.getPiecewise === "function") {
      for (const [attr, pdf] of importer.getPiecewise(listName)) importPiecewiseFromDf(n, pdf, component, attr);
    }
    imported.push(listName);
  }
  logger.info(`Imported network '${n.name}' has ${imported.join(", ")}`);
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// ----------------------------------------------------------------------
// Exporter
// ----------------------------------------------------------------------

function isNull(v) {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

function valuesEqual(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b) && false);
  return a === b;
}

/**
 * Collect the data PyPSA's exporters write (network attributes, CRS, meta,
 * snapshots, investment periods, non-default static columns and time series)
 * (mirrors `NetworkIOMixin._export_to_exporter`).
 */
export function collectExport(n, { export_standard_types = false } = {}) {
  // network attributes (python `dir()` order: sorted)
  const attrs = {};
  const candidates = {
    _linearized_uc: n._linearized_uc,
    _multi_invest: n._multi_invest,
    _objective: n._objective,
    _objective_constant: n._objective_constant,
    _committable_big_m: n._committable_big_m,
    iteration: n._iterationSet ? n.iteration : undefined,
    now: n.now,
    pypsa_version: PYPSA_VERSION,
    srid: n.srid,
  };
  for (const k of Object.keys(candidates).sort()) {
    const v = candidates[k];
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") attrs[k] = v;
  }
  if (!n._linearizedUcSet) delete attrs._linearized_uc;

  const crsWkt = n._crs._crs ?? (n.srid === 4326 ? DEFAULT_CRS_WKT : null);
  const crs = crsWkt === null ? {} : { _crs: crsWkt };

  // snapshots (snapshot_weightings.reset_index())
  const sw = n.snapshot_weightings;
  const snsCols = n.snapshots.isMulti ? ["period", "timestep"] : ["snapshot"];
  const snsData = new Map();
  const dt = {};
  if (n.snapshots.isMulti) {
    snsData.set("period", n.snapshots.values.map((t) => t[0]));
    snsData.set("timestep", n.snapshots.values.map((t) => t[1]));
  } else snsData.set("snapshot", n.snapshots.values.slice());
  for (const c of sw.columns) {
    snsData.set(c, sw.col(c));
    dt[c] = "float";
  }
  const snapshots = new DataFrame({
    index: new Index(Array.from({ length: n.snapshots.length }, (_, i) => i)),
    columns: [...snsCols, ...sw.columns.values],
    data: snsData,
    dtypes: dt,
  });

  let periods = null;
  if (n.has_periods) {
    periods = n.investment_period_weightings.copy();
    for (const c of periods.columns) periods.dtypes[c] = "float";
  }

  const statics = [];
  const series = [];
  const piecewise = [];
  const removed = [];
  for (const component of [...n.all_components].sort()) {
    const c = n.c.get(component);
    const listName = c.list_name;
    const defaults = c.defaults;
    let st = c.static;
    if (!export_standard_types && n.standard_type_components.has(component)) {
      if (st.index.isMulti) {
        // `static.drop(standard_types.index, level="name")`
        const std = c.standard_types.index;
        st = st.takeRows(st.index.values.map((t, i) => [t[1], i]).filter(([nm]) => !std.has(nm)).map(([, i]) => i));
      } else st = st.dropRows(c.standard_types.index);
    }
    const colExport = [];
    for (const col of st.columns) {
      if (col === "g_pu" || col === "b_pu") continue;
      const def = defaults.get(col);
      const arr = st.col(col);
      if (def && isNull(def.default) && Array.from(arr).every(isNull)) continue;
      if (def) {
        const want = def.typ === "str" ? "object" : def.typ === "bool" ? "bool" : def.typ;
        const have = st.dtypes[col] ?? (arr instanceof Float64Array ? "float" : "object");
        if (have === want && Array.from(arr).every((v) => valuesEqual(v, def.default))) continue;
      }
      colExport.push(col);
    }
    if (st.index.length === 0) {
      removed.push({ listName, attr: null });
      continue;
    }
    const out = st.loc(null, colExport);
    if (colExport.includes("obj") && component === "SubNetwork") out.set("obj", new Float64Array(out.index.length).fill(NaN));
    out.index = new Index(out.index.values, out.index.isMulti ? ["scenario", "name"] : "name");
    statics.push({ component, listName, df: out });

    for (const [attr, df] of Object.entries(c.dynamic)) {
      const def = defaults.get(attr);
      let cols;
      if (!def) cols = df.columns.values;
      else if (isNull(def.default)) cols = df.columns.values.filter((cc) => Array.from(df.col(cc)).some((v) => !isNull(v)));
      else cols = df.columns.values.filter((cc) => Array.from(df.col(cc)).some((v) => v !== def.default));
      if (cols.length > 0 && df.index.length > 0) {
        const sdf = df.loc(null, cols);
        if (df.columns.isMulti) sdf.columns = new Index(sdf.columns.values, df.columns.names);
        sdf.index = new Index(Array.from({ length: df.index.length }, (_, i) => i));
        for (const cc of cols) sdf.dtypes[cc] = "float";
        series.push({ listName, attr, df: sdf });
      } else {
        removed.push({ listName, attr });
      }
    }

    for (const [attr, df] of Object.entries(c.piecewise)) {
      if (!df.empty) piecewise.push({ listName, attr, df });
      else removed.push({ listName, attr, piecewise: true });
    }
  }
  return { name: n.name, attrs, crs, meta: n.meta, snapshots, periods, statics, series, piecewise, removed };
}

function exportToFolder(n, folder, { export_standard_types = false } = {}) {
  if (n.has_scenarios) throw new Error("NotImplementedError: Stochastic networks are not supported in the CSV exporter. Use netcdf instead.");
  if (!folder.exists()) {
    logger.warning(`Directory ${folder.dir ?? ""} does not exist, creating it`);
    folder.mkdir();
  }
  const ex = collectExport(n, { export_standard_types });
  const netDf = new DataFrame({
    index: new Index([ex.name], "name"),
    columns: Object.keys(ex.attrs),
    data: Object.fromEntries(Object.entries(ex.attrs).map(([k, v]) => [k, [v]])),
    dtypes: Object.fromEntries(
      Object.entries(ex.attrs).map(([k, v]) => [k, typeof v === "number" ? (Number.isInteger(v) && !k.startsWith("_objective") ? "int" : "float") : "object"]),
    ),
  });
  folder.write("network.csv", writeCSV(netDf));
  folder.write("crs.json", pyJsonDumps(ex.crs));
  folder.write("meta.json", pyJsonDumps(ex.meta));
  folder.write("snapshots.csv", writeCSV(ex.snapshots));
  if (ex.periods) folder.write("investment_periods.csv", writeCSV(ex.periods));
  const seriesBy = new Map();
  for (const s of ex.series) {
    if (!seriesBy.has(s.listName)) seriesBy.set(s.listName, []);
    seriesBy.get(s.listName).push(s);
  }
  for (const { listName, df } of ex.statics) {
    folder.write(`${listName}.csv`, writeCSV(df));
    for (const { attr, df: sdf } of seriesBy.get(listName) ?? []) folder.write(`${listName}-${attr}.csv`, writeCSV(sdf));
  }
  for (const { listName, attr, df } of ex.piecewise) folder.write(`${listName}-${attr}-pw.csv`, writeCSVMulti(df));
  for (const { listName, attr, piecewise } of ex.removed) {
    if (attr !== null) folder.remove(piecewise ? `${listName}-${attr}-pw.csv` : `${listName}-${attr}.csv`);
  }
  logger.info(`Exported network '${n.name}' contains: ${ex.statics.map((s) => s.listName).join(", ")}`);
}

// ----------------------------------------------------------------------
// Network methods
// ----------------------------------------------------------------------

Object.assign(Network.prototype, {
  /**
   * Import from a CSV folder (path on disk or in-memory {filename: text} map).
   */
  import_from_csv_folder(path, { skip_time = false } = {}) {
    const folder = asFolder(path);
    importFromImporter(this, new ImporterCSV(folder), skip_time);
    return this;
  },

  /**
   * Export to a CSV folder (path on disk or MemoryFolder). Returns the folder.
   */
  export_to_csv_folder(path = null, { export_standard_types = false } = {}) {
    const folder = path === null ? new MemoryFolder() : asFolder(path);
    exportToFolder(this, folder, { export_standard_types });
    return folder;
  },
});

/** Convenience loader: `Network.from_csv_folder(path)`. */
Network.from_csv_folder = function fromCsvFolder(path, opts = {}) {
  const n = new Network(opts);
  n.import_from_csv_folder(path, opts);
  return n;
};

export { asFolder, importFromImporter };

// SPDX-License-Identifier: MIT
/**
 * Excel import and export (mirrors PyPSA's `_ImporterExcel` / `_ExporterExcel`):
 * one sheet per component (`generators`), per time series (`generators-p_set`)
 * and per piecewise attribute (`generators-marginal_cost-pw`, stacked), plus
 * `network`, `meta`, `crs`, `snapshots` and `investment_periods`, laid out
 * like `pandas.DataFrame.to_excel`. Sheets are read back with pandas'
 * `read_excel` semantics: cell values go through the same type inference
 * as the CSV importer (`readCSV`), dates become snapshot labels.
 *
 * The xlsx files are plain SpreadsheetML in a ZIP archive (inline strings,
 * one date style), readable by Excel, openpyxl and calamine.
 */

import { Network } from "./network.js";
import { Index } from "../core/index.js";
import { DataFrame } from "../core/frame.js";
import { readCSV, pyFloatRepr } from "../core/csv.js";
import { readZip, writeZip, zipText } from "../core/zip.js";
import { collectExport, importFromImporter, pyJsonDumps, isUrl } from "./io.js";
import { logger } from "../logger.js";

const fs = globalThis.process?.getBuiltinModule?.("node:fs") ?? null;

// ----------------------------------------------------------------------
// sheet names (Excel's 31-character limit, PyPSA's built-in short names)
// ----------------------------------------------------------------------

const SHEET_NAME_MAP = {
  "storage_units-state_of_charge_set": "storage_units-soc_set",
  "storage_units-efficiency_dispatch": "storage_units-eff_dispatch",
  "generators-marginal_cost_piecewise": "generators-marginal_cost_pw",
  "generators-capital_cost_piecewise": "generators-capital_cost_pw",
  "processes-capital_cost_piecewise": "processes-capital_cost_pw",
  "processes-marginal_cost_piecewise": "processes-marginal_cost_pw",
  "storage_units-capital_cost_piecewise": "storage_units-capital_cost_pw",
  "storage_units-marginal_cost_piecewise": "storage_units-marginal_cost_pw",
  "transformers-capital_cost_piecewise": "transformers-capital_cost_pw",
};

/** `_get_safe_excel_sheet_name`: long <-> short names (both directions). */
export function safeSheetName(name) {
  if (name in SHEET_NAME_MAP) return SHEET_NAME_MAP[name];
  for (const [long, short] of Object.entries(SHEET_NAME_MAP)) if (name === short) return long;
  return name;
}

// ----------------------------------------------------------------------
// cells, dates and XML
// ----------------------------------------------------------------------

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY = 864e5;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

/** A date cell: `{date: ms since 1970}`. */
function dateCell(label) {
  const m = DATETIME_RE.exec(label);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0);
  return { date: ms };
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (x, k = 2) => String(x).padStart(k, "0");
  let s = `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  if (d.getUTCMilliseconds()) s += `.${p(d.getUTCMilliseconds(), 3)}000`;
  return s;
}

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function colName(j) {
  let s = "";
  for (let k = j + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

function colIndex(ref) {
  let j = 0;
  for (const ch of ref.replace(/\d+$/, "")) j = j * 26 + (ch.charCodeAt(0) - 64);
  return j - 1;
}

// ----------------------------------------------------------------------
// workbook writing
// ----------------------------------------------------------------------

function cellXml(ref, v) {
  if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) || v === "") return "";
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "number") {
    // pandas writes infinities as the strings "inf" / "-inf" (inf_rep)
    if (!Number.isFinite(v)) return cellXml(ref, v > 0 ? "inf" : "-inf");
    return `<c r="${ref}" t="n"><v>${pyFloatRepr(v)}</v></c>`;
  }
  if (typeof v === "object" && "date" in v) return `<c r="${ref}" s="1" t="n"><v>${pyFloatRepr((v.date - EXCEL_EPOCH) / DAY)}</v></c>`;
  const s = String(v);
  const space = /^\s|\s$/.test(s) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"><is><t${space}>${escapeXml(s)}</t></is></c>`;
}

function sheetXml(rows) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  rows.forEach((row, i) => {
    const cells = row.map((v, j) => cellXml(`${colName(j)}${i + 1}`, v)).join("");
    out.push(`<row r="${i + 1}">${cells}</row>`);
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

/** Bytes of an xlsx workbook with sheets `[[name, rows]]` (rows: arrays of cells). */
export function writeWorkbook(sheets) {
  const entries = [];
  const n = sheets.length;
  entries.push([
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      "</Types>",
  ]);
  entries.push([
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  ]);
  entries.push([
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map(([name], i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>",
  ]);
  entries.push([
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  ]);
  entries.push([
    "xl/styles.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="YYYY-MM-DD HH:MM:SS"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  ]);
  sheets.forEach(([, rows], i) => entries.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(rows)]));
  return writeZip(entries);
}

// ----------------------------------------------------------------------
// workbook reading
// ----------------------------------------------------------------------

// built-in number formats that display dates or times
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code) {
  // drop quoted text, escapes and [colour]/[$-locale] sections
  const s = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(s) && !/^General$/i.test(s);
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

/** Text of `<t>` runs inside an element (inline or shared strings, rich text). */
function textOf(xml) {
  let s = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) s += m[1] === undefined ? "" : unescapeXml(m[1]);
  return s;
}

/**
 * Sheets of an xlsx workbook as a Map name -> rows (arrays of cells: number,
 * string, boolean, `{date}` or null), in workbook order.
 */
export function readWorkbook(bytes) {
  const zip = readZip(bytes);
  const wb = zipText(zip, "xl/workbook.xml");
  if (wb === null) throw new Error("Not an xlsx workbook (xl/workbook.xml missing)");
  const date1904 = /<workbookPr[^>]*\bdate1904="(1|true)"/.test(wb);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : EXCEL_EPOCH;
  const rels = new Map();
  for (const m of (zipText(zip, "xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], "Id"), attr(m[0], "Target"));
  const shared = [];
  const sst = zipText(zip, "xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  // date styles
  const dateStyles = new Set();
  const styles = zipText(zip, "xl/styles.xml");
  if (styles) {
    const custom = new Map();
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], "numFmtId")), attr(m[0], "formatCode"));
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    if (xfs) {
      [...xfs[1].matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
        const id = Number(attr(m[0], "numFmtId") ?? 0);
        if (DATE_FORMAT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dateStyles.add(i);
      });
    }
  }
  const sheets = new Map();
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name");
    let target = rels.get(attr(m[0], "r:id"));
    if (!target) continue;
    target = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const xml = zipText(zip, target) ?? "";
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNum = Number(attr(r[1], "r") ?? rows.length + 1) - 1;
      const row = [];
      let next = 0;
      for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], "r");
        const j = ref ? colIndex(ref) : next;
        next = j + 1;
        const t = attr(c[1], "t") ?? "n";
        const body = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        let val = null;
        if (t === "inlineStr") val = textOf(body);
        else if (t === "s") val = v ? shared[Number(v[1])] : null;
        else if (t === "str") val = v ? unescapeXml(v[1]) : "";
        else if (t === "b") val = v ? v[1].trim() === "1" : null;
        else if (t === "e") val = null;
        else if (v) {
          const x = Number(v[1]);
          const s = Number(attr(c[1], "s") ?? 0);
          // calamine rounds date serials to milliseconds
          val = dateStyles.has(s) ? { date: epoch + Math.round(x * DAY) } : x;
        }
        row[j] = val;
      }
      rows[rowNum] = row;
    }
    sheets.set(name, Array.from(rows, (row) => Array.from(row ?? [], (x) => (x === undefined ? null : x))));
  }
  return sheets;
}

// ----------------------------------------------------------------------
// pandas.read_excel
// ----------------------------------------------------------------------

/** A cell as the CSV text pandas' parser would see (same type inference). */
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "object" && "date" in v) return fmtDate(v.date);
  return String(v);
}

function csvQuote(s) {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Sheet rows as CSV text (blank rows dropped, ragged rows padded). */
function sheetCSV(rows) {
  const live = rows.filter((r) => r.some((v) => cellText(v) !== ""));
  const width = live.reduce((w, r) => Math.max(w, r.length), 0);
  return live.map((r) => Array.from({ length: width }, (_, j) => csvQuote(cellText(r[j]))).join(",")).join("\n") + "\n";
}

class ImporterExcel {
  constructor(bytes) {
    this.sheets = readWorkbook(bytes);
  }

  _csv(name) {
    const rows = this.sheets.get(name);
    return rows === undefined || !rows.length ? null : sheetCSV(rows);
  }

  getAttributes() {
    const text = this._csv("network");
    if (text === null) return null;
    const df = readCSV(text, { indexCol: null, dtypes: { pypsa_version: "str", name: "str" } });
    if (df.index.length === 0) return {};
    const row = df.row(0);
    if ("name" in row && typeof row.name === "number" && Number.isNaN(row.name)) row.name = "";
    return row;
  }

  getMeta() {
    const rows = this.sheets.get("meta");
    if (!rows || rows.length < 2) return {};
    const meta = {};
    for (const r of rows.slice(1)) {
      let value = r[1] ?? NaN;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          // a plain string
        }
      }
      meta[r[0]] = value;
    }
    return meta;
  }

  getCrs() {
    const rows = this.sheets.get("crs");
    if (!rows || rows.length < 2) return {};
    return Object.fromEntries(rows.slice(1).map((r) => [r[0], r[1]]));
  }

  getSnapshots() {
    const text = this._csv("snapshots");
    return text === null ? null : readCSV(text, { indexCol: 0 });
  }

  getInvestmentPeriods() {
    const text = this._csv("investment_periods");
    if (text === null) return null;
    const df = readCSV(text, { indexCol: 0 });
    df.index = new Index(
      df.index.values.map((v) => Math.trunc(Number(v))),
      df.index.name,
    );
    return df;
  }

  getStatic(listName) {
    const text = this._csv(listName);
    if (text === null) return null;
    let df = readCSV(text, { indexCol: 0, indexAsStr: true });
    // a sheet with only the index column: its header row was read as a name
    if (df.columns.length === 0 && df.index.length > 0 && df.index.at(0) === "name") df = df.takeRows(Array.from({ length: df.index.length - 1 }, (_, i) => i + 1));
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
    const re = new RegExp(`^${listName}-(.+)$`);
    for (const raw of this.sheets.keys()) {
      const name = safeSheetName(raw);
      const m = re.exec(name);
      if (!m || name.endsWith("-pw")) continue;
      yield [m[1], readCSV(this._csv(raw), { indexCol: 0 })];
    }
  }

  *getPiecewise(listName) {
    const re = new RegExp(`^${listName}-(.+)-pw$`);
    for (const raw of this.sheets.keys()) {
      const m = re.exec(safeSheetName(raw));
      if (!m) continue;
      yield [m[1], unstackPiecewise(readCSV(this._csv(raw), { indexCol: null }))];
    }
  }
}

/**
 * `df.set_index(["breakpoint", "attribute"]).unstack("attribute", sort=False)`
 * with columns (name, attribute): every name with every attribute.
 */
function unstackPiecewise(df) {
  const names = df.columns.values.filter((c) => c !== "breakpoint" && c !== "attribute");
  const bp = df.col("breakpoint");
  const at = df.col("attribute");
  const breakpoints = [...new Set(Array.from(bp))];
  const attrs = [...new Set(Array.from(at))];
  const tuples = [];
  const data = new Map();
  for (const nm of names) {
    const col = df.col(nm);
    for (const a of attrs) {
      const t = [nm, a];
      const vals = new Float64Array(breakpoints.length).fill(NaN);
      for (let i = 0; i < bp.length; i++) if (at[i] === a) vals[breakpoints.indexOf(bp[i])] = Number(col[i]);
      tuples.push(t);
      data.set(t, vals);
    }
  }
  return new DataFrame({ index: new Index(breakpoints, "breakpoint"), columns: new Index(tuples, ["name", "attribute"]), data });
}

// ----------------------------------------------------------------------
// pandas.DataFrame.to_excel
// ----------------------------------------------------------------------

/** Rows of `df.to_excel(index=index)` (single-level columns). */
function frameRows(df, { index = true, dates = false } = {}) {
  const value = (v) => (dates && typeof v === "string" ? (dateCell(v) ?? v) : v);
  const header = [];
  if (index) header.push(...(df.index.isMulti ? df.index.names.map((x) => x ?? null) : [df.index.name ?? null]));
  header.push(...df.columns.values.map(String));
  const rows = [header];
  const cols = df.columns.values.map((c) => df.col(c));
  for (let i = 0; i < df.index.length; i++) {
    const row = [];
    if (index) {
      const lab = df.index.at(i);
      row.push(...(df.index.isMulti ? lab : [lab]));
    }
    for (const a of cols) row.push(value(a[i]));
    rows.push(row);
  }
  return rows;
}

/** `df.stack("attribute", future_stack=True).reset_index()` rows of a piecewise frame. */
function piecewiseRows(df) {
  const tuples = df.columns.values;
  const names = [...new Set(tuples.map((t) => t[0]))];
  const attrs = [...new Set(tuples.map((t) => t[1]))];
  const key = new Map(tuples.map((t) => [`${t[0]}\u0000${t[1]}`, df.col(t)]));
  const rows = [["breakpoint", "attribute", ...names]];
  df.index.values.forEach((b, i) => {
    for (const a of attrs) rows.push([b, a, ...names.map((nm) => key.get(`${nm}\u0000${a}`)?.[i] ?? NaN)]);
  });
  return rows;
}

function exportSheets(n, { export_standard_types = false } = {}) {
  if (n.has_scenarios) throw new Error("NotImplementedError: Stochastic networks are not supported in the Excel exporter. Use netcdf instead.");
  const ex = collectExport(n, { export_standard_types });
  const sheets = [];
  const attrs = Object.entries(ex.attrs);
  sheets.push(["network", [["name", ...attrs.map(([k]) => k)], [ex.name, ...attrs.map(([, v]) => v)]]]);
  sheets.push(["crs", [["Key", "Value"], ...Object.entries(ex.crs)]]);
  sheets.push(["meta", [["Key", "Value"], ...Object.entries(ex.meta).map(([k, v]) => [k, v !== null && typeof v === "object" ? pyJsonDumps(v) : v])]]);
  sheets.push(["snapshots", frameRows(ex.snapshots, { dates: true })]);
  if (ex.periods) sheets.push(["investment_periods", frameRows(ex.periods)]);
  const seriesBy = new Map();
  for (const s of ex.series) {
    if (!seriesBy.has(s.listName)) seriesBy.set(s.listName, []);
    seriesBy.get(s.listName).push(s);
  }
  for (const { listName, df } of ex.statics) {
    sheets.push([listName, frameRows(df)]);
    for (const { attr, df: sdf } of seriesBy.get(listName) ?? []) sheets.push([safeSheetName(`${listName}-${attr}`), frameRows(sdf)]);
  }
  for (const { listName, attr, df } of ex.piecewise) sheets.push([safeSheetName(`${listName}-${attr}-pw`), piecewiseRows(df)]);
  const removed = new Set();
  for (const { listName, attr, piecewise } of ex.removed) {
    removed.add(attr === null ? listName : safeSheetName(piecewise ? `${listName}-${attr}-pw` : `${listName}-${attr}`));
  }
  return { sheets, removed, ex };
}

function readBytes(path) {
  if (isUrl(path)) {
    throw new Error("ValueError: Excel workbooks at URLs: fetch the bytes first, e.g. `Network.from_excel(new Uint8Array(await (await fetch(url)).arrayBuffer()))`");
  }
  if (path instanceof Uint8Array) return path;
  if (path instanceof ArrayBuffer) return new Uint8Array(path);
  if (!fs) throw new Error("Reading files needs Node.js; pass the workbook bytes instead");
  if (!fs.existsSync(path)) throw new Error(`FileNotFoundError: Excel file ${path} does not exist.`);
  return new Uint8Array(fs.readFileSync(path));
}

Object.assign(Network.prototype, {
  /**
   * Import from an Excel workbook (a path, or the xlsx bytes).
   * @param {string|Uint8Array} path
   */
  import_from_excel(path, { skip_time = false } = {}) {
    importFromImporter(this, new ImporterExcel(readBytes(path)), skip_time);
    return this;
  },

  /**
   * Export to an Excel workbook. Like PyPSA (openpyxl in append mode), sheets
   * of an existing file are kept unless replaced or stale. With `path` null
   * the xlsx bytes are returned.
   */
  export_to_excel(path = null, { export_standard_types = false } = {}) {
    const { sheets, removed, ex } = exportSheets(this, { export_standard_types });
    let book = sheets;
    if (path !== null && fs && fs.existsSync(path)) {
      // keep the existing sheets (replaced in place, stale ones removed)
      const fresh = new Map(sheets);
      const merged = [];
      for (const [name, rows] of readWorkbook(new Uint8Array(fs.readFileSync(path)))) {
        if (removed.has(name) && !fresh.has(name)) {
          logger.warning(`Stale sheet ${name} removed`);
          continue;
        }
        if (name === "_temp") continue;
        merged.push([name, fresh.has(name) ? fresh.get(name) : rows]);
        fresh.delete(name);
      }
      book = [...merged, ...fresh];
    } else if (path !== null) logger.warning(`Excel file ${path} does not exist, creating it`);
    const bytes = writeWorkbook(book);
    logger.info(`Exported network '${ex.name}' contains: ${ex.statics.map((s) => s.listName).join(", ")}`);
    if (path === null) return bytes;
    fs.writeFileSync(path, bytes);
    return path;
  },
});

/** Convenience loader: `Network.from_excel(path)`. */
Network.from_excel = function fromExcel(path, opts = {}) {
  const n = new Network(opts);
  n.import_from_excel(path, opts);
  return n;
};

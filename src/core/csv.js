// SPDX-License-Identifier: MIT
/**
 * CSV reading/writing compatible with the way PyPSA uses `pandas.read_csv`
 * and `DataFrame.to_csv`.
 */

import Papa from "papaparse";
import { Index } from "./index.js";
import { DataFrame } from "./frame.js";

// pandas default NA values
const NA_VALUES = new Set([
  "",
  "#N/A",
  "#N/A N/A",
  "#NA",
  "-1.#IND",
  "-1.#QNAN",
  "-NaN",
  "-nan",
  "1.#IND",
  "1.#QNAN",
  "<NA>",
  "N/A",
  "NA",
  "NULL",
  "NaN",
  "None",
  "n/a",
  "nan",
  "null",
]);

const TRUE_VALUES = new Set(["True", "TRUE", "true"]);
const FALSE_VALUES = new Set(["False", "FALSE", "false"]);
const NUM_RE = /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|Inf|INF|infinity|Infinity)$/;
const INT_RE = /^[+-]?\d+$/;

export function parseNumber(s) {
  const t = s.trim();
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  return Number(t);
}

/**
 * Infer a typed column from raw strings like pandas does.
 * Returns {values, dtype} with dtype in "float" | "int" | "bool" | "object".
 */
export function inferColumn(raw, { naValues = NA_VALUES } = {}) {
  const n = raw.length;
  let allNum = true;
  let allInt = true;
  let allBool = true;
  let anyNa = false;
  let anyVal = false;
  for (let i = 0; i < n; i++) {
    const s = raw[i];
    if (s === null || s === undefined || naValues.has(s)) {
      anyNa = true;
      continue;
    }
    anyVal = true;
    const t = s.trim();
    if (allNum && !NUM_RE.test(t)) allNum = false;
    if (allInt && !INT_RE.test(t)) allInt = false;
    if (allBool && !TRUE_VALUES.has(t) && !FALSE_VALUES.has(t)) allBool = false;
  }
  if (!anyVal) {
    const a = new Float64Array(n).fill(NaN);
    return { values: a, dtype: "float" };
  }
  if (allNum) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = raw[i];
      a[i] = s === null || s === undefined || naValues.has(s) ? NaN : parseNumber(s);
    }
    return { values: a, dtype: allInt && !anyNa ? "int" : "float" };
  }
  if (allBool && !anyNa) {
    return { values: raw.map((s) => TRUE_VALUES.has(s.trim())), dtype: "bool" };
  }
  return {
    values: raw.map((s) => (s === null || s === undefined || naValues.has(s) ? NaN : allBool ? TRUE_VALUES.has(s.trim()) : s)),
    dtype: "object",
  };
}

function inferIndexLabels(raw, asStr = false) {
  const { values, dtype } = inferColumn(raw);
  if (asStr) {
    // mimic `index.astype(str)` after pandas type inference
    if (dtype === "int") return Array.from(values, (v) => String(v));
    if (dtype === "float") return Array.from(values, (v) => pyFloatRepr(v));
    return values.map((v) => (typeof v === "number" && Number.isNaN(v) ? "nan" : String(v)));
  }
  if (dtype === "int") return Array.from(values);
  if (dtype === "float") return Array.from(values);
  return values.map((v) => (typeof v === "number" && Number.isNaN(v) ? "" : String(v)));
}

/**
 * Parse CSV text. With `indexCol = 0` the first column becomes the index.
 * Column dtypes are inferred; `dtypes` can force "str" columns.
 */
export function readCSV(text, { indexCol = 0, dtypes = {}, quoteChar = '"', indexAsStr = false } = {}) {
  const res = Papa.parse(text, { skipEmptyLines: true, quoteChar });
  const rows = res.data;
  if (rows.length === 0) return new DataFrame();
  const header = rows[0];
  const body = rows.slice(1);
  const ncol = header.length;
  const columns = [];
  const colsRaw = [];
  for (let j = 0; j < ncol; j++) colsRaw.push(body.map((r) => (j < r.length ? r[j] : "")));
  let index;
  let indexName = null;
  let start = 0;
  if (indexCol === 0) {
    indexName = header[0] === "" ? null : header[0];
    index = new Index(inferIndexLabels(colsRaw[0], indexAsStr), indexName);
    start = 1;
  } else {
    index = new Index(Array.from({ length: body.length }, (_, i) => i));
  }
  const data = new Map();
  const dt = {};
  for (let j = start; j < ncol; j++) {
    let name = header[j];
    // pandas de-duplicates column names
    let k = 1;
    const base = name;
    while (data.has(name)) name = `${base}.${k++}`;
    columns.push(name);
    if (dtypes[name] === "str") {
      data.set(
        name,
        colsRaw[j].map((s) => (NA_VALUES.has(s) ? NaN : s)),
      );
      dt[name] = "object";
    } else {
      const { values, dtype } = inferColumn(colsRaw[j]);
      data.set(name, values);
      dt[name] = dtype;
    }
  }
  const df = new DataFrame({ index, columns, data, dtypes: dt });
  return df;
}

/** Format a double like Python's `repr(float)`. */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (Object.is(x, -0)) return "-0.0";
  if (x === 0) return "0.0";
  // shortest round-trip digits
  const e = x.toExponential(); // e.g. "1.2345e-5"
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
  const sign = m[1];
  const digits = m[2] + (m[3] || "");
  const exp = parseInt(m[4], 10);
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
    const es = exp < 0 ? `-${String(-exp).padStart(2, "0")}` : `+${String(exp).padStart(2, "0")}`;
    return `${sign}${mant}e${es}`;
  }
  if (exp >= 0) {
    if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
    return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  }
  return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
}

export function formatCell(v, { floatColumn = false } = {}) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "";
    if (!floatColumn && Number.isInteger(v)) return String(v);
    return pyFloatRepr(v);
  }
  return String(v);
}

function quote(s, quoteChar = '"') {
  if (s.includes(",") || s.includes(quoteChar) || s.includes("\n") || s.includes("\r")) {
    return quoteChar + s.split(quoteChar).join(quoteChar + quoteChar) + quoteChar;
  }
  return s;
}

/**
 * Write DataFrame as CSV text like `pandas.DataFrame.to_csv`.
 * @param {DataFrame} df
 * @param {object} opts
 * @param {boolean} [opts.index=true]
 * @param {object} [opts.columnKinds] column -> "float" | "int" | "bool" | "object"
 */
export function writeCSV(df, { index = true, indexLabel = null, columnKinds = {}, quoteChar = '"' } = {}) {
  const lines = [];
  const header = [];
  if (index) {
    if (df.index.isMulti) header.push(...df.index.names.map((n) => n ?? ""));
    else header.push(indexLabel ?? df.index.name ?? "");
  }
  for (const c of df.columns) header.push(String(c));
  lines.push(header.map((h) => quote(h, quoteChar)).join(","));
  const cols = df.columns.values.map((c) => {
    const a = df.col(c);
    const kind = columnKinds[c] ?? df.dtypes[c];
    const floatColumn = kind ? kind === "float" : a instanceof Float64Array;
    return { a, floatColumn };
  });
  for (let i = 0; i < df.index.length; i++) {
    const row = [];
    if (index) {
      const lab = df.index.at(i);
      if (df.index.isMulti) row.push(...lab.map((v) => formatCell(v)));
      else row.push(formatCell(lab));
    }
    for (const { a, floatColumn } of cols) row.push(formatCell(a[i], { floatColumn }));
    lines.push(row.map((s) => quote(s, quoteChar)).join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Write a frame with two-level (tuple) columns like `DataFrame.to_csv`:
 * one header row per column level (prefixed by the level name), then a row
 * with the index name.
 */
export function writeCSVMulti(df, { quoteChar = '"' } = {}) {
  const lines = [];
  const names = df.columns.names;
  for (let l = 0; l < names.length; l++) {
    lines.push([names[l] ?? "", ...df.columns.values.map((t) => String(t[l]))].map((h) => quote(h, quoteChar)).join(","));
  }
  lines.push([df.index.name ?? "", ...df.columns.values.map(() => "")].map((h) => quote(h, quoteChar)).join(","));
  const cols = df.columns.values.map((c) => df.col(c));
  for (let i = 0; i < df.index.length; i++) {
    const row = [formatCell(df.index.at(i))];
    for (const a of cols) row.push(formatCell(a[i], { floatColumn: true }));
    lines.push(row.map((x) => quote(x, quoteChar)).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Read a CSV written by `writeCSVMulti` (`pd.read_csv(index_col=0, header=[0, 1])`). */
export function readCSVMulti(text, { quoteChar = '"', nlevels = 2 } = {}) {
  const res = Papa.parse(text, { skipEmptyLines: true, quoteChar });
  const rows = res.data;
  const headers = rows.slice(0, nlevels);
  const indexRow = rows[nlevels];
  // the index-name row only has its first field set
  const hasIndexRow = indexRow && indexRow.slice(1).every((x) => x === "");
  const body = rows.slice(nlevels + (hasIndexRow ? 1 : 0));
  const ncol = headers[0].length;
  const levelNames = headers.map((h) => (h[0] === "" ? null : h[0]));
  const tuples = [];
  const data = new Map();
  for (let j = 1; j < ncol; j++) {
    const t = headers.map((h) => h[j]);
    tuples.push(t);
    const { values } = inferColumn(body.map((r) => (j < r.length ? r[j] : "")));
    data.set(t, Float64Array.from(values, (v) => (typeof v === "number" ? v : Number(v))));
  }
  const index = new Index(inferIndexLabels(body.map((r) => r[0]), false), hasIndexRow && indexRow[0] !== "" ? indexRow[0] : null);
  return new DataFrame({ index, columns: new Index(tuples, levelNames), data });
}

// SPDX-License-Identifier: MIT
/**
 * Minimal column-oriented DataFrame / Series, just enough to mirror the
 * pandas usage inside PyPSA.
 */

import { Index, asIndex, labelKey } from "./index.js";

export function isNumberArray(a) {
  return a instanceof Float64Array || a instanceof Float32Array || a instanceof Int32Array;
}

function makeFilled(n, fill, like) {
  if (typeof fill === "number" && (like === undefined || isNumberArray(like) || like === "float")) {
    const a = new Float64Array(n);
    if (fill !== 0) a.fill(fill);
    return a;
  }
  return new Array(n).fill(fill);
}

function cloneArray(a) {
  return isNumberArray(a) ? a.slice() : a.slice();
}

function takeArray(a, positions, fill) {
  if (isNumberArray(a) && (typeof fill === "number" || fill === undefined)) {
    const out = new Float64Array(positions.length);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      out[i] = p < 0 ? (fill === undefined ? NaN : fill) : a[p];
    }
    return out;
  }
  const out = new Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    out[i] = p < 0 ? (fill === undefined ? NaN : fill) : a[p];
  }
  return out;
}

export class Series {
  constructor(values = [], index = null, name = null) {
    this.values = values;
    this.index = index === null ? new Index(Array.from({ length: values.length }, (_, i) => i)) : asIndex(index);
    this.name = name;
    if (this.index.length !== this.values.length) {
      throw new Error(`Series length mismatch: ${this.values.length} values vs ${this.index.length} labels`);
    }
  }

  static fromObject(obj, name = null) {
    const keys = Object.keys(obj);
    return new Series(
      keys.map((k) => obj[k]),
      new Index(keys),
      name,
    );
  }

  get length() {
    return this.values.length;
  }

  get empty() {
    return this.values.length === 0;
  }

  get(label) {
    const i = this.index.getLoc(label);
    if (i < 0) throw new Error(`KeyError: ${JSON.stringify(label)}`);
    return this.values[i];
  }

  getOr(label, fallback) {
    const i = this.index.getLoc(label);
    return i < 0 ? fallback : this.values[i];
  }

  set(label, v) {
    const i = this.index.getLoc(label);
    if (i < 0) throw new Error(`KeyError: ${JSON.stringify(label)}`);
    this.values[i] = v;
  }

  loc(labels) {
    const idx = asIndex(labels);
    const pos = this.index.getIndexer(idx);
    for (let i = 0; i < pos.length; i++) if (pos[i] < 0) throw new Error(`KeyError: ${JSON.stringify(idx.at(i))}`);
    return new Series(takeArray(this.values, pos), idx, this.name);
  }

  reindex(labels, fill = NaN) {
    const idx = asIndex(labels);
    const pos = this.index.getIndexer(idx);
    return new Series(takeArray(this.values, pos, fill), idx, this.name);
  }

  filter(mask) {
    const pos = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) pos.push(i);
    return new Series(takeArray(this.values, pos), this.index.take(pos), this.name);
  }

  map(fn) {
    return new Series(Array.from(this.values, fn), this.index, this.name);
  }

  /** Map values through another Series (pandas `Series.map(series)`). */
  mapSeries(other, fill = NaN) {
    return new Series(
      Array.from(this.values, (v) => {
        const i = other.index.getLoc(v);
        return i < 0 ? fill : other.values[i];
      }),
      this.index,
      this.name,
    );
  }

  sum() {
    let s = 0;
    for (const v of this.values) if (!Number.isNaN(v)) s += v;
    return s;
  }

  toObject() {
    const out = {};
    this.index.values.forEach((k, i) => {
      out[Array.isArray(k) ? k.join("|") : k] = this.values[i];
    });
    return out;
  }

  toArray() {
    return Array.from(this.values);
  }

  copy() {
    return new Series(cloneArray(this.values), this.index, this.name);
  }

  rename(name) {
    return new Series(this.values, this.index, name);
  }

  entries() {
    return this.index.values.map((k, i) => [k, this.values[i]]);
  }
}

export class DataFrame {
  /**
   * @param {object} opts
   * @param {Index|Array} opts.index row labels
   * @param {Index|Array} [opts.columns] column labels
   * @param {object|Map} [opts.data] column label -> array
   */
  constructor({ index = [], columns = null, data = null, dtypes = null } = {}) {
    this.index = asIndex(index);
    /** column -> "float" | "int" | "bool" | "object" (optional metadata) */
    this.dtypes = dtypes ? { ...dtypes } : {};
    this._cols = new Map();
    let cols;
    if (columns === null) {
      cols = data instanceof Map ? [...data.keys()] : data ? Object.keys(data) : [];
    } else {
      cols = columns instanceof Index ? columns.values : columns;
    }
    this.columns = columns instanceof Index ? columns : new Index(cols);
    for (const c of cols) {
      let arr = data instanceof Map ? data.get(c) : data ? data[c] : undefined;
      if (arr === undefined) arr = makeFilled(this.index.length, NaN);
      if (arr.length !== this.index.length) {
        throw new Error(`Column ${c} has length ${arr.length} but index has length ${this.index.length}`);
      }
      this._cols.set(labelKey(c), arr);
    }
  }

  static empty(index, columns, fill = NaN, numeric = true) {
    const idx = asIndex(index);
    const cols = asIndex(columns);
    const data = new Map();
    for (const c of cols) data.set(c, numeric ? makeFilled(idx.length, fill, "float") : new Array(idx.length).fill(fill));
    return new DataFrame({ index: idx, columns: cols, data });
  }

  get shape() {
    return [this.index.length, this.columns.length];
  }

  get empty() {
    return this.index.length === 0 || this.columns.length === 0;
  }

  has(col) {
    return this._cols.has(labelKey(col));
  }

  /** Raw column array (live). */
  col(col) {
    const a = this._cols.get(labelKey(col));
    if (a === undefined) throw new Error(`KeyError: column ${JSON.stringify(col)}`);
    return a;
  }

  colOr(col, fallback) {
    const a = this._cols.get(labelKey(col));
    return a === undefined ? fallback : a;
  }

  series(col) {
    return new Series(this.col(col), this.index, col);
  }

  /** Set or add a column. Scalar values are broadcast. */
  set(col, values) {
    let arr = values;
    if (values instanceof Series) arr = values.reindex(this.index).values;
    else if (!Array.isArray(values) && !isNumberArray(values)) {
      arr = makeFilled(this.index.length, values, typeof values === "number" ? "float" : "obj");
    }
    if (arr.length !== this.index.length) throw new Error(`Length mismatch setting column ${col}`);
    const k = labelKey(col);
    if (!this._cols.has(k)) this.columns = this.columns.append([col]);
    this._cols.set(k, arr);
    return this;
  }

  deleteCol(col) {
    const k = labelKey(col);
    if (!this._cols.has(k)) return this;
    this._cols.delete(k);
    delete this.dtypes[col];
    this.columns = this.columns.filter((c) => labelKey(c) !== k);
    return this;
  }

  at(row, col) {
    const i = this.index.getLoc(row);
    if (i < 0) throw new Error(`KeyError: row ${JSON.stringify(row)}`);
    return this.col(col)[i];
  }

  setAt(row, col, value) {
    const i = this.index.getLoc(row);
    if (i < 0) throw new Error(`KeyError: row ${JSON.stringify(row)}`);
    if (!this.has(col)) this.set(col, makeFilled(this.index.length, NaN, typeof value === "number" ? "float" : "obj"));
    this.col(col)[i] = value;
  }

  iat(i, col) {
    return this.col(col)[i];
  }

  /** Row as plain object. */
  row(label) {
    const i = typeof label === "number" && !this.index.has(label) ? label : this.index.getLoc(label);
    const out = {};
    for (const c of this.columns) out[c] = this._cols.get(labelKey(c))[i];
    return out;
  }

  /** Select rows (labels) and/or columns (labels). Missing labels raise. */
  loc(rows = null, cols = null) {
    const ridx = rows === null ? this.index : asIndex(rows, this.index.isMulti ? this.index.names : this.index.name);
    const cidx = cols === null ? this.columns : asIndex(cols);
    const pos = rows === null ? null : this.index.getIndexer(ridx);
    if (pos) for (let i = 0; i < pos.length; i++) if (pos[i] < 0) throw new Error(`KeyError: row ${JSON.stringify(ridx.at(i))}`);
    const data = new Map();
    for (const c of cidx) {
      const a = this.col(c);
      data.set(c, pos === null ? cloneArray(a) : takeArray(a, pos));
    }
    return new DataFrame({ index: ridx, columns: cidx, data, dtypes: this.dtypes });
  }

  /** Rows by boolean mask. */
  filter(mask) {
    const pos = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) pos.push(i);
    return this.takeRows(pos);
  }

  takeRows(pos) {
    const data = new Map();
    for (const c of this.columns) data.set(c, takeArray(this.col(c), pos));
    return new DataFrame({ index: this.index.take(pos), columns: this.columns, data, dtypes: this.dtypes });
  }

  reindex({ index = null, columns = null, fill = NaN } = {}) {
    const ridx = index === null ? this.index : asIndex(index);
    const cidx = columns === null ? this.columns : asIndex(columns);
    const pos = index === null ? null : this.index.getIndexer(ridx);
    const data = new Map();
    for (const c of cidx) {
      const a = this._cols.get(labelKey(c));
      if (a === undefined) {
        data.set(c, makeFilled(ridx.length, fill, typeof fill === "number" ? "float" : "obj"));
      } else {
        data.set(c, pos === null ? cloneArray(a) : takeArray(a, pos, fill));
      }
    }
    return new DataFrame({ index: ridx, columns: cidx, data, dtypes: this.dtypes });
  }

  dropRows(labels) {
    const drop = new Set(asIndex(labels).values.map(labelKey));
    const pos = [];
    this.index.values.forEach((v, i) => {
      if (!drop.has(labelKey(v))) pos.push(i);
    });
    return this.takeRows(pos);
  }

  dropCols(labels) {
    const drop = new Set(asIndex(labels).values.map(labelKey));
    const keep = this.columns.values.filter((c) => !drop.has(labelKey(c)));
    return this.loc(null, keep);
  }

  copy() {
    return this.loc(null, null);
  }

  /** pandas-like `drop({columns, index})`. */
  drop({ columns = null, index = null, errors = "raise" } = {}) {
    let df = this;
    if (columns !== null) {
      const cols = asIndex(columns);
      if (errors === "raise") for (const c of cols) if (!df.has(c)) throw new Error(`KeyError: column ${c} not found`);
      df = df.dropCols(cols);
    }
    if (index !== null) df = df.dropRows(index);
    return df === this ? this.copy() : df;
  }

  renameIndex(mapper) {
    const df = this.copy();
    df.index = new Index(
      this.index.values.map((v) => (typeof mapper === "function" ? mapper(v) : mapper[v] ?? v)),
      this.index.isMulti ? this.index.names : this.index.name,
    );
    return df;
  }

  renameColumns(mapper) {
    const data = new Map();
    const newCols = [];
    for (const c of this.columns) {
      const nc = typeof mapper === "function" ? mapper(c) : mapper[c] ?? c;
      newCols.push(nc);
      data.set(nc, this.col(c));
    }
    const dtypes = {};
    this.columns.values.forEach((c, i) => {
      if (this.dtypes[c]) dtypes[newCols[i]] = this.dtypes[c];
    });
    return new DataFrame({ index: this.index, columns: newCols, data, dtypes });
  }

  /** Append rows of other frames (columns union, missing filled with NaN). */
  static concatRows(frames, columns = null) {
    frames = frames.filter((f) => f);
    if (frames.length === 0) return new DataFrame();
    let cols = columns;
    if (cols === null) {
      const seen = new Set();
      cols = [];
      for (const f of frames)
        for (const c of f.columns) {
          const k = labelKey(c);
          if (!seen.has(k)) {
            seen.add(k);
            cols.push(c);
          }
        }
    }
    const idxVals = [];
    for (const f of frames) idxVals.push(...f.index.values);
    const index = new Index(idxVals, frames[0].index.isMulti ? frames[0].index.names : frames[0].index.name);
    const data = new Map();
    const dtypes = {};
    for (const f of frames) for (const [k, v] of Object.entries(f.dtypes)) if (!(k in dtypes)) dtypes[k] = v;
    for (const c of cols) {
      const parts = frames.map((f) => f.colOr(c, null));
      const allNum = parts.every((p) => p === null || isNumberArray(p));
      const out = allNum ? new Float64Array(index.length) : new Array(index.length);
      let off = 0;
      frames.forEach((f, j) => {
        const p = parts[j];
        for (let i = 0; i < f.index.length; i++) out[off + i] = p === null ? NaN : p[i];
        off += f.index.length;
      });
      data.set(c, out);
    }
    return new DataFrame({ index, columns: cols, data, dtypes });
  }

  /** Concatenate frames side by side (same index assumed or reindexed). */
  static concatCols(frames, index = null) {
    frames = frames.filter((f) => f);
    const idx = index ?? (frames[0] ? frames[0].index : new Index());
    const data = new Map();
    const cols = [];
    for (const f of frames) {
      const g = f.index.equals(idx) ? f : f.reindex({ index: idx });
      for (const c of g.columns) {
        cols.push(c);
        data.set(c, g.col(c));
      }
    }
    return new DataFrame({ index: idx, columns: cols, data });
  }

  /** Apply a function to every value of numeric columns. */
  applyNumeric(fn) {
    const data = new Map();
    for (const c of this.columns) {
      const a = this.col(c);
      const out = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = fn(a[i], i, c);
      data.set(c, out);
    }
    return new DataFrame({ index: this.index, columns: this.columns, data });
  }

  /** Rows x columns 2-D array (row-major). */
  toRows() {
    const cols = this.columns.values.map((c) => this.col(c));
    return this.index.values.map((_, i) => cols.map((a) => a[i]));
  }

  toObject() {
    const out = {};
    for (const c of this.columns) out[c] = Array.from(this.col(c));
    return { index: this.index.values, columns: this.columns.values, data: out };
  }

  *iterRows() {
    for (let i = 0; i < this.index.length; i++) {
      const row = {};
      for (const c of this.columns) row[c] = this._cols.get(labelKey(c))[i];
      yield [this.index.at(i), row];
    }
  }

  toString() {
    const head = ["", ...this.columns.values.map(String)];
    const rows = this.index.values.slice(0, 20).map((r, i) => [
      Array.isArray(r) ? r.join("|") : String(r),
      ...this.columns.values.map((c) => String(this.col(c)[i])),
    ]);
    return [head, ...rows].map((r) => r.join("\t")).join("\n");
  }
}

export { makeFilled, takeArray, cloneArray };

// SPDX-License-Identifier: MIT
/**
 * A small labelled N-d array in the spirit of xarray's `DataArray` /
 * `Dataset`, enough for PyPSA's component views `c.da` and `c.ds`: named
 * dimensions with an `Index` of coordinates each and the values in C order.
 */

import { Index, asIndex } from "./index.js";
import { DataFrame, Series } from "./frame.js";

const product = (shape) => shape.reduce((a, b) => a * b, 1);

export class DataArray {
  /**
   * @param {ArrayLike} values values in C order of `dims`
   * @param {{dims: string[], coords: Index[], name?: string|null}} spec
   */
  constructor(values, { dims, coords, name = null }) {
    this.dims = dims;
    this._coords = coords.map((c, d) => (c instanceof Index ? c : new Index(c, dims[d])));
    this.name = name;
    this.values = values;
    if (values.length !== product(this.shape)) throw new Error(`DataArray: ${values.length} values for shape (${this.shape.join(", ")})`);
  }

  /** Lengths of the dimensions. */
  get shape() {
    return this._coords.map((c) => c.length);
  }

  get size() {
    return this.values.length;
  }

  get ndim() {
    return this.dims.length;
  }

  /** Coordinates per dimension (`{dim: Index}`). */
  get coords() {
    return Object.fromEntries(this.dims.map((d, i) => [d, this._coords[i]]));
  }

  /** `{dim: length}`. */
  get sizes() {
    return Object.fromEntries(this.dims.map((d, i) => [d, this._coords[i].length]));
  }

  _strides() {
    const shape = this.shape;
    const strides = new Array(shape.length).fill(1);
    for (let d = shape.length - 2; d >= 0; d--) strides[d] = strides[d + 1] * shape[d + 1];
    return strides;
  }

  _dimPos(dim) {
    const d = this.dims.indexOf(dim);
    if (d < 0) throw new Error(`ValueError: Dimensions ('${dim}',) do not exist. Expected one or more of (${this.dims.map((x) => `'${x}'`).join(", ")})`);
    return d;
  }

  /** Value at one label per dimension, in `dims` order. */
  loc(...labels) {
    const strides = this._strides();
    let k = 0;
    labels.forEach((l, d) => {
      const i = this._coords[d].getLoc(l);
      if (i < 0) throw new Error(`KeyError: ${JSON.stringify(l)}`);
      k += i * strides[d];
    });
    return this.values[k];
  }

  /**
   * Positional selection `{dim: position | positions}`; a scalar position
   * drops the dimension (xarray's `isel`).
   */
  isel(selection) {
    const pick = this.dims.map((d, i) => {
      if (!(d in selection)) return { keep: true, pos: Array.from({ length: this._coords[i].length }, (_, k) => k) };
      const s = selection[d];
      const len = this._coords[i].length;
      const norm = (p) => (p < 0 ? p + len : p);
      if (Array.isArray(s)) return { keep: true, pos: s.map(norm) };
      return { keep: false, pos: [norm(s)] };
    });
    for (const d of Object.keys(selection)) this._dimPos(d);
    const strides = this._strides();
    const out = [];
    const rec = (d, base) => {
      if (d === this.dims.length) {
        out.push(this.values[base]);
        return;
      }
      for (const p of pick[d].pos) rec(d + 1, base + p * strides[d]);
    };
    rec(0, 0);
    const dims = this.dims.filter((_, d) => pick[d].keep);
    const coords = this._coords.map((c, d) => (pick[d].keep ? c.take(pick[d].pos) : null)).filter((c) => c !== null);
    const values = this.values instanceof Float64Array ? Float64Array.from(out) : out;
    if (!dims.length) return values[0];
    return new DataArray(values, { dims, coords, name: this.name });
  }

  /** Label-based selection `{dim: label | labels}` (xarray's `sel`). */
  sel(selection) {
    const pos = {};
    for (const [dim, s] of Object.entries(selection)) {
      const c = this._coords[this._dimPos(dim)];
      const locate = (l) => {
        const i = c.getLoc(l);
        if (i < 0) throw new Error(`KeyError: ${JSON.stringify(l)}`);
        return i;
      };
      pos[dim] = Array.isArray(s) || s instanceof Index ? asIndex(s).values.map(locate) : locate(s);
    }
    return this.isel(pos);
  }

  /** The array with its dimensions reordered. */
  transpose(...dims) {
    if (!dims.length) dims = [...this.dims].reverse();
    if (dims.length !== this.dims.length || dims.some((d) => !this.dims.includes(d))) {
      throw new Error(`ValueError: ${JSON.stringify(dims)} must be a permuted list of ${JSON.stringify(this.dims)}`);
    }
    const order = dims.map((d) => this._dimPos(d));
    const shape = order.map((d) => this._coords[d].length);
    const strides = this._strides();
    const out = this.values instanceof Float64Array ? new Float64Array(this.size) : new Array(this.size);
    const idx = new Array(dims.length).fill(0);
    for (let k = 0; k < this.size; k++) {
      let src = 0;
      for (let j = 0; j < dims.length; j++) src += idx[j] * strides[order[j]];
      out[k] = this.values[src];
      for (let j = dims.length - 1; j >= 0; j--) {
        if (++idx[j] < shape[j]) break;
        idx[j] = 0;
      }
    }
    return new DataArray(out, { dims, coords: order.map((d) => this._coords[d]), name: this.name });
  }

  /** pandas object of a 0-, 1- or 2-d array (Series indexed by the dimension, DataFrame with dims[0] as rows). */
  to_pandas() {
    if (this.ndim === 0) return this.values[0];
    if (this.ndim === 1) return new Series(Array.from(this.values), this._coords[0], this.name);
    if (this.ndim === 2) {
      const [rows, cols] = this._coords;
      const data = new Map();
      cols.values.forEach((c, j) => {
        const col = this.values instanceof Float64Array ? new Float64Array(rows.length) : new Array(rows.length);
        for (let i = 0; i < rows.length; i++) col[i] = this.values[i * cols.length + j];
        data.set(c, col);
      });
      return new DataFrame({ index: rows, columns: cols, data });
    }
    throw new Error(`ValueError: cannot convert arrays with ${this.ndim} dimensions into pandas objects. Requires 2 or fewer dimensions.`);
  }

  /** Nested arrays of the values. */
  toArray() {
    const shape = this.shape;
    const rec = (d, off) => {
      if (d === shape.length) return this.values[off];
      const step = product(shape.slice(d + 1));
      return Array.from({ length: shape[d] }, (_, i) => rec(d + 1, off + i * step));
    };
    return rec(0, 0);
  }

  toString() {
    const head = `<DataArray${this.name ? ` '${this.name}'` : ""} (${this.dims.map((d, i) => `${d}: ${this._coords[i].length}`).join(", ")})>`;
    const vals = Array.from(this.values.slice(0, 8), (v) => String(v)).join(", ");
    const coords = this.dims.map((d, i) => `  * ${d} (${d}) ${this._coords[i].values.slice(0, 4).map((v) => JSON.stringify(v)).join(" ")}${this._coords[i].length > 4 ? " ..." : ""}`);
    return [head, `[${vals}${this.size > 8 ? ", ..." : ""}]`, "Coordinates:", ...coords].join("\n");
  }
}

export class Dataset {
  /** @param {Map<string, DataArray>|Object} dataVars */
  constructor(dataVars) {
    this.data_vars = dataVars instanceof Map ? dataVars : new Map(Object.entries(dataVars));
  }

  /** The variable `name`. */
  get(name) {
    const v = this.data_vars.get(name);
    if (!v) throw new Error(`KeyError: '${name}'`);
    return v;
  }

  /** `{dim: length}` over all variables. */
  get sizes() {
    const out = {};
    for (const v of this.data_vars.values()) Object.assign(out, v.sizes);
    return out;
  }

  /** `{dim: Index}` over all variables. */
  get coords() {
    const out = {};
    for (const v of this.data_vars.values()) Object.assign(out, v.coords);
    return out;
  }

  get dims() {
    return Object.keys(this.sizes);
  }

  toString() {
    const lines = [`<Dataset> (${Object.entries(this.sizes).map(([d, l]) => `${d}: ${l}`).join(", ")})`, "Data variables:"];
    for (const [k, v] of this.data_vars) lines.push(`    ${k} (${v.dims.join(", ")})`);
    return lines.join("\n");
  }
}


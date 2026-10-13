// SPDX-License-Identifier: MIT
/**
 * Minimal pandas-like Index / MultiIndex.
 *
 * Labels are plain JS primitives (strings or numbers). A MultiIndex stores
 * its labels as arrays (tuples) and has `names.length > 1`.
 */

const SEP = "\u001f";

export function labelKey(v) {
  if (Array.isArray(v)) return v.map(labelKey).join(SEP);
  if (typeof v === "number") return `#${v}`;
  return `$${v}`;
}

/** Python-like ordering for sorting labels (numbers before strings). */
export function compareLabels(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareLabels(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  const ta = typeof a;
  const tb = typeof b;
  if (ta === "number" && tb === "number") return a - b;
  if (ta === "number") return -1;
  if (tb === "number") return 1;
  const sa = String(a);
  const sb = String(b);
  // Python compares strings by code point
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export class Index {
  /**
   * @param {Array} values labels (tuples for a MultiIndex)
   * @param {string|null|string[]} name name, or list of level names for a MultiIndex
   */
  constructor(values = [], name = null) {
    this.values = Array.isArray(values) ? values : Array.from(values);
    if (Array.isArray(name)) {
      this.names = name.slice();
      this.name = name.length === 1 ? name[0] : null;
    } else {
      this.name = name ?? null;
      this.names = [this.name];
    }
    this._map = null;
  }

  static from(values, name = null) {
    if (values instanceof Index) return values;
    return new Index(values, name);
  }

  static multi(tuples, names) {
    return new Index(tuples, names);
  }

  static fromProduct(levels, names) {
    let out = [[]];
    for (const level of levels) {
      const next = [];
      for (const prefix of out) for (const v of level) next.push([...prefix, v]);
      out = next;
    }
    return new Index(out, names);
  }

  get isMulti() {
    return this.names.length > 1;
  }

  get nlevels() {
    return this.names.length;
  }

  get length() {
    return this.values.length;
  }

  get empty() {
    return this.values.length === 0;
  }

  at(i) {
    return this.values[i];
  }

  _ensureMap() {
    if (this._map === null) {
      const m = new Map();
      const vals = this.values;
      for (let i = 0; i < vals.length; i++) {
        const k = labelKey(vals[i]);
        if (!m.has(k)) m.set(k, i);
      }
      this._map = m;
    }
    return this._map;
  }

  /** Position of label or -1. */
  getLoc(label) {
    const i = this._ensureMap().get(labelKey(label));
    return i === undefined ? -1 : i;
  }

  has(label) {
    return this._ensureMap().has(labelKey(label));
  }

  getIndexer(labels) {
    const arr = labels instanceof Index ? labels.values : labels;
    const out = new Int32Array(arr.length);
    const m = this._ensureMap();
    for (let i = 0; i < arr.length; i++) {
      const j = m.get(labelKey(arr[i]));
      out[i] = j === undefined ? -1 : j;
    }
    return out;
  }

  isin(labels) {
    const set = new Set((labels instanceof Index ? labels.values : labels).map(labelKey));
    return this.values.map((v) => set.has(labelKey(v)));
  }

  get isUnique() {
    return this._ensureMap().size === this.values.length;
  }

  toArray() {
    return this.values.slice();
  }

  [Symbol.iterator]() {
    return this.values[Symbol.iterator]();
  }

  map(fn) {
    return this.values.map(fn);
  }

  filter(maskOrFn) {
    const vals =
      typeof maskOrFn === "function"
        ? this.values.filter(maskOrFn)
        : this.values.filter((_, i) => maskOrFn[i]);
    return new Index(vals, this.isMulti ? this.names : this.name);
  }

  take(positions) {
    const vals = Array.from(positions, (p) => this.values[p]);
    return new Index(vals, this.isMulti ? this.names : this.name);
  }

  slice(start, end) {
    return new Index(this.values.slice(start, end), this.isMulti ? this.names : this.name);
  }

  rename(name) {
    return new Index(this.values, name);
  }

  copy() {
    return new Index(this.values.slice(), this.isMulti ? this.names : this.name);
  }

  equals(other) {
    if (!(other instanceof Index)) other = new Index(other);
    if (other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) {
      if (labelKey(this.values[i]) !== labelKey(other.values[i])) return false;
    }
    return true;
  }

  /** Pandas-like union (sorted unless `sort === false`). */
  union(other, sort = null) {
    const o = other instanceof Index ? other.values : other;
    if (this.equals(o)) return this.copy();
    // pandas does not sort when either side is empty
    if (o.length === 0) return this.unique();
    if (this.length === 0) return new Index(o, this.isMulti ? this.names : this.name).unique();
    const seen = new Set();
    const out = [];
    for (const v of [...this.values, ...o]) {
      const k = labelKey(v);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }
    if (sort !== false) trySort(out);
    return new Index(out, this.isMulti ? this.names : this.name);
  }

  /** Pandas-like intersection: keeps order of `this` (sort=False default). */
  intersection(other, sort = false) {
    const o = other instanceof Index ? other : new Index(other);
    const seen = new Set();
    const out = [];
    for (const v of this.values) {
      const k = labelKey(v);
      if (o.has(v) && !seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }
    if (sort) trySort(out);
    return new Index(out, this.isMulti ? this.names : this.name);
  }

  /** Pandas-like difference (sorted by default like `sort=None`). */
  difference(other, sort = null) {
    const o = other instanceof Index ? other : new Index(other);
    // pandas does not sort when `other` is empty (GH#24959)
    if (o.length === 0) {
      const u = this.unique();
      return sort === true ? u.sortValues() : u;
    }
    const seen = new Set();
    const out = [];
    for (const v of this.values) {
      const k = labelKey(v);
      if (!o.has(v) && !seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }
    if (sort !== false) trySort(out);
    return new Index(out, this.isMulti ? this.names : this.name);
  }

  unique() {
    const seen = new Set();
    const out = [];
    for (const v of this.values) {
      const k = labelKey(v);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }
    return new Index(out, this.isMulti ? this.names : this.name);
  }

  dropDuplicates() {
    return this.unique();
  }

  _levelPos(level) {
    if (typeof level === "number") return level;
    const p = this.names.indexOf(level);
    if (p < 0) throw new Error(`Level ${level} not found in index with names ${this.names}`);
    return p;
  }

  /** Values of one level (as a plain Index). */
  getLevelValues(level) {
    if (!this.isMulti) return new Index(this.values.slice(), this.name);
    const p = this._levelPos(level);
    return new Index(
      this.values.map((t) => t[p]),
      this.names[p],
    );
  }

  /** Unique values of one level in order of appearance. */
  uniqueLevel(level) {
    return this.getLevelValues(level).unique();
  }

  /** Positions where level `level` equals `value`. */
  locLevel(level, value) {
    const p = this._levelPos(level);
    const k = labelKey(value);
    const out = [];
    for (let i = 0; i < this.values.length; i++) {
      if (labelKey(this.values[i][p]) === k) out.push(i);
    }
    return out;
  }

  insert(pos, value) {
    const vals = this.values.slice();
    vals.splice(pos, 0, value);
    return new Index(vals, this.isMulti ? this.names : this.name);
  }

  append(other) {
    const o = other instanceof Index ? other.values : other;
    return new Index([...this.values, ...o], this.isMulti ? this.names : this.name);
  }

  sortValues() {
    const vals = this.values.slice();
    vals.sort(compareLabels);
    return new Index(vals, this.isMulti ? this.names : this.name);
  }

  toString() {
    return `Index([${this.values.map((v) => JSON.stringify(v)).join(", ")}], name=${JSON.stringify(
      this.isMulti ? this.names : this.name,
    )})`;
  }
}

function trySort(arr) {
  try {
    arr.sort(compareLabels);
  } catch {
    // incomparable labels: keep order
  }
}

export function asIndex(x, name = null) {
  if (x instanceof Index) return x;
  if (x === undefined || x === null) return new Index([], name);
  if (typeof x === "string" || typeof x === "number") return new Index([x], name);
  return new Index(Array.from(x), name);
}

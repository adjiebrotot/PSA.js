// SPDX-License-Identifier: MIT
/**
 * Emulation of CPython's hash functions and `set` hash table, as needed to
 * reproduce iteration orders that PyPSA (and networkx) derive from Python sets.
 *
 * PyPSA's parity fixtures are generated with `PYTHONHASHSEED=0`, which zeroes
 * the hash secret, so `hash(str)` is SipHash-1-3 with a zero key. The set
 * implementation mirrors `Objects/setobject.c` (CPython >= 3.11): open
 * addressing with 9 linear probes, perturbed probing, resizing at 3/5 fill and
 * dummy entries on discard.
 */

const M64 = (1n << 64n) - 1n;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;
const MINSIZE = 8;
const DUMMY = Symbol("dummy");

const rotl = (x, b) => ((x << b) | (x >> (64n - b))) & M64;

function sipRound(v) {
  v[0] = (v[0] + v[1]) & M64;
  v[2] = (v[2] + v[3]) & M64;
  v[1] = rotl(v[1], 13n) ^ v[0];
  v[3] = rotl(v[3], 16n) ^ v[2];
  v[0] = rotl(v[0], 32n);
  v[2] = (v[2] + v[1]) & M64;
  v[0] = (v[0] + v[3]) & M64;
  v[1] = rotl(v[1], 17n) ^ v[2];
  v[3] = rotl(v[3], 21n) ^ v[0];
  v[2] = rotl(v[2], 32n);
}

/** SipHash-1-3 with a zero key (CPython's `pysiphash` under PYTHONHASHSEED=0). */
function siphash13(bytes) {
  const v = [0x736f6d6570736575n, 0x646f72616e646f6dn, 0x6c7967656e657261n, 0x7465646279746573n];
  const len = bytes.length;
  let i = 0;
  for (; i + 8 <= len; i += 8) {
    let m = 0n;
    for (let k = 7; k >= 0; k--) m = (m << 8n) | BigInt(bytes[i + k]);
    v[3] ^= m;
    sipRound(v);
    v[0] ^= m;
  }
  let b = (BigInt(len) << 56n) & M64;
  for (let k = len - i - 1; k >= 0; k--) b |= BigInt(bytes[i + k]) << BigInt(8 * k);
  v[3] ^= b;
  sipRound(v);
  v[0] ^= b;
  v[2] ^= 0xffn;
  sipRound(v);
  sipRound(v);
  sipRound(v);
  return v[0] ^ v[1] ^ v[2] ^ v[3];
}

/** Bytes of CPython's compact unicode representation (latin-1, UCS-2 or UCS-4). */
function unicodeBytes(s) {
  const cps = Array.from(s, (c) => c.codePointAt(0));
  const max = cps.reduce((a, c) => Math.max(a, c), 0);
  const kind = max < 256 ? 1 : max < 65536 ? 2 : 4;
  const out = new Uint8Array(cps.length * kind);
  cps.forEach((c, j) => {
    for (let k = 0; k < kind; k++) out[j * kind + k] = (c >>> (8 * k)) & 0xff;
  });
  return out;
}

const strHashCache = new Map();

/** `hash(s)` for a Python str under PYTHONHASHSEED=0, as unsigned 64-bit BigInt. */
export function strHash(s) {
  let h = strHashCache.get(s);
  if (h === undefined) {
    if (s.length === 0) h = 0n;
    else {
      h = siphash13(unicodeBytes(s));
      if (h === M64) h = M64 - 1n; // -1 is reserved: CPython returns -2
    }
    strHashCache.set(s, h);
  }
  return h;
}

const MODULUS = (1n << 61n) - 1n;

/** `hash(i)` for a Python int, as unsigned 64-bit BigInt. */
export function intHash(i) {
  let x = BigInt(i);
  const neg = x < 0n;
  if (neg) x = -x;
  let h = x % MODULUS;
  if (neg) h = -h;
  if (h === -1n) h = -2n;
  return h & M64;
}

/** Hash of a JS value as Python would hash the corresponding object. */
export function pyHash(v) {
  if (v instanceof FrozenSet) return v.hash;
  if (typeof v === "string") return strHash(v);
  if (typeof v === "number" && Number.isInteger(v)) return intHash(v);
  if (typeof v === "bigint") return intHash(v);
  throw new TypeError(`pyHash: unsupported value ${String(v)}`);
}

/** Equality key of a value (Python `==` for the supported types). */
function eqKey(v) {
  if (v instanceof FrozenSet) return v.key;
  return typeof v === "string" ? `s:${v}` : `i:${v}`;
}

/** A Python `set` hash table holding JS values. */
export class PySet {
  constructor(iterable = null) {
    this.mask = MINSIZE - 1;
    this.table = new Array(MINSIZE).fill(null);
    this.fill = 0;
    this.used = 0;
    if (iterable) {
      if (iterable instanceof PySet) this._merge(iterable);
      else for (const v of iterable) this.add(v);
    }
  }

  get size() {
    return this.used;
  }

  /** Slot of `value` (or of the first free/dummy slot on the probe sequence). */
  _lookup(value, hash) {
    const key = eqKey(value);
    const mask = this.mask;
    let perturb = hash;
    let i = Number(hash & BigInt(mask));
    let freeslot = -1;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let j = i;
      do {
        const e = this.table[j];
        if (e === null) return { found: false, slot: freeslot >= 0 ? freeslot : j, unused: freeslot < 0 };
        // CPython keeps the last dummy on the probe path as the free slot
        if (e.key === DUMMY) freeslot = j;
        else if (e.hash === hash && e.eq === key) return { found: true, slot: j };
        j++;
      } while (probes--);
      perturb >>= PERTURB_SHIFT;
      i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  has(value) {
    return this._lookup(value, pyHash(value)).found;
  }

  add(value) {
    const hash = pyHash(value);
    const r = this._lookup(value, hash);
    if (r.found) return this;
    this.table[r.slot] = { key: value, hash, eq: eqKey(value) };
    this.used++;
    if (r.unused) {
      this.fill++;
      if (this.fill * 5 >= this.mask * 3) this._resize(this.used > 50000 ? this.used * 2 : this.used * 4);
    }
    return this;
  }

  /** Remove `value`; returns whether it was present. */
  discard(value) {
    const r = this._lookup(value, pyHash(value));
    if (!r.found) return false;
    this.table[r.slot] = { key: DUMMY, hash: M64, eq: null };
    this.used--;
    return true;
  }

  _insertClean(table, mask, entry) {
    let perturb = entry.hash;
    let i = Number(entry.hash & BigInt(mask));
    for (;;) {
      if (table[i] === null) {
        table[i] = entry;
        return;
      }
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 1; j <= LINEAR_PROBES; j++) {
          if (table[i + j] === null) {
            table[i + j] = entry;
            return;
          }
        }
      }
      perturb >>= PERTURB_SHIFT;
      i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  _resize(minused) {
    let size = MINSIZE;
    while (size <= minused) size <<= 1;
    const old = this.table;
    this.table = new Array(size).fill(null);
    this.mask = size - 1;
    this.fill = this.used;
    for (const e of old) if (e !== null && e.key !== DUMMY) this._insertClean(this.table, this.mask, e);
  }

  /** `set_merge` into an empty set (copy constructor / `set(other)`). */
  _merge(other) {
    if (other.used === 0) return;
    if ((this.fill + other.used) * 5 >= this.mask * 3) this._resize((this.used + other.used) * 2);
    if (this.fill === 0 && this.mask === other.mask && other.fill === other.used) {
      this.table = other.table.map((e) => (e === null ? null : { ...e }));
      this.fill = other.fill;
      this.used = other.used;
      return;
    }
    if (this.fill === 0) {
      this.fill = other.used;
      this.used = other.used;
      for (const e of other.table) if (e !== null && e.key !== DUMMY) this._insertClean(this.table, this.mask, { ...e });
      return;
    }
    for (const v of other) this.add(v);
  }

  /** `self ^ other` (CPython: copy of `other`, then symmetric update with `self`). */
  symmetricDifference(other) {
    const result = new PySet(other);
    for (const v of this) if (!result.discard(v)) result.add(v);
    return result;
  }

  *[Symbol.iterator]() {
    for (const e of this.table) if (e !== null && e.key !== DUMMY) yield e.key;
  }
}

const shuffleBits = (h) => (((h ^ 89869747n) ^ ((h << 16n) & M64)) * 3644798167n) & M64;

/** A Python `frozenset` (keeps its own table, so iteration order matches CPython). */
export class FrozenSet {
  constructor(iterable) {
    this.set = iterable instanceof PySet ? iterable : new PySet(iterable);
    this.key = `f:${[...this.set].map(eqKey).sort().join("\u0001")}`;
    const so = this.set;
    let hash = 0n;
    for (const e of so.table) hash ^= shuffleBits(e === null ? 0n : e.hash);
    if ((so.mask + 1 - so.fill) & 1) hash ^= shuffleBits(0n);
    if ((so.fill - so.used) & 1) hash ^= shuffleBits(M64);
    hash ^= (BigInt(so.used + 1) * 1927868237n) & M64;
    hash ^= (hash >> 11n) ^ (hash >> 25n);
    hash = (hash * 69069n + 907133923n) & M64;
    if (hash === M64) hash = 590923713n;
    this.hash = hash;
  }

  get size() {
    return this.set.size;
  }

  [Symbol.iterator]() {
    return this.set[Symbol.iterator]();
  }
}

/** Signed 64-bit representation of a hash (as printed by Python's `hash`). */
export function signedHash(h) {
  return BigInt.asIntN(64, h);
}

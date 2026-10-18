// SPDX-License-Identifier: MIT
/**
 * Minimal ZIP archive reading and writing (for xlsx files): stored and
 * deflated entries, CRC-32, no encryption or ZIP64. Node.js' zlib is used
 * when available; elsewhere entries are written stored and read with the
 * bundled inflate.
 */

const zlib = globalThis.process?.getBuiltinModule?.("node:zlib") ?? null;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build a ZIP archive from `[[name, data]]` (data: string or Uint8Array).
 * Entries carry a fixed timestamp (1980-01-01) so output is deterministic.
 */
export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const raw = typeof data === "string" ? encoder.encode(data) : data;
    const nameBytes = encoder.encode(name);
    const crc = crc32(raw);
    const deflated = zlib ? new Uint8Array(zlib.deflateRawSync(raw)) : null;
    const method = deflated && deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, body);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true);
    cen.setUint16(12, 0, true);
    cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, raw.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

// ----------------------------------------------------------------------
// inflate (RFC 1951), used where no zlib is available (browsers)
// ----------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman decoding table from code lengths: {counts, symbols}. */
function huffman(lengths) {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  lengths.forEach((l, sym) => {
    if (l) symbols[offs[l]++] = sym;
  });
  return { counts, symbols };
}

/** Decompress a raw deflate stream. */
export function inflateRaw(data) {
  let pos = 0;
  let bit = 0;
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let n = 0;
  const ensure = (k) => {
    if (n + k <= out.length) return;
    const grown = new Uint8Array(Math.max(out.length * 2, n + k));
    grown.set(out.subarray(0, n));
    out = grown;
  };
  const bits = (k) => {
    let v = 0;
    for (let i = 0; i < k; i++) {
      if (pos >= data.length) throw new Error("inflate: unexpected end of data");
      v |= ((data[pos] >>> bit) & 1) << i;
      if (++bit === 8) {
        bit = 0;
        pos++;
      }
    }
    return v;
  };
  const decode = ({ counts, symbols }) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = counts[len];
      if (code - first < count) return symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("inflate: invalid Huffman code");
  };
  const fixedLit = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
  const fixedDist = huffman(new Array(30).fill(5));
  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      if (bit) {
        bit = 0;
        pos++;
      }
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      ensure(len);
      out.set(data.subarray(pos, pos + len), n);
      n += len;
      pos += len;
      continue;
    }
    let lit = fixedLit;
    let dist = fixedDist;
    if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const cl = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clTable = huffman(cl);
      const lengths = [];
      while (lengths.length < hlit + hdist) {
        const sym = decode(clTable);
        if (sym < 16) lengths.push(sym);
        else if (sym === 16) {
          const prev = lengths[lengths.length - 1];
          for (let r = bits(2) + 3; r > 0; r--) lengths.push(prev);
        } else for (let r = sym === 17 ? bits(3) + 3 : bits(7) + 11; r > 0; r--) lengths.push(0);
      }
      lit = huffman(lengths.slice(0, hlit));
      dist = huffman(lengths.slice(hlit));
    } else if (type !== 1) throw new Error("inflate: invalid block type");
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[n++] = sym;
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(dist);
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        ensure(len);
        for (let k = 0; k < len; k++, n++) out[n] = out[n - d];
      }
    }
  }
  return out.slice(0, n);
}

/** Entries of a ZIP archive as a Map name -> Uint8Array. */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end of central directory)");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nlen = view.getUint16(p + 28, true);
    const xlen = view.getUint16(p + 30, true);
    const clen = view.getUint16(p + 32, true);
    const lho = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const lnlen = view.getUint16(lho + 26, true);
    const lxlen = view.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lxlen;
    const data = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, zlib ? new Uint8Array(zlib.inflateRawSync(data)) : inflateRaw(data));
    else throw new Error(`Unsupported zip compression method ${method}`);
  }
  return out;
}

export function zipText(entries, name) {
  const b = entries.get(name);
  return b === undefined ? null : decoder.decode(b);
}

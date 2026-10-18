// SPDX-License-Identifier: MIT
/**
 * Clauset-Newman-Moore greedy modularity communities, a port of networkx's
 * `greedy_modularity_communities` (networkx 3.x) including its `MappedQueue`
 * heap, so that ties between equal modularity gains break the same way (by
 * the node pair).
 */

import { compareLabels, labelKey } from "../core/index.js";

class HeapElement {
  constructor(priority, element) {
    this.priority = priority;
    this.element = element;
    this.key = labelKey(element);
  }
}

function compareTuple(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareLabels(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** `_HeapElement.__lt__`: priority, then the element. */
function lt(a, b) {
  if (a.priority === b.priority) return compareTuple(a.element, b.element) < 0;
  return a.priority < b.priority;
}

/** networkx `MappedQueue`: a binary min-heap with element positions. */
class MappedQueue {
  constructor(items = []) {
    this.heap = items;
    this.position = new Map();
    // heapq.heapify
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this._siftup(i, i);
    this.heap.forEach((e, i) => this.position.set(e.key, i));
  }

  static fromEntries(entries) {
    return new MappedQueue(entries.map(([element, priority]) => new HeapElement(priority, element)));
  }

  get length() {
    return this.heap.length;
  }

  push(elt) {
    if (this.position.has(elt.key)) return false;
    const pos = this.heap.length;
    this.heap.push(elt);
    this.position.set(elt.key, pos);
    this._siftdown(0, pos);
    return true;
  }

  pop() {
    const elt = this.heap[0];
    this.position.delete(elt.key);
    if (this.heap.length === 1) {
      this.heap.pop();
      return elt;
    }
    const last = this.heap.pop();
    this.heap[0] = last;
    this.position.set(last.key, 0);
    this._siftup(0);
    return elt;
  }

  update(oldKey, elt) {
    const pos = this.position.get(oldKey);
    this.heap[pos] = elt;
    this.position.delete(oldKey);
    this.position.set(elt.key, pos);
    this._siftup(pos);
  }

  remove(key) {
    const pos = this.position.get(key);
    if (pos === undefined) throw new Error(`KeyError: ${key}`);
    this.position.delete(key);
    if (pos === this.heap.length - 1) {
      this.heap.pop();
      return;
    }
    const last = this.heap.pop();
    this.heap[pos] = last;
    this.position.set(last.key, pos);
    this._siftup(pos);
  }

  // heapq's _siftup: move the smaller child up to a leaf, then sift the item
  // back up towards `start` (heapify passes the subtree root, MappedQueue 0)
  _siftup(pos, start = null) {
    const heapify = start !== null;
    const heap = this.heap;
    const end = heap.length;
    const newitem = heap[pos];
    let child = 2 * pos + 1;
    while (child < end) {
      const right = child + 1;
      if (right < end && !lt(heap[child], heap[right])) child = right;
      heap[pos] = heap[child];
      if (!heapify) this.position.set(heap[pos].key, pos);
      pos = child;
      child = 2 * pos + 1;
    }
    heap[pos] = newitem;
    if (!heapify) this.position.set(newitem.key, pos);
    this._siftdown(heapify ? start : 0, pos, heapify);
  }

  _siftdown(start, pos, heapify = false) {
    const heap = this.heap;
    const newitem = heap[pos];
    while (pos > start) {
      const parentPos = (pos - 1) >> 1;
      const parent = heap[parentPos];
      if (!lt(newitem, parent)) break;
      heap[pos] = parent;
      if (!heapify) this.position.set(parent.key, pos);
      pos = parentPos;
    }
    heap[pos] = newitem;
    if (!heapify) this.position.set(newitem.key, pos);
  }
}

/**
 * Communities of an undirected weighted graph (`nodes` in insertion order,
 * `edges` as `[u, v, weight]` with networkx `Graph` semantics: a repeated
 * edge replaces the weight). Returns arrays of nodes, largest first.
 */
export function greedy_modularity_communities(nodes, edges, { cutoff = 1, best_n = null, resolution = 1 } = {}) {
  // nx.Graph adjacency (insertion ordered, repeated edges overwrite)
  const adj = new Map(nodes.map((u) => [u, new Map()]));
  for (const [u, v, w] of edges) {
    if (!adj.has(u)) adj.set(u, new Map());
    if (!adj.has(v)) adj.set(v, new Map());
    adj.get(u).set(v, w);
    adj.get(v).set(u, w);
  }
  const G = [...adj.keys()];
  // G.edges(data=weight): each edge once, from the first-seen endpoint
  const edgeList = [];
  const seen = new Set();
  for (const [u, nbrs] of adj) {
    for (const [v, w] of nbrs) if (!seen.has(v)) edgeList.push([u, v, w]);
    seen.add(u);
  }
  if (!edgeList.length) return G.map((u) => [u]);
  const N = G.length;
  if (cutoff < 1 || cutoff > N) throw new Error(`ValueError: cutoff must be between 1 and ${N}. Got ${cutoff}.`);
  if (best_n !== null && best_n !== undefined) {
    if (best_n < 1 || best_n > N) throw new Error(`ValueError: best_n must be between 1 and ${N}. Got ${best_n}.`);
    if (best_n < cutoff) throw new Error(`ValueError: Must have best_n >= cutoff. Got ${best_n} < ${cutoff}`);
    if (best_n === 1) return [G.slice()];
  } else best_n = N;

  // degrees (a self-loop counts twice) and total weight, summed as networkx
  const deg = new Map();
  for (const [u, nbrs] of adj) {
    let d = 0;
    for (const [, w] of nbrs) d += w;
    if (nbrs.has(u)) d += nbrs.get(u);
    deg.set(u, d);
  }
  let m = 0;
  for (const u of G) m += deg.get(u);
  m /= 2;
  const q0 = 1 / m;
  const a = new Map(G.map((u) => [u, deg.get(u) * q0 * 0.5]));
  const b = a;

  const dq = new Map(); // u -> Map(v -> dq)
  const row = (u) => {
    if (!dq.has(u)) dq.set(u, new Map());
    return dq.get(u);
  };
  for (const [u, v, w] of edgeList) {
    if (u === v) continue;
    row(u).set(v, (row(u).get(v) ?? 0) + w);
    row(v).set(u, (row(v).get(u) ?? 0) + w);
  }
  for (const [u, nbrs] of dq) for (const [v, w] of nbrs) nbrs.set(v, q0 * w - resolution * (a.get(u) * b.get(v) + b.get(u) * a.get(v)));

  const heaps = new Map(G.map((u) => [u, MappedQueue.fromEntries([...row(u)].map(([v, x]) => [[u, v], -x]))]));
  const H = new MappedQueue(G.filter((u) => heaps.get(u).length > 0).map((u) => heaps.get(u).heap[0]));
  const communities = new Map(G.map((u) => [u, [u]]));
  const key = (x, y) => labelKey([x, y]);

  // one CNM step: returns false when no merge is left
  const step = () => {
    if (H.length <= 1) return null;
    const top = H.pop();
    const [u, v] = top.element;
    return { dqMax: -top.priority, u, v };
  };
  const merge = ({ u, v }) => {
    heaps.get(u).pop();
    if (heaps.get(u).length > 0) H.push(heaps.get(u).heap[0]);
    const hv = heaps.get(v);
    if (hv.heap[0].key === key(v, u)) {
      H.remove(key(v, u));
      hv.remove(key(v, u));
      if (hv.length > 0) H.push(hv.heap[0]);
    } else hv.remove(key(v, u));

    communities.set(v, [...communities.get(u), ...communities.get(v)]);
    communities.delete(u);

    const uN = new Set(row(u).keys());
    const vN = new Set(row(v).keys());
    const all = [...new Set([...uN, ...vN])].filter((w) => w !== u && w !== v);
    for (const w of all) {
      let dvw;
      if (uN.has(w) && vN.has(w)) dvw = row(v).get(w) + row(u).get(w);
      else if (vN.has(w)) dvw = row(v).get(w) - resolution * (a.get(u) * b.get(w) + a.get(w) * b.get(u));
      else dvw = row(u).get(w) - resolution * (a.get(v) * b.get(w) + a.get(w) * b.get(v));
      for (const [r, c] of [
        [v, w],
        [w, v],
      ]) {
        const hr = heaps.get(r);
        row(r).set(c, dvw);
        const oldMax = hr.length > 0 ? hr.heap[0] : null;
        const d = new HeapElement(-dvw, [r, c]);
        if (vN.has(w)) hr.update(d.key, d);
        else hr.push(d);
        if (oldMax === null) H.push(d);
        else {
          const rowMax = hr.heap[0];
          if (oldMax.key !== rowMax.key || oldMax.priority !== rowMax.priority) H.update(oldMax.key, rowMax);
        }
      }
    }
    for (const w of [...row(u).keys()]) {
      row(w).delete(u);
      if (w === v) continue;
      for (const [r, c] of [
        [w, u],
        [u, w],
      ]) {
        const hr = heaps.get(r);
        const k = key(r, c);
        if (hr.heap[0].key === k) {
          hr.remove(k);
          H.remove(k);
          if (hr.length > 0) H.push(hr.heap[0]);
        } else hr.remove(k);
      }
    }
    dq.delete(u);
    heaps.set(u, new MappedQueue());
    a.set(v, a.get(v) + a.get(u));
    a.set(u, 0);
  };

  const bySize = () => [...communities.values()].map((c, i) => [c, i]).sort((x, y) => y[0].length - x[0].length || x[1] - y[1]).map(([c]) => c);
  while (communities.size > cutoff) {
    const s = step();
    if (s === null) {
      let res = bySize();
      while (res.length > best_n) {
        const [c1, c2, ...rest] = res;
        res = [[...c1, ...c2], ...rest];
      }
      return res;
    }
    if (s.dqMax < 0 && communities.size <= best_n) break;
    merge(s);
  }
  return bySize();
}

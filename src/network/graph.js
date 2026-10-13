// SPDX-License-Identifier: MIT
/**
 * Graph utilities reproducing the networkx/scipy behaviour PyPSA relies on
 * (ordered multigraph, simple-graph conversion, cycle basis, connected
 * components labelling).
 */

import { DataFrame } from "../core/frame.js";
import { Index, labelKey } from "../core/index.js";
import { CSC } from "../linalg/sparse.js";
import { PySet, FrozenSet } from "../core/pyset.js";

/** Insertion-ordered undirected multigraph (like networkx.MultiGraph). */
export class MultiGraph {
  constructor() {
    /** node -> Map(neighborKey -> {node, edges: Map(keyKey -> {key, data})}) */
    this._adj = new Map();
    this._nodes = new Map();
  }

  addNode(n) {
    const k = labelKey(n);
    if (!this._adj.has(k)) {
      this._adj.set(k, new Map());
      this._nodes.set(k, n);
    }
  }

  addEdge(u, v, key, data = {}) {
    this.addNode(u);
    this.addNode(v);
    const ku = labelKey(u);
    const kv = labelKey(v);
    let entry = this._adj.get(ku).get(kv);
    if (!entry) {
      const edges = new Map();
      this._adj.get(ku).set(kv, { node: v, edges });
      this._adj.get(kv).set(ku, { node: u, edges });
      entry = this._adj.get(ku).get(kv);
    }
    entry.edges.set(labelKey(key), { key, data });
  }

  get nodes() {
    return [...this._nodes.values()];
  }

  neighbors(n) {
    return [...this._adj.get(labelKey(n)).values()].map((e) => e.node);
  }

  /** Edge keys between u and v (insertion order). */
  edgeKeys(u, v) {
    const e = this._adj.get(labelKey(u))?.get(labelKey(v));
    return e ? [...e.edges.values()].map((x) => x.key) : [];
  }

  /** Edges (u, v, key, data) in networkx order. */
  *edges() {
    const seen = new Set();
    for (const [ku, nbrs] of this._adj) {
      const u = this._nodes.get(ku);
      for (const [kv, { node: v, edges }] of nbrs) {
        if (seen.has(kv)) continue;
        for (const { key, data } of edges.values()) yield [u, v, key, data];
      }
      seen.add(ku);
    }
  }

  get numberOfEdges() {
    let c = 0;
    for (const _ of this.edges()) c++;
    return c;
  }

  degree(n) {
    let d = 0;
    for (const [kv, { edges }] of this._adj.get(labelKey(n))) d += kv === labelKey(n) ? 2 * edges.size : edges.size;
    return d;
  }

  /** Simple graph as `nx.Graph(multigraph)` would build it. */
  toSimple() {
    const g = new SimpleGraph();
    for (const n of this._nodes.values()) g.addNode(n);
    const seen = new Set();
    for (const [ku, nbrs] of this._adj) {
      const u = this._nodes.get(ku);
      for (const [kv, { node: v }] of nbrs) {
        const pair = `${ku}\u0002${kv}`;
        if (!seen.has(pair)) {
          g.addEdge(u, v);
          seen.add(`${kv}\u0002${ku}`);
        }
      }
    }
    return g;
  }
}

/** Insertion-ordered undirected simple graph. */
export class SimpleGraph {
  constructor() {
    this._adj = new Map();
    this._nodes = new Map();
  }

  addNode(n) {
    const k = labelKey(n);
    if (!this._adj.has(k)) {
      this._adj.set(k, new Map());
      this._nodes.set(k, n);
    }
  }

  addEdge(u, v) {
    this.addNode(u);
    this.addNode(v);
    this._adj.get(labelKey(u)).set(labelKey(v), v);
    this._adj.get(labelKey(v)).set(labelKey(u), u);
  }

  get nodes() {
    return [...this._nodes.values()];
  }

  neighbors(n) {
    return [...this._adj.get(labelKey(n)).values()];
  }

  *edges() {
    const seen = new Set();
    for (const [ku, nbrs] of this._adj) {
      const u = this._nodes.get(ku);
      for (const [kv, v] of nbrs) if (!seen.has(kv)) yield [u, v];
      seen.add(ku);
    }
  }
}

/** Port of `networkx.cycle_basis` (same traversal order). */
export function cycleBasis(G) {
  const gnodes = new Map([...G._nodes.entries()]);
  const cycles = [];
  let root = null;
  while (gnodes.size) {
    if (root === null) {
      const lastKey = [...gnodes.keys()].pop();
      root = gnodes.get(lastKey);
      gnodes.delete(lastKey);
    }
    const stack = [root];
    const pred = new Map([[labelKey(root), root]]);
    const used = new Map([[labelKey(root), new Set()]]);
    while (stack.length) {
      const z = stack.pop();
      const kz = labelKey(z);
      const zused = used.get(kz);
      for (const nbr of G.neighbors(z)) {
        const kn = labelKey(nbr);
        if (!used.has(kn)) {
          pred.set(kn, z);
          stack.push(nbr);
          used.set(kn, new Set([kz]));
        } else if (kn === kz) {
          cycles.push([z]);
        } else if (!zused.has(kn)) {
          const pn = used.get(kn);
          const cycle = [nbr, z];
          let p = pred.get(kz);
          while (!pn.has(labelKey(p))) {
            cycle.push(p);
            p = pred.get(labelKey(p));
          }
          cycle.push(p);
          cycles.push(cycle);
          used.get(kn).add(kz);
        }
      }
    }
    for (const k of pred.keys()) gnodes.delete(k);
    root = null;
  }
  return cycles;
}

// ----------------------------------------------------------------------
// BFS-refined cycle basis (pypsa.network.graph.bfs_refined_cycle_basis)
// ----------------------------------------------------------------------
//
// PyPSA iterates over Python sets of nodes, edges (frozensets) and cycle
// indices here, so the resulting basis depends on CPython's hashing. The sets
// are emulated with `PySet`/`FrozenSet` (hash seed 0, as used for the parity
// fixtures) so that the basis, cycle orientation and order match PyPSA.

/** Node iteration order of `G.subgraph(nodes)` (networkx `FilterAtlas`). */
function subgraphNodes(G, nodeSet) {
  const nodes = new PySet();
  for (const v of nodeSet) nodes.add(v);
  if (2 * nodes.size < G._nodes.size) return [...nodes];
  return [...G._nodes.values()].filter((v) => nodes.has(v));
}

/** `networkx.connected_components` with `_plain_bfs` (yields PySets). */
function* connectedComponentSets(G) {
  const seen = new Set();
  const total = G._nodes.size;
  for (const v of G._nodes.values()) {
    if (seen.has(labelKey(v))) continue;
    const n = total - seen.size;
    const comp = new PySet([v]);
    let nextlevel = [v];
    outer: while (nextlevel.length) {
      const thislevel = nextlevel;
      nextlevel = [];
      for (const u of thislevel) {
        for (const w of G.neighbors(u)) {
          if (!comp.has(w)) {
            comp.add(w);
            nextlevel.push(w);
          }
        }
        if (comp.size === n) break outer;
      }
    }
    for (const w of comp) seen.add(labelKey(w));
    yield comp;
  }
}

/** Fundamental cycles of a breadth-first spanning tree grown from `root`. */
function bfsFundamentalCycles(G, nodes, inSub, root) {
  const parent = new Map([[labelKey(root), root]]);
  const tree = new Set();
  const edgeKey = (u, v) => {
    const a = labelKey(u);
    const b = labelKey(v);
    return a < b ? `${a}\u0002${b}` : `${b}\u0002${a}`;
  };
  let level = [root];
  while (level.length) {
    const next = [];
    for (const p of level) {
      for (const c of G.neighbors(p)) {
        if (!inSub.has(labelKey(c)) || parent.has(labelKey(c))) continue;
        parent.set(labelKey(c), p);
        tree.add(edgeKey(p, c));
        next.push(c);
      }
    }
    level = next;
  }
  const cycles = [];
  const rootKey = labelKey(root);
  for (const [u, v] of subgraphEdges(G, nodes, inSub)) {
    if (tree.has(edgeKey(u, v))) continue;
    const ancestors = new Set([labelKey(u)]);
    let current = u;
    while (labelKey(current) !== rootKey) {
      current = parent.get(labelKey(current));
      ancestors.add(labelKey(current));
    }
    const left = [v];
    current = v;
    while (!ancestors.has(labelKey(current))) {
      current = parent.get(labelKey(current));
      left.push(current);
    }
    const lca = labelKey(current);
    const right = [u];
    while (labelKey(right[right.length - 1]) !== lca) right.push(parent.get(labelKey(right[right.length - 1])));
    cycles.push([...right, ...left.slice(0, -1).reverse()]);
  }
  return cycles;
}

/** Edges of a subgraph view in networkx order. */
function* subgraphEdges(G, nodes, inSub) {
  const seen = new Set();
  for (const u of nodes) {
    const ku = labelKey(u);
    for (const v of G.neighbors(u)) {
      const kv = labelKey(v);
      if (inSub.has(kv) && !seen.has(kv)) yield [u, v];
    }
    seen.add(ku);
  }
}

function bfsCycleBasis(G, numRoots = 5) {
  const cycles = [];
  for (const comp of connectedComponentSets(G)) {
    const nodes = subgraphNodes(G, comp);
    const inSub = new Set(nodes.map(labelKey));
    const degree = (v) => {
      let d = 0;
      for (const w of G.neighbors(v)) if (inSub.has(labelKey(w))) d += labelKey(w) === labelKey(v) ? 2 : 1;
      return d;
    };
    const roots = nodes
      .map((v) => [v, degree(v)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, numRoots)
      .map(([v]) => v);
    let best = null;
    let bestKey = null;
    for (const root of roots) {
      const cand = bfsFundamentalCycles(G, nodes, inSub, root);
      const key = [cand.reduce((m, c) => Math.max(m, c.length), 0), cand.reduce((s, c) => s + c.length, 0)];
      if (best === null || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = cand;
        bestKey = key;
      }
    }
    if (best) cycles.push(...best);
  }
  return cycles;
}

/** Cyclic node ordering if the frozenset edges form exactly one simple cycle. */
function edgeSetToCycle(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    const [u, v] = [...edge];
    if (v === undefined) throw new Error("not enough values to unpack (expected 2, got 1)");
    if (!adjacency.has(u)) adjacency.set(u, []);
    adjacency.get(u).push(v);
    if (!adjacency.has(v)) adjacency.set(v, []);
    adjacency.get(v).push(u);
  }
  if (!adjacency.size || [...adjacency.values()].some((nb) => nb.length !== 2)) return null;
  const start = adjacency.keys().next().value;
  const order = [start];
  let previous = null;
  let current = start;
  for (;;) {
    const [left, right] = adjacency.get(current);
    const following = left === previous ? right : left;
    if (following === start) return order.length === edges.size ? order : null;
    order.push(following);
    previous = current;
    current = following;
  }
}

/** Port of `pypsa.network.graph.bfs_refined_cycle_basis` for string node labels. */
export function bfsRefinedCycleBasis(G, maxPasses = 50) {
  const cycles = bfsCycleBasis(G);
  const edgeSet = (cycle) => new PySet(cycle.map((_, i) => new FrozenSet([cycle[i], cycle[(i + 1) % cycle.length]])));
  const edgeSets = cycles.map(edgeSet);
  for (let pass = 0; pass < maxPasses; pass++) {
    const edgeToCycles = new Map();
    edgeSets.forEach((edges, index) => {
      for (const e of edges) {
        if (!edgeToCycles.has(e.key)) edgeToCycles.set(e.key, []);
        edgeToCycles.get(e.key).push(index);
      }
    });
    let swaps = 0;
    const order = cycles.map((_, i) => i).sort((a, b) => cycles[b].length - cycles[a].length);
    for (const left of order) {
      const candidates = new PySet();
      for (const e of edgeSets[left]) for (const index of edgeToCycles.get(e.key)) candidates.add(index);
      candidates.discard(left);
      for (const right of candidates) {
        if (cycles[right].length >= cycles[left].length) continue;
        const replacementEdges = edgeSets[left].symmetricDifference(edgeSets[right]);
        if (replacementEdges.size >= cycles[left].length) continue;
        const replacement = edgeSetToCycle(replacementEdges);
        if (replacement === null) continue;
        cycles[left] = replacement;
        edgeSets[left] = replacementEdges;
        swaps++;
        break;
      }
    }
    if (!swaps) break;
  }
  return cycles;
}

/**
 * Connected components labels of an undirected graph given as edge list over
 * `nNodes` nodes (scipy.sparse.csgraph labelling: by first node appearance).
 */
export function connectedComponents(nNodes, edges) {
  const adj = Array.from({ length: nNodes }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const labels = new Int32Array(nNodes).fill(-1);
  let count = 0;
  for (let s = 0; s < nNodes; s++) {
    if (labels[s] >= 0) continue;
    const stack = [s];
    labels[s] = count;
    while (stack.length) {
      const v = stack.pop();
      for (const w of adj[v]) {
        if (labels[w] < 0) {
          labels[w] = count;
          stack.push(w);
        }
      }
    }
    count++;
  }
  return [count, labels];
}

// ----------------------------------------------------------------------
// Network / SubNetwork graph mixin
// ----------------------------------------------------------------------

export const GraphMixin = {
  /**
   * Build the ordered multigraph of buses and branches.
   */
  graph({ branch_components = null, weight = null, inf_weight = false, include_inactive = true } = {}) {
    const comps = [...(branch_components ? new Set(branch_components) : this._defaultBranchComponents())].sort();
    const g = new MultiGraph();
    for (const b of this.c.get("buses").static.index) g.addNode(b);
    for (const cname of comps) {
      const c = this.c.get(cname);
      const st = c.static;
      if (st.index.length === 0) continue;
      const active = st.has("active") ? st.col("active") : null;
      const b0 = st.col("bus0");
      const b1 = st.col("bus1");
      const w = weight !== null ? st.colOr(weight, null) : null;
      for (let i = 0; i < st.index.length; i++) {
        if (!include_inactive && active && !active[i]) continue;
        let data = {};
        if (weight !== null) {
          let wv = w ? w[i] : 0;
          if (!Number.isFinite(wv) && !Number.isNaN(wv) && inf_weight !== true) {
            if (inf_weight === false) continue;
            wv = inf_weight;
          }
          data = { weight: wv };
        }
        g.addEdge(b0[i], b1[i], [c.name, st.index.at(i)], data);
      }
    }
    return g;
  },

  /** Adjacency matrix as DataFrame (bus x bus) or dense rows. */
  adjacency_matrix({ branch_components = null, investment_period = null, busorder = null, weights = null, return_dataframe = true } = {}) {
    const comps = branch_components ? new Set(branch_components) : this._defaultBranchComponents();
    const buses = busorder ?? this.c.get("buses").static.index;
    const n = buses.length;
    const cols = Array.from({ length: n }, () => new Float64Array(n));
    for (const c of this.components.values()) {
      if (!comps.has(c.name) || c.empty) continue;
      const active = c.get_active_assets(investment_period).values;
      const st = c.static;
      const b0 = st.col("bus0");
      const b1 = st.col("bus1");
      for (let i = 0; i < st.index.length; i++) {
        if (!active[i]) continue;
        const r = buses.getLoc(b0[i]);
        const cc = buses.getLoc(b1[i]);
        if (r < 0 || cc < 0) continue;
        cols[cc][r] = weights ? weights[c.name].get(st.index.at(i)) : 1;
      }
    }
    if (!return_dataframe) return cols;
    const data = new Map();
    buses.values.forEach((b, j) => data.set(b, cols[j]));
    return new DataFrame({ index: buses, columns: buses, data });
  },

  /** Incidence matrix (buses x active branches) as CSC. */
  incidence_matrix({ branch_components = null, busorder = null } = {}) {
    const comps = branch_components ? new Set(branch_components) : this._defaultBranchComponents();
    const buses = busorder ?? this.c.get("buses").static.index;
    const rows = [];
    const cols = [];
    const vals = [];
    let nb = 0;
    const b0s = [];
    const b1s = [];
    for (const c of this.components.values()) {
      if (!comps.has(c.name)) continue;
      const st = c.static;
      if (st.index.length === 0) continue;
      const active = st.col("active");
      const b0 = st.col("bus0");
      const b1 = st.col("bus1");
      for (let i = 0; i < st.index.length; i++) {
        if (!active[i]) continue;
        b0s.push(buses.getLoc(b0[i]));
        b1s.push(buses.getLoc(b1[i]));
        nb++;
      }
    }
    for (let k = 0; k < nb; k++) {
      rows.push(b0s[k]);
      cols.push(k);
      vals.push(1);
    }
    for (let k = 0; k < nb; k++) {
      rows.push(b1s[k]);
      cols.push(k);
      vals.push(-1);
    }
    return CSC.fromTriplets(buses.length, nb, rows, cols, vals);
  },
};

export { Index };

// SPDX-License-Identifier: MIT
/**
 * Graph utilities reproducing the networkx/scipy behaviour PyPSA relies on
 * (ordered multigraph, simple-graph conversion, cycle basis, connected
 * components labelling).
 */

import { DataFrame } from "../core/frame.js";
import { Index, labelKey } from "../core/index.js";
import { CSC } from "../linalg/sparse.js";

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

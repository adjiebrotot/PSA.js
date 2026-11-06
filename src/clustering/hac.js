// SPDX-License-Identifier: MIT
/**
 * Connectivity-constrained Ward clustering, a port of scikit-learn's
 * `AgglomerativeClustering(linkage="ward", connectivity=...)` (sklearn 1.x:
 * `_fix_connectivity`, `ward_tree`, `_hc_cut` and `hc_get_heads`), so that
 * the merge order, its tie-breaking and the cluster numbering match.
 */

import { pyFma } from "../core/pymath.js";

// ----------------------------------------------------------------------
// heapq on arrays of comparable items
// ----------------------------------------------------------------------

function heapSiftdown(heap, start, pos, lt) {
  const newitem = heap[pos];
  while (pos > start) {
    const parentPos = (pos - 1) >> 1;
    const parent = heap[parentPos];
    if (!lt(newitem, parent)) break;
    heap[pos] = parent;
    pos = parentPos;
  }
  heap[pos] = newitem;
}

function heapSiftup(heap, pos, lt) {
  const end = heap.length;
  const start = pos;
  const newitem = heap[pos];
  let child = 2 * pos + 1;
  while (child < end) {
    const right = child + 1;
    if (right < end && !lt(heap[child], heap[right])) child = right;
    heap[pos] = heap[child];
    pos = child;
    child = 2 * pos + 1;
  }
  heap[pos] = newitem;
  heapSiftdown(heap, start, pos, lt);
}

const heapify = (heap, lt) => {
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) heapSiftup(heap, i, lt);
};
const heappush = (heap, item, lt) => {
  heap.push(item);
  heapSiftdown(heap, 0, heap.length - 1, lt);
};
const heappop = (heap, lt) => {
  const last = heap.pop();
  if (!heap.length) return last;
  const top = heap[0];
  heap[0] = last;
  heapSiftup(heap, 0, lt);
  return top;
};
const heappushpop = (heap, item, lt) => {
  if (heap.length && lt(heap[0], item)) {
    [item, heap[0]] = [heap[0], item];
    heapSiftup(heap, 0, lt);
  }
  return item;
};

/** Python tuple `<` for (float, int, int). */
const tupleLt = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};
const numLt = (a, b) => a < b;

// ----------------------------------------------------------------------
// connectivity
// ----------------------------------------------------------------------

/** `scipy.sparse.csgraph.connected_components`: labels in order of the lowest node. */
function connectedComponents(rows) {
  const n = rows.length;
  const labels = new Int32Array(n).fill(-1);
  let k = 0;
  for (let s = 0; s < n; s++) {
    if (labels[s] >= 0) continue;
    const stack = [s];
    labels[s] = k;
    while (stack.length) {
      const u = stack.pop();
      for (const v of rows[u]) {
        if (labels[v] < 0) {
          labels[v] = k;
          stack.push(v);
        }
      }
    }
    k++;
  }
  return { count: k, labels };
}

const sqNorm = (x) => x.reduce((s, v) => s + v * v, 0); // einsum("ij,ij->i")
const fmaDot = (x, y) => {
  // BLAS kernels accumulate the products with FMA
  let dot = 0;
  for (let k = 0; k < x.length; k++) dot = pyFma(x[k], y[k], dot);
  return dot;
};
/** sklearn `normalize` (l2): rows divided by their norm (0 -> 1). */
const unit = (x) => {
  const nrm = Math.sqrt(sqNorm(x));
  const d = nrm < 10 * Number.EPSILON ? 1 : nrm;
  return x.map((v) => v / d);
};

/**
 * sklearn `pairwise_distances(Xi, Xj, metric)` between rows. Euclidean:
 * `sqrt(-2 X.Y^T + |x|^2 + |y|^2)` (rounding matters: identical points need
 * not come out at exactly zero); manhattan: scipy's `cdist(cityblock)`;
 * cosine: `1 - normalize(X).normalize(Y)^T`, clipped to [0, 2].
 */
function pairwiseDistances(Xi, Xj, metric = "euclidean") {
  // a callable metric is evaluated for every pair (sklearn's `_pairwise_callable`)
  if (typeof metric === "function") return Xi.map((x) => Xj.map((y) => metric(x, y)));
  if (metric === "manhattan" || metric === "l1") {
    return Xi.map((x) => Xj.map((y) => x.reduce((s, v, k) => s + Math.abs(v - y[k]), 0)));
  }
  if (metric === "cosine") {
    const yi = Xj.map(unit);
    return Xi.map((x) => {
      const xn = unit(x);
      return yi.map((yn) => Math.min(Math.max(-fmaDot(xn, yn) + 1, 0), 2));
    });
  }
  return Xi.map((x) => {
    const xx = sqNorm(x);
    return Xj.map((y) => Math.sqrt(Math.max(-2 * fmaDot(x, y) + xx + sqNorm(y), 0)));
  });
}

/** sklearn `paired_distances(x, y, metric)` of two rows. */
function pairedDistance(x, y, metric = "euclidean") {
  if (typeof metric === "function") return metric(x, y);
  if (metric === "manhattan" || metric === "l1") return x.reduce((s, v, k) => s + Math.abs(v - y[k]), 0);
  if (metric === "cosine") {
    const xn = unit(x);
    const yn = unit(y);
    return 0.5 * sqNorm(xn.map((v, k) => v - yn[k]));
  }
  return Math.sqrt(sqNorm(x.map((v, k) => v - y[k])));
}

/** Distance of the connectivity edge (i, j): `X[i][j]` for a precomputed matrix. */
const edgeDistance = (X, i, j, metric) => (metric === "precomputed" ? Number(X[i][j]) : pairedDistance(X[i], X[j], metric));

/**
 * `_fix_connectivity`: symmetric row lists (sorted, LIL), and when the graph
 * is disconnected every pair of components joined at their closest samples.
 */
function fixConnectivity(X, adjacency, metric = "euclidean") {
  const n = X.length;
  const sets = Array.from({ length: n }, () => new Set());
  adjacency.forEach(([i, j]) => {
    sets[i].add(j);
    sets[j].add(i);
  });
  let rows = sets.map((s) => [...s].sort((a, b) => a - b));
  const { count, labels } = connectedComponents(rows);
  if (count > 1) {
    for (let i = 0; i < count; i++) {
      const idxI = [...labels.keys()].filter((p) => labels[p] === i);
      for (let j = 0; j < i; j++) {
        const idxJ = [...labels.keys()].filter((p) => labels[p] === j);
        const D =
          metric === "precomputed"
            ? idxI.map((p) => idxJ.map((q) => X[p][q]))
            : pairwiseDistances(
                idxI.map((p) => X[p]),
                idxJ.map((p) => X[p]),
                metric,
              );
        let best = [0, 0];
        D.forEach((r, a) => r.forEach((d, b) => d < D[best[0]][best[1]] && (best = [a, b])));
        const [p, q] = [idxI[best[0]], idxJ[best[1]]];
        sets[p].add(q);
        sets[q].add(p);
      }
    }
    rows = sets.map((s) => [...s].sort((a, b) => a - b));
  }
  return { rows, nComponents: count };
}

// ----------------------------------------------------------------------
// ward tree
// ----------------------------------------------------------------------

function wardDist(m1, m2, row, col) {
  const n = (m1[row] * m1[col]) / (m1[row] + m1[col]);
  let pa = 0;
  for (let j = 0; j < m2[row].length; j++) {
    const d = m2[row][j] / m1[row] - m2[col][j] / m1[col];
    pa += d * d;
  }
  return pa * n;
}

/** `ward_tree(X, connectivity, n_clusters)`: children pairs and parents. */
function wardTree(X, rows, nClusters) {
  const nSamples = X.length;
  const nFeatures = X[0]?.length ?? 0;
  if (nClusters !== null && nClusters > nSamples) {
    throw new Error(`ValueError: Cannot provide more clusters than samples. ${nClusters} n_clusters was asked, and there are ${nSamples} samples.`);
  }
  const nNodes = nClusters === null ? 2 * nSamples - 1 : 2 * nSamples - nClusters;
  const A = rows.map((r) => r.slice());
  const m1 = new Float64Array(nNodes);
  const m2 = Array.from({ length: nNodes }, (_, i) => (i < nSamples ? Float64Array.from(X[i]) : new Float64Array(nFeatures)));
  for (let i = 0; i < nSamples; i++) m1[i] = 1;
  const inertia = [];
  A.forEach((r, ind) => {
    for (const i of r) if (i < ind) inertia.push([wardDist(m1, m2, ind, i), ind, i]);
  });
  heapify(inertia, tupleLt);
  const parent = Int32Array.from({ length: nNodes }, (_, i) => i);
  const used = new Uint8Array(nNodes).fill(1);
  const children = [];
  const notVisited = new Uint8Array(nNodes);
  const parentsOf = (nodes, out) => {
    for (let node of nodes) {
      let p = parent[node];
      while (p !== node) {
        node = p;
        p = parent[node];
      }
      if (notVisited[node]) {
        notVisited[node] = 0;
        out.push(node);
      }
    }
  };
  for (let k = nSamples; k < nNodes; k++) {
    let i;
    let j;
    for (;;) {
      [, i, j] = heappop(inertia, tupleLt);
      if (used[i] && used[j]) break;
    }
    parent[i] = k;
    parent[j] = k;
    children.push([i, j]);
    used[i] = 0;
    used[j] = 0;
    m1[k] = m1[i] + m1[j];
    for (let f = 0; f < nFeatures; f++) m2[k][f] = m2[i][f] + m2[j][f];
    const cols = [];
    notVisited.fill(1);
    notVisited[k] = 0;
    parentsOf(A[i], cols);
    parentsOf(A[j], cols);
    for (const c of cols) A[c].push(k);
    A.push(cols);
    for (const c of cols) heappush(inertia, [wardDist(m1, m2, k, c), k, c], tupleLt);
  }
  return { children: children.map(([a, b]) => [b, a]), parent };
}

/** `_hc_get_descendent`: leaves below `node`. */
function descendents(node, children, nLeaves) {
  if (node < nLeaves) return [node];
  const ind = [node];
  const out = [];
  let count = 1;
  while (count) {
    const i = ind.pop();
    if (i < nLeaves) {
      out.push(i);
      count--;
    } else {
      ind.push(...children[i - nLeaves]);
      count++;
    }
  }
  return out;
}

/** `_hc_cut`: labels of `nClusters` clusters from a full tree. */
function hcCut(nClusters, children, nLeaves) {
  if (nClusters > nLeaves) throw new Error(`ValueError: Cannot extract more clusters than samples: ${nClusters} clusters were given for a tree with ${nLeaves} leaves.`);
  const last = children[children.length - 1];
  const nodes = [-(Math.max(...last) + 1)];
  for (let c = 0; c < nClusters - 1; c++) {
    const these = children[-nodes[0] - nLeaves];
    heappush(nodes, -these[0], numLt);
    heappushpop(nodes, -these[1], numLt);
  }
  const label = new Int32Array(nLeaves);
  nodes.forEach((node, i) => {
    for (const leaf of descendents(-node, children, nLeaves)) label[leaf] = i;
  });
  return label;
}

/** `hc_get_heads` + `searchsorted(unique(heads), heads)` for an early-stopped tree. */
function headLabels(parent, nSamples) {
  const p = Int32Array.from(parent);
  for (let node0 = p.length - 1; node0 >= 0; node0--) {
    let node = node0;
    let par = p[node];
    while (par !== node) {
      p[node0] = par;
      node = par;
      par = p[node];
    }
  }
  const heads = Array.from(p.subarray(0, nSamples));
  const uniq = [...new Set(heads)].sort((a, b) => a - b);
  const rank = new Map(uniq.map((h, i) => [h, i]));
  return Int32Array.from(heads, (h) => rank.get(h));
}

/**
 * `linkage_tree(X, connectivity, n_clusters, linkage, affinity)` for complete
 * and average linkage: edges in a heap compared by weight only (sklearn's
 * `WeightedEdge`), cluster neighbourhoods as key-ordered maps merged by max
 * or size-weighted mean (`max_merge` / `average_merge`).
 */
function linkageTree(X, rows, nClusters, linkage, metric) {
  const nSamples = X.length;
  if (nClusters !== null && nClusters > nSamples) throw new Error(`ValueError: Cannot provide more clusters than samples. ${nClusters} n_clusters was asked, and there are ${nSamples} samples.`);
  const nNodes = nClusters === null ? 2 * nSamples - 1 : 2 * nSamples - nClusters;
  const lt = (a, b) => a[0] < b[0];
  // A[i]: Map neighbour -> distance, kept in ascending key order (std::map)
  const A = new Array(nNodes).fill(null);
  const inertia = [];
  rows.forEach((r, ind) => {
    const nbrs = r.filter((c) => c !== ind);
    A[ind] = new Map(nbrs.map((c) => [c, edgeDistance(X, ind, c, metric)]));
    for (const c of nbrs) if (c < ind) inertia.push([A[ind].get(c), ind, c]);
  });
  heapify(inertia, lt);
  const parent = Int32Array.from({ length: nNodes }, (_, i) => i);
  const used = new Int32Array(nNodes).fill(1);
  const children = [];
  const sortedMap = (m) => new Map([...m.entries()].sort((a, b) => a[0] - b[0]));
  for (let k = nSamples; k < nNodes; k++) {
    let i;
    let j;
    for (;;) {
      [, i, j] = heappop(inertia, lt);
      if (used[i] && used[j]) break;
    }
    parent[i] = k;
    parent[j] = k;
    children.push([i, j]);
    const ni = used[i];
    const nj = used[j];
    used[k] = ni + nj;
    used[i] = 0;
    used[j] = 0;
    const merged = new Map();
    for (const [c, d] of A[i]) if (used[c]) merged.set(c, d);
    for (const [c, d] of A[j]) {
      if (!used[c]) continue;
      if (!merged.has(c)) merged.set(c, d);
      else if (linkage === "complete") merged.set(c, Math.max(merged.get(c), d));
      else merged.set(c, (ni * merged.get(c) + nj * d) / (ni + nj));
    }
    const coord = sortedMap(merged);
    for (const [c, d] of coord) {
      A[c].set(k, d);
      heappush(inertia, [d, k, c], lt);
    }
    A[k] = coord;
    A[i] = null;
    A[j] = null;
  }
  return { children: children.map(([a, b]) => [b, a]), parent };
}

/**
 * `_single_linkage_tree`: scipy's `minimum_spanning_tree` of the
 * connectivity graph (Kruskal over a stable sort of the CSR entries; zero
 * distances count as machine epsilon), its edges stably sorted by weight and
 * merged with sklearn's `_single_linkage_label` union-find.
 */
function singleLinkageTree(X, rows, nClusters, metric) {
  const nSamples = X.length;
  const nNodes = nClusters === null ? 2 * nSamples - 1 : 2 * nSamples - nClusters;
  const eps = Number.EPSILON;
  const edges = [];
  rows.forEach((r, i) => {
    for (const j of r) {
      if (j === i) continue;
      const d = edgeDistance(X, i, j, metric);
      edges.push([i, j, d === 0 ? eps : d]);
    }
  });
  const byWeight = (list) => list.map((_, k) => k).sort((a, b) => list[a][2] - list[b][2] || a - b);
  // Kruskal: keep an entry when it joins two trees
  const root = Int32Array.from({ length: nSamples }, (_, i) => i);
  const find = (x) => {
    while (root[x] !== x) {
      root[x] = root[root[x]];
      x = root[x];
    }
    return x;
  };
  const keep = new Uint8Array(edges.length);
  for (const k of byWeight(edges)) {
    const a = find(edges[k][0]);
    const b = find(edges[k][1]);
    if (a !== b) {
      root[a] = b;
      keep[k] = 1;
    }
  }
  // the tree's entries in CSR order, epsilon undone, stably sorted by weight
  const mst = edges.filter((_, k) => keep[k]).map(([i, j, d]) => [i, j, d === eps ? 0 : d]);
  const sorted = byWeight(mst).map((k) => mst[k]);
  // `_single_linkage_label` (UnionFind with path shortcuts)
  const parentUF = new Int32Array(2 * nSamples - 1).fill(-1);
  let nextLabel = nSamples;
  const fastFind = (n0) => {
    let n = n0;
    while (parentUF[n] !== -1) n = parentUF[n];
    let p = n0;
    while (p !== n && parentUF[p] !== n) {
      const q = parentUF[p];
      parentUF[p] = n;
      p = q;
    }
    return n;
  };
  const children = sorted.map(([a, b]) => {
    const l = fastFind(a);
    const r = fastFind(b);
    parentUF[l] = nextLabel;
    parentUF[r] = nextLabel;
    nextLabel++;
    return [l, r];
  });
  const parent = Int32Array.from({ length: nNodes }, (_, i) => i);
  children.forEach(([l, r], k) => {
    const i = nSamples + k;
    if (nClusters !== null && i >= nNodes) return;
    if (l < nNodes) parent[l] = i;
    if (r < nNodes) parent[r] = i;
  });
  return { children, parent };
}

/**
 * Labels of `AgglomerativeClustering(n_clusters, connectivity, linkage,
 * metric).fit_predict(X)`: `X` rows are samples, `adjacency` a list of
 * `[i, j]` connected sample pairs. Linkages "ward", "complete", "average"
 * and "single"; metrics "euclidean"/"l2", "manhattan"/"l1", "cosine",
 * "precomputed" (`X` is the distance matrix) or a function of two rows.
 */
export function agglomerativeClustering(X, adjacency, nClusters, { linkage = "ward", metric = "euclidean" } = {}) {
  const nSamples = X.length;
  if (linkage !== "ward" && metric === "cosine" && X.some((x) => x.every((v) => v === 0))) {
    throw new Error("ValueError: Cosine affinity cannot be used when X contains zero vectors");
  }
  const { rows } = fixConnectivity(X, adjacency, linkage === "ward" ? "euclidean" : metric);
  const full = nClusters < Math.max(100, 0.02 * nSamples);
  const k = full ? null : nClusters;
  const tree = linkage === "ward" ? wardTree(X, rows, k) : linkage === "single" ? singleLinkageTree(X, rows, k, metric) : linkageTree(X, rows, k, linkage, metric);
  return full ? hcCut(nClusters, tree.children, nSamples) : headLabels(tree.parent, nSamples);
}

/** Ward clustering (`agglomerativeClustering` with linkage "ward"). */
export function wardClustering(X, adjacency, nClusters) {
  return agglomerativeClustering(X, adjacency, nClusters);
}

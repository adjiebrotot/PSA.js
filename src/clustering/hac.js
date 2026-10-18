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

/**
 * sklearn `euclidean_distances` (squared, before the square root) between
 * rows: `-2 X.Y^T + |x|^2 + |y|^2`, the products accumulated with FMA as in
 * the BLAS kernel, the norms summed plainly (`einsum`). Rounding matters:
 * identical points need not come out at exactly zero.
 */
function sqDistances(Xi, Xj) {
  const norm = (x) => x.reduce((s, v) => s + v * v, 0);
  return Xi.map((x) => {
    const xx = norm(x);
    return Xj.map((y) => {
      let dot = 0;
      for (let k = 0; k < x.length; k++) dot = pyFma(x[k], y[k], dot);
      return Math.max(-2 * dot + xx + norm(y), 0);
    });
  });
}

/**
 * `_fix_connectivity`: symmetric row lists (sorted, LIL), and when the graph
 * is disconnected every pair of components joined at their closest samples.
 */
function fixConnectivity(X, adjacency) {
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
        const D = sqDistances(
          idxI.map((p) => X[p]),
          idxJ.map((p) => X[p]),
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
 * Labels of `AgglomerativeClustering(n_clusters, connectivity, linkage="ward")
 * .fit_predict(X)`: `X` rows are samples, `adjacency` a list of `[i, j]`
 * connected sample pairs.
 */
export function wardClustering(X, adjacency, nClusters) {
  const nSamples = X.length;
  const { rows } = fixConnectivity(X, adjacency);
  const full = nClusters < Math.max(100, 0.02 * nSamples);
  const { children, parent } = wardTree(X, rows, full ? null : nClusters);
  return full ? hcCut(nClusters, children, nSamples) : headLabels(parent, nSamples);
}

// SPDX-License-Identifier: MIT
/**
 * Small sparse linear algebra toolkit (just enough for PyPSA's power flow):
 * compressed sparse column matrices, a minimum-degree fill-reducing
 * ordering and a left-looking (Gilbert–Peierls) sparse LU with threshold
 * partial pivoting.
 */

export class CSC {
  /**
   * @param {number} m rows
   * @param {number} n columns
   * @param {Int32Array} colptr
   * @param {Int32Array} rowind
   * @param {Float64Array} values
   */
  constructor(m, n, colptr, rowind, values) {
    this.m = m;
    this.n = n;
    this.colptr = colptr;
    this.rowind = rowind;
    this.values = values;
  }

  /** Build from triplets, summing duplicates. */
  static fromTriplets(m, n, rows, cols, vals) {
    const nnz = rows.length;
    const count = new Int32Array(n + 1);
    for (let k = 0; k < nnz; k++) count[cols[k] + 1]++;
    for (let j = 0; j < n; j++) count[j + 1] += count[j];
    const next = count.slice(0, n);
    const ri = new Int32Array(nnz);
    const vv = new Float64Array(nnz);
    for (let k = 0; k < nnz; k++) {
      const p = next[cols[k]]++;
      ri[p] = rows[k];
      vv[p] = vals[k];
    }
    // sort rows within columns and sum duplicates
    const colptr = new Int32Array(n + 1);
    const outR = [];
    const outV = [];
    const mark = new Int32Array(m).fill(-1);
    for (let j = 0; j < n; j++) {
      colptr[j] = outR.length;
      const start = count[j];
      const end = count[j + 1];
      const idx = [];
      for (let p = start; p < end; p++) idx.push(p);
      idx.sort((a, b) => ri[a] - ri[b]);
      for (const p of idx) {
        const r = ri[p];
        if (mark[r] === j) outV[outV.length - 1] += vv[p];
        else {
          mark[r] = j;
          outR.push(r);
          outV.push(vv[p]);
        }
      }
    }
    colptr[n] = outR.length;
    return new CSC(m, n, colptr, Int32Array.from(outR), Float64Array.from(outV));
  }

  static fromDense(rows) {
    const m = rows.length;
    const n = m ? rows[0].length : 0;
    const r = [];
    const c = [];
    const v = [];
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) if (rows[i][j] !== 0) r.push(i) && c.push(j) && v.push(rows[i][j]);
    return CSC.fromTriplets(m, n, r, c, v);
  }

  get nnz() {
    return this.colptr[this.n];
  }

  transpose() {
    const rows = [];
    const cols = [];
    const vals = [];
    for (let j = 0; j < this.n; j++) {
      for (let p = this.colptr[j]; p < this.colptr[j + 1]; p++) {
        rows.push(j);
        cols.push(this.rowind[p]);
        vals.push(this.values[p]);
      }
    }
    return CSC.fromTriplets(this.n, this.m, rows, cols, vals);
  }

  /** y = A x */
  matvec(x) {
    const y = new Float64Array(this.m);
    for (let j = 0; j < this.n; j++) {
      const xj = x[j];
      if (xj === 0) continue;
      for (let p = this.colptr[j]; p < this.colptr[j + 1]; p++) y[this.rowind[p]] += this.values[p] * xj;
    }
    return y;
  }

  /** y = A^T x */
  rmatvec(x) {
    const y = new Float64Array(this.n);
    for (let j = 0; j < this.n; j++) {
      let s = 0;
      for (let p = this.colptr[j]; p < this.colptr[j + 1]; p++) s += this.values[p] * x[this.rowind[p]];
      y[j] = s;
    }
    return y;
  }

  /** Sparse product A * B. */
  mul(B) {
    if (this.n !== B.m) throw new Error("dimension mismatch");
    const rows = [];
    const cols = [];
    const vals = [];
    const acc = new Float64Array(this.m);
    const mark = new Int32Array(this.m).fill(-1);
    for (let j = 0; j < B.n; j++) {
      const touched = [];
      for (let q = B.colptr[j]; q < B.colptr[j + 1]; q++) {
        const k = B.rowind[q];
        const bkj = B.values[q];
        for (let p = this.colptr[k]; p < this.colptr[k + 1]; p++) {
          const i = this.rowind[p];
          if (mark[i] !== j) {
            mark[i] = j;
            acc[i] = 0;
            touched.push(i);
          }
          acc[i] += this.values[p] * bkj;
        }
      }
      for (const i of touched) {
        rows.push(i);
        cols.push(j);
        vals.push(acc[i]);
      }
    }
    return CSC.fromTriplets(this.m, B.n, rows, cols, vals);
  }

  /** Scale columns: A * diag(d). */
  scaleCols(d) {
    const v = this.values.slice();
    for (let j = 0; j < this.n; j++) for (let p = this.colptr[j]; p < this.colptr[j + 1]; p++) v[p] *= d[j];
    return new CSC(this.m, this.n, this.colptr, this.rowind, v);
  }

  /** Scale rows: diag(d) * A. */
  scaleRows(d) {
    const v = this.values.slice();
    for (let j = 0; j < this.n; j++) for (let p = this.colptr[j]; p < this.colptr[j + 1]; p++) v[p] *= d[this.rowind[p]];
    return new CSC(this.m, this.n, this.colptr, this.rowind, v);
  }

  /** Sub-matrix with given row and column index lists. */
  sub(rowIdx, colIdx) {
    const rmap = new Int32Array(this.m).fill(-1);
    rowIdx.forEach((r, i) => (rmap[r] = i));
    const rows = [];
    const cols = [];
    const vals = [];
    colIdx.forEach((c, jj) => {
      for (let p = this.colptr[c]; p < this.colptr[c + 1]; p++) {
        const r = rmap[this.rowind[p]];
        if (r >= 0) {
          rows.push(r);
          cols.push(jj);
          vals.push(this.values[p]);
        }
      }
    });
    return CSC.fromTriplets(rowIdx.length, colIdx.length, rows, cols, vals);
  }

  toDense() {
    const out = Array.from({ length: this.m }, () => new Float64Array(this.n));
    for (let j = 0; j < this.n; j++) for (let p = this.colptr[j]; p < this.colptr[j + 1]; p++) out[this.rowind[p]][j] += this.values[p];
    return out;
  }
}

/** Diagonal sparse matrix. */
export function diag(d) {
  const n = d.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  return CSC.fromTriplets(n, n, idx, idx, Array.from(d));
}

// ----------------------------------------------------------------------
// Minimum degree ordering on the pattern of A + A^T
// ----------------------------------------------------------------------

export function minimumDegreeOrdering(A) {
  const n = A.n;
  const adj = Array.from({ length: n }, () => new Set());
  for (let j = 0; j < n; j++) {
    for (let p = A.colptr[j]; p < A.colptr[j + 1]; p++) {
      const i = A.rowind[p];
      if (i !== j) {
        adj[i].add(j);
        adj[j].add(i);
      }
    }
  }
  const eliminated = new Uint8Array(n);
  const order = new Int32Array(n);
  // binary heap keyed by (degree, index) with lazy deletion
  const heap = [];
  const push = (deg, v) => {
    heap.push([deg, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const pa = (i - 1) >> 1;
      if (heap[pa][0] < deg || (heap[pa][0] === deg && heap[pa][1] < v)) break;
      heap[i] = heap[pa];
      i = pa;
    }
    heap[i] = [deg, v];
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      const nh = heap.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const cmp = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
        let best = last;
        if (l < nh && cmp(heap[l], best)) {
          m = l;
          best = heap[l];
        }
        if (r < nh && cmp(heap[r], best)) m = r;
        if (m === i) break;
        heap[i] = heap[m];
        i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  for (let v = 0; v < n; v++) push(adj[v].size, v);
  let k = 0;
  while (k < n) {
    const [deg, v] = pop();
    if (eliminated[v] || deg !== adj[v].size) continue;
    eliminated[v] = 1;
    order[k++] = v;
    const nbrs = [...adj[v]];
    for (const a of nbrs) adj[a].delete(v);
    for (let x = 0; x < nbrs.length; x++) {
      const a = nbrs[x];
      for (let y = x + 1; y < nbrs.length; y++) {
        const b = nbrs[y];
        if (!adj[a].has(b)) {
          adj[a].add(b);
          adj[b].add(a);
        }
      }
    }
    for (const a of nbrs) push(adj[a].size, a);
    adj[v].clear();
  }
  return order;
}

// ----------------------------------------------------------------------
// Sparse LU
// ----------------------------------------------------------------------

export class SingularMatrixError extends Error {}

/**
 * Factorise square A as P A Q = L U.
 * @param {CSC} A
 * @param {object} [opts]
 * @param {number} [opts.tol=0.1] diagonal pivoting threshold
 */
export function sparseLU(A, { tol = 0.1, order = null } = {}) {
  const n = A.n;
  if (A.m !== n) throw new Error("sparseLU requires a square matrix");
  const q = order ?? minimumDegreeOrdering(A);
  const pinv = new Int32Array(n).fill(-1); // row -> step
  const prow = new Int32Array(n); // step -> row
  // L columns (original row indices), U columns (step indices)
  const Lp = [];
  const Lv = [];
  const Up = [];
  const Uv = [];
  const Udiag = new Float64Array(n);
  const x = new Float64Array(n);
  const mark = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const posStack = new Int32Array(n);
  const topo = new Int32Array(n);

  for (let k = 0; k < n; k++) {
    const col = q[k];
    // --- symbolic: reach of nonzeros of A(:,col) in graph of L
    let top = n;
    for (let p = A.colptr[col]; p < A.colptr[col + 1]; p++) {
      const start = A.rowind[p];
      if (mark[start] === k) continue;
      // iterative DFS
      let head = 0;
      stack[0] = start;
      mark[start] = k;
      posStack[0] = 0;
      while (head >= 0) {
        const i = stack[head];
        const j = pinv[i];
        let done = true;
        if (j >= 0) {
          const rows = Lp[j];
          for (let t = posStack[head]; t < rows.length; t++) {
            const r = rows[t];
            if (mark[r] !== k) {
              posStack[head] = t + 1;
              mark[r] = k;
              head++;
              stack[head] = r;
              posStack[head] = 0;
              done = false;
              break;
            }
          }
        }
        if (done) {
          head--;
          topo[--top] = i;
        }
      }
    }
    // --- numeric: sparse triangular solve
    for (let t = top; t < n; t++) x[topo[t]] = 0;
    for (let p = A.colptr[col]; p < A.colptr[col + 1]; p++) x[A.rowind[p]] += A.values[p];
    for (let t = top; t < n; t++) {
      const i = topo[t];
      const j = pinv[i];
      if (j < 0) continue;
      const xi = x[i];
      if (xi === 0) continue;
      const rows = Lp[j];
      const vals = Lv[j];
      for (let s = 0; s < rows.length; s++) x[rows[s]] -= vals[s] * xi;
    }
    // --- pivot selection
    let ipiv = -1;
    let amax = -1;
    for (let t = top; t < n; t++) {
      const i = topo[t];
      if (pinv[i] < 0) {
        const a = Math.abs(x[i]);
        if (a > amax) {
          amax = a;
          ipiv = i;
        }
      }
    }
    if (ipiv === -1 || amax <= 0) throw new SingularMatrixError("Matrix is exactly singular");
    // prefer the "diagonal" (row col) if acceptable
    if (pinv[col] < 0 && mark[col] === k && Math.abs(x[col]) >= tol * amax) ipiv = col;
    const pivot = x[ipiv];
    pinv[ipiv] = k;
    prow[k] = ipiv;
    Udiag[k] = pivot;
    const uRows = [];
    const uVals = [];
    const lRows = [];
    const lVals = [];
    for (let t = top; t < n; t++) {
      const i = topo[t];
      const v = x[i];
      if (i === ipiv) continue;
      const j = pinv[i];
      if (j >= 0) {
        if (v !== 0) {
          uRows.push(j);
          uVals.push(v);
        }
      } else if (v !== 0) {
        lRows.push(i);
        lVals.push(v / pivot);
      }
    }
    Up.push(Int32Array.from(uRows));
    Uv.push(Float64Array.from(uVals));
    Lp.push(Int32Array.from(lRows));
    Lv.push(Float64Array.from(lVals));
  }
  return new LUFactor(n, q, prow, Lp, Lv, Up, Uv, Udiag);
}

export class LUFactor {
  constructor(n, q, prow, Lp, Lv, Up, Uv, Udiag) {
    Object.assign(this, { n, q, prow, Lp, Lv, Up, Uv, Udiag });
  }

  /** Solve A x = b. */
  solve(b) {
    const n = this.n;
    const z = Float64Array.from(b);
    const w = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const r = this.prow[k];
      const v = z[r];
      w[k] = v;
      if (v === 0) continue;
      const rows = this.Lp[k];
      const vals = this.Lv[k];
      for (let s = 0; s < rows.length; s++) z[rows[s]] -= vals[s] * v;
    }
    for (let k = n - 1; k >= 0; k--) {
      const yk = w[k] / this.Udiag[k];
      w[k] = yk;
      if (yk === 0) continue;
      const rows = this.Up[k];
      const vals = this.Uv[k];
      for (let s = 0; s < rows.length; s++) w[rows[s]] -= vals[s] * yk;
    }
    const x = new Float64Array(n);
    for (let k = 0; k < n; k++) x[this.q[k]] = w[k];
    return x;
  }
}

/** Solve A x = b for one or many right-hand sides (array of vectors). */
export function spsolve(A, b) {
  const lu = sparseLU(A);
  if (Array.isArray(b) && b.length && typeof b[0] === "object") return b.map((r) => lu.solve(r));
  return lu.solve(b);
}

/** Infinity norm of a vector. */
export function normInf(v) {
  let m = 0;
  for (const x of v) {
    const a = Math.abs(x);
    if (Number.isNaN(a)) return NaN;
    if (a > m) m = a;
  }
  return m;
}

/** Dense Moore–Penrose pseudo-inverse of a symmetric matrix via eigen-decomposition (Jacobi). */
export function pinvSymmetric(M, rcond = 1e-15) {
  const n = M.length;
  const a = M.map((r) => Float64Array.from(r));
  const v = Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n);
    r[i] = 1;
    return r;
  });
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let qq = p + 1; qq < n; qq++) off += a[p][qq] * a[p][qq];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let qq = p + 1; qq < n; qq++) {
        const apq = a[p][qq];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[qq][qq] - a[p][p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][qq];
          a[k][p] = c * akp - s * akq;
          a[k][qq] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[qq][k];
          a[p][k] = c * apk - s * aqk;
          a[qq][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][qq];
          v[k][p] = c * vkp - s * vkq;
          v[k][qq] = s * vkp + c * vkq;
        }
      }
    }
  }
  const eig = a.map((r, i) => r[i]);
  const maxEig = Math.max(...eig.map(Math.abs));
  const cutoff = rcond * maxEig;
  const out = Array.from({ length: n }, () => new Float64Array(n));
  for (let k = 0; k < n; k++) {
    if (Math.abs(eig[k]) <= cutoff) continue;
    const inv = 1 / eig[k];
    for (let i = 0; i < n; i++) {
      const vik = v[i][k] * inv;
      if (vik === 0) continue;
      for (let j = 0; j < n; j++) out[i][j] += vik * v[j][k];
    }
  }
  return out;
}

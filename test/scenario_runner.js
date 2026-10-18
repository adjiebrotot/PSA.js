// SPDX-License-Identifier: MIT
/**
 * Executes JSON parity scenarios with PSA.js (the JS twin of
 * scripts/parity/run_scenarios.py).
 */

import assert from "node:assert/strict";
import { Network, NetworkCollection, DataFrame, Series, Index, LinearExpression, QuadraticExpression } from "../src/index.js";
import path from "node:path";
import { ROOT, examplePath, decode as decodeFixture, assertFrameClose, assertSeriesClose, assertNetworkMatches, isClose, fmtLabel } from "./helpers.js";

function dateRange({ start, periods, freq = "h" }) {
  const m = /^(\d*)(h|D|min|s)$/.exec(freq);
  const step = (m[1] ? Number(m[1]) : 1) * { h: 36e5, D: 864e5, min: 6e4, s: 1e3 }[m[2]];
  const [d, t = "00:00:00"] = start.split(/[ T]/);
  const [Y, M, D] = d.split("-").map(Number);
  const [hh, mm, ss = 0] = t.split(":").map(Number);
  const t0 = Date.UTC(Y, M - 1, D, hh, mm, ss);
  const p = (x) => String(x).padStart(2, "0");
  return Array.from({ length: periods }, (_, i) => {
    const dt = new Date(t0 + i * step);
    return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
  });
}

export function decodeValue(v, n) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if ("$float" in v) return v.$float === "inf" ? Infinity : v.$float === "-inf" ? -Infinity : NaN;
    if ("$ts" in v) return v.$ts;
    if ("$slice" in v) return n.snapshots.slice(...v.$slice);
    if ("$date_range" in v) return dateRange(v.$date_range);
    if ("$index" in v) return new Index(v.$index.values, v.$index.name ?? null);
    if ("$multiindex_named" in v) return new Index(v.$multiindex_named.tuples, v.$multiindex_named.names);
    if ("$multiindex" in v) return new Index(v.$multiindex, v.$multiindex[0].map(() => null));
    if ("$path" in v) return getPathSync(n, v.$path);
    if ("$tuple" in v) return v.$tuple.map((x) => decodeValue(x, n));
    if ("$frame" in v) {
      const spec = v.$frame;
      const data = new Map();
      spec.columns.forEach((c, j) => data.set(c, Float64Array.from(spec.data, (row) => Number(decodeValue(row[j], n)))));
      return new DataFrame({ index: n.snapshots, columns: spec.columns, data });
    }
    if ("$pairs" in v) return new Map(v.$pairs.map(([k, x]) => [decodeValue(k, n), decodeValue(x, n)]));
    if ("$df" in v) {
      const spec = v.$df;
      const data = new Map();
      spec.columns.forEach((c, j) => data.set(c, spec.data.map((row) => decodeValue(row[j], n))));
      const columns = spec.column_names ? new Index(spec.columns, spec.column_names) : spec.columns;
      return new DataFrame({ index: new Index(spec.index, spec.index_name ?? null), columns, data });
    }
    if ("$pandapower" in v) return path.join(ROOT, v.$pandapower);
    if ("$ppc" in v) return v.$ppc;
    if ("$columns" in v) {
      // a column subset of a frame reached by path
      const df = getPathSync(n, v.$columns.path);
      return new DataFrame({ index: df.index, columns: v.$columns.columns, data: new Map(v.$columns.columns.map((c) => [c, df.col(c)])) });
    }
    if ("$var" in v) return n.model.variables.get(v.$var);
    if ("$result" in v) return currentResults[v.$result];
    if ("$da" in v) {
      // a constant with named dims: a Series (1-D) or DataFrame (2-D) whose
      // index/column names carry the dims
      const spec = v.$da;
      const coord = (d) => (d === "snapshot" && !spec.coords?.snapshot ? n.snapshots.rename("snapshot") : new Index(spec.coords[d], d));
      const data = decodeValue(spec.data, n);
      if (spec.dims.length === 1) return new Series(data, coord(spec.dims[0]), spec.name ?? null);
      const rows = coord(spec.dims[0]);
      const cols = coord(spec.dims[1]);
      const m = new Map();
      cols.values.forEach((c, j) => m.set(c, data.map((row) => row[j])));
      return new DataFrame({ index: rows, columns: cols, data: m });
    }
    if ("$series" in v) {
      const spec = v.$series;
      const vals = spec.values.map((x) => decodeValue(x, n));
      return new Series(vals, spec.index ? new Index(spec.index) : n.snapshots);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeValue(x, n)]));
  }
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, n));
  return v;
}

function callWithKwargs(target, fnName, args, kwargs) {
  // `obj(...)` (Python `__call__`) on callable accessors such as n.statistics
  if (fnName === "__call__" && typeof target === "function") {
    return kwargs && Object.keys(kwargs).length ? target(...args, kwargs) : target(...args);
  }
  const fn = target[fnName];
  if (typeof fn !== "function") throw new Error(`${fnName} is not a function on ${target}`);
  if (kwargs && Object.keys(kwargs).length) return fn.call(target, ...args, kwargs);
  return fn.call(target, ...args);
}

function step(obj, p) {
  if (obj instanceof Map && obj.has(p)) return obj.get(p);
  if (obj instanceof DataFrame) return obj.series(p);
  if (obj instanceof Series) return obj.get(p);
  return obj[p];
}

export function getPathSync(n, path) {
  let obj = n;
  for (const p of path) {
    if (Array.isArray(p)) {
      const [name, args = [], kwargs = {}] = p;
      obj = callWithKwargs(obj, name, decodeValue(args, n), decodeValue(kwargs, n));
    } else obj = step(obj, p);
  }
  return obj;
}

export async function getPath(n, path) {
  let obj = n;
  for (const p of path) {
    if (Array.isArray(p)) {
      const [name, args = [], kwargs = {}] = p;
      obj = await callWithKwargs(obj, name, decodeValue(args, n), decodeValue(kwargs, n));
    } else if (obj instanceof Map && obj.has(p)) {
      obj = obj.get(p);
    } else if (obj instanceof DataFrame) {
      obj = obj.series(p);
    } else if (obj instanceof Series) {
      obj = obj.get(p);
    } else {
      obj = obj[p];
    }
  }
  return obj;
}

// results of the running scenario (for `$result` references)
let currentResults = {};

// Python operator methods used in scenario call chains
const DUNDER = { __pow__: "pow", __neg__: "neg", __mul__: "mul", __add__: "add", __sub__: "sub" };

export async function runScenario(scenario, onRecord = null) {
  let n = null;
  const records = {};
  const saved = {};
  const results = {};
  currentResults = results;
  const runOp = async (op) => {
    const kind = op[0];
    switch (kind) {
      case "load_example":
        n = Network.from_csv_folder(examplePath(op[1]));
        break;
      case "load_network":
        n = Network.from_csv_folder(path.join(ROOT, "test", "networks", op[1]));
        break;
      case "new_network":
        n = new Network(op[1] ?? {});
        break;
      case "set_snapshots":
        n.set_snapshots(decodeValue(op[1], n), op[2] ?? {});
        break;
      case "set_multi_snapshots":
        n.set_snapshots(new Index(op[1], ["period", "timestep"]));
        break;
      case "set_investment_periods":
        n.set_investment_periods(op[1]);
        break;
      case "add":
        n.add(op[1], decodeValue(op[2], n), decodeValue(op[3] ?? {}, n), op[4] ?? {});
        break;
      case "remove":
        n.remove(op[1], op[2]);
        break;
      case "set_static": {
        const [, listName, attr, mapping] = op;
        for (const [k, v] of Object.entries(mapping)) n.c.get(listName).static.setAt(k, attr, decodeValue(v, n));
        break;
      }
      case "set_static_sc": {
        // scenario-specific static values on a stochastic network
        const [, listName, attr, scenario, mapping] = op;
        for (const [k, v] of Object.entries(mapping)) n.c.get(listName).static.setAt([scenario, k], attr, decodeValue(v, n));
        break;
      }
      case "set_static_where": {
        const [, listName, attr, col, match, v] = op;
        const st = n.c.get(listName).static;
        const val = decodeValue(v, n);
        st.index.values.forEach((nm, i) => {
          if (st.col(col)[i] === match) st.setAt(nm, attr, val);
        });
        break;
      }
      case "set_static_all": {
        const [, listName, attr, v] = op;
        const st = n.c.get(listName).static;
        const val = decodeValue(v, n);
        const prev = st.colOr(attr, null);
        if (val instanceof Series) st.set(attr, prev instanceof Float64Array ? Float64Array.from(val.reindex(st.index).values) : val);
        else if (Array.isArray(val)) st.set(attr, prev instanceof Float64Array ? Float64Array.from(val) : val);
        else if (typeof val === "number" && (prev === null || prev instanceof Float64Array)) st.set(attr, new Float64Array(st.index.length).fill(val));
        else st.set(attr, st.index.values.map(() => val));
        break;
      }
      case "set_dynamic": {
        const [, listName, attr, mapping] = op;
        const c = n.c.get(listName);
        for (const [k, v] of Object.entries(mapping)) {
          const df = c.dynamic[attr];
          const val = decodeValue(v, n);
          df.set(k, typeof val === "number" ? new Float64Array(df.index.length).fill(val) : Float64Array.from(val));
        }
        break;
      }
      case "set_dynamic_sc": {
        const [, listName, attr, scenario, mapping] = op;
        const df = n.c.get(listName).dynamic[attr];
        for (const [k, v] of Object.entries(mapping)) {
          const val = decodeValue(v, n);
          df.set([scenario, k], typeof val === "number" ? new Float64Array(df.index.length).fill(val) : Float64Array.from(val));
        }
        break;
      }
      case "set_weightings":
        n.snapshot_weightings.set(op[1], Float64Array.from(decodeValue(op[2], n)));
        break;
      case "set_period_weightings":
        n.investment_period_weightings.set(op[1], Float64Array.from(decodeValue(op[2], n)));
        break;
      case "call": {
        const name = op[1];
        const args = decodeValue(op[2] ?? [], n);
        const kwargs = decodeValue(op[3] ?? {}, n);
        const parts = name.split(".");
        let target = n;
        for (const p of parts.slice(0, -1)) target = target[p];
        const res = await callWithKwargs(target, parts[parts.length - 1], args, kwargs);
        if (op[4]) results[op[4]] = res;
        break;
      }
      case "create_model":
        n.optimize.create_model(decodeValue(op[1] ?? {}, n));
        break;
      case "add_constraint": {
        const [, varName, dimsSpec, sign, rhs, cname] = op;
        let v = n.model.variables.get(varName).toExpr();
        let dims = dimsSpec;
        if (dims && typeof dims === "object" && !Array.isArray(dims)) {
          v = v.sel(decodeValue(dims.sel, n));
          dims = "sum" in dims ? dims.sum : "all";
        }
        const expr = dims === "all" ? v.sum() : dims === null ? v : v.sum(dims);
        n.model.add_constraints(expr, sign, decodeValue(rhs, n), { name: cname });
        break;
      }
      case "expression": {
        // n.optimize.expressions[stat](kwargs), optionally summed
        const [, outKey, stat, kwargs, post = null] = op;
        let e = n.optimize.expressions[stat](decodeValue(kwargs ?? {}, n));
        if (post !== null) e = post === "all" ? e.sum() : e.sum(post);
        results[outKey] = e;
        break;
      }
      case "linexpr": {
        // a chain of linopy calls starting from a model variable or an earlier result
        const [, outKey, start, chain] = op;
        let obj = "var" in start ? n.model.variables.get(start.var) : results[start.result];
        for (const [name, args = [], kwargs = {}] of chain) {
          obj = await callWithKwargs(obj, DUNDER[name] ?? name, decodeValue(args, n), decodeValue(kwargs, n));
        }
        results[outKey] = obj instanceof LinearExpression || obj instanceof QuadraticExpression ? obj : obj.toExpr();
        break;
      }
      case "set_objective": {
        // replace the objective by an expression (optionally added to the current one)
        const [, key, opts = {}] = op;
        let expr = results[key];
        if (opts.add) expr = n.model.objective_expression().add(expr);
        n.model.add_objective(expr, { overwrite: true, sense: opts.sense ?? "min" });
        break;
      }
      case "expr_constraint": {
        const [, outKey, sign, rhs, cname] = op;
        n.model.add_constraints(results[outKey], sign, decodeValue(rhs, n), { name: cname });
        break;
      }
      case "add_variable":
        n.model.add_variables({ name: op[1] });
        break;
      case "solve_model": {
        const res = await n.optimize.solve_model(decodeValue(op[1] ?? {}, n));
        if (op[2]) results[op[2]] = res;
        break;
      }
      case "call_replace": {
        const parts = op[1].split(".");
        let target = n;
        for (const p of parts.slice(0, -1)) target = target[p];
        const res = await callWithKwargs(target, parts[parts.length - 1], decodeValue(op[2] ?? [], n), decodeValue(op[3] ?? {}, n));
        if (op[4]) results[op[4]] = res;
        n = res instanceof Network ? res : res.n ?? res;
        break;
      }
      case "set_attr":
        n[op[1]] = decodeValue(op[2], n);
        break;
      case "save_network":
        saved[op[1]] = n;
        break;
      case "make_collection": {
        const kw = decodeValue(op[2] ?? {}, n);
        n = new NetworkCollection(op[1].map((k) => saved[k]), kw);
        break;
      }
      case "copy":
        n = n.copy(op[1] ?? {});
        break;
      case "record": {
        const key = op[1];
        const what = op[2];
        if (what === "network") records[key] = n;
        else if (what === "result") records[key] = results[op[3]];
        else if (what === "result_path") records[key] = await getPath(results[op[3]], op[4]);
        else if (what === "path") records[key] = await getPath(n, op[3]);
        else if (what === "model_lp") records[key] = { $lp: n.model.to_lp() };
        else if (what === "lp") records[key] = { $lp: n.optimize.create_model(decodeValue(op[3] ?? {}, n)).to_lp() };
        else throw new Error(`unknown record ${what}`);
        if (onRecord) onRecord(key, records[key]);
        break;
      }
      default:
        throw new Error(`unknown op ${kind}`);
    }
  };
  for (const op of scenario.ops) {
    if (op[0] === "expect_error") {
      let raised = false;
      try {
        await runOp(op[2]);
      } catch {
        raised = true;
      }
      records[op[1]] = raised;
      if (onRecord) onRecord(op[1], raised);
      continue;
    }
    await runOp(op);
  }
  return { network: n, records };
}

/** Compare a JS record value with a fixture record. */
export function assertRecordMatches(actual, expected, opts) {
  const where = opts.path ?? "record";
  switch (expected.$type) {
    case "network": {
      const exp = { ...expected };
      assertNetworkMatches(actual, exp, opts);
      break;
    }
    case "frame":
      assert.ok(actual instanceof DataFrame, `${where}: expected DataFrame, got ${actual?.constructor?.name}`);
      if (opts.checkIndexNames) assert.deepEqual(actual.index.names, expected.index.names, `${where}: index names differ`);
      assertFrameClose(actual, expected, opts);
      break;
    case "series":
      assert.ok(actual instanceof Series, `${where}: expected Series, got ${actual?.constructor?.name}`);
      if (opts.checkIndexNames) assert.deepEqual(actual.index.names, expected.index.names, `${where}: index names differ`);
      assertSeriesClose(actual, expected, opts);
      break;
    case "index": {
      const vals = actual instanceof Index ? actual.values : actual;
      assert.deepEqual(vals.map(fmtLabel), expected.values.map(fmtLabel), `${where}: index differs`);
      break;
    }
    case "value": {
      const a = actual === null || actual === undefined ? NaN : actual;
      const b = decodeFixture(expected.value);
      if (!isClose(a, b, opts.rtol ?? 1e-9, opts.atol ?? 1e-9)) assert.fail(`${where}: PSA.js=${a} PyPSA=${b}`);
      break;
    }
    case "array": {
      const flatten = (x) => (Array.isArray(x) || ArrayBuffer.isView(x) ? Array.from(x).flatMap(flatten) : [x]);
      const flat = flatten(actual);
      assert.equal(flat.length, expected.values.length, `${where}: array size differs`);
      expected.values.forEach((v, i) => {
        const b = decodeFixture(v);
        if (!isClose(flat[i], b, opts.rtol ?? 1e-9, opts.atol ?? 1e-9)) assert.fail(`${where}[${i}]: PSA.js=${flat[i]} PyPSA=${b}`);
      });
      break;
    }
    case "lp":
      assertLpMatches(actual.$lp, expected.text, opts);
      break;
    case "linexpr":
    case "quadexpr":
      assertLinexprMatches(actual, expected, { ...opts, path: where });
      break;
    case "dict":
      for (const [k, v] of Object.entries(expected.items)) {
        const a = actual instanceof Map ? actual.get(k) : actual[k];
        assertRecordMatches(a, v, { ...opts, path: `${where}.${k}` });
      }
      break;
    case "list":
      expected.items.forEach((v, i) => assertRecordMatches(actual[i], v, { ...opts, path: `${where}[${i}]` }));
      break;
    default:
      throw new Error(`unknown record type ${expected.$type}`);
  }
}

/**
 * Compare a LinearExpression with linopy's: dims, coordinates (labels and
 * level names), the `_term` slot layout (variable labels incl. -1 padding),
 * coefficients of the present terms and constants.
 */
export function assertLinexprMatches(actual, expected, { exprRtol = 1e-12, path: where = "linexpr" } = {}) {
  assert.ok(actual && actual.vars && actual.dims, `${where}: expected a LinearExpression, got ${actual?.constructor?.name}`);
  // quadratic expressions hold a pair of variables per term
  const factors = expected.$type === "quadexpr" ? 2 : 1;
  assert.equal(actual instanceof QuadraticExpression, factors === 2, `${where}: expected a ${factors === 2 ? "Quadratic" : "Linear"}Expression, got ${actual.constructor.name}`);
  assert.deepEqual(actual.dims, expected.dims, `${where}: dims differ`);
  expected.coords.forEach((c, d) => {
    const idx = actual.coords[d];
    const norm = (v) => JSON.stringify(v, (_, x) => (typeof x === "number" && Number.isNaN(x) ? null : x));
    assert.deepEqual(idx.values.map(norm), c.values.map(norm), `${where}: coords of ${expected.dims[d]} differ`);
    assert.deepEqual(idx.names, c.names, `${where}: level names of ${expected.dims[d]} differ`);
  });
  assert.equal(actual.nterm, expected.nterm, `${where}: nterm differs`);
  assert.deepEqual(Array.from(actual.vars), expected.vars, `${where}: term variables differ`);
  const close = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= exprRtol * Math.max(Math.abs(a), Math.abs(b));
  expected.coeffs.forEach((c, i) => {
    const v = expected.vars[i * factors];
    if (v < 0) return;
    const b = decodeFixture(c);
    if (!close(actual.coeffs[i], b)) assert.fail(`${where}: coeff[${i}] (var ${v}) PSA.js=${actual.coeffs[i]} PyPSA=${b}`);
  });
  assert.equal(actual.consts.length, expected.const.length, `${where}: const size differs`);
  expected.const.forEach((v, i) => {
    const b = decodeFixture(v);
    const a = actual.consts[i];
    if (!(close(a, b) || (Number.isNaN(a) && Number.isNaN(b)))) assert.fail(`${where}: const[${i}] PSA.js=${a} PyPSA=${b}`);
  });
}

function parseNum(t) {
  if (t === "inf" || t === "+inf") return Infinity;
  if (t === "-inf") return -Infinity;
  if (!/^[+-]?(\d|\.\d)/.test(t)) return null;
  const v = Number(t);
  return Number.isNaN(v) ? null : v;
}

/** Compare LP texts: identical structure, numbers equal within tolerance. */
export function assertLpMatches(actual, expected, { lpRtol = 1e-12, path: where = "lp" } = {}) {
  if (actual === expected) return;
  // linopy writes the SOS sets in (non-deterministic) polars group order
  const sosSplit = (t) => {
    const i = t.indexOf("\n\nsos\n\n");
    return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i).split("\n").sort().join("\n")];
  };
  const [aMain, aSos] = sosSplit(actual);
  const [bMain, bSos] = sosSplit(expected);
  assert.equal(aSos, bSos, `${where}: SOS sections differ`);
  const a = aMain.split("\n");
  const b = bMain.split("\n");
  assert.equal(a.length, b.length, `${where}: LP line count differs (PSA.js ${a.length}, PyPSA ${b.length})`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ta = a[i].split(" ");
    const tb = b[i].split(" ");
    const fail = () => assert.fail(`${where}: line ${i + 1} differs:\n  PSA.js: ${a[i]}\n  PyPSA:  ${b[i]}`);
    if (ta.length !== tb.length) fail();
    for (let k = 0; k < ta.length; k++) {
      if (ta[k] === tb[k]) continue;
      const x = parseNum(ta[k]);
      const y = parseNum(tb[k]);
      if (x === null || y === null) fail();
      if (!(Math.abs(x - y) <= lpRtol * Math.max(Math.abs(x), Math.abs(y)))) fail();
    }
  }
}

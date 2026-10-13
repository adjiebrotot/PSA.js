// SPDX-License-Identifier: MIT
/**
 * Executes JSON parity scenarios with PSA.js (the JS twin of
 * scripts/parity/run_scenarios.py).
 */

import assert from "node:assert/strict";
import { Network, DataFrame, Series, Index } from "../src/index.js";
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
    if ("$multiindex" in v) return new Index(v.$multiindex, v.$multiindex[0].map(() => null));
    if ("$path" in v) return getPathSync(n, v.$path);
    if ("$tuple" in v) return v.$tuple.map((x) => decodeValue(x, n));
    if ("$frame" in v) {
      const spec = v.$frame;
      const data = new Map();
      spec.columns.forEach((c, j) => data.set(c, Float64Array.from(spec.data, (row) => Number(decodeValue(row[j], n)))));
      return new DataFrame({ index: n.snapshots, columns: spec.columns, data });
    }
    if ("$df" in v) {
      const spec = v.$df;
      const data = new Map();
      spec.columns.forEach((c, j) => data.set(c, spec.data.map((row) => decodeValue(row[j], n))));
      return new DataFrame({ index: new Index(spec.index), columns: spec.columns, data });
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

export async function runScenario(scenario, onRecord = null) {
  let n = null;
  const records = {};
  const results = {};
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
  const a = actual.split("\n");
  const b = expected.split("\n");
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

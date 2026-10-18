// SPDX-License-Identifier: MIT
/**
 * Statistics accessor (mirrors `pypsa.statistics`): capital and operational
 * expenditure, capacities, energy balances, curtailment, capacity factors,
 * revenues, market values and prices, grouped by carrier, bus carrier, bus,
 * country, ... like PyPSA.
 *
 * Results are `Series` (index: component and group levels) or, for
 * time-resolved / multi-period results, `DataFrame`s.
 */

import { Index, compareLabels, labelKey } from "../core/index.js";
import { DataFrame, Series } from "../core/frame.js";
import { Network } from "../network/network.js";
import { NOMINAL_ATTRS } from "../components/components.js";
import { LOOKUP } from "../optimization/common.js";
import { logger } from "../logger.js";
import { Tab, KeyError, isKeyError, groupRows, groupByLevels, concatRows, roundTo, aggregate } from "./table.js";
import { scenarioView } from "../network/scenarios.js";
import { PySet } from "../core/pyset.js";

import { statisticsOptions } from "../options.js";

export { statisticsOptions };

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

function staticCol(c, attr) {
  const st = c.static;
  if (!st.has(attr)) throw new KeyError(attr);
  return st.col(attr);
}

function staticGet(c, attr, fallback) {
  return c.static.has(attr) ? c.static.col(attr) : fallback;
}

function dynamic(c, attr) {
  const df = c.dynamic[attr];
  if (df === undefined) throw new KeyError(attr);
  return df;
}

/** Union of column labels like pandas arithmetic alignment (sorted when different). */
function alignColumns(a, b) {
  if (a.equals(b)) return a;
  return a.union(b);
}

/** Element-wise operation of two snapshot-indexed frames with column alignment. */
function frameOp(a, b, fn) {
  const cols = alignColumns(a.columns, b.columns);
  const nS = a.index.length;
  const out = new DataFrame({ index: a.index });
  const nan = new Float64Array(nS).fill(NaN);
  for (const c of cols) {
    const x = a.has(c) ? a.col(c) : nan;
    const y = b.has(c) ? b.col(c) : nan;
    out.set(c, Float64Array.from({ length: nS }, (_, i) => fn(x[i], y[i])));
  }
  return out;
}

/** Frame (snapshots x names) combined with a per-name series (pandas aligns on columns). */
function frameSeriesOp(df, names, values, fn) {
  const sIdx = names instanceof Index ? names : new Index(names);
  const cols = alignColumns(df.columns, sIdx);
  const nS = df.index.length;
  const out = new DataFrame({ index: df.index });
  for (const c of cols) {
    const x = df.has(c) ? df.col(c) : null;
    const p = sIdx.getLoc(c);
    const v = p < 0 ? NaN : values[p];
    out.set(c, Float64Array.from({ length: nS }, (_, i) => fn(x ? x[i] : NaN, v)));
  }
  return out;
}

function frameMap(df, fn) {
  const out = new DataFrame({ index: df.index });
  for (const c of df.columns) out.set(c, Float64Array.from(df.col(c), fn));
  return out;
}

function selectColumns(df, names) {
  const out = new DataFrame({ index: df.index });
  for (const c of names) {
    if (!df.has(c)) throw new KeyError(`${c} not in columns`);
    out.set(c, df.col(c));
  }
  return out;
}

/** pandas Series.map(mapping) with NaN for missing keys. */
function mapValues(values, keys, mapped) {
  const pos = new Map(keys.map((k, i) => [labelKey(k), i]));
  return values.map((v) => {
    const i = pos.get(labelKey(v));
    return i === undefined ? NaN : mapped[i];
  });
}

export function isNa(v) {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

export function normalizeCarrierNiceNames(n, carrier) {
  if (carrier === null || carrier === undefined) return carrier;
  const scalar = typeof carrier === "string";
  if (!scalar && !Array.isArray(carrier)) return carrier;
  const carriers = scalar ? [carrier] : carrier;
  const st = n.c.carriers.static;
  const nice = st.has("nice_name") ? st.col("nice_name") : [];
  // scenario-indexed carriers: the first value per name (`groupby(level="name").first()`)
  const seen = new Set();
  const entries = st.index.values
    .map((k, i) => [st.index.isMulti ? k[k.length - 1] : k, nice[i]])
    .filter(([k]) => (seen.has(k) ? false : seen.add(k)))
    .filter(([, v]) => v !== "" && !isNa(v));
  if (!entries.length) return carrier;
  const counts = new Map();
  for (const [, v] of entries) counts.set(v, (counts.get(v) ?? 0) + 1);
  const toCarrier = new Map(entries.filter(([, v]) => counts.get(v) === 1).map(([k, v]) => [v, k]));
  const out = carriers.map((c) => toCarrier.get(c) ?? c);
  return scalar ? out[0] : out;
}

/** Python `re.search` semantics for `str.contains`. */
export function contains(s, pattern) {
  if (typeof s !== "string") return false;
  try {
    return new RegExp(pattern).test(s);
  } catch {
    return s.includes(pattern);
  }
}

export function resolve_at_port(at_port, bus_carrier = null) {
  if (at_port === false) return 0;
  if (at_port === true) return "all";
  if (at_port === null || at_port === undefined) return bus_carrier ? "all" : [0];
  return at_port;
}

// ----------------------------------------------------------------------
// groupers
// ----------------------------------------------------------------------

/** Grouper functions return {name, values} aligned with the component's static index. */
export class Groupers {
  carrier(n, c, { nice_names = true } = {}) {
    const comp = n.c.get(c);
    const st = comp.static;
    let values = st.has("carrier") ? Array.from(st.col("carrier")) : st.index.values.map(() => "");
    if (nice_names) {
      const cs = n.c.carriers.static;
      const nice = cs.has("nice_name") ? cs.col("nice_name") : [];
      const keys = [];
      const mapped = [];
      cs.index.values.forEach((k, i) => {
        if (nice[i] !== "") {
          keys.push(k);
          mapped.push(nice[i]);
        }
      });
      const m = mapValues(values, keys, mapped);
      values = values.map((v, i) => (isNa(m[i]) ? v : m[i])).map((v) => (v === "" ? "-" : v));
    }
    return { name: "carrier", values };
  }

  bus_carrier(n, c, { port = "", nice_names = true } = {}) {
    const busCarrier = this.carrier(n, "Bus", { nice_names });
    const comp = n.c.get(c);
    const buses = staticCol(comp, `bus${port}`);
    return { name: "bus_carrier", values: mapValues(Array.from(buses), n.c.buses.static.index.values, busCarrier.values) };
  }

  bus(n, c, { port = "" } = {}) {
    return { name: "bus", values: Array.from(staticCol(n.c.get(c), `bus${port}`)) };
  }

  _busAttr(n, c, port, attr) {
    const buses = staticCol(n.c.get(c), `bus${port}`);
    const bs = n.c.buses.static;
    return { name: attr, values: mapValues(Array.from(buses), bs.index.values, Array.from(staticCol(n.c.get("Bus"), attr))) };
  }

  country(n, c, { port = "" } = {}) {
    return this._busAttr(n, c, port, "country");
  }

  location(n, c, { port = "" } = {}) {
    return this._busAttr(n, c, port, "location");
  }

  unit(n, c, { port = "" } = {}) {
    return this._busAttr(n, c, port, "unit");
  }

  name(n, c) {
    return { name: "name", values: n.c.get(c).static.index.values.slice() };
  }

  list_groupers() {
    const names = new Set(["carrier", "bus_carrier", "bus", "country", "location", "unit", "name"]);
    for (const k of Object.keys(this)) if (!k.startsWith("_")) names.add(k);
    return [...names];
  }

  /**
   * Register a custom grouper `(n, c, {port, nice_names}) => values aligned
   * with the static index` (or `{name, values}`).
   */
  add_grouper(name, fn) {
    this[name] = fn;
  }

  /** Resolve a groupby spec into a list of {name, values}. */
  resolve(n, c, keys, { port = "", nice_names = false } = {}) {
    const list = typeof keys === "string" || typeof keys === "function" ? [keys] : keys;
    return list.flatMap((key) => {
      if (typeof key === "function") {
        const g = key(n, c, { port, nice_names });
        // a list of Series groups by several keys (one level each), like pandas
        if (Array.isArray(g) && g.length && g.every((x) => x instanceof Series)) return g.map((x) => normalizeGrouper(x, "group"));
        if (g instanceof DataFrame) throw new Error("ValueError: Grouper for '<class 'pandas.DataFrame'>' not 1-dimensional");
        return [normalizeGrouper(g, "group")];
      }
      if (typeof this[key] === "function" && key !== "resolve" && key !== "add_grouper" && key !== "list_groupers") {
        return normalizeGrouper(this[key](n, c, { port, nice_names }), key);
      }
      const st = n.c.get(c).static;
      if (!st.has(key)) throw new KeyError(`Unknown grouper ${key}.`);
      return { name: key, values: Array.from(st.col(key)) };
    });
  }
}

function normalizeGrouper(g, fallbackName) {
  if (g instanceof Series) return { name: g.name ?? fallbackName, values: Array.from(g.values) };
  if (Array.isArray(g) || ArrayBuffer.isView(g)) return { name: fallbackName, values: Array.from(g) };
  return g;
}

export const groupers = new Groupers();

// ----------------------------------------------------------------------
// shared functions
// ----------------------------------------------------------------------

/** Operational time series used for capacity factors and market values. */
export function get_operation(n, c) {
  if (n.passive_branch_components.has(c)) return dynamic(n.c.get(c), "p0");
  if (c === "Store") return dynamic(n.c.get(c), "e");
  const p = dynamic(n.c.get(c), "p");
  if ((p.columns.length === 0 || p.index.length === 0) && n.branch_components.has(c)) return dynamic(n.c.get(c), "p0");
  return p;
}

/** Efficiency of a port (per component, static). */
export function port_efficiency(n, cName, port = 0) {
  const c = n.c.get(cName);
  const p = c._as_port(port);
  const len = c.static.index.length;
  const ones = new Float64Array(len).fill(1);
  if (n.one_port_components.has(c.name)) return ones;
  if (n.passive_branch_components.has(c.name)) return p === 0 ? ones.map(() => -1) : ones;
  if (c.name === "Link") {
    if (p === 0) return ones.map(() => -1);
    const key = p === 1 ? "efficiency" : `efficiency${p}`;
    return c.static.has(key) ? Float64Array.from(c.static.col(key)) : ones;
  }
  if (c.name === "Process") {
    const key = `rate${p}`;
    return c.static.has(key) ? Float64Array.from(c.static.col(key)) : ones;
  }
  throw new Error(`port_efficiency has not been implemented for: ${c.name}`);
}

/** Branches connecting buses of the same carrier (component, name). */
export function get_transmission_branches(n, bus_carrier = null) {
  const bc = n.c.buses.static;
  if (bc.index.isMulti) return transmissionBranchesMulti(n, bus_carrier);
  const busCarrier = new Map(bc.index.values.map((b, i) => [b, bc.col("carrier")[i]]));
  let carriers = bus_carrier;
  if (typeof carriers === "string") carriers = [carriers];
  else if (carriers === null || carriers === undefined) carriers = [...new Set(bc.col("carrier"))];
  const out = [];
  for (const c of n.branch_components) {
    const st = n.c.get(c).static;
    const busCols = st.columns.values.filter((col) => String(col).includes("bus"));
    // `res |= set(matching_idx)` per carrier: names in CPython set order
    const res = new PySet();
    for (const carrier of carriers) {
      const matching = st.index.values.filter((nm, i) => {
        let cnt = 0;
        for (const col of busCols) if (busCarrier.get(st.col(col)[i]) === carrier) cnt++;
        return cnt > 1;
      });
      res._merge(new PySet(matching));
    }
    for (const nm of res) out.push([c, nm]);
  }
  return new Index(out, ["component", "name"]);
}

/**
 * `get_transmission_branches` for scenario- or network-indexed buses (PyPSA's
 * NetworkCollection path, also taken by stochastic networks): rows keep their
 * leading levels, `(…levels, component, name)` per component and bus carrier
 * in row order.
 */
function transmissionBranchesMulti(n, bus_carrier) {
  const bc = n.c.buses.static;
  const lead = bc.index.names.slice(0, -1);
  // bus -> carrier by name, first row wins
  const busCarrier = new Map();
  bc.index.values.forEach((t, i) => {
    const b = t[t.length - 1];
    if (!busCarrier.has(b)) busCarrier.set(b, bc.col("carrier")[i]);
  });
  let carriers;
  if (typeof bus_carrier === "string") carriers = [bus_carrier];
  else if (bus_carrier === null || bus_carrier === undefined) carriers = [...new Set(busCarrier.values())];
  else carriers = [...bus_carrier];
  const out = [];
  for (const c of n.branch_components) {
    const st = n.c.get(c).static;
    const busCols = st.columns.values.filter((col) => String(col).includes("bus"));
    for (const carrier of carriers) {
      st.index.values.forEach((t, i) => {
        let cnt = 0;
        for (const col of busCols) if (busCarrier.get(st.col(col)[i]) === carrier) cnt++;
        if (cnt > 1) out.push(Array.isArray(t) ? [...t.slice(0, -1), c, t[t.length - 1]] : [t, c, t]);
      });
    }
  }
  return new Index(out, [...lead, "component", "name"]);
}

// ----------------------------------------------------------------------
// accessor
// ----------------------------------------------------------------------

const DEFAULTS = {
  components: null,
  groupby_method: "sum",
  aggregate_across_components: false,
  groupby: "carrier",
  at_port: null,
  carrier: null,
  bus_carrier: null,
  nice_names: null,
  drop_zero: null,
  round: null,
};

export class StatisticsAccessor {
  constructor(n) {
    this._n = n;
    this.groupers = groupers;
  }

  get is_multi_indexed() {
    return this._n.snapshots.isMulti;
  }

  // -------------------------------------------------------------- time
  /** Snapshot weightings column of `n` (the member network evaluated by a statistic). */
  _weights(column, n = this._n) {
    const w = n.snapshot_weightings;
    return Float64Array.from(w.col(column));
  }

  /**
   * Aggregate a snapshot-indexed frame over time with weights. Returns a Tab
   * indexed by the frame's columns.
   */
  _aggregate_timeseries(df, weights, agg = "sum") {
    const n = this._n;
    const names = df.columns;
    if (!agg) {
      // obj.T
      const rows = names.values.map((c) => Float64Array.from(df.col(c)));
      return new Tab(new Index(names.values, "name"), df.index, rows);
    }
    let aggr = agg === true ? "sum" : agg;
    let w = weights;
    const sns = n.snapshots;
    if (aggr === "mean") {
      if (sns.isMulti) {
        const tot = new Map();
        sns.values.forEach((s, i) => tot.set(labelKey(s[0]), (tot.get(labelKey(s[0])) ?? 0) + w[i]));
        w = Float64Array.from(w, (x, i) => x / tot.get(labelKey(sns.at(i)[0])));
      } else {
        let tot = 0;
        for (const x of w) tot += x;
        w = Float64Array.from(w, (x) => x / tot);
      }
      aggr = "sum";
    }
    if (aggr !== "sum") {
      const rows = names.values.map((c) => {
        const a = Array.from(df.col(c));
        return Float64Array.of(aggregateArr(a, aggr));
      });
      return new Tab(new Index(names.values, "name"), null, rows);
    }
    if (sns.isMulti) {
      const periods = [...new Set(sns.values.map((s) => s[0]))].sort(compareLabels);
      const pos = new Map(periods.map((p, i) => [labelKey(p), i]));
      const rows = names.values.map((c) => {
        const a = df.col(c);
        const out = new Float64Array(periods.length);
        for (let i = 0; i < a.length; i++) {
          const v = a[i] * w[i];
          if (!Number.isNaN(v)) out[pos.get(labelKey(sns.at(i)[0]))] += v;
        }
        return out;
      });
      return new Tab(new Index(names.values, "name"), new Index(periods, "period"), rows);
    }
    // weights @ df (NaN propagates like numpy's dot)
    const rows = names.values.map((c) => {
      const a = df.col(c);
      let s = 0;
      for (let i = 0; i < a.length; i++) s += w[i] * a[i];
      return Float64Array.of(s);
    });
    return new Tab(new Index(names.values, "name"), null, rows);
  }

  // -------------------------------------------------------------- filters
  _filter_active_assets(c, tab) {
    if (!tab.isSeries) return tab;
    const comp = this._n.c.get(c);
    if (!this.is_multi_indexed) {
      const mask = comp.get_active_assets();
      const active = comp.static.index.filter(mask.values);
      return tab.loc(active.intersection(tab.index));
    }
    const periods = this._n.investment_periods.values;
    const parts = periods.map((p) => {
      const mask = comp.get_active_assets(p);
      const active = comp.static.index.filter(mask.values);
      return tab.loc(active.intersection(tab.index));
    });
    // pd.concat(axis=1): unsorted union of the row labels
    let index = parts.length ? parts[0].index : new Index([], "name");
    for (const part of parts.slice(1)) {
      if (part.index.equals(index)) continue;
      const extra = part.index.values.filter((x) => !index.has(x));
      index = new Index([...index.values, ...extra], "name");
    }
    const rows = index.values.map((l) =>
      Float64Array.from(parts, (part) => {
        const i = part.index.getLoc(l);
        return i < 0 ? NaN : part.rows[i][0];
      }),
    );
    return new Tab(index, new Index(periods, "period"), rows);
  }

  _filter_bus_carrier(c, port, bus_carrier, tab) {
    if (bus_carrier === null || bus_carrier === undefined) return tab;
    const n = this._n;
    const comp = n.c.get(c);
    const busCol = staticCol(comp, `bus${port}`);
    const st = comp.static;
    const bs = n.c.buses.static;
    const busCarriers = bs.col("carrier");
    const unique = new Set(busCarriers);
    const keep = tab.index.values.map((nm) => {
      const i = st.index.getLoc(nm);
      if (i < 0) throw new KeyError(nm);
      const bi = bs.index.getLoc(busCol[i]);
      const pc = bi < 0 ? NaN : busCarriers[bi];
      if (isNa(pc)) return false;
      if (typeof bus_carrier === "string") return unique.has(bus_carrier) ? pc === bus_carrier : contains(pc, bus_carrier);
      if (Array.isArray(bus_carrier)) return bus_carrier.includes(pc);
      throw new TypeError(`Argument \`bus_carrier\` must be a string or list, got ${typeof bus_carrier}`);
    });
    return tab.filter(keep);
  }

  _filter_carrier(c, carrier, tab) {
    const comp = this._n.c.get(c);
    if (carrier === null || carrier === undefined || !comp.static.has("carrier")) return tab;
    const st = comp.static;
    const col = st.col("carrier");
    const carriers = tab.index.values.map((nm) => col[st.index.getLoc(nm)]);
    const unique = new Set(carriers);
    const keep = carriers.map((cc) => {
      if (typeof carrier === "string") return unique.has(carrier) ? cc === carrier : contains(cc, carrier);
      if (Array.isArray(carrier)) return carrier.includes(cc);
      throw new TypeError(`Argument \`carrier\` must be a string or list, got ${typeof carrier}`);
    });
    return tab.filter(keep);
  }

  // -------------------------------------------------------------- core
  _get_grouping(c, groupby, port, nice_names) {
    if (typeof groupby === "function") return groupers.resolve(this._n, c, [groupby], { port, nice_names });
    if (typeof groupby === "string" || Array.isArray(groupby)) return groupers.resolve(this._n, c, Array.isArray(groupby) ? groupby : [groupby], { port, nice_names });
    if (groupby !== false) throw new Error(`Argument \`groupby\` must be a string, list, callable, or False, got ${groupby}.`);
    return null;
  }

  _aggregate_components_groupby(tab, grouping, agg, c) {
    const st = this._n.c.get(c).static;
    const pos = tab.index.values.map((nm) => st.index.getLoc(nm));
    const keys = grouping.map((g) => pos.map((p) => (p < 0 ? NaN : g.values[p])));
    return groupRows(
      tab,
      keys,
      grouping.map((g) => g.name),
      agg,
    );
  }

  _apply_option_kwargs(tab, { drop_zero = null, round = null } = {}) {
    const round_ = round === null || round === undefined ? statisticsOptions.round : round;
    const drop_ = drop_zero === null || drop_zero === undefined ? statisticsOptions.drop_zero : drop_zero;
    let out = tab;
    if (round_) out = out.map((x) => roundTo(x, round_));
    if (drop_) {
      if (out.isSeries) out = out.filter(out.rows.map((r) => r[0] !== 0));
      else out = out.map((x) => (x === 0 ? NaN : x));
    }
    return out;
  }

  /**
   * Evaluate `func(n, c, port)` for all components and ports, filter, group
   * and concatenate the results (mirrors `_aggregate_components`).
   * @returns {Tab}
   */
  _aggregate_components(func, opts = {}) {
    const n = this._n;
    let { components = null, agg = "sum", groupby = "carrier", aggregate_across_components = false, drop_zero = null, round = null } = opts;
    const isOne = typeof components === "string";
    let d;
    const members = this._members();
    if (members) {
      // stochastic networks and network collections: evaluate each member and
      // add its key levels after `component`; the values of each port cover
      // all members, grouped values are sorted by the member keys
      const perMember = members.items.map(([, m]) => new Map(m.statistics._accessor._component_port_tabs(func, opts)));
      let order = members.items.map(([key], s) => [key, s]);
      if (groupby !== false) order = order.sort((a, b) => compareLabels(a[0], b[0]));
      const comps = [];
      for (const m of perMember) for (const cn of m.keys()) if (!comps.includes(cn)) comps.push(cn);
      d = comps.map((cn) => {
        const ports = [];
        for (const m of perMember) for (const [port] of m.get(cn) ?? []) if (!ports.includes(port)) ports.push(port);
        const values = ports.map((port) => {
          const parts = order.map(([key, s]) => [key, perMember[s].get(cn)?.find(([q]) => q === port)?.[1]]).filter(([, t]) => t !== undefined);
          const tab = prefixRows(parts, members.names);
          if (groupby !== false || !n.has_scenarios) return tab;
          // ungrouped values of stochastic networks follow the static rows
          // (components added after `set_scenarios` come after both
          // scenarios); time series of `sign * p` keep the sorted union of
          // the static rows and the scenario-major result columns
          const st = n.c.get(cn).static;
          if (opts._signAligned && tab.cols !== null && st.has("sign") && !isScenarioMajor(st.index)) return sortedRows(tab);
          return staticRowOrder(tab, st.index);
        });
        return [cn, this._combine_ports(values, opts.agg ?? "sum")];
      });
    } else d = this._component_tabs(func, opts);
    let df;
    if (!d.length) df = new Tab(new Index([], ["component", "name"]), null, []);
    else if (isOne) df = d[0][1];
    else {
      const names = d.map(([, t]) => t.index.names);
      let colNames;
      if (names.every((x) => JSON.stringify(x) === JSON.stringify(names[0]))) colNames = ["component", ...names[0]];
      else if (names.every((x) => x.length === 1)) colNames = ["component", "name"];
      else throw new Error("Multi-indexed data must have the same index names.");
      df = concatRows(
        d.map(([, t]) => t),
        d.map(([cn]) => cn),
        colNames,
      );
    }
    if (!df.empty) df = this._apply_option_kwargs(df, { drop_zero, round });
    if (aggregate_across_components) {
      logger.warning("Passing `aggregate_across_components` is deprecated. Group the result instead.");
      const lv = df.index.names.map((nm, i) => [nm, i]).filter(([nm]) => nm !== "component");
      const keys = lv.map(([, i]) => df.index.values.map((v) => v[i]));
      df = groupRows(
        df,
        keys,
        lv.map(([nm]) => nm),
        agg,
      );
    }
    return df;
  }

  /**
   * Members evaluated separately: the scenarios of a stochastic network (as
   * views) or the networks of a collection, with their key level names.
   */
  _members() {
    const n = this._n;
    if (n.is_collection) return { items: n._members(), names: n._index_names };
    if (n.has_scenarios) return { items: n.scenarios.values.map((sc) => [sc, scenarioView(n, sc)]), names: ["scenario"] };
    return null;
  }

  /** Per-component results `[[component, Tab]]` (filtered and grouped). */
  _component_tabs(func, opts = {}) {
    return this._component_port_tabs(func, opts).map(([cn, ports]) => [
      cn,
      this._combine_ports(
        ports.map(([, t]) => t),
        opts.agg ?? "sum",
      ),
    ]);
  }

  /** Concatenate the values of the ports of a component (grouped if not unique). */
  _combine_ports(values, agg) {
    let df = values.length > 1 ? concatRows(values) : values[0];
    if (!df.index.isUnique) df = groupByLevels(df, agg);
    return df;
  }

  /** Per-component, per-port results `[[component, [[port, Tab], ...]]]`. */
  _component_port_tabs(func, opts = {}) {
    const n = this._n;
    let { components = null, agg = "sum", groupby = "carrier", at_port = null, bus_carrier = null, carrier = null, nice_names = null } = opts;
    const d = [];
    if (typeof components === "string") components = [components];
    if (components === null || components === undefined) components = [...new Set([...n.branch_components, ...n.one_port_components])].sort();
    if (nice_names === null || nice_names === undefined) nice_names = statisticsOptions.nice_names;
    if (nice_names) {
      bus_carrier = normalizeCarrierNiceNames(n, bus_carrier);
      carrier = normalizeCarrierNiceNames(n, carrier);
    }
    at_port = resolve_at_port(at_port, bus_carrier);
    for (const cn of components) {
      const c = n.c.get(cn);
      if (c.static.empty || c.static.index.length === 0) continue;
      const values = [];
      for (const port of c._as_ports(at_port)) {
        const portSuffix = c.ports[port];
        if (portSuffix === undefined) continue;
        let vals = wrapKeyError(() => func(n, cn, portSuffix));
        if (vals.empty) continue;
        vals = this._filter_active_assets(cn, vals);
        vals = this._filter_bus_carrier(cn, portSuffix, bus_carrier, vals);
        vals = this._filter_carrier(cn, carrier, vals);
        if (vals.empty) continue;
        if (groupby !== false) {
          const grouping = this._get_grouping(cn, groupby, portSuffix, nice_names);
          vals = this._aggregate_components_groupby(vals, grouping, agg, cn);
        } else vals = vals.renameIndex("name");
        values.push([portSuffix, vals]);
      }
      if (!values.length) continue;
      d.push([cn, values]);
    }
    return d;
  }

  _finalize(tab, name, unit) {
    const out = tab.toPandas(null);
    out.attrs = { name, unit };
    return out;
  }

  _periodWeights(tab) {
    // df.multiply(weights, level="period")
    const n = this._n;
    if (!n.has_investment_periods || tab.empty) return tab;
    const w = n.investment_period_weightings;
    if (tab.cols !== null && tab.cols.name === "period") {
      const ws = tab.cols.values.map((p) => w.at(p, "objective"));
      return new Tab(
        tab.index,
        tab.cols,
        tab.rows.map((r) => r.map((x, j) => x * ws[j])),
      );
    }
    return tab;
  }

  // -------------------------------------------------------------- statistics
  /** Total capital expenditure (`capital_cost * nominal_opt`). */
  capex(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const cost_attribute = opts.cost_attribute ?? "capital_cost";
    const func = (n, c) => {
      const comp = n.c.get(c);
      const attr = NOMINAL_ATTRS[c];
      if (!attr) throw new KeyError(c);
      const cap = staticCol(comp, `${attr}_opt`);
      const cost = cost_attribute === "capital_cost" ? comp.capital_cost : staticCol(comp, cost_attribute);
      // optimised piecewise capital costs (`<cost_attribute>_piecewise_opt`)
      const pw = comp.static.has(`${cost_attribute}_piecewise_opt`) ? staticCol(comp, `${cost_attribute}_piecewise_opt`) : null;
      return Tab.series(
        comp.static.index,
        Float64Array.from(cap, (x, i) => x * (pw ? cost[i] + pw[i] : cost[i] + 0)),
      );
    };
    let tab = this._aggregate_components(func, { ...o, agg: o.groupby_method });
    tab = this._periodWeights(tab);
    return this._finalize(tab, "Capital Expenditure", "currency");
  }

  /** Capital expenditure of the installed (pre-optimisation) capacity. */
  installed_capex(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const cost_attribute = opts.cost_attribute ?? "capital_cost";
    const func = (n, c) => {
      const comp = n.c.get(c);
      const attr = NOMINAL_ATTRS[c];
      if (!attr) throw new KeyError(c);
      const cap = staticCol(comp, attr);
      const cost = cost_attribute === "capital_cost" ? comp.capital_cost : staticCol(comp, cost_attribute);
      return Tab.series(
        comp.static.index,
        Float64Array.from(cap, (x, i) => x * cost[i]),
      );
    };
    let tab = this._aggregate_components(func, { ...o, agg: o.groupby_method });
    tab = this._periodWeights(tab);
    return this._finalize(tab, "Capital Expenditure Fixed", "currency");
  }

  /** Capital expenditure of the expanded capacity (capex - installed_capex). */
  expanded_capex(opts = {}) {
    const a = this.capex(opts);
    const b = this.installed_capex(opts);
    const out = subFill(a, b);
    out.attrs = { name: "Capital Expenditure Expanded", unit: "currency" };
    return out;
  }

  /** Overnight investment cost of the optimal capacity. */
  overnight_cost(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const func = (n, c) => {
      const comp = n.c.get(c);
      const attr = NOMINAL_ATTRS[c];
      if (!attr) throw new KeyError(c);
      const cap = staticCol(comp, `${attr}_opt`);
      const cost = comp.overnight_cost;
      return Tab.series(
        comp.static.index,
        Float64Array.from(cap, (x, i) => x * cost[i]),
      );
    };
    const tab = this._aggregate_components(func, { ...o, agg: o.groupby_method });
    return this._finalize(tab, "Overnight Investment Cost", "currency");
  }

  /** Fixed operation and maintenance cost. */
  fom(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const func = (n, c) => {
      const comp = n.c.get(c);
      const attr = NOMINAL_ATTRS[c];
      if (!attr) throw new KeyError(c);
      const cap = staticCol(comp, `${attr}_opt`);
      const cost = staticCol(comp, "fom_cost");
      return Tab.series(
        comp.static.index,
        Float64Array.from(cap, (x, i) => x * cost[i]),
      );
    };
    const tab = this._aggregate_components(func, { ...o, agg: o.groupby_method });
    return this._finalize(tab, "Fixed O&M Cost", "currency");
  }

  _capacity(opts, optimal) {
    const o = { ...DEFAULTS, ...opts };
    const storage = opts.storage ?? false;
    if (storage) o.components = ["Store", "StorageUnit"];
    const resolved = resolve_at_port(o.at_port, o.bus_carrier);
    const func = (n, c, port) => {
      const comp = n.c.get(c);
      let eff = port_efficiency(n, c, port);
      const ports = comp._as_ports(resolved);
      if (ports.length === 1 && ports[0] === 0) eff = eff.map(Math.abs);
      const attr = NOMINAL_ATTRS[c];
      if (!attr) throw new KeyError(c);
      const cap = staticCol(comp, optimal ? `${attr}_opt` : attr);
      let col = Float64Array.from(cap, (x, i) => x * eff[i]);
      if (storage && c === "StorageUnit") {
        const mh = staticCol(comp, "max_hours");
        col = col.map((x, i) => x * mh[i]);
      }
      return Tab.series(comp.static.index, col);
    };
    return this._aggregate_components(func, { ...o, agg: o.groupby_method });
  }

  /** Optimal capacity (nominal_opt scaled by port efficiency). */
  optimal_capacity(opts = {}) {
    return this._finalize(this._capacity(opts, true), "Optimal Capacity", "MW");
  }

  /** Installed capacity (nominal attribute scaled by port efficiency). */
  installed_capacity(opts = {}) {
    return this._finalize(this._capacity(opts, false), "Installed Capacity", "MW");
  }

  /** Expanded capacity (optimal - installed where optimal exceeds installed). */
  expanded_capacity(opts = {}) {
    const { storage, ...rest } = opts;
    void storage;
    const optimal = this._capacity(rest, true);
    const installed = this._capacity(rest, false);
    const inst = installed.loc(optimal.index).map((x) => (Number.isNaN(x) ? 0 : x));
    const rows = optimal.rows.map((r, i) => r.map((x, j) => (Math.abs(x) > Math.abs(inst.rows[i][j]) ? x - inst.rows[i][j] : 0)));
    return this._finalize(new Tab(optimal.index, optimal.cols, rows), "Expanded Capacity", "MW");
  }

  /** Operational expenditure (marginal, storage, quadratic, spill, start-up, shut-down, stand-by costs). */
  opex(opts = {}) {
    const o = { ...DEFAULTS, groupby_time: "sum", ...opts };
    let costTypes = opts.cost_types ?? null;
    if (costTypes === null) costTypes = ["marginal_cost", "marginal_cost_quadratic", "marginal_cost_storage", "spill_cost", "start_up_cost", "shut_down_cost", "stand_by_cost"];
    else if (typeof costTypes === "string") costTypes = [costTypes];
    const func = (n, c, port) => {
      const comp = n.c.get(c);
      const weights = this._weights("objective", n);
      const ones = new Float64Array(weights.length).fill(1);
      const comI = comp.committables;
      const result = [];
      for (const costType of ["marginal_cost", "marginal_cost_storage", "marginal_cost_quadratic", "spill_cost"]) {
        if (!costTypes.includes(costType) || !comp.static.has(costType)) continue;
        const rows = LOOKUP.filter((r) => r.component === c && r[costType]);
        if (!rows.length) throw new KeyError(c);
        if (rows.length !== 1) throw new Error("can only convert an array of size 1 to a Python scalar");
        const attr = rows[0].variable + port;
        let cost = n.get_switchable_as_dense(c, costType);
        const pw = comp.dynamic[`${costType}_piecewise_opt`];
        if (pw && !pw.empty) cost = frameOp(cost, pw, (a, b) => a + b);
        const p = dynamic(comp, attr);
        const v = costType === "marginal_cost_quadratic" ? frameMap(p, (x) => x * x) : p;
        const opex = frameOp(v, cost, (a, b) => a * b);
        result.push(this._aggregate_timeseries(opex, weights, o.groupby_time));
      }
      const mapping = { start_up_cost: "start_up", shut_down_cost: "shut_down", stand_by_cost: "status" };
      for (const [costType, attr] of Object.entries(mapping)) {
        if (!costTypes.includes(costType) || !comp.static.has(costType) || comI.empty) continue;
        const cost = n.get_switchable_as_dense(c, costType, null, comI);
        const v = selectColumns(dynamic(comp, attr), comI.values);
        const opex = frameOp(v, cost, (a, b) => a * b);
        const w = attr === "status" ? weights : ones;
        result.push(this._aggregate_timeseries(opex, w, o.groupby_time));
      }
      if (!result.length) return Tab.empty();
      return groupByLevels(concatRows(result), "sum");
    };
    let tab = this._aggregate_components(func, { ...o, agg: o.groupby_method });
    tab = this._periodWeights(tab);
    return this._finalize(tab, "Operational Expenditure", "currency");
  }

  /** Total system cost (capex + fixed O&M + opex). */
  system_cost(opts = {}) {
    const groupby_time = opts.groupby_time === false ? "sum" : opts.groupby_time ?? "sum";
    if (opts.groupby_time === false) logger.warning("Passing `groupby_time=False` to `system_cost` is deprecated.");
    const capex = this.capex(stripKeys(opts, ["groupby_time"]));
    const fom = this.fom(stripKeys(opts, ["groupby_time"]));
    const opex = this.opex({ ...opts, groupby_time });
    const parts = [capex, fom, opex].filter((part) => !isEmpty(part));
    const df = parts.length ? parts.slice(1).reduce((a, b) => addFill(a, b), parts[0]) : capex;
    df.attrs = { name: "System Cost", unit: "currency" };
    return df;
  }

  _energyBalanceTab(opts, direction) {
    const o = { ...DEFAULTS, groupby_time: "sum", at_port: "all", ...opts };
    if (!("groupby" in opts) || opts.groupby === null) o.groupby = ["carrier", "bus_carrier"];
    const n = this._n;
    const func = (nn, c, port) => {
      const comp = nn.c.get(c);
      const weights = this._weights("generators", nn);
      const p0 = dynamic(comp, `p${port}`);
      let p;
      if (nn.branch_components.has(c)) p = frameMap(p0, (x) => -1.0 * x);
      else {
        const sign = staticGet(comp, "sign", null);
        p = sign === null ? frameMap(p0, (x) => x) : frameSeriesOp(p0, comp.static.index, sign, (x, s) => s * x);
      }
      if (direction === "supply") p = frameMap(p, (x) => (x < 0 ? 0 : x));
      else if (direction === "withdrawal") p = frameMap(p, (x) => (x > 0 ? 0 : -x));
      else if (direction !== "both") throw new Error(`Argument 'direction' must be 'supply', 'withdrawal' or 'both', got '${direction}'.`);
      return this._aggregate_timeseries(p, weights, o.groupby_time);
    };
    void n;
    return this._aggregate_components(func, { ...o, agg: o.groupby_method, _signAligned: true });
  }

  /** Energy balance (supply positive, withdrawal negative). */
  energy_balance(opts = {}) {
    const direction = opts.direction ?? "both";
    const { direction: _d, ...rest } = opts;
    void _d;
    const tab = this._energyBalanceTab(rest, direction);
    return this._finalize(tab, "Energy Balance", this._n.bus_carrier_unit(rest.bus_carrier ?? null));
  }

  /** Supply (positive part of the energy balance). */
  supply(opts = {}) {
    return this._finalize(this._energyBalanceTab({ groupby: "carrier", ...opts }, "supply"), "Supply", "carrier dependent");
  }

  /** Withdrawal (negative part of the energy balance). */
  withdrawal(opts = {}) {
    return this._finalize(this._energyBalanceTab({ groupby: "carrier", ...opts }, "withdrawal"), "Withdrawal", "carrier dependent");
  }

  /** Energy transmitted between buses of the same carrier. */
  transmission(opts = {}) {
    const o = { ...DEFAULTS, groupby_time: "sum", at_port: "bus0", ...opts };
    const n = this._n;
    // PyPSA passes `n.branch_components` (Python set iteration order)
    if (o.components === null) o.components = [...n.branch_components];
    // per network evaluated (the scenario views of stochastic networks)
    const branchesOf = new Map();
    const func = (nn, c, port) => {
      if (!branchesOf.has(nn)) branchesOf.set(nn, get_transmission_branches(nn, o.bus_carrier));
      const branches = branchesOf.get(nn);
      const names = branches.values.filter((b) => b[0] === c).map((b) => b[1]);
      if (!names.length && !branches.values.some((b) => b[0] === c)) throw new KeyError(c);
      const p = selectColumns(dynamic(nn.c.get(c), `p${port}`), names);
      return this._aggregate_timeseries(p, this._weights("generators", nn), o.groupby_time);
    };
    const tab = this._aggregate_components(func, { ...o, agg: o.groupby_method });
    return this._finalize(tab, "Transmission", "carrier dependent");
  }

  /** Curtailment (available minus dispatched energy). */
  curtailment(opts = {}) {
    const o = { ...DEFAULTS, groupby_time: "sum", ...opts };
    const func = (n, c) => {
      const comp = n.c.get(c);
      if (!comp.static.has("p_max_pu")) throw new KeyError("p_max_pu");
      const avail = frameSeriesOp(n.get_switchable_as_dense(c, "p_max_pu"), comp.static.index, staticCol(comp, "p_nom_opt"), (x, v) => x * v);
      const p = frameMap(frameOp(avail, dynamic(comp, "p"), (a, b) => a - b), (x) => (x < 0 ? 0 : x));
      return this._aggregate_timeseries(p, this._weights("generators", n), o.groupby_time);
    };
    const tab = this._aggregate_components(func, { ...o, agg: o.groupby_method });
    return this._finalize(tab, "Curtailment", "MWh");
  }

  _operationTab(o) {
    const func = (n, c) => {
      const p = frameMap(get_operation(n, c), Math.abs);
      return this._aggregate_timeseries(p, this._weights("generators", n), o.groupby_time);
    };
    return this._aggregate_components(func, { ...o, agg: o.groupby_method });
  }

  /** Capacity factor (mean absolute operation over optimal capacity). */
  capacity_factor(opts = {}) {
    const o = { ...DEFAULTS, groupby_time: "mean", ...opts };
    const df = this._operationTab(o);
    const cap = this._capacity(stripKeys(o, ["groupby_time"]), true);
    const c = cap.loc(df.index);
    const rows = df.rows.map((r, i) => r.map((x) => x / c.rows[i][0]));
    return this._finalize(new Tab(df.index, df.cols, rows), "Capacity Factor", "p.u.");
  }

  _revenueTab(o, direction) {
    const func = (n, c, port) => {
      const comp = n.c.get(c);
      const p0 = dynamic(comp, `p${port}`);
      let df;
      if (n.branch_components.has(c)) df = frameMap(p0, (x) => -1.0 * x);
      else {
        const sign = staticGet(comp, "sign", null);
        df = sign === null ? p0 : frameSeriesOp(p0, comp.static.index, sign, (x, s) => s * x);
      }
      const busCol = staticCol(comp, `bus${port}`);
      const mp = n.c.buses.dynamic.marginal_price;
      if (direction === "input") df = frameMap(df, (x) => (x > 0 ? 0 : x));
      else if (direction === "output") df = frameMap(df, (x) => (x < 0 ? 0 : x));
      else if (direction !== "both") throw new Error(`Argument 'direction' must be 'input', 'output' or 'both', got '${direction}'.`);
      const rev = new DataFrame({ index: df.index });
      for (const nm of df.columns) {
        const i = comp.static.index.getLoc(nm);
        if (i < 0) throw new KeyError(nm);
        const bus = busCol[i];
        const price = mp.has(bus) ? mp.col(bus) : null;
        rev.set(
          nm,
          Float64Array.from(df.col(nm), (x, t) => x * (price ? price[t] : 0)),
        );
      }
      return this._aggregate_timeseries(rev, this._weights("objective", n), o.groupby_time);
    };
    return this._aggregate_components(func, { ...o, agg: o.groupby_method });
  }

  /** Revenue (dispatch times marginal price at the connected bus). */
  revenue(opts = {}) {
    const o = { ...DEFAULTS, groupby_time: "sum", at_port: "all", ...opts };
    const direction = opts.direction ?? "both";
    return this._finalize(this._revenueTab(o, direction), "Revenue", "currency");
  }

  /** Market value (revenue per unit of operation). */
  market_value(opts = {}) {
    const o = { ...DEFAULTS, groupby_time: "mean", at_port: "all", ...opts };
    const rev = this._revenueTab(o, "both");
    const denom = this._operationTab({ ...o, at_port: [0], bus_carrier: null, drop_zero: false, round: null });
    let out;
    if (denom.empty) out = rev.map(() => NaN);
    else out = rev.combine(denom, (a, b) => a / b);
    return this._finalize(out, "Market Value", "currency / operational unit");
  }

  /** Average marginal prices per bus (load or time weighted). */
  prices(opts = {}) {
    if (this._n.is_collection) return this._collection_prices(opts);
    const { groupby = false, weighting = "load", groupby_time = true, bus_carrier = null, drop_zero = null, round = null } = opts;
    const n = this._n;
    const sw = this._weights("objective");
    let keys;
    if (groupby === false) keys = [];
    else if (typeof groupby === "string") keys = [groupby];
    else if (Array.isArray(groupby)) keys = groupby;
    else throw new Error(`Grouping prices by ${groupby} is not supported.`);
    const buses = n.c.buses.static;
    const grouperCols = keys.map((key) => {
      const col = key === "bus_carrier" ? "carrier" : key;
      if (col === "name") return { name: key, values: buses.index.values.slice() };
      if (buses.has(col)) return { name: key, values: Array.from(buses.col(col)) };
      throw new Error(`Grouping prices by '${key}' is not supported. Use 'name', 'bus_carrier' or a static bus attribute.`);
    });
    let prices = n.c.buses.dynamic.marginal_price;
    if (bus_carrier !== null) {
      const bcs = typeof bus_carrier === "string" ? [bus_carrier] : bus_carrier;
      const carriers = buses.col("carrier");
      const keep = buses.index.values.filter((b, i) => bcs.includes(carriers[i]) && prices.has(b));
      prices = selectColumns(prices, keep);
    }
    if (!groupby_time) {
      const rows = prices.columns.values.map((b) => Float64Array.from(prices.col(b)));
      let index = new Index(prices.columns.values, "name");
      if (grouperCols.length) {
        index = new Index(
          prices.columns.values.map((b) => {
            const i = buses.index.getLoc(b);
            const ks = grouperCols.map((g) => (i < 0 ? NaN : g.values[i]));
            return ks.length > 1 ? ks : ks[0];
          }),
          grouperCols.length > 1 ? grouperCols.map((g) => g.name) : grouperCols[0].name,
        );
      }
      return new Tab(index, prices.index, rows).toPandas();
    }
    let weights;
    if (weighting === "load") {
      const w = this._energyBalanceTab({ groupby: "bus", bus_carrier, nice_names: false, groupby_time: false }, "withdrawal");
      // groupby("bus").sum().T
      const busLevel = w.index.names.indexOf("bus");
      const g = groupRows(
        w,
        [w.index.values.map((v) => (busLevel >= 0 && w.index.isMulti ? v[busLevel] : v))],
        ["bus"],
        "sum",
      );
      weights = new DataFrame({ index: n.snapshots });
      for (const b of prices.columns) {
        const i = g.index.getLoc(b);
        weights.set(b, i < 0 ? new Float64Array(n.snapshots.length).fill(1) : Float64Array.from(g.rows[i]));
      }
    } else if (weighting === "time") {
      weights = new DataFrame({ index: n.snapshots });
      for (const b of prices.columns) weights.set(b, new Float64Array(n.snapshots.length).fill(1));
    } else throw new Error(`Weighting '${weighting}' is not supported. Use 'load' or 'time'.`);
    const dot = (arr) => {
      let s = 0;
      for (let t = 0; t < arr.length; t++) s += sw[t] * arr[t];
      return s;
    };
    const cols = prices.columns.values;
    const a = cols.map((b) => dot(Float64Array.from(prices.col(b), (x, t) => x * weights.col(b)[t])));
    const bsum = cols.map((b) => dot(weights.col(b)));
    let tab = Tab.series(
      new Index(cols, "name"),
      a.map((x, i) => x / bsum[i]),
    );
    if (grouperCols.length) {
      const pos = cols.map((b) => buses.index.getLoc(b));
      const keysArr = grouperCols.map((g) => pos.map((p) => (p < 0 ? NaN : g.values[p])));
      const vals = tab.rows.map((r) => r[0]);
      const weighted = new Tab(
        tab.index,
        null,
        vals.map((v, i) => Float64Array.of(v * bsum[i])),
      );
      const num = groupRows(
        weighted,
        keysArr,
        grouperCols.map((g) => g.name),
        "sum",
      );
      const den = groupRows(
        Tab.series(tab.index, bsum),
        keysArr,
        grouperCols.map((g) => g.name),
        "sum",
      );
      tab = new Tab(
        num.index,
        null,
        num.rows.map((r, i) => Float64Array.of(r[0] / den.rows[i][0])),
      );
    }
    tab = this._apply_option_kwargs(tab, { drop_zero, round });
    return this._finalize(tab, "Prices", "currency / MWh");
  }

  /**
   * Prices of a network collection. As in PyPSA v1.4.0 the load weights are
   * grouped by bus name across the networks and do not align with the
   * `(network, name)` price columns, so every bus is weighted by the
   * snapshot weightings only; grouped prices pool the networks.
   */
  _collection_prices(opts = {}) {
    const { groupby = false, weighting = "load", groupby_time = true, bus_carrier = null, drop_zero = null, round = null } = opts;
    const nc = this._n;
    if (weighting !== "load" && weighting !== "time") throw new Error(`Weighting '${weighting}' is not supported. Use 'load' or 'time'.`);
    let keys;
    if (groupby === false) keys = [];
    else if (typeof groupby === "string") keys = [groupby];
    else if (Array.isArray(groupby)) keys = groupby;
    else throw new Error(`Grouping prices by ${groupby} is not supported.`);
    const tuple = (k) => (Array.isArray(k) ? k : [k]);
    const rows = [];
    for (const [key, n] of nc._members()) {
      const buses = n.c.buses.static;
      const prices = n.c.buses.dynamic.marginal_price;
      const carriers = buses.has("carrier") ? buses.col("carrier") : null;
      const sw = this._weights("objective", n);
      for (const b of prices.columns.values) {
        const i = buses.index.getLoc(b);
        if (bus_carrier !== null) {
          const bcs = typeof bus_carrier === "string" ? [bus_carrier] : bus_carrier;
          if (!(i >= 0 && bcs.includes(carriers[i]))) continue;
        }
        const groupKeys = keys.map((k) => {
          const col = k === "bus_carrier" ? "carrier" : k;
          if (col === "name") return b;
          if (!buses.has(col)) throw new Error(`Grouping prices by '${k}' is not supported. Use 'name', 'bus_carrier' or a static bus attribute.`);
          return i < 0 ? NaN : buses.col(col)[i];
        });
        rows.push({ key: tuple(key), bus: b, groupKeys, series: Float64Array.from(prices.col(b)), sw });
      }
    }
    const names = nc._index_names;
    if (!groupby_time) {
      const index = keys.length
        ? new Index(rows.map((r) => [...r.key, ...r.groupKeys]), [...names, ...keys])
        : new Index(rows.map((r) => [...r.key, r.bus]), [...names, "name"]);
      return new Tab(index, nc.snapshots, rows.map((r) => r.series)).toPandas();
    }
    for (const r of rows) {
      let a = 0;
      let b = 0;
      r.series.forEach((x, t) => {
        a += r.sw[t] * x;
        b += r.sw[t];
      });
      r.value = a / b;
      r.weight = b;
    }
    let tab;
    if (!keys.length) {
      tab = Tab.series(new Index(rows.map((r) => [...r.key, r.bus]), [...names, "name"]), Float64Array.from(rows, (r) => r.value));
    } else {
      // `df.groupby(groupers).apply(weighted mean)` over all networks
      const groups = new Map();
      for (const r of rows) {
        const label = keys.length > 1 ? r.groupKeys : r.groupKeys[0];
        const k = labelKey(label);
        if (!groups.has(k)) groups.set(k, { label, a: 0, b: 0 });
        const g = groups.get(k);
        g.a += r.value * r.weight;
        g.b += r.weight;
      }
      const sorted = [...groups.values()].sort((x, y) => compareLabels(x.label, y.label));
      tab = Tab.series(
        new Index(
          sorted.map((g) => g.label),
          keys.length > 1 ? keys : keys[0],
        ),
        Float64Array.from(sorted, (g) => g.a / g.b),
      );
    }
    tab = this._apply_option_kwargs(tab, { drop_zero, round });
    return this._finalize(tab, "Prices", "currency / MWh");
  }

  /** Overview table of the main statistics (deprecated in PyPSA but kept). */
  call(opts = {}) {
    const funcs = [
      ["optimal_capacity", "Optimal Capacity"],
      ["installed_capacity", "Installed Capacity"],
      ["supply", "Supply"],
      ["withdrawal", "Withdrawal"],
      ["energy_balance", "Energy Balance"],
      ["transmission", "Transmission"],
      ["capacity_factor", "Capacity Factor"],
      ["curtailment", "Curtailment"],
      ["capex", "Capital Expenditure"],
      ["opex", "Operational Expenditure"],
      ["revenue", "Revenue"],
      ["market_value", "Market Value"],
    ];
    // PyPSA passes every argument explicitly, so e.g. `at_port=None` replaces
    // the defaults of the individual statistics
    const args = {
      components: null,
      groupby_method: "sum",
      aggregate_across_components: false,
      groupby: "carrier",
      at_port: null,
      carrier: null,
      bus_carrier: null,
      nice_names: null,
      drop_zero: null,
      round: null,
      ...opts,
    };
    const res = funcs.map(([f, name]) => [name, this[f](args)]);
    const keys = new Map();
    for (const [, s] of res) for (const l of s.index.values) keys.set(labelKey(l), l);
    const labels = [...keys.values()].sort(compareLabels);
    const names = res.find(([, s]) => s.index.length)?.[1].index.names ?? ["component", "carrier"];
    const df = new DataFrame({ index: new Index(labels, names) });
    for (const [name, s] of res) {
      df.set(
        name,
        Float64Array.from(labels, (l) => {
          const i = s.index.getLoc(l);
          return i < 0 ? 0 : s.values[i];
        }),
      );
    }
    return df;
  }
}

/** Concatenate `[[key, Tab]]` with the (scalar or tuple) keys as leading levels. */
/** Whether `(scenario, name)` rows run scenario by scenario over the same names. */
function isScenarioMajor(index) {
  const names = [];
  const scen = [];
  for (const [sc, nm] of index.values) {
    if (!scen.length || scen[scen.length - 1] !== sc) scen.push(sc);
    if (scen.length === 1) names.push(nm);
  }
  if (new Set(scen).size !== scen.length || index.length !== scen.length * names.length) return false;
  return index.values.every(([sc, nm], i) => sc === scen[Math.floor(i / names.length)] && nm === names[i % names.length]);
}

/** Rows of `tab` sorted by their labels (pandas' sorted union). */
function sortedRows(tab) {
  const take = tab.index.values.map((_, i) => i).sort((i, j) => compareLabels(tab.index.values[i], tab.index.values[j]));
  return new Tab(new Index(take.map((i) => tab.index.values[i]), tab.index.names), tab.cols, take.map((i) => tab.rows[i]));
}

/** Rows `(scenario, name)` of `tab` in the order of the static index (others last). */
function staticRowOrder(tab, staticIndex) {
  if (!tab.index.isMulti || tab.index.names.length !== 2 || !staticIndex.isMulti) return tab;
  const pos = new Map(staticIndex.values.map((t, i) => [`${t[0]}\u0000${t[1]}`, i]));
  const keyed = tab.index.values.map((t, i) => [pos.get(`${t[0]}\u0000${t[1]}`) ?? Infinity, i]);
  if (keyed.every(([p], i) => i === 0 || p >= keyed[i - 1][0])) return tab;
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const take = keyed.map(([, i]) => i);
  return new Tab(new Index(take.map((i) => tab.index.values[i]), tab.index.names), tab.cols, take.map((i) => tab.rows[i]));
}

function prefixRows(parts, names) {
  const tuple = (k) => (Array.isArray(k) ? k : [k]);
  const tabs = parts.map(([, t]) => t);
  const merged = concatRows(tabs);
  const labels = [];
  parts.forEach(([key, t]) => {
    for (const l of t.index.values) labels.push([...tuple(key), ...(t.index.isMulti ? l : [l])]);
  });
  const inner = tabs[0].index.isMulti ? tabs[0].index.names : [tabs[0].index.name];
  return new Tab(new Index(labels, [...names, ...inner]), merged.cols, merged.rows);
}

function aggregateArr(a, agg) {
  // unweighted `DataFrame.agg(agg)` over time (NaN skipped)
  if (typeof agg === "function") return agg(a);
  return aggregate(Array.from(a), agg);
}

function wrapKeyError(fn) {
  try {
    return fn();
  } catch (e) {
    if (isKeyError(e)) return Tab.empty();
    throw e;
  }
}

function stripKeys(o, keys) {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

function isEmpty(x) {
  return x instanceof Series ? x.length === 0 : x.index.length === 0 || x.columns.length === 0;
}

function toTab(x) {
  if (x instanceof Series) return Tab.series(x.index, Float64Array.from(x.values));
  return new Tab(
    x.index,
    x.columns,
    x.index.values.map((_, i) => Float64Array.from(x.columns.values, (c) => x.col(c)[i])),
  );
}

/** `a.sub(b, fill_value=0)` */
function subFill(a, b) {
  const t = toTab(a).combine(toTab(b), (x, y) => x - y, 0);
  return t.toPandas();
}

/** `a.add(b, fill_value=0)` */
function addFill(a, b) {
  const t = toTab(a).combine(toTab(b), (x, y) => x + y, 0);
  return t.toPandas();
}

/** Install `n.statistics` (callable, with statistic methods). */
// keyword arguments deprecated in PyPSA 1.0 (`deprecated_kwargs`)
const DEPRECATED_KWARGS = { comps: "components", aggregate_groups: "groupby_method", aggregate_time: "groupby_time" };

function renameDeprecatedKwargs(name, opts) {
  if (!opts || typeof opts !== "object") return opts;
  let out = opts;
  for (const [old, neu] of Object.entries(DEPRECATED_KWARGS)) {
    if (!(old in opts)) continue;
    if (neu in opts) throw new Error(`TypeError: ${name} received both ${old} and ${neu}`);
    logger.warning(`\`${old}\` is deprecated as an argument to \`${name}\`; use \`${neu}\` instead. Deprecated in version 1.0 and will be removed in version 2.0.`);
    out = out === opts ? { ...opts } : out;
    out[neu] = out[old];
    delete out[old];
  }
  return out;
}

/** The callable `statistics` accessor of a network or collection. */
export function makeStatisticsAccessor(n) {
  const acc = new StatisticsAccessor(n);
  const fn = (opts = {}) => acc.call(renameDeprecatedKwargs("__call__", opts));
  for (const name of Object.getOwnPropertyNames(StatisticsAccessor.prototype)) {
    if (name === "constructor" || name.startsWith("_") || name === "is_multi_indexed") continue;
    fn[name] = (opts, ...rest) => acc[name](renameDeprecatedKwargs(name, opts), ...rest);
  }
  fn.groupers = groupers;
  fn._accessor = acc;
  Object.defineProperty(fn, "is_multi_indexed", { get: () => acc.is_multi_indexed, enumerable: true });
  Object.defineProperty(fn, "n", {
    get: () => {
      logger.warning("Accessing the network instance via `n` is deprecated. Use the network instance directly.");
      return n;
    },
    enumerable: true,
  });
  return fn;
}

Network._accessorInitialisers.push((n) => {
  const fn = makeStatisticsAccessor(n);
  Object.defineProperty(n, "statistics", { value: fn, writable: true, configurable: true, enumerable: false });
});

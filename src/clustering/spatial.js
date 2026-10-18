// SPDX-License-Identifier: MIT
/**
 * Spatial clustering (mirrors `pypsa.clustering.spatial`): aggregate buses,
 * lines, one-port components and links according to a bus map.
 */

import { Index, compareLabels, labelKey } from "../core/index.js";
import { DataFrame, Series, isNumberArray } from "../core/frame.js";
import { Network } from "../network/network.js";
import { haversinePts } from "../components/components.js";
import { logger } from "../logger.js";
import { pyHypot } from "../core/pymath.js";
import { greedy_modularity_communities } from "./modularity.js";

const sumKeepNa = (xs) => {
  const v = xs.filter((x) => !(typeof x === "number" && Number.isNaN(x)));
  return v.length ? v.reduce((a, b) => a + b, 0) : NaN;
};

export const DEFAULT_ONE_PORT_STRATEGIES = {
  p: "sum",
  q: "sum",
  p_set: sumKeepNa,
  q_set: sumKeepNa,
  p_nom: "sum",
  p_nom_max: "sum",
  p_nom_min: "sum",
  e_nom: "sum",
  e_nom_max: "sum",
  e_nom_min: "sum",
  weight: "sum",
  ramp_limit_up: "mean",
  ramp_limit_down: "mean",
  ramp_limit_start_up: "mean",
  ramp_limit_shut_down: "mean",
  build_year: () => 0,
  lifetime: () => Infinity,
  control: () => "",
  p_max_pu: "capacity_weighted_average",
  p_min_pu: "capacity_weighted_average",
  capital_cost: "capacity_weighted_average",
  marginal_cost: "capacity_weighted_average",
  efficiency: "capacity_weighted_average",
  max_hours: "capacity_weighted_average",
  inflow: "sum",
};

export const DEFAULT_BUS_STRATEGIES = {
  x: "mean",
  y: "mean",
  v_nom: "max",
  v_mag_pu_max: "min",
  v_mag_pu_min: "max",
  generator: () => "",
};

export const DEFAULT_LINE_STRATEGIES = {
  r: "reciprocal_voltage_weighted_average",
  x: "reciprocal_voltage_weighted_average",
  g: "voltage_weighted_average",
  b: "voltage_weighted_average",
  terrain_factor: "mean",
  s_min_pu: "capacity_weighted_average",
  s_max_pu: "capacity_weighted_average",
  s_nom: "sum",
  s_nom_min: "sum",
  s_nom_max: "sum",
  s_nom_extendable: "any",
  num_parallel: "sum",
  capital_cost: "length_capacity_weighted_average",
  v_ang_min: "max",
  v_ang_max: "min",
  lifetime: "capacity_weighted_average",
  build_year: "capacity_weighted_average",
};

function isNa(v) {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

/** x / sum(x) if the (NaN-propagating) sum is positive, else uniform weights. */
export function normed_or_uniform(xs) {
  let s = 0;
  for (const x of xs) s += x;
  if (s > 0) return xs.map((x) => x / s);
  return xs.map(() => 1 / xs.length);
}

function makeConsense(component, attr) {
  return (xs, key) => {
    const v = xs[0];
    const allEqual = xs.every((x) => x === v);
    const allNull = xs.every(isNa);
    if (!allEqual && !allNull) {
      throw new Error(`In ${component} cluster ${key}, the values of attribute ${attr} do not agree:\n${xs.join(", ")}`);
    }
    return v;
  };
}

function alignStrategies(strategies, keys, component) {
  const out = {};
  for (const k of keys) out[k] = k in strategies ? strategies[k] : makeConsense(component, k);
  return out;
}

function aggValues(xs, strategy, key) {
  if (typeof strategy === "function") return strategy(xs, key);
  const nums = xs.filter((x) => !isNa(x));
  switch (strategy) {
    case "sum": {
      if (nums.length && typeof nums[0] === "string") return nums.join("");
      let s = 0;
      for (const x of nums) s += Number(x);
      return s;
    }
    case "mean":
      return nums.length ? nums.reduce((a, b) => a + Number(b), 0) / nums.length : NaN;
    case "max":
      return nums.length ? nums.reduce((a, b) => (compareLabels(b, a) > 0 ? b : a)) : NaN;
    case "min":
      return nums.length ? nums.reduce((a, b) => (compareLabels(b, a) < 0 ? b : a)) : NaN;
    case "any":
      return xs.some((x) => Boolean(x) && !isNa(x));
    case "first":
      return nums.length ? nums[0] : NaN;
    default:
      throw new Error(`Unknown aggregation strategy '${strategy}'`);
  }
}

/**
 * Group the rows of a static frame by `keys` (aligned with rows; missing keys
 * are dropped) and aggregate each column with its strategy. Groups are sorted.
 * @returns {{labels: Array, columns: Object<string, Array>}}
 */
function groupAgg(st, keys, strategies) {
  const groups = new Map();
  const labels = [];
  keys.forEach((k, i) => {
    if (Array.isArray(k) ? k.some(isNa) : isNa(k)) return;
    const lk = labelKey(k);
    if (!groups.has(lk)) {
      groups.set(lk, []);
      labels.push(k);
    }
    groups.get(lk).push(i);
  });
  labels.sort(compareLabels);
  const columns = {};
  for (const [col, strat] of Object.entries(strategies)) {
    const arr = st.col(col);
    columns[col] = labels.map((l) => aggValues(groups.get(labelKey(l)).map((i) => arr[i]), strat, l));
  }
  return { labels, columns, members: labels.map((l) => groups.get(labelKey(l))) };
}

function outputColumns(c) {
  const out = new Set();
  for (const [attr, def] of c.ctype.defaults) if (def.static && String(def.status ?? "").startsWith("Output")) out.add(attr);
  return out;
}

function mapBus(busmap, b) {
  const v = busmap instanceof Map ? busmap.get(b) : busmap instanceof Series ? busmap.getOr(b, undefined) : busmap[b];
  return v === undefined ? NaN : v;
}

function flattenLabel(l) {
  return Array.isArray(l) ? l.map(String).join(" ").trim() : l;
}

/** Aggregate buses by the bus map. */
export function aggregatebuses(n, busmap, custom_strategies = {}) {
  const c = n.c.get("Bus");
  const out = outputColumns(c);
  const columns = c.static.columns.values.filter((col) => !out.has(col));
  const strategies = alignStrategies({ ...DEFAULT_BUS_STRATEGIES, ...custom_strategies }, columns, "Bus");
  const keys = c.static.index.values.map((b) => mapBus(busmap, b));
  const { labels, columns: data } = groupAgg(c.static, keys, strategies);
  return { index: labels.map(flattenLabel), data, columns };
}

/** Aggregate lines between clustered buses; returns {index, data, columns, linemap}. */
export function aggregatelines(n, busmap, { line_length_factor = 1.0, custom_strategies = {}, bus_strategies = {}, custom_line_groupers = [] } = {}) {
  const c = n.c.get("Line");
  const st0 = c.static;
  const pos = [];
  st0.index.values.forEach((nm, i) => {
    const a = mapBus(busmap, st0.col("bus0")[i]);
    const b = mapBus(busmap, st0.col("bus1")[i]);
    if (!(a === b)) pos.push(i);
  });
  const st = st0.takeRows(pos);
  const nl = st.index.length;
  const buses = n.c.buses.static;
  const busPos = (b) => buses.index.getLoc(b);
  const origLength = Float64Array.from(st.col("length"));
  const origVNom = Float64Array.from(st.col("bus0"), (b) => buses.col("v_nom")[busPos(b)]);

  const bs = { ...DEFAULT_BUS_STRATEGIES, ...bus_strategies };
  const busKeys = buses.index.values.map((b) => mapBus(busmap, b));
  const cl = groupAgg(buses, busKeys, { x: bs.x, y: bs.y, v_nom: bs.v_nom });
  const clPos = new Map(cl.labels.map((l, i) => [labelKey(l), i]));
  const clAt = (attr, b) => cl.columns[attr][clPos.get(labelKey(b))];

  const bus0 = Array.from(st.col("bus0"), (b) => mapBus(busmap, b));
  const bus1 = Array.from(st.col("bus1"), (b) => mapBus(busmap, b));
  for (let i = 0; i < nl; i++) {
    if (compareLabels(bus0[i], bus1[i]) > 0) [bus0[i], bus1[i]] = [bus1[i], bus0[i]];
  }
  st.set("bus0", bus0);
  st.set("bus1", bus1);

  const out = outputColumns(c);
  const columns = st.columns.values.filter((col) => !out.has(col));
  const strategies = alignStrategies({ ...DEFAULT_LINE_STRATEGIES, ...custom_strategies }, columns, "Line");

  // grouper: ngroup() over sorted (bus0, bus1, *custom) keys, as strings
  const gkeys = st.index.values.map((_, i) => [bus0[i], bus1[i], ...custom_line_groupers.map((g) => st.col(g)[i])]);
  const uniq = [...new Map(gkeys.map((k) => [labelKey(k), k])).values()].sort(compareLabels);
  const gnum = new Map(uniq.map((k, i) => [labelKey(k), String(i)]));
  const grouper = gkeys.map((k) => gnum.get(labelKey(k)));

  const length = Float64Array.from({ length: nl }, (_, i) => haversinePts(clAt("x", bus0[i]), clAt("y", bus0[i]), clAt("x", bus1[i]), clAt("y", bus1[i])) * line_length_factor);
  st.set("length", length);
  const lengthFactor = Float64Array.from({ length: nl }, (_, i) => (origLength[i] > 0 ? length[i] / origLength[i] : length[i]));
  const vNom = Float64Array.from({ length: nl }, (_, i) => Math.max(clAt("v_nom", bus0[i]), clAt("v_nom", bus1[i])));
  const voltageFactor = Float64Array.from({ length: nl }, (_, i) => (origVNom[i] / vNom[i]) ** 2);

  const members = new Map();
  grouper.forEach((g, i) => {
    if (!members.has(g)) members.set(g, []);
    members.get(g).push(i);
  });
  const capW = new Float64Array(nl);
  const sNom = st.col("s_nom");
  for (const idx of members.values()) {
    const w = normed_or_uniform(idx.map((i) => sNom[i]));
    idx.forEach((i, k) => (capW[i] = w[k]));
  }
  const strat = { ...strategies };
  for (const [col, s] of Object.entries(strategies)) {
    const v = st.col(col);
    if (s === "capacity_weighted_average") {
      st.set(
        col,
        Float64Array.from(v, (x, i) => x * capW[i]),
      );
      strat[col] = "sum";
    } else if (s === "reciprocal_voltage_weighted_average") {
      st.set(
        col,
        Float64Array.from(v, (x, i) => voltageFactor[i] / (lengthFactor[i] * x)),
      );
      strat[col] = (xs) => 1.0 / xs.reduce((a, b) => a + (isNa(b) ? 0 : b), 0);
    } else if (s === "voltage_weighted_average") {
      st.set(
        col,
        Float64Array.from(v, (x, i) => voltageFactor[i] * lengthFactor[i] * x),
      );
      strat[col] = "sum";
    } else if (s === "length_capacity_weighted_average") {
      st.set(
        col,
        Float64Array.from(v, (x, i) => x * lengthFactor[i] * capW[i]),
      );
      strat[col] = "sum";
    }
  }
  const { labels, columns: data } = groupAgg(st, grouper, strat);
  const linemap = new Series(grouper, new Index(st.index.values, "name"));
  return { index: labels, data, columns, linemap };
}

/** Aggregate one-port components at the clustered buses (by bus and carrier). */
export function aggregateoneport(n, busmap, component, { carriers = null, buses = null, with_time = true, custom_strategies = {} } = {}) {
  const c = n.c.get(component);
  const st0 = c.static;
  const hasCarrier = st0.has("carrier");
  const carrierSet = hasCarrier ? new Set(carriers ?? st0.col("carrier")) : null;
  const busSet = buses ? new Set(buses) : null;
  const toAgg = st0.index.values.map((_, i) => (hasCarrier ? carrierSet.has(st0.col("carrier")[i]) : true) || (busSet ? busSet.has(st0.col("bus")[i]) : false));
  const aggPos = [];
  const restPos = [];
  toAgg.forEach((t, i) => (t ? aggPos : restPos).push(i));
  const st = st0.takeRows(aggPos);
  const bus = Array.from(st.col("bus"), (b) => mapBus(busmap, b));
  st.set("bus", bus);
  const out = outputColumns(c);
  const columns = st.columns.values.filter((col) => !out.has(col));
  const strategies = { ...DEFAULT_ONE_PORT_STRATEGIES, ...custom_strategies };
  const statStrat = alignStrategies(strategies, columns, component);
  const keys = st.index.values.map((_, i) => (hasCarrier ? [bus[i], st.col("carrier")[i]] : bus[i]));
  const groupOf = new Map();
  keys.forEach((k, i) => {
    const lk = labelKey(k);
    if (!groupOf.has(lk)) groupOf.set(lk, []);
    groupOf.get(lk).push(i);
  });
  const weightsFor = (col) => {
    const w = new Float64Array(st.index.length);
    const v = st.col(col);
    for (const idx of groupOf.values()) {
      const nw = normed_or_uniform(idx.map((i) => v[i]));
      idx.forEach((i, k) => (w[i] = nw[k]));
    }
    return w;
  };
  const capCol = st.columns.values.find((x) => x === "p_nom" || x === "e_nom");
  const capW = capCol ? weightsFor(capCol) : null;
  const wW = st.has("weight") ? weightsFor("weight") : null;
  for (const [k, v] of Object.entries(statStrat)) {
    if (v === "weighted_average") {
      st.set(
        k,
        Float64Array.from(st.col(k), (x, i) => x * wW[i]),
      );
      statStrat[k] = "sum";
    } else if (v === "capacity_weighted_average") {
      st.set(
        k,
        Float64Array.from(st.col(k), (x, i) => x * capW[i]),
      );
      statStrat[k] = "sum";
    } else if (v === "weighted_min") {
      st.set(
        "p_nom_max",
        Float64Array.from(st.col("p_nom_max"), (x, i) => x / wW[i]),
      );
      statStrat[k] = "min";
    }
  }
  const agg = groupAgg(st, keys, statStrat);
  const aggNames = agg.labels.map(flattenLabel);
  // non-aggregated rows keep their names (bus remapped)
  const rest = st0.takeRows(restPos);
  rest.set(
    "bus",
    Array.from(rest.col("bus"), (b) => mapBus(busmap, b)),
  );
  const names = [...aggNames, ...rest.index.values];
  const data = {};
  const allCols = [...new Set([...columns, ...rest.columns.values])];
  for (const col of allCols) {
    const def = c.ctype.defaults.get(col)?.default;
    const a = col in agg.columns ? agg.columns[col] : aggNames.map(() => NaN);
    const b = rest.has(col) ? Array.from(rest.col(col)) : rest.index.values.map(() => NaN);
    data[col] = [...a, ...b].map((v) => (isNa(v) && def !== undefined ? def : v));
  }
  const dynamic = {};
  if (with_time) {
    const dynStrat = alignStrategies(strategies, Object.keys(c.dynamic), component);
    for (const [attr, df] of Object.entries(c.dynamic)) {
      if (df.columns.length === 0 || df.index.length === 0) continue;
      const dense = n.get_switchable_as_dense(component, attr);
      const strategy = dynStrat[attr];
      const res = new DataFrame({ index: dense.index });
      agg.labels.forEach((l, gi) => {
        const memberCols = agg.members[gi].map((i) => dense.col(st.index.at(i)));
        const col = Float64Array.from(dense.index.values, (_, t) => {
          const xs = memberCols.map((a) => a[t]);
          if (strategy === "capacity_weighted_average") return xs.reduce((s, x, k) => s + x * capW[agg.members[gi][k]], 0);
          if (strategy === "weighted_average") return xs.reduce((s, x, k) => s + x * wW[agg.members[gi][k]], 0);
          if (strategy === "weighted_min") return Math.min(...xs.map((x, k) => x / wW[agg.members[gi][k]]));
          return aggValues(xs, strategy, l);
        });
        res.set(aggNames[gi], col);
      });
      for (const nm of rest.index.values) res.set(nm, Float64Array.from(dense.col(nm)));
      // drop columns equal to the static value in all snapshots
      const keep = res.columns.values.filter((nm) => {
        if (!(attr in data)) return true;
        const sv = data[attr][names.indexOf(nm)];
        return !res.col(nm).every((x) => x === sv);
      });
      const fin = new DataFrame({ index: dense.index });
      for (const nm of keep) fin.set(nm, res.col(nm));
      dynamic[attr] = fin;
    }
  }
  return { index: names, data, columns: allCols, dynamic };
}

function addFromColumns(n, component, names, data, columns) {
  if (!names.length) return;
  const kwargs = {};
  const idx = new Index(names, "name");
  for (const col of columns) {
    const vals = data[col];
    kwargs[col] = new Series(isNumberArray(vals) || vals.every((v) => typeof v === "number") ? Float64Array.from(vals) : vals, idx, col);
  }
  n.add(component, names, kwargs);
}

/** Result of a spatial clustering: the clustered network and the bus/line maps. */
export class Clustering {
  constructor(n, busmap, linemap) {
    this.n = n;
    this.busmap = busmap;
    this.linemap = linemap;
  }
}

/**
 * Cluster the network according to `busmap` (bus -> cluster label).
 * @returns {Clustering}
 */
export function get_clustering_from_busmap(n, busmap, opts = {}) {
  const {
    with_time = true,
    line_length_factor = 1.0,
    aggregate_generators_weighted = false,
    aggregate_one_ports = {},
    aggregate_generators_carriers = null,
    scale_link_capital_costs = true,
    bus_strategies = {},
    one_port_strategies = {},
    generator_strategies = {},
    line_strategies = {},
    aggregate_generators_buses = null,
    custom_line_groupers = [],
  } = opts;
  const bm = busmap instanceof Series ? busmap : busmap instanceof Map ? busmap : Series.fromObject(busmap);
  const buses = aggregatebuses(n, bm, bus_strategies);
  const lines = aggregatelines(n, bm, { line_length_factor, custom_strategies: line_strategies, bus_strategies, custom_line_groupers });

  const clustered = new Network();
  addFromColumns(clustered, "Bus", buses.index, buses.data, buses.columns);
  addFromColumns(clustered, "Line", lines.index, lines.data, lines.columns);
  clustered.c.global_constraints.static = n.c.global_constraints.static;

  if (with_time) {
    clustered.set_snapshots(n.snapshots);
    clustered.snapshot_weightings = n.snapshot_weightings.copy();
    if (n.investment_periods.length) {
      clustered.set_investment_periods(n.investment_periods);
      clustered.investment_period_weightings = n.investment_period_weightings.copy();
    }
  }

  const onePorts = new Set(n.one_port_components);
  if (aggregate_generators_weighted) {
    onePorts.delete("Generator");
    const g = aggregateoneport(n, bm, "Generator", { carriers: aggregate_generators_carriers, buses: aggregate_generators_buses, with_time, custom_strategies: generator_strategies });
    addFromColumns(clustered, "Generator", g.index, g.data, g.columns);
    if (with_time) for (const [attr, df] of Object.entries(g.dynamic)) if (df.columns.length) clustered._import_series_from_df(df, "Generator", attr);
  }
  for (const op of Array.isArray(aggregate_one_ports) ? aggregate_one_ports : Object.keys(aggregate_one_ports)) {
    onePorts.delete(op);
    const r = aggregateoneport(n, bm, op, { with_time, custom_strategies: one_port_strategies[op] ?? {} });
    addFromColumns(clustered, op, r.index, r.data, r.columns);
    for (const [attr, df] of Object.entries(r.dynamic)) if (df.columns.length) clustered._import_series_from_df(df, op, attr);
  }
  for (const c of n.components.values()) {
    if (!onePorts.has(c.name)) continue;
    const st = c.static;
    const mapped = Array.from(st.col("bus"), (b) => mapBus(bm, b));
    const keep = [];
    mapped.forEach((b, i) => !isNa(b) && keep.push(i));
    const rows = st.takeRows(keep);
    rows.set(
      "bus",
      keep.map((i) => mapped[i]),
    );
    const data = {};
    for (const col of rows.columns) data[col] = Array.from(rows.col(col));
    addFromColumns(clustered, c.name, rows.index.values, data, rows.columns.values);
  }
  if (with_time) {
    for (const c of n.components.values()) {
      if (!onePorts.has(c.name)) continue;
      for (const [attr, df] of Object.entries(c.dynamic)) {
        if (df.columns.length && df.index.length) clustered._import_series_from_df(df, c.name, attr);
      }
    }
  }

  // links
  const links = n.c.links.static;
  if (links.index.length) {
    const busCols = ["bus0", "bus1", ...n.c.links.additional_ports.map((p) => `bus${p}`)];
    const mappedCols = Object.fromEntries(busCols.filter((col) => links.has(col)).map((col) => [col, Array.from(links.col(col), (b) => mapBus(bm, b))]));
    const keep = [];
    links.index.values.forEach((_, i) => {
      const a = mappedCols.bus0[i];
      const b = mappedCols.bus1[i];
      if (!isNa(a) && !isNa(b) && a !== b) keep.push(i);
    });
    const nlk = links.takeRows(keep);
    for (const [col, v] of Object.entries(mappedCols)) nlk.set(col, keep.map((i) => v[i]));
    const bpos = new Map(buses.index.map((b, i) => [labelKey(b), i]));
    const bx = (b) => buses.data.x[bpos.get(labelKey(b))];
    const by = (b) => buses.data.y[bpos.get(labelKey(b))];
    const origLen = nlk.col("length");
    const newLen = Float64Array.from(keep, (_, k) => {
      const L = origLen[k];
      if (!isNa(L) && L > 0) return line_length_factor * haversinePts(bx(nlk.col("bus0")[k]), by(nlk.col("bus0")[k]), bx(nlk.col("bus1")[k]), by(nlk.col("bus1")[k]));
      return 0;
    });
    nlk.set("length", newLen);
    if (scale_link_capital_costs) {
      nlk.set(
        "capital_cost",
        Float64Array.from(nlk.col("capital_cost"), (cc, k) => {
          const f = newLen[k] / origLen[k];
          return cc * (Number.isNaN(f) ? 1 : f);
        }),
      );
    }
    const data = {};
    for (const col of nlk.columns) data[col] = Array.from(nlk.col(col));
    addFromColumns(clustered, "Link", nlk.index.values, data, nlk.columns.values);
    if (with_time) for (const [attr, df] of Object.entries(n.c.links.dynamic)) if (df.columns.length && df.index.length) clustered._import_series_from_df(df, "Link", attr);
  }

  const car = n.c.carriers.static;
  if (car.index.length) {
    const data = {};
    for (const col of car.columns) data[col] = Array.from(car.col(col));
    addFromColumns(clustered, "Carrier", car.index.values, data, car.columns.values);
  }
  clustered.determine_network_topology();
  return new Clustering(clustered, busmap, lines.linemap);
}

/** Collapse stub buses (degree one) into their neighbours. */
export function busmap_by_stubs(n, matching_attrs = null) {
  const busmap = new Map(n.c.buses.static.index.values.map((b) => [b, b]));
  const adj = new Map(n.c.buses.static.index.values.map((b) => [b, new Set()]));
  for (const cname of [...n.branch_components].sort()) {
    const st = n.c.get(cname).static;
    st.index.values.forEach((_, i) => {
      const a = st.col("bus0")[i];
      const b = st.col("bus1")[i];
      if (a === b) return;
      adj.get(a)?.add(b);
      adj.get(b)?.add(a);
    });
  }
  const bs = n.c.buses.static;
  const match = (u, v) => matching_attrs === null || matching_attrs.every((a) => bs.at(u, a) === bs.at(v, a));
  for (;;) {
    const stubs = [];
    for (const u of [...adj.keys()]) {
      const nb = [...adj.get(u)];
      if (nb.length === 1 && match(u, nb[0])) {
        const v = nb[0];
        for (const [k, val] of busmap) if (val === u) busmap.set(k, v);
        stubs.push(u);
        adj.get(v).delete(u);
        adj.delete(u);
      }
    }
    if (!stubs.length) break;
  }
  return new Series(
    [...busmap.values()],
    new Index([...busmap.keys()], "name"),
  );
}

/**
 * k-means busmap on bus coordinates (Lloyd's algorithm with k-means++
 * initialisation and a seeded RNG; scikit-learn's implementation differs, so
 * labels need not match PyPSA).
 */
export function busmap_by_kmeans(n, bus_weightings, n_clusters, { buses_i = null, random_state = 0, n_init = 10, max_iter = 300 } = {}) {
  const bs = n.c.buses.static;
  const names = buses_i ? (buses_i instanceof Index ? buses_i.values : buses_i) : bs.index.values;
  const pts = [];
  const w = bus_weightings instanceof Series ? bus_weightings : Series.fromObject(bus_weightings);
  for (const b of names) {
    const rep = Math.trunc(w.getOr(b, 0));
    for (let r = 0; r < rep; r++) pts.push([bs.at(b, "x"), bs.at(b, "y")]);
  }
  let seed = random_state >>> 0 || 1;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  let best = null;
  for (let run = 0; run < n_init; run++) {
    const centers = [pts[Math.floor(rand() * pts.length)]];
    while (centers.length < n_clusters) {
      const dist = pts.map((p) => Math.min(...centers.map((c) => d2(p, c))));
      const tot = dist.reduce((a, b) => a + b, 0);
      let r = rand() * tot;
      let k = 0;
      while (k < pts.length - 1 && r > dist[k]) r -= dist[k++];
      centers.push(pts[k]);
    }
    let assign = new Int32Array(pts.length);
    for (let it = 0; it < max_iter; it++) {
      let changed = false;
      pts.forEach((p, i) => {
        let bi = 0;
        let bd = Infinity;
        centers.forEach((c, j) => {
          const d = d2(p, c);
          if (d < bd) [bd, bi] = [d, j];
        });
        if (assign[i] !== bi) changed = true;
        assign[i] = bi;
      });
      for (let j = 0; j < centers.length; j++) {
        const mem = pts.filter((_, i) => assign[i] === j);
        if (mem.length) centers[j] = [mem.reduce((s, p) => s + p[0], 0) / mem.length, mem.reduce((s, p) => s + p[1], 0) / mem.length];
      }
      if (!changed && it > 0) break;
    }
    const inertia = pts.reduce((s, p, i) => s + d2(p, centers[assign[i]]), 0);
    if (!best || inertia < best.inertia) best = { inertia, centers: centers.map((c) => [...c]) };
  }
  const labels = names.map((b) => {
    const p = [bs.at(b, "x"), bs.at(b, "y")];
    let bi = 0;
    let bd = Infinity;
    best.centers.forEach((c, j) => {
      const d = d2(p, c);
      if (d < bd) [bd, bi] = [d, j];
    });
    return String(bi);
  });
  return new Series(labels, new Index(names, "name"));
}

/**
 * Busmap from Clauset-Newman-Moore greedy modularity communities of the line
 * graph, weighted by `s_nom / |r + jx|` (networkx, exactly `n_clusters`
 * communities; labels by decreasing community size).
 */
export function busmap_by_greedy_modularity(n, n_clusters, buses_i = null) {
  if (buses_i && !(buses_i instanceof Index) && !Array.isArray(buses_i)) buses_i = buses_i.buses_i ?? null;
  const buses = buses_i === null ? n.c.buses.static.index.values : asList(buses_i);
  n.calculate_dependent_values();
  const st = n.c.lines.static;
  const inBuses = new Set(buses.map(labelKey));
  const edges = [];
  st.index.values.forEach((_, i) => {
    const b0 = st.col("bus0")[i];
    const b1 = st.col("bus1")[i];
    if (!inBuses.has(labelKey(b0)) || !inBuses.has(labelKey(b1))) return;
    edges.push([b0, b1, st.col("s_nom")[i] / pyHypot(st.col("r")[i], st.col("x")[i])]);
  });
  const communities = greedy_modularity_communities(buses, edges, { best_n: n_clusters, cutoff: n_clusters });
  const label = new Map();
  communities.forEach((c, k) => c.forEach((b) => label.set(labelKey(b), String(k))));
  return new Series(
    buses.map((b) => label.get(labelKey(b))),
    new Index(buses.map(String), "name"),
  );
}

function asList(x) {
  return x instanceof Index ? x.values : Array.isArray(x) ? x : [x];
}

/** `_scenarios_not_implemented`: spatial clustering does not support stochastic networks. */
function scenariosNotImplemented(n, method) {
  if (n.has_scenarios) throw new Error(`ValueError: Method '${method}' is not yet implemented for stochastic networks.`);
}

/** Spatial clustering accessor (`n.cluster.spatial`). */
export class SpatialClusteringAccessor {
  constructor(n) {
    this._n = n;
  }

  get_clustering_from_busmap(busmap, opts = {}) {
    scenariosNotImplemented(this._n, "get_clustering_from_busmap");
    return get_clustering_from_busmap(this._n, busmap, opts);
  }

  cluster_by_busmap(busmap, opts = {}) {
    scenariosNotImplemented(this._n, "cluster_by_busmap");
    return get_clustering_from_busmap(this._n, busmap, opts).n;
  }

  busmap_by_kmeans(bus_weightings, n_clusters, opts = {}) {
    scenariosNotImplemented(this._n, "busmap_by_kmeans");
    return busmap_by_kmeans(this._n, bus_weightings, n_clusters, opts);
  }

  cluster_by_kmeans(bus_weightings, n_clusters, { line_length_factor = 1.0, ...opts } = {}) {
    scenariosNotImplemented(this._n, "cluster_by_kmeans");
    const busmap = busmap_by_kmeans(this._n, bus_weightings, n_clusters, opts);
    return get_clustering_from_busmap(this._n, busmap, { line_length_factor }).n;
  }

  busmap_by_stubs(matching_attrs = null) {
    return busmap_by_stubs(this._n, matching_attrs);
  }

  busmap_by_hac() {
    scenariosNotImplemented(this._n, "busmap_by_hac");
    throw new Error("busmap_by_hac (scikit-learn agglomerative clustering) is not available in PSA.js; compute a busmap and use cluster_by_busmap.");
  }

  busmap_by_greedy_modularity(n_clusters, buses_i = null) {
    scenariosNotImplemented(this._n, "busmap_by_greedy_modularity");
    return busmap_by_greedy_modularity(this._n, n_clusters, buses_i);
  }

  cluster_by_greedy_modularity(n_clusters, buses_i = null, { line_length_factor = 1.0 } = {}) {
    scenariosNotImplemented(this._n, "cluster_by_greedy_modularity");
    if (buses_i && !(buses_i instanceof Index) && !Array.isArray(buses_i)) ({ buses_i = null, line_length_factor = 1.0 } = buses_i);
    const busmap = busmap_by_greedy_modularity(this._n, n_clusters, buses_i);
    return get_clustering_from_busmap(this._n, busmap, { line_length_factor }).n;
  }
}

void logger;

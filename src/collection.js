// SPDX-License-Identifier: MIT
/**
 * Collections of networks (mirrors `pypsa.NetworkCollection`).
 *
 * A collection behaves like a single network whose component data carry the
 * collection index (default level `network`, the network names) as leading
 * index levels: static data and active assets are concatenated row-wise, time
 * series column-wise, and network-wide properties (snapshots, component
 * sets, investment periods) come from the first network. Statistics evaluate
 * every member and add the collection levels after `component`.
 */

import { Network } from "./network/network.js";
import { DataFrame, Series, isNumberArray } from "./core/frame.js";
import { Index, labelKey } from "./core/index.js";
import { makeStatisticsAccessor } from "./statistics/accessor.js";

function keyTuple(key) {
  return Array.isArray(key) ? key : [key];
}

/** `pd.concat(results, axis=0)`: rows prefixed with the collection keys. */
function concatRows(collection, frames) {
  const names = collection._index_names;
  const labels = [];
  const parts = [];
  frames.forEach(([key, df]) => {
    const innerNames = df.index.isMulti ? df.index.names : [df.index.name ?? "name"];
    for (const l of df.index.values) labels.push([...keyTuple(key), ...(df.index.isMulti ? l : [l])]);
    parts.push([df, innerNames]);
  });
  const columns = [];
  for (const [df] of parts) for (const c of df.columns.values) if (!columns.some((x) => labelKey(x) === labelKey(c))) columns.push(c);
  const data = new Map();
  for (const c of columns) {
    const arrays = parts.map(([df]) => (df.has(c) ? Array.from(df.col(c)) : new Array(df.index.length).fill(NaN)));
    const flat = arrays.flat();
    data.set(c, parts.every(([df]) => !df.has(c) || isNumberArray(df.col(c))) ? Float64Array.from(flat) : flat);
  }
  const first = parts[0]?.[1] ?? ["name"];
  return new DataFrame({ index: new Index(labels, [...names, ...first]), columns, data, dtypes: parts[0]?.[0].dtypes });
}

/** `pd.concat(results, axis=1)`: columns prefixed with the collection keys. */
function concatColumns(collection, frames) {
  const names = collection._index_names;
  const index = frames.length ? frames[0][1].index : new Index([], "snapshot");
  const cols = [];
  const data = new Map();
  for (const [key, df] of frames) {
    const pos = df.index.equals(index) ? null : df.index.getIndexer(index);
    for (const c of df.columns.values) {
      const t = [...keyTuple(key), ...(Array.isArray(c) ? c : [c])];
      cols.push(t);
      const a = df.col(c);
      data.set(t, pos === null ? Float64Array.from(a) : Float64Array.from(pos, (p) => (p < 0 ? NaN : a[p])));
    }
  }
  const inner = frames.length && frames[0][1].columns.isMulti ? frames[0][1].columns.names : ["name"];
  return new DataFrame({ index, columns: new Index(cols, [...names, ...inner]), data });
}

/** `MemberProxy.index_concat`: an index of (keys..., value) tuples. */
function concatIndexes(collection, results) {
  const labels = [];
  for (const [key, idx] of results) for (const v of idx.values) labels.push([...keyTuple(key), v]);
  const name = results.length ? results[0][1].name : null;
  return new Index(labels, [...collection._index_names, ...(name ? [name] : [])]);
}

/** One component type across the networks of a collection (`nc.c.generators`). */
class CollectionComponents {
  constructor(collection, name) {
    this._collection = collection;
    this._name = name;
  }

  _members() {
    return this._collection._members().map(([key, n]) => [key, n.c.get(this._name)]);
  }

  get _first() {
    return this._members()[0][1];
  }

  get name() {
    return this._first.name;
  }

  get list_name() {
    return this._first.list_name;
  }

  get ports() {
    return this._first.ports;
  }

  _as_port(port) {
    return this._first._as_port(port);
  }

  _as_ports(ports) {
    return this._first._as_ports(ports);
  }

  get static() {
    return concatRows(
      this._collection,
      this._members().map(([key, c]) => [key, c.static]),
    );
  }

  get dynamic() {
    const members = this._members();
    const out = {};
    const attrs = [];
    for (const [, c] of members) for (const k of Object.keys(c.dynamic)) if (!attrs.includes(k)) attrs.push(k);
    for (const attr of attrs) {
      Object.defineProperty(out, attr, {
        enumerable: true,
        get: () =>
          concatColumns(
            this._collection,
            members.filter(([, c]) => c.dynamic[attr]).map(([key, c]) => [key, c.dynamic[attr]]),
          ),
      });
    }
    return out;
  }

  get committables() {
    return concatIndexes(
      this._collection,
      this._members().map(([key, c]) => [key, c.committables]),
    );
  }

  get_active_assets(investment_period = null) {
    const parts = this._members().map(([key, c]) => {
      const s = c.get_active_assets(investment_period);
      return [key, new DataFrame({ index: s.index, columns: ["active"], data: { active: Array.from(s.values) } })];
    });
    const df = concatRows(this._collection, parts);
    return new Series(df.col("active"), df.index, "active");
  }

  get capital_cost() {
    return this._seriesConcat((c) => new Series(Float64Array.from(c.capital_cost), c.static.index, "capital_cost"));
  }

  get annuity() {
    return this._seriesConcat((c) => new Series(Float64Array.from(c.annuity), c.static.index, "annuity"));
  }

  _seriesConcat(fn) {
    const parts = this._members().map(([key, c]) => {
      const s = fn(c);
      return [key, new DataFrame({ index: s.index, columns: [s.name], data: { [s.name]: s.values } })];
    });
    const df = concatRows(this._collection, parts);
    const name = df.columns.at(0);
    return new Series(df.col(name), df.index, name);
  }
}

/** `nc.c` / `nc.components`: component accessors by class or list name. */
class CollectionComponentsStore {
  constructor(collection) {
    this._collection = collection;
    const first = collection._members()[0][1];
    for (const c of first.components.values()) {
      for (const key of new Set([c.name, c.list_name])) {
        Object.defineProperty(this, key, { enumerable: false, get: () => new CollectionComponents(collection, c.name) });
      }
    }
  }

  get(name) {
    const first = this._collection._members()[0][1];
    return new CollectionComponents(this._collection, first.c.get(name).name);
  }
}

export class NetworkCollection {
  /**
   * @param {Network[]|Map|object|Series} networks member networks; for a Map,
   *   object or Series the keys become the collection index
   * @param {object} [opts]
   * @param {Index|Array} [opts.index] collection index (default: the network
   *   names, level `network`)
   */
  constructor(networks, { index = null } = {}) {
    let keys = null;
    let list;
    if (networks instanceof Series) {
      if (index !== null) throw new Error("ValueError: When passing a pandas Series or dict, the index must be None, as the keys are used as the collection index.");
      keys = networks.index;
      list = Array.from(networks.values);
    } else if (networks instanceof Map || (networks && typeof networks === "object" && !Array.isArray(networks) && !(networks instanceof Network))) {
      if (index !== null) throw new Error("ValueError: When passing a pandas Series or dict, the index must be None, as the keys are used as the collection index.");
      const entries = networks instanceof Map ? [...networks.entries()] : Object.entries(networks);
      keys = new Index(
        entries.map(([k]) => k),
        "network",
      );
      list = entries.map(([, v]) => v);
    } else if (typeof networks === "string") {
      throw new Error("TypeError: Single strings are not supported. Pass a list of strings or Network objects.");
    } else {
      list = Array.from(networks);
    }
    for (const n of list) {
      if (!(n instanceof Network)) {
        throw new Error(`TypeError: All values must be PSA.js Network objects, got ${typeof n}. (Load files first, e.g. with Network.from_netcdf.)`);
      }
    }
    if (keys === null) {
      if (index === null) {
        const names = list.map((n) => (n.name ? n.name : "network"));
        const dup = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
        if (dup.length) {
          throw new Error(`ValueError: Duplicate network names found: [${dup.map((d) => `'${d}'`).join(", ")}]. Please provide a custom index or ensure all networks have unique names.`);
        }
        keys = new Index(names, "network");
      } else {
        keys = index instanceof Index ? index : new Index(Array.from(index));
        if (keys.length !== list.length) throw new Error("ValueError: The length of the index must match the number of networks provided.");
      }
    }
    if (!keys.isMulti && (keys.name === null || keys.name === undefined)) keys = new Index(keys.values, "network");
    if (keys.isMulti && keys.names.some((x) => x === null || x === undefined)) throw new Error("ValueError: All levels of MultiIndex must have names");
    this.networks = new Series(list, keys);
    this._validate_network_compatibility();
    this.statistics = makeStatisticsAccessor(this);
  }

  _validate_network_compatibility() {
    const list = this.networks.values;
    if (list.length <= 1) return;
    const periods = list.map((n) => n.has_investment_periods);
    if (periods.some(Boolean) && !periods.every(Boolean)) {
      throw new Error(
        "ValueError: NetworkCollection cannot mix networks with and without investment periods. All member networks must either have investment periods or none of them must.",
      );
    }
  }

  /** `[[key, network], ...]` in collection order. */
  _members() {
    if (!this.networks.values.length) throw new Error("AttributeError: Please provide at least one network.");
    return this.networks.index.values.map((k, i) => [k, this.networks.values[i]]);
  }

  get _first() {
    return this._members()[0][1];
  }

  get index() {
    return this.networks.index;
  }

  get _index_names() {
    return this.index.isMulti ? this.index.names : [this.index.name];
  }

  get is_collection() {
    return true;
  }

  get has_scenarios() {
    return this.networks.values.some((n) => n.has_scenarios);
  }

  get length() {
    return this.networks.values.length;
  }

  [Symbol.iterator]() {
    return this.networks.values[Symbol.iterator]();
  }

  /** Member network by key. */
  get_network(key) {
    const i = this.index.getLoc(key);
    if (i < 0) throw new Error(`KeyError: "Collection '${key}' not found in network collection."`);
    return this.networks.values[i];
  }

  // ---------------------------------------------- properties of the first network

  get snapshots() {
    return this._first.snapshots;
  }

  get has_investment_periods() {
    return this._first.has_investment_periods;
  }

  get investment_periods() {
    return this._first.investment_periods;
  }

  get investment_period_weightings() {
    return this._first.investment_period_weightings;
  }

  get periods() {
    return this._first.periods;
  }

  get has_periods() {
    return this._first.has_periods;
  }

  get branch_components() {
    return this._first.branch_components;
  }

  get passive_branch_components() {
    return this._first.passive_branch_components;
  }

  get controllable_branch_components() {
    return this._first.controllable_branch_components;
  }

  get one_port_components() {
    return this._first.one_port_components;
  }

  get passive_one_port_components() {
    return this._first.passive_one_port_components;
  }

  get controllable_one_port_components() {
    return this._first.controllable_one_port_components;
  }

  get standard_type_components() {
    return this._first.standard_type_components;
  }

  get all_components() {
    return this._first.all_components;
  }

  bus_carrier_unit(bus_carrier) {
    return this._first.bus_carrier_unit(bus_carrier);
  }

  // ---------------------------------------------- concatenated data

  get snapshot_weightings() {
    return concatRows(
      this,
      this._members().map(([key, n]) => [key, n.snapshot_weightings]),
    );
  }

  get c() {
    return new CollectionComponentsStore(this);
  }

  get components() {
    return this.c;
  }

  get_switchable_as_dense(component, attr, snapshots = null, inds = null) {
    return concatColumns(
      this,
      this._members().map(([key, n]) => [key, n.get_switchable_as_dense(component, attr, snapshots, inds)]),
    );
  }

  get_committable_i(c) {
    return concatIndexes(
      this,
      this._members().map(([key, n]) => [key, n.get_committable_i(c)]),
    );
  }

  toString() {
    const entries = this.index.values.slice(0, 5).map((v) => (Array.isArray(v) ? `(${v.map((x) => `'${x}'`).join(", ")})` : `'${v}'`));
    const more = this.length > 5 ? ` ... and ${this.length - 5} more` : "";
    const info = this.index.isMulti
      ? `MultiIndex with ${this.index.nlevels} levels: [${this.index.names.map((x) => `'${x}'`).join(", ")}]\n  First ${entries.length} entries: [${entries.join(", ")}]${more}`
      : `Index name: '${this.index.name ?? "network"}'\nEntries: [${entries.join(", ")}]${more}`;
    return `NetworkCollection\n-----------------\nNetworks: ${this.length}\n${info}`;
  }
}

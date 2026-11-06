// SPDX-License-Identifier: MIT
/**
 * Components container (mirrors `pypsa.components.components.Components`
 * plus its descriptor/index/array mixins).
 */

import { DataFrame, Series, isNumberArray } from "../core/frame.js";
import { Index, asIndex, labelKey } from "../core/index.js";
import { DataArray, Dataset } from "../core/dataarray.js";
import { isSnapshotMajor } from "../network/scenario_frames.js";
import { annuity, periodizedCost } from "../costs.js";
import { typToDtype } from "./types.js";
import { logger } from "../logger.js";
import { piecewiseAttrs, piecewiseSchema, splitPort, emptyPiecewiseFrame } from "./piecewise.js";

export const RE_PORTS = /^bus(\d*)$/;
export const RE_PORTS_GE_2 = /^bus((?:[2-9]|[1-9]\d+))$/;

export const NOMINAL_ATTRS = {
  Generator: "p_nom",
  Line: "s_nom",
  Transformer: "s_nom",
  Link: "p_nom",
  Process: "p_nom",
  Store: "e_nom",
  StorageUnit: "p_nom",
};

const OPERATIONAL_BASE = {
  Generator: "p",
  Line: "s",
  Link: "p",
  Load: "p",
  Process: "p",
  StorageUnit: "p",
  Store: "e",
  Transformer: "s",
};

export function emptyStaticFrame(ctype) {
  const cols = [];
  const data = new Map();
  const dtypes = {};
  for (const [attr, def] of ctype.defaults) {
    if (!def.static || attr === "name") continue;
    cols.push(attr);
    const dt = typToDtype(def.typ);
    dtypes[attr] = dt;
    data.set(attr, dt === "float" || dt === "int" ? new Float64Array(0) : []);
  }
  return new DataFrame({ index: new Index([], "name"), columns: cols, data, dtypes });
}

export class Components {
  constructor(ctype, n = null) {
    this.ctype = ctype;
    this.n = n;
    this.static = emptyStaticFrame(ctype);
    this.dynamic = {};
    const sns = n ? n.snapshots : new Index(["now"], "snapshot");
    for (const [attr, def] of ctype.defaults) {
      if (def.varying) this.dynamic[attr] = new DataFrame({ index: sns, columns: [] });
    }
    // Piecewise breakpoint data: one empty frame per piecewise y attribute
    this.piecewise = {};
    for (const row of piecewiseAttrs(ctype.name)) {
      if (!(row.y in this.piecewise)) this.piecewise[row.y] = emptyPiecewiseFrame();
    }
  }

  // ------------------------------------------------------------------
  // Piecewise data
  // ------------------------------------------------------------------

  /** Piecewise schema rows for this component type. */
  get _piecewise_attrs() {
    return piecewiseAttrs(this.name);
  }

  /** Whether this component has piecewise breakpoint data for `attr`. */
  has_piecewise(attr) {
    const df = this.piecewise[attr];
    return df !== undefined && !df.empty;
  }

  /** Piecewise schema row for `attr`, ignoring any port suffix (null if undefined). */
  _piecewise_schema(attr) {
    let row = piecewiseSchema(this.name, attr);
    const [base, port] = splitPort(attr);
    if (!row && port) {
      // only schema rows with a {port} placeholder accept suffixed attrs
      const candidate = piecewiseSchema(this.name, base);
      if (candidate && candidate.aux_variable.includes("{port}")) row = candidate;
    }
    return row;
  }

  /** Model-variable name of the piecewise auxiliary variable for `attr`. */
  _piecewise_aux_var(attr) {
    const row = this._piecewise_schema(attr);
    if (!row) throw new Error(`ValueError: '${this.name}' has no piecewise schema for attribute '${attr}'.`);
    // an empty port suffix denotes port 1
    const port = splitPort(attr)[1] || "1";
    return `${this.name}-${row.aux_variable.replace("{port}", port)}`;
  }

  /** Model-variable name of the piecewise x variable for `attr`. */
  _piecewise_x_var(attr) {
    const row = this._piecewise_schema(attr);
    if (!row) throw new Error(`ValueError: '${this.name}' has no piecewise schema for attribute '${attr}'.`);
    return `${this.name}-${row.x.replaceAll("_pu", "")}`;
  }

  // ------------------------------------------------------------------
  // Basic descriptors
  // ------------------------------------------------------------------

  get name() {
    return this.ctype.name;
  }

  get list_name() {
    return this.ctype.list_name;
  }

  get description() {
    return this.ctype.description;
  }

  get category() {
    return this.ctype.category;
  }

  get type() {
    return this.ctype.category;
  }

  /** Attribute definitions (ordered Map attr -> definition). */
  get defaults() {
    return this.ctype.defaults;
  }

  get standard_types() {
    return this.ctype.standard_types;
  }

  get empty() {
    return this.static.index.length === 0;
  }

  get length() {
    return this.static.index.length;
  }

  get attached() {
    return this.n !== null;
  }

  /** Component names (unique `name` level for stochastic networks). */
  get names() {
    const idx = this.static.index;
    return idx.isMulti ? idx.uniqueLevel("name") : idx.unique();
  }

  get snapshots() {
    return this.n.snapshots;
  }

  get investment_periods() {
    return this.n.investment_periods;
  }

  get has_investment_periods() {
    return this.n.has_investment_periods;
  }

  get has_scenarios() {
    return this.n ? this.n.has_scenarios : false;
  }

  get scenarios() {
    return this.n ? this.n.scenarios : new Index([], "scenario");
  }

  toString() {
    return `'${this.name}' Components`;
  }

  /** Attribute default value. */
  defaultOf(attr) {
    const d = this.ctype.defaults.get(attr);
    return d ? d.default : NaN;
  }

  // ------------------------------------------------------------------
  // Ports
  // ------------------------------------------------------------------

  get ports() {
    const out = [];
    for (const c of this.static.columns) {
      const m = RE_PORTS.exec(c);
      if (m) out.push(m[1]);
    }
    return out;
  }

  get additional_ports() {
    const out = [];
    for (const c of this.static.columns) {
      const m = RE_PORTS_GE_2.exec(c);
      if (m) out.push(m[1]);
    }
    return out;
  }

  _as_port(port) {
    if (typeof port === "string") {
      const p = port.startsWith("bus") ? port.slice(3) : port;
      if (p === "") return 0;
      const v = Number(p);
      if (!Number.isInteger(v)) throw new Error(`Ports should be given as int or 'busX' string, not: ${port}`);
      return v;
    }
    return port;
  }

  _as_ports(ports) {
    if (ports === "all") return this.ports.map((_, i) => i);
    if (typeof ports === "string" || typeof ports === "number") return [this._as_port(ports)];
    return ports.map((p) => this._as_port(p));
  }

  // Multiport (Link/Process) helpers -----------------------------------

  get _coefficient_attr() {
    return this.name === "Process" ? "rate" : "efficiency";
  }

  get _output_ports() {
    if (this.name === "Process") return this.ports;
    return ["1", ...this.additional_ports];
  }

  _port_suffix(port) {
    if (this.name === "Process") return port;
    return port === "1" ? "" : port;
  }

  get _unsuffixed_attrs() {
    return this.name === "Link" ? new Set(["efficiency", "delay", "cyclic_delay"]) : new Set();
  }

  // ------------------------------------------------------------------
  // Carriers / operational attributes
  // ------------------------------------------------------------------

  get unique_carriers() {
    if (this.empty || !this.static.has("carrier")) return new Set();
    return new Set(this.static.col("carrier").filter((c) => typeof c === "string" && c !== ""));
  }

  get _operational_attrs() {
    const base = OPERATIONAL_BASE[this.name];
    if (base === undefined) throw new Error(`Component ${this.name} has no operational attributes.`);
    return {
      base,
      nom: `${base}_nom`,
      nom_extendable: `${base}_nom_extendable`,
      nom_min: `${base}_nom_min`,
      nom_max: `${base}_nom_max`,
      nom_set: `${base}_nom_set`,
      nom_mod: `${base}_nom_mod`,
      min_pu: `${base}_min_pu`,
      max_pu: `${base}_max_pu`,
      set: `${base}_set`,
    };
  }

  /** Names where `mask` holds (single-level, as scenarios cannot vary them). */
  _indexWhere(mask) {
    const idx = this.static.index.filter(mask);
    return idx.isMulti ? idx.uniqueLevel("name") : idx;
  }

  /** Empty name index (`static.iloc[:0].index`, without the scenario level). */
  _emptyNames() {
    const idx = this.static.index;
    return idx.isMulti ? new Index([], "name") : idx.slice(0, 0);
  }

  get extendables() {
    const col = OPERATIONAL_BASE[this.name] ? `${OPERATIONAL_BASE[this.name]}_nom_extendable` : null;
    if (!col || !this.static.has(col)) return this._emptyNames();
    return this._indexWhere(this.static.col(col).map(Boolean));
  }

  get fixed() {
    const col = OPERATIONAL_BASE[this.name] ? `${OPERATIONAL_BASE[this.name]}_nom_extendable` : null;
    if (!col || !this.static.has(col)) return this._emptyNames();
    return this._indexWhere(this.static.col(col).map((x) => !x));
  }

  get committables() {
    if (!this.static.has("committable")) return this._emptyNames();
    return this._indexWhere(this.static.col("committable").map(Boolean));
  }

  /** Components with maintenance scheduling (`maintainable=True`). */
  get maintainables() {
    if (!this.static.has("maintainable")) return this._emptyNames();
    return this._indexWhere(this.static.col("maintainable").map(Boolean));
  }

  get modulars() {
    const base = OPERATIONAL_BASE[this.name];
    const col = base ? `${base}_nom_mod` : null;
    if (!col || !this.static.has(col)) return this._emptyNames();
    return this._indexWhere(Array.from(this.static.col(col), (x) => x > 0));
  }

  // ------------------------------------------------------------------
  // Activity
  // ------------------------------------------------------------------

  /**
   * Boolean Series of active assets (optionally for investment period(s)).
   * @returns {Series}
   */
  get_active_assets(investment_period = null) {
    const active = this.static.has("active") ? this.static.col("active").map(Boolean) : this.static.index.map(() => true);
    if (investment_period === null || investment_period === undefined) {
      return new Series(active, this.static.index, "active");
    }
    if (!this.static.has("build_year") || !this.static.has("lifetime")) return new Series(active, this.static.index, "active");
    const periods = Array.isArray(investment_period) ? investment_period : [investment_period];
    const by = this.static.col("build_year");
    const lt = this.static.col("lifetime");
    const ip = this.n.investment_periods;
    const out = active.map(() => false);
    for (const p of periods) {
      if (!ip.has(p)) throw new Error("Investment period not in `n.investment_periods`");
      for (let i = 0; i < out.length; i++) {
        if (by[i] <= p && p < by[i] + lt[i]) out[i] = true;
      }
    }
    return new Series(
      out.map((v, i) => v && active[i]),
      this.static.index,
      "active",
    );
  }

  /** Names of assets active in any scenario. */
  get active_assets() {
    // scenario views of stochastic networks keep the names active in any scenario
    if (this._activeNamesOverride) return this._activeNamesOverride;
    const a = this.get_active_assets();
    const idx = this.static.index.filter(a.values);
    return idx.isMulti ? idx.uniqueLevel("name") : idx.unique();
  }

  get inactive_assets() {
    return this.names.difference(this.active_assets);
  }

  /** Restrict `data` (indexed by component names) to the active assets. */
  filter_by_active_assets(data, investment_period = null) {
    if (typeof investment_period === "number" && Number.isNaN(investment_period)) investment_period = null;
    if (data instanceof Index || Array.isArray(data)) {
      const idx = asIndex(data);
      if (investment_period !== null) {
        const active = this.get_active_assets(investment_period);
        return idx.filter(idx.values.map((v) => active.getOr(v, false)));
      }
      return idx.intersection(this.active_assets);
    }
    // DataFrame indexed by names
    let names = data.index.unique();
    if (investment_period !== null) {
      const active = this.get_active_assets(investment_period);
      names = names.filter(names.values.map((v) => active.getOr(v, false)));
    } else {
      names = names.intersection(this.active_assets);
    }
    return data.filter(data.index.isin(names));
  }

  /**
   * Activity mask DataFrame (snapshots x names) of booleans.
   */
  get_activity_mask(sns = null, index = null) {
    const snapshots = sns === null ? this.n.snapshots : asIndex(sns);
    const names = this.static.index;
    const data = new Map();
    if (this.has_investment_periods) {
      const perPeriod = new Map();
      for (const p of this.n.investment_periods) perPeriod.set(labelKey(p), this.get_active_assets(p).values);
      const periodPos = snapshots.values.map((s) => s[0]);
      names.values.forEach((nme, j) => {
        data.set(
          nme,
          periodPos.map((p) => perPeriod.get(labelKey(p))[j]),
        );
      });
    } else {
      const act = this.get_active_assets().values;
      names.values.forEach((nme, j) => data.set(nme, new Array(snapshots.length).fill(act[j])));
    }
    let df = new DataFrame({ index: snapshots, columns: names, data });
    if (index !== null) df = df.reindex({ columns: asIndex(index), fill: NaN });
    return df;
  }

  /** The network the component is attached to (raises when detached). */
  get n_save() {
    if (!this.attached) throw new Error("AttributeError: Component must be attached to a Network.");
    return this.n;
  }

  /** PyPSA's class name of the component (`Generators`, `StorageUnits`). */
  get _className() {
    return this.list_name
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");
  }

  /**
   * An attribute as a labelled array (PyPSA's `_as_xarray`): time-varying
   * attributes (snapshot, name) combining static and dynamic values, static
   * ones (name), `"active"` the activity mask. Stochastic networks add a
   * `scenario` dimension: (snapshot, scenario, name) and (scenario, name);
   * the mask is (scenario, name, snapshot) unless the component's name level
   * makes PyPSA's layout snapshot-major.
   */
  _as_xarray(attr) {
    const n = this.n_save;
    const sns = new Index(n.snapshots.values, "snapshot");
    const isActive = attr === "active";
    const isDynamic = !isActive && Object.prototype.hasOwnProperty.call(this.dynamic, attr);
    if (!isActive && !isDynamic && !this.static.has(attr)) {
      throw new Error(`AttributeError: '${this._className}' components has no attribute '${attr}'.`);
    }
    const frame = isActive ? this.get_activity_mask() : isDynamic ? this._as_dynamic(attr) : null;
    const timeVarying = frame !== null;
    if (!this.has_scenarios) {
      const names = new Index(this.static.index.values, "name");
      if (!timeVarying) return new DataArray(Array.from(this.static.col(attr)), { dims: ["name"], coords: [names], name: attr });
      const N = names.length;
      const values = isActive ? new Array(sns.length * N) : new Float64Array(sns.length * N);
      names.values.forEach((nm, j) => {
        const col = frame.col(nm);
        for (let t = 0; t < sns.length; t++) values[t * N + j] = col[t];
      });
      return new DataArray(values, { dims: ["snapshot", "name"], coords: [sns, names], name: attr });
    }
    const scenarios = new Index(n.scenarios.values, "scenario");
    const names = new Index(this.names.values, "name");
    const S = scenarios.length;
    const N = names.length;
    if (!timeVarying) {
      const col = this.static.col(attr);
      const values = [];
      for (const sc of scenarios.values) {
        for (const nm of names.values) {
          const i = this.static.index.getLoc([sc, nm]);
          values.push(i < 0 ? NaN : col[i]);
        }
      }
      const out = values.every((v) => typeof v === "number") ? Float64Array.from(values) : values;
      return new DataArray(out, { dims: ["scenario", "name"], coords: [scenarios, names], name: attr });
    }
    const T = sns.length;
    const values = isActive ? new Array(T * S * N).fill(NaN) : new Float64Array(T * S * N).fill(NaN);
    const snapshotMajor = isActive ? isSnapshotMajor(this) : this._dynamicSnapshotMajor(attr);
    scenarios.values.forEach((sc, s) => {
      names.values.forEach((nm, j) => {
        if (!frame.has([sc, nm])) return;
        const col = frame.col([sc, nm]);
        for (let t = 0; t < T; t++) values[snapshotMajor ? (t * S + s) * N + j : (s * N + j) * T + t] = col[t];
      });
    });
    return snapshotMajor
      ? new DataArray(values, { dims: ["snapshot", "scenario", "name"], coords: [sns, scenarios, names], name: attr })
      : new DataArray(values, { dims: ["scenario", "name", "snapshot"], coords: [scenarios, names, sns], name: attr });
  }

  /**
   * Whether PyPSA's `c.da.<attr>` of a time-varying attribute is laid out
   * (snapshot, scenario, name): `_as_dynamic` concatenates the time series of
   * some components with the static values of the others, which sorts the
   * `name` level; with time series for none or all of them the columns keep
   * the component's own level order (`isSnapshotMajor`).
   */
  _dynamicSnapshotMajor(attr) {
    const dyn = this.dynamic[attr];
    const index = this.static.index;
    if (!dyn.columns.length || index.values.every((t) => dyn.has(t))) return isSnapshotMajor(this);
    const names = this.names.values;
    const sorted = [...names].sort();
    return names.some((nm, i) => nm !== sorted[i]);
  }

  /** Labelled arrays of the attributes, `c.da.p_max_pu` or `c.da["p_max_pu"]` (PyPSA's xarray accessor). */
  get da() {
    const c = this;
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "symbol" || prop === "then") return undefined;
          if (prop === "toString") return () => `<XarrayAccessor for ${c._className}>`;
          return c._as_xarray(prop);
        },
        has: (_t, prop) => typeof prop === "string" && (c.static.has(prop) || prop in c.dynamic),
        ownKeys: () => [...new Set([...c.static.columns, ...Object.keys(c.dynamic)])].sort(),
        getOwnPropertyDescriptor: (_t, prop) => ({ enumerable: true, configurable: true, value: c._as_xarray(prop) }),
      },
    );
  }

  /**
   * All attributes as a `Dataset` (PyPSA's `c.ds`): the static columns and
   * the time-varying attributes with data.
   */
  get ds() {
    const vars = new Map();
    for (const attr of this.static.columns) vars.set(attr, this._as_xarray(attr));
    for (const [attr, df] of Object.entries(this.dynamic)) if (df.index.length && df.columns.length) vars.set(attr, this._as_xarray(attr));
    return new Dataset(vars);
  }

  // ------------------------------------------------------------------
  // Array helpers
  // ------------------------------------------------------------------

  /**
   * Dense time series of an attribute (snapshots x names), combining static
   * and dynamic values (mirrors `_as_dynamic` / `get_switchable_as_dense`).
   */
  _as_dynamic(attr, snapshots = null, inds = null) {
    const sns = snapshots === null ? this.n.snapshots : asIndex(snapshots);
    let index = this.static.index;
    const staticCol = this.static.colOr(attr, null);
    let dyn = this.dynamic[attr] ?? null;
    if (inds !== null) index = index.intersection(asIndex(inds));
    const data = new Map();
    const staticPos = staticCol ? this.static.index.getIndexer(index) : null;
    let rowPos = null;
    if (dyn && !dyn.index.equals(sns)) rowPos = dyn.index.getIndexer(sns);
    for (let j = 0; j < index.length; j++) {
      const nme = index.at(j);
      const out = new Float64Array(sns.length);
      if (dyn && dyn.has(nme)) {
        const a = dyn.col(nme);
        if (rowPos === null) for (let i = 0; i < out.length; i++) out[i] = a[i];
        else for (let i = 0; i < out.length; i++) out[i] = rowPos[i] < 0 ? NaN : a[rowPos[i]];
      } else {
        const v = staticCol ? staticCol[staticPos[j]] : NaN;
        out.fill(typeof v === "number" ? v : v === true ? 1 : v === false ? 0 : NaN);
      }
      data.set(nme, out);
    }
    return new DataFrame({ index: sns, columns: index, data });
  }

  /** Static attribute as Series. */
  series(attr) {
    return this.static.series(attr);
  }

  /**
   * Lower/upper per-unit bounds as dense frames (snapshots x names).
   */
  get_bounds_pu(attr = null) {
    const name = this.name;
    const dense = (a) => this._as_dynamic(a);
    if (name === "Line" || name === "Transformer") {
      const max = dense("s_max_pu");
      return [max.applyNumeric((v) => -v), max];
    }
    if (name === "StorageUnit") {
      const at = attr ?? "p_store";
      if (at === "p_store") {
        const max = dense("p_min_pu").applyNumeric((v) => -v);
        return [max.applyNumeric(() => 0), max];
      }
      if (at === "state_of_charge") {
        const max = dense("max_hours");
        return [max.applyNumeric(() => 0), max];
      }
      const max = dense("p_max_pu");
      return [max.applyNumeric(() => 0), max];
    }
    if (name === "Store") return [dense("e_min_pu"), dense("e_max_pu")];
    return [dense("p_min_pu"), dense("p_max_pu")];
  }

  // ------------------------------------------------------------------
  // Costs
  // ------------------------------------------------------------------

  get nyears() {
    return this.n.nyears;
  }

  _nyearsArg() {
    const ny = this.n.nyears;
    return ny instanceof Series ? Array.from(ny.values) : ny;
  }

  /** Periodized capital + fixed O&M cost per asset (Float64Array aligned with static index). */
  get periodized_cost() {
    const s = this.static;
    return periodizedCost({
      capital_cost: s.col("capital_cost"),
      overnight_cost: s.col("overnight_cost"),
      discount_rate: s.col("discount_rate"),
      lifetime: s.col("lifetime"),
      fom_cost: s.has("fom_cost") ? s.col("fom_cost") : new Float64Array(s.index.length),
      nyears: this._nyearsArg(),
    });
  }

  /** Periodized capital cost without fixed O&M (Float64Array). */
  get capital_cost() {
    const s = this.static;
    return periodizedCost({
      capital_cost: s.col("capital_cost"),
      overnight_cost: s.col("overnight_cost"),
      discount_rate: s.col("discount_rate"),
      lifetime: s.col("lifetime"),
      fom_cost: null,
      nyears: this._nyearsArg(),
    });
  }

  get annuity() {
    return annuity(this.static.col("discount_rate"), this.static.col("lifetime"));
  }

  get overnight_cost() {
    const s = this.static;
    const overnight = s.col("overnight_cost");
    const capital = s.col("capital_cost");
    const dr = s.col("discount_rate");
    const lt = s.col("lifetime");
    const ann = this.annuity;
    const ny = this.n.nyears;
    const nyScalar = ny instanceof Series ? ny.values.reduce((a, b) => a + b, 0) / ny.length : ny;
    const out = new Float64Array(overnight.length);
    const bad = [];
    for (let i = 0; i < out.length; i++) {
      if (!Number.isNaN(overnight[i])) out[i] = overnight[i];
      else {
        if (capital[i] !== 0 && (Number.isNaN(dr[i]) || Number.isNaN(lt[i]))) bad.push(s.index.at(i));
        out[i] = capital[i] / (ann[i] * nyScalar);
      }
    }
    if (bad.length) {
      throw new Error(
        `Cannot back-calculate overnight_cost for ${JSON.stringify(bad)}: both 'discount_rate' and 'lifetime' must be provided when 'overnight_cost' is not set.`,
      );
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Unit commitment big-M
  // ------------------------------------------------------------------

  _infer_committable_big_m_scale() {
    const candidates = [];
    if (this.n) {
      const load = this.n.get_switchable_as_dense("Load", "p_set");
      let peak = 0;
      for (let i = 0; i < load.index.length; i++) {
        let s = 0;
        for (const c of load.columns) s += load.col(c)[i];
        peak = Math.max(peak, Math.abs(s));
      }
      if (load.index.length) candidates.push(peak);
    }
    const nomAttr = this._operational_attrs.nom;
    const finite = Array.from(this.static.col(nomAttr)).filter((v) => Number.isFinite(v) && v > 0);
    if (finite.length) candidates.push(Math.max(...finite));
    const finiteMax = Array.from(this.static.col(`${nomAttr}_max`)).filter((v) => Number.isFinite(v) && v > 0);
    if (finiteMax.length) candidates.push(Math.max(...finiteMax));
    if (!candidates.length) return 1e6;
    const fallback = Math.max(...candidates) * 10;
    if (!Number.isFinite(fallback) || fallback <= 0) return 1e6;
    return fallback;
  }

  /**
   * Big-M values per (snapshot, name) for committable assets.
   * @param {Index} names
   * @param {DataFrame|null} maxPu dense frame (snapshots x names) or null
   * @returns {DataFrame} snapshots x names (or if maxPu provided, aligned with it)
   */
  get_committable_big_m_values(names, maxPu = null, committableBigM = null) {
    const nomAttr = this._operational_attrs.nom;
    const nomMax = this.static.series(`${nomAttr}_max`).loc(names);
    const mp = maxPu ?? this.get_bounds_pu(this._operational_attrs.base)[1].loc(null, names);
    let bigM = committableBigM;
    if (bigM === null && this.n) bigM = this.n._committable_big_m;
    if (bigM === null || bigM === undefined) bigM = this._infer_committable_big_m_scale();
    else {
      if (!Number.isFinite(bigM)) throw new Error(`committable_big_m must be finite, got ${bigM}.`);
      if (bigM <= 0) throw new Error(`committable_big_m must be positive, got ${bigM}.`);
    }
    const data = new Map();
    names.values.forEach((nme, j) => {
      const a = mp.col(nme);
      const nm = nomMax.values[j];
      const out = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) {
        out[i] = Number.isFinite(nm) && nm > 0 ? nm * a[i] : bigM * (Number.isNaN(a[i]) ? 1 : a[i]);
      }
      data.set(nme, out);
    });
    return new DataFrame({ index: mp.index, columns: names, data });
  }

  // ------------------------------------------------------------------
  // Mutation helpers
  // ------------------------------------------------------------------

  /** Add components of this class (`n.add(<class>, name, kwargs, opts)`). */
  add(name, kwargs = {}, opts = {}) {
    if (!this.attached) throw new Error("Components must be attached to a network to add components.");
    return this.n.add(this.name, name, kwargs, opts);
  }

  /** Rename components (`{old: new}`) in static, dynamic and referencing data of the network. */
  rename_component_names(mapping) {
    for (const v of Object.values(mapping)) if (typeof v !== "string") throw new Error("New names must be strings.");
    this.static = this.static.renameIndex((v) => mapping[v] ?? v);
    for (const [k, v] of Object.entries(this.dynamic)) this.dynamic[k] = v.renameColumns((c) => mapping[c] ?? c);
    if (this.attached) {
      const colName = this.name.toLowerCase();
      for (const comp of this.n.components.values()) {
        if (comp.empty) continue;
        for (const port of comp.ports) {
          const col = `${colName}${port}`;
          if (comp.static.has(col)) {
            comp.static.set(
              col,
              comp.static.col(col).map((v) => mapping[v] ?? v),
            );
          }
        }
      }
    }
  }

  // Buses -------------------------------------------------------------

  /** Add the buses referenced by the components but missing from the network. */
  add_missing_buses(kwargs = {}) {
    if (this.name !== "Bus") throw new Error("add_missing_buses is only defined for buses");
    const n = this.n;
    const all = new Set();
    const busNames = n.c.buses.names;
    for (const c of n.components.values()) {
      if (c.empty) continue;
      for (const col of c.static.columns) {
        if (!/^bus\d*$/.test(col)) continue;
        let buses = c.static.col(col).map((b) => (typeof b === "number" && Number.isNaN(b) ? "nan" : String(b)));
        for (const b of buses) {
          if (b === "" || b === "nan") continue;
          if (!busNames.has(b)) all.add(b);
        }
      }
    }
    const missing = [...all].sort();
    if (!missing.length) return new Index([], "name");
    return this.add(missing, kwargs, { return_names: true });
  }

  /** Add the carriers referenced by the components but missing from the network. */
  add_missing_carriers(kwargs = {}) {
    if (this.name !== "Carrier") throw new Error("add_missing_carriers is only defined for carriers");
    const all = new Set();
    for (const c of this.n.components.values()) for (const car of c.unique_carriers) all.add(car);
    const existing = new Set(this.names.values);
    const missing = [...all].filter((c) => !existing.has(c)).sort();
    if (!missing.length) return new Index([], "name");
    return this.add(missing, kwargs, { return_names: true });
  }

  /**
   * Assign palette colours to carriers without a colour (or all with
   * `overwrite`), in sorted carrier order like PyPSA.
   */
  assign_colors({ carriers = null, palette = "tab10", overwrite = false } = {}) {
    if (this.name !== "Carrier") throw new Error("assign_colors is only defined for carriers");
    const st = this.static;
    let target;
    if (carriers === null) {
      target = overwrite ? this.names.values : st.index.values.filter((_, i) => st.col("color")[i] === "" || st.col("color")[i] === null || Number.isNaN(st.col("color")[i]));
    } else {
      target = typeof carriers === "string" ? [carriers] : [...carriers];
      const unknown = target.filter((c) => !this.names.has(c));
      if (unknown.length) throw new Error(`Cannot assign colors to unknown carriers: ${unknown}`);
    }
    if (!target.length) return;
    target = [...target].sort();
    const colors = Components._generateColors(target.length, palette);
    target.forEach((c, i) => st.setAt(c, "color", colors[i]));
    logger.info(`Assigned colors to ${target.length} carriers using '${palette}' palette.`);
  }

  /** Line lengths from bus coordinates via haversine (km). */
  calculate_line_length() {
    const buses = this.n.c.buses.static;
    const x = buses.series("x");
    const y = buses.series("y");
    const b0 = this.static.series("bus0");
    const b1 = this.static.series("bus1");
    const out = b0.values.map((bus0, i) => {
      const bus1 = b1.values[i];
      return haversinePts(x.get(bus0), y.get(bus0), x.get(bus1), y.get(bus1)) * 1000;
    });
    return new Series(Float64Array.from(out), this.static.index, null);
  }

  /**
   * Scale `s_max_pu` of lines to per-line summer / winter ratings by month
   * (`Lines.apply_seasonal_rating`). `ratings` is a DataFrame indexed by line
   * name with `summer` and `winter` columns (absolute MVA ratings).
   */
  apply_seasonal_rating(ratings, { summer_months = [4, 5, 6, 7, 8, 9], compose = true } = {}) {
    if (this.name !== "Line") throw new TypeError(`'${this.name}' components have no method 'apply_seasonal_rating'.`);
    const n = this.n;
    const sns = n.snapshots;
    const months = sns.isMulti
      ? null
      : sns.values.map((t) => {
          const m = typeof t === "string" ? /^\d{4}-(\d{2})-\d{2}/.exec(t.trim()) : null;
          return m ? Number(m[1]) : null;
        });
    if (!months || months.some((x) => x === null)) {
      throw new TypeError(`apply_seasonal_rating requires n.snapshots to be a DatetimeIndex; got ${sns.isMulti ? "MultiIndex" : "Index"}.`);
    }
    const missingCols = ["summer", "winter"].filter((col) => !ratings.has(col));
    if (missingCols.length) throw new Error(`KeyError: \`ratings\` DataFrame is missing required columns: [${missingCols.map((x) => `'${x}'`).join(", ")}]`);
    const names = ratings.index;
    const missingLines = names.difference(this.static.index);
    if (missingLines.length) {
      const shown = missingLines.values.slice(0, 5).map((x) => `'${x}'`);
      throw new Error(`KeyError: \`ratings\` references ${missingLines.length} line(s) not in n.lines.index: [${shown.join(", ")}]${missingLines.length > 5 ? "..." : ""}`);
    }
    if (!summer_months.length) throw new Error("`summer_months` must be non-empty.");
    const summer = Array.from(ratings.col("summer"), Number);
    const winter = Array.from(ratings.col("winter"), Number);
    if (summer.some((x) => !(x > 0)) || winter.some((x) => !(x > 0))) throw new Error("All summer and winter ratings must be strictly positive.");
    const sNom = names.values.map((nm) => this.static.at(nm, "s_nom"));
    const bad = names.values.filter((_, j) => sNom[j] <= 0);
    if (bad.length) {
      throw new Error(
        `apply_seasonal_rating scales s_max_pu = rating / s_nom and requires a strictly positive s_nom for every rated line; got non-positive s_nom for: [${bad
          .slice(0, 5)
          .map((x) => `'${x}'`)
          .join(", ")}]`,
      );
    }
    const isSummer = months.map((mo) => summer_months.includes(mo));
    const dyn = this.dynamic.s_max_pu;
    names.values.forEach((nm, j) => {
      const sPu = summer[j] / sNom[j];
      const wPu = winter[j] / sNom[j];
      const seasonal = isSummer.map((su) => (su ? sPu : wPu));
      let out = Float64Array.from(seasonal);
      if (compose) {
        const staticPu = this.static.at(nm, "s_max_pu");
        const existing = dyn.has(nm) ? dyn.col(nm) : null;
        out = out.map((v, i) => {
          const e = existing && !Number.isNaN(existing[i]) ? existing[i] : staticPu;
          return e * v;
        });
      }
      dyn.set(nm, out);
    });
  }

  /** Delay source indexer for multiport components. */
  static get_delay_source_indexer(snapshots, weightings, delay, isCyclic) {
    return getDelaySourceIndexer(snapshots, weightings, delay, isCyclic);
  }
}

export const EARTH_RADIUS = 6378137.0;

/** Great-circle distance in km between two (lon, lat) points (pypsa.geo.haversine_pts). */
export function haversinePts(lon0, lat0, lon1, lat1) {
  const rad = Math.PI / 180;
  const la0 = lat0 * rad;
  const la1 = lat1 * rad;
  const c = Math.sin((la1 - la0) / 2.0) ** 2 + Math.cos(la0) * Math.cos(la1) * Math.sin((lon0 * rad - lon1 * rad) / 2.0) ** 2;
  return 6371.0 * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

function delayPositions(weights, delay, isCyclic) {
  const n = weights.length;
  const tau = new Float64Array(n);
  for (let i = 1; i < n; i++) tau[i] = tau[i - 1] + weights[i - 1];
  const src = new Int32Array(n);
  const valid = new Array(n).fill(true);
  let total = 0;
  for (const w of weights) total += w;
  if (isCyclic && total <= 0) {
    throw new Error("Cyclic weighted delay requires a positive total snapshot weighting over the optimized snapshots.");
  }
  let misaligned = false;
  for (let i = 0; i < n; i++) {
    let st = tau[i] - delay;
    if (isCyclic) st = ((st % total) + total) % total;
    else valid[i] = st >= 0;
    // searchsorted(tau, st, side="right") - 1
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tau[mid] <= st) lo = mid + 1;
      else hi = mid;
    }
    let s = lo - 1;
    s = Math.min(Math.max(s, 0), n - 1);
    src[i] = s;
    if (valid[i] && tau[s] !== st) misaligned = true;
  }
  if (misaligned) {
    console.warn(
      `Delay ${delay} does not align exactly with snapshot weighting boundaries and will be rounded to the nearest snapshot boundary.`,
    );
  }
  return [src, valid];
}

export function getDelaySourceIndexer(snapshots, weightings, delay, isCyclic) {
  const n = snapshots.length;
  if (n === 0) return [new Int32Array(0), []];
  if (delay <= 0) return [Int32Array.from({ length: n }, (_, i) => i), new Array(n).fill(true)];
  const w = Array.from(weightings);
  if (snapshots.isMulti) {
    const src = new Int32Array(n);
    const valid = new Array(n);
    let offset = 0;
    for (const period of snapshots.uniqueLevel(0)) {
      const pos = snapshots.locLevel(0, period);
      const ww = pos.map((p) => w[p]);
      const [ps, pv] = delayPositions(ww, delay, isCyclic);
      for (let i = 0; i < ww.length; i++) {
        src[offset + i] = ps[i] + offset;
        valid[offset + i] = pv[i];
      }
      offset += ww.length;
    }
    return [src, valid];
  }
  return delayPositions(w, delay, isCyclic);
}

export { isNumberArray };

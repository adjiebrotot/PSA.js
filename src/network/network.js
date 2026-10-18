// SPDX-License-Identifier: MIT
/**
 * Network container (mirrors `pypsa.Network`).
 */

import { canonicalWkt } from "../core/wkt.js";
import { Components, RE_PORTS_GE_2 } from "../components/components.js";
import { componentTypes, getComponentType, allStandardAttrs, typToDtype, PYPSA_VERSION } from "../components/types.js";
import { DataFrame, Series, isNumberArray, makeFilled } from "../core/frame.js";
import { Index, asIndex, labelKey } from "../core/index.js";
import { pyFloatRepr } from "../core/csv.js";
import { ComponentsStore, installStoreAccessors } from "./store.js";
import { NOMINAL_ATTRS } from "../components/components.js";
import { importPiecewiseFromDf, piecewiseFromAddValue } from "../components/piecewise.js";
import { broadcastStatic, broadcastDynamic, uniqueNames, unionLevel } from "./scenario_frames.js";
import { PySet } from "../core/pyset.js";
import { logger } from "../logger.js";

export const DEFAULT_TIMESTAMP = "now";
export const HOURS_PER_YEAR = 8760.0;
export const DEFAULT_EPSG = 4326;

// Set literals as written in `pypsa.network.components`; PyPSA iterates them
// (and their unions) in CPython's hash table order, which `pySetOrder`
// reproduces for the fixtures' PYTHONHASHSEED=0.
const PASSIVE_BRANCH = ["Transformer", "Line"];
const CONTROLLABLE_BRANCH = ["Link", "Process"];
const PASSIVE_ONE_PORT = ["ShuntImpedance"];
const CONTROLLABLE_ONE_PORT = ["StorageUnit", "Store", "Generator", "Load"];

/**
 * A set literal as CPython builds it: literals of three or more constants are
 * compiled to a frozenset constant, which marshal stores sorted by the
 * serialized elements (short ASCII strings: by length, then content) and the
 * set copies (`SET_UPDATE`); shorter literals insert in source order.
 */
function pySetLiteral(items) {
  if (items.length < 3) return new PySet(items);
  const stored = [...items].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return new PySet(new PySet(stored));
}

/** Iteration order of `literal_0 | literal_1 | ...` in CPython. */
function pySetOrder(...literals) {
  const out = pySetLiteral(literals[0]);
  // `set_merge`: resizes for the other set's size before inserting its entries
  for (const lit of literals.slice(1)) out._merge(pySetLiteral(lit));
  return [...out];
}
const ORDER = {
  passive_branch: pySetOrder(PASSIVE_BRANCH),
  controllable_branch: pySetOrder(CONTROLLABLE_BRANCH),
  passive_one_port: pySetOrder(PASSIVE_ONE_PORT),
  controllable_one_port: pySetOrder(CONTROLLABLE_ONE_PORT),
  one_port: pySetOrder(PASSIVE_ONE_PORT, CONTROLLABLE_ONE_PORT),
  branch: pySetOrder(PASSIVE_BRANCH, CONTROLLABLE_BRANCH),
};
const STANDARD_TYPES = ["LineType", "TransformerType"];
const ALL_COMPONENTS = [
  "Carrier",
  "Line",
  "Transformer",
  "Shape",
  "Generator",
  "StorageUnit",
  "Store",
  "ShuntImpedance",
  "Link",
  "GlobalConstraint",
  "SubNetwork",
  "TransformerType",
  "LineType",
  "Bus",
  "Load",
  "Process",
];

function isScalar(v) {
  return v === null || v === undefined || typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

function is1dListLike(v) {
  return (Array.isArray(v) && !v.some((x) => Array.isArray(x) || isNumberArray(x))) || isNumberArray(v) || v instanceof Index;
}

function is2dArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => Array.isArray(x) || isNumberArray(x));
}

function buildSuffixedNames(name, suffix) {
  const single = isScalar(name);
  if (Array.isArray(suffix)) {
    if (!single) throw new Error("Cannot pass list to both `name` and `suffix`. Pass a scalar `name` with a list `suffix`.");
    if (suffix.length === 0) throw new Error("Empty list `suffix` passed.");
    return new Index(suffix.map((s) => String(name) + s));
  }
  const names = single ? [name] : Array.from(name instanceof Index ? name.values : name);
  return new Index(names.map((x) => pyStr(x) + suffix));
}

/** Python `str()` for labels (ints without decimals, floats with). */
function pyStr(x) {
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : pyFloatRepr(x);
  if (typeof x === "boolean") return x ? "True" : "False";
  return String(x);
}

/** Pandas `_sort_attrs`: attrs_list order first, then the remaining labels. */
export function sortAttrs(axisLabels, attrsList) {
  const axis = asIndex(axisLabels);
  if (axis.length === 0 || attrsList.length === 0) return axis;
  const attrs = asIndex(attrsList);
  const existing = attrs.intersection(axis);
  if (existing.length === 0) return axis;
  const remaining = axis.difference(attrs, false);
  return existing.append(remaining.values).unique();
}

/** Convert a value to a target type like pandas `astype`. */
function castValue(v, typ) {
  if (typ === "float") {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") return v === "" ? NaN : Number(v);
    return v === null || v === undefined ? NaN : Number(v);
  }
  if (typ === "int") {
    const x = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
    return Number.isNaN(x) ? 0 : Math.trunc(x);
  }
  if (typ === "bool") {
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "number") return Number.isNaN(v) ? true : v !== 0;
    return Boolean(v);
  }
  // str
  if (typeof v === "number") return Number.isNaN(v) ? "" : pyStr(v);
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

function inferDtype(arr) {
  if (isNumberArray(arr)) return "float";
  let allNum = true;
  let allBool = true;
  for (const v of arr) {
    if (typeof v !== "number") allNum = false;
    if (typeof v !== "boolean") allBool = false;
  }
  if (arr.length && allBool) return "bool";
  if (allNum) return "float";
  return "object";
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

/** Generic deep copy of a DataFrame. */
function copyFrame(df) {
  return df.copy();
}

export class Network {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name]
   * @param {boolean} [opts.ignore_standard_types]
   * @param {string} [opts.import_name] path to a CSV folder or an .xlsx file (Node.js only;
   *   netCDF and HDF5 files: `await Network.from_netcdf(path)` / `Network.from_hdf5(path)`)
   */
  constructor(opts = {}) {
    if (typeof opts === "string") opts = { import_name: opts };
    const { name = "Unnamed Network", ignore_standard_types = false, import_name = null, ...rest } = opts;
    this._pypsa_version = PYPSA_VERSION;
    this._name = name;
    this._meta = {};
    this._crs = { _crs: null, epsg: DEFAULT_EPSG };

    const sns = new Index([DEFAULT_TIMESTAMP], "snapshot");
    this._snapshots_data = DataFrame.empty(sns, ["objective", "stores", "generators"], 1);
    this._investment_periods_data = DataFrame.empty(new Index([], "period"), ["objective", "years"], NaN);

    this._model = null;
    this._objective = null;
    this._objective_constant = null;
    this._multi_invest = 0;
    this._linearized_uc = 0;
    this._committable_big_m = null;
    this.iteration = 0;

    this._components = null;
    // initialise store
    void this.components;

    if (!ignore_standard_types) this._read_in_default_standard_types();

    if (import_name) {
      if (typeof import_name === "string" && /\.xlsx$/i.test(import_name)) this.import_from_excel(import_name);
      else if (typeof import_name === "string" && /\.(nc|h5|hdf5)$/i.test(import_name)) {
        // h5wasm loads asynchronously
        const loader = /\.nc$/i.test(import_name) ? "from_netcdf" : "from_hdf5";
        throw new Error(`ValueError: netCDF and HDF5 files load asynchronously; use \`await Network.${loader}(path)\``);
      } else this.import_from_csv_folder(import_name);
    }

    for (const [k, v] of Object.entries(rest)) this[k] = v;

    // accessors attached by other modules (optimize, statistics, cluster)
    for (const init of Network._accessorInitialisers) init(this);
  }

  // ------------------------------------------------------------------
  // Components store
  // ------------------------------------------------------------------

  get components() {
    if (this._components === null) {
      const store = new ComponentsStore();
      for (const ct of componentTypes.values()) {
        store.set(ct.list_name, new Components(ct, this));
      }
      installStoreAccessors(store);
      this._components = store;
    }
    return this._components;
  }

  get c() {
    return this.components;
  }

  _read_in_default_standard_types() {
    for (const stdType of STANDARD_TYPES) {
      const st = this.c.get(stdType).standard_types;
      const kwargs = {};
      for (const col of st.columns) kwargs[col] = Array.from(st.col(col));
      this.add(stdType, st.index.values, kwargs);
    }
  }

  get passive_branch_components() {
    return new Set(ORDER.passive_branch);
  }

  get controllable_branch_components() {
    return new Set(ORDER.controllable_branch);
  }

  get passive_one_port_components() {
    return new Set(ORDER.passive_one_port);
  }

  get controllable_one_port_components() {
    return new Set(ORDER.controllable_one_port);
  }

  get standard_type_components() {
    return new Set(STANDARD_TYPES);
  }

  get one_port_components() {
    return new Set(ORDER.one_port);
  }

  get branch_components() {
    return new Set(ORDER.branch);
  }

  get all_components() {
    return new Set(ALL_COMPONENTS);
  }

  // ------------------------------------------------------------------
  // Meta data
  // ------------------------------------------------------------------

  get name() {
    return this._name;
  }

  set name(v) {
    this._name = v;
  }

  get pypsa_version() {
    return this._pypsa_version;
  }

  get meta() {
    return this._meta;
  }

  set meta(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError("Meta must be a dictionary");
    this._meta = v;
  }

  get srid() {
    return this._crs.epsg;
  }

  set srid(v) {
    this._crs = { _crs: null, epsg: Number(v) };
  }

  get crs() {
    return this._crs;
  }

  get model() {
    return this._model;
  }

  get objective() {
    return this._objective;
  }

  get objective_constant() {
    return this._objective_constant;
  }

  get is_solved() {
    return this._objective !== null;
  }

  get is_collection() {
    return false;
  }

  /** A single network of a NetworkCollection (only collections have members). */
  get_network() {
    throw new Error("ValueError: This method can only be used on a NetworkCollection.");
  }

  toString() {
    return `PyPSA Network '${this.name}'`;
  }

  repr() {
    const header = `${this}\n${"-".repeat(String(this).length)}`;
    const comps = [...this.components.values()]
      .filter((c) => !c.name.includes("Type") && !c.empty)
      .map((c) => [c.name, ` - ${c.name}: ${c.static.index.length}`])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let content = "\nComponents:";
    let h = header;
    if (comps.length) content += "\n" + comps.map((x) => x[1]).join("\n");
    else {
      h = "Empty " + header;
      content += " none";
    }
    return `${h}${content}\nSnapshots: ${this.snapshots.length}\n`;
  }

  // Legacy static/dynamic accessors (n.buses, n.buses_t, ...)
  static _installLegacyAccessors() {
    for (const ct of componentTypes.values()) {
      const ln = ct.list_name;
      Object.defineProperty(Network.prototype, ln, {
        get() {
          return this.c.get(ln).static;
        },
        set(v) {
          this.c.get(ln).static = v;
        },
        configurable: true,
      });
      Object.defineProperty(Network.prototype, `${ln}_t`, {
        get() {
          return this.c.get(ln).dynamic;
        },
        set(v) {
          this.c.get(ln).dynamic = v;
        },
        configurable: true,
      });
    }
  }

  // ------------------------------------------------------------------
  // Snapshots / investment periods
  // ------------------------------------------------------------------

  get snapshots() {
    return this._snapshots_data.index;
  }

  set snapshots(v) {
    this.set_snapshots(v);
  }

  /**
   * @param {Array|Index} snapshots labels; arrays of [period, timestep] create a MultiIndex
   */
  set_snapshots(snapshots, { default_snapshot_weightings = 1.0, weightings_from_timedelta = false } = {}) {
    let sns;
    if (snapshots instanceof Index) {
      sns = snapshots.isMulti ? new Index(snapshots.values, ["period", "timestep"]) : new Index(snapshots.values, "snapshot");
    } else {
      const arr = Array.from(snapshots);
      if (arr.length && Array.isArray(arr[0])) {
        if (arr[0].length !== 2) throw new Error("Maximally two levels of MultiIndex supported");
        sns = new Index(arr, ["period", "timestep"]);
      } else sns = new Index(arr, "snapshot");
    }
    if (sns.length === 0) throw new Error("Snapshots must not be empty.");

    this._snapshots_data = this._snapshots_data.reindex({ index: sns, fill: default_snapshot_weightings });

    if (weightings_from_timedelta) {
      const times = sns.isMulti ? null : sns.values.map(parseTimestamp);
      if (times && times.every((t) => t !== null)) {
        const hours = new Float64Array(times.length);
        for (let i = 0; i < times.length - 1; i++) hours[i] = (times[i + 1] - times[i]) / 3600000;
        if (times.length > 1) hours[times.length - 1] = hours[times.length - 2];
        else hours[0] = NaN;
        for (const c of this._snapshots_data.columns) this._snapshots_data.set(c, hours.slice());
      } else {
        logger.info("Skipping `weightings_from_timedelta` as `snapshots` is not of type `pd.DatetimeIndex`.");
      }
    }

    for (const cname of this.all_components) {
      const c = this.c.get(cname);
      for (const k of Object.keys(c.dynamic)) {
        const df = c.dynamic[k];
        const def = c.defaults.get(k);
        if (df.columns.length === 0 || df.index.length === 0) {
          c.dynamic[k] = new DataFrame({ index: this.snapshots, columns: df.columns, data: emptyColsData(df.columns, this.snapshots.length, def ? def.default : NaN) });
        } else if (def && def.varying) {
          c.dynamic[k] = reindexDynamic(df, this.snapshots, def.default);
        } else {
          c.dynamic[k] = reindexDynamic(df, this.snapshots, NaN);
        }
      }
    }

    if (sns.isMulti) {
      this.investment_period_weightings = this.investment_period_weightings.reindex({ index: this.periods, fill: 1.0 });
    }
  }

  get timesteps() {
    if (this.snapshots.isMulti) return this.snapshots.getLevelValues("timestep").unique();
    return this.snapshots;
  }

  /** Set the investment periods; the snapshots become (period, timestep) pairs. */
  set_investment_periods(periods) {
    const p = new Index(Array.from(periods instanceof Index ? periods.values : periods), "period");
    if (p.length === 0) return;
    const vals = p.values;
    const ok = vals.every((v) => Number.isInteger(v)) && p.isUnique && vals.every((v, i) => i === 0 || v > vals[i - 1]);
    if (!ok) {
      throw new Error(
        "Investment periods are not strictly increasing integers, which is required for multi-period investment optimisation.",
      );
    }
    if (this.snapshots.isMulti) {
      const snsPeriods = this.snapshots.uniqueLevel("period");
      if (!vals.every((v) => snsPeriods.has(v))) throw new Error("Not all investment periods are in level `period` of snapshots.");
      if (vals.length < snsPeriods.length) throw new Error("Investment periods do not equal first level values of snapshots.");
    } else {
      logger.info("Repeating time-series for each investment period and converting snapshots to a pandas.MultiIndex.");
      const sns = Index.fromProduct([vals, this.snapshots.values], ["period", "timestep"]);
      for (const cname of this.all_components) {
        const c = this.c.get(cname);
        for (const k of Object.keys(c.dynamic)) {
          c.dynamic[k] = tileFrame(c.dynamic[k], vals.length, sns);
        }
      }
      this._snapshots_data = tileFrame(this._snapshots_data, vals.length, sns);
    }
    this.investment_period_weightings = this.investment_period_weightings.reindex({ index: this.periods, fill: 1.0 });
  }

  get periods() {
    if (this.snapshots.isMulti) return new Index(this.snapshots.uniqueLevel("period").values, "period");
    return new Index([], "period");
  }

  set periods(v) {
    this.set_investment_periods(v);
  }

  get has_periods() {
    return this.periods.length > 0;
  }

  get investment_periods() {
    return this.periods;
  }

  set investment_periods(v) {
    this.periods = v;
  }

  get has_investment_periods() {
    return this.has_periods;
  }

  get snapshot_weightings() {
    return this._snapshots_data;
  }

  set snapshot_weightings(df) {
    if (df instanceof Series || Array.isArray(df) || isNumberArray(df)) {
      const values = df instanceof Series ? df.reindex(this.snapshots).values : df;
      if (values.length !== this.snapshots.length) throw new Error("Weightings not defined for all snapshots.");
      const out = new DataFrame({ index: this.snapshots });
      for (const c of this._snapshots_data.columns) out.set(c, Float64Array.from(values));
      this._snapshots_data = out;
      return;
    }
    if (!df.index.equals(this.snapshots)) throw new Error("Weightings not defined for all snapshots.");
    const out = df.copy();
    out.index = this.snapshots;
    this._snapshots_data = out;
  }

  get nyears() {
    const w = this.snapshot_weightings.col("objective");
    if (this.has_investment_periods) {
      const periods = this.periods;
      const sums = new Float64Array(periods.length);
      const sns = this.snapshots.values;
      for (let i = 0; i < sns.length; i++) sums[periods.getLoc(sns[i][0])] += w[i];
      return new Series(sums.map((s) => s / HOURS_PER_YEAR), periods, "objective");
    }
    let s = 0;
    for (const x of w) s += x;
    return s / HOURS_PER_YEAR;
  }

  get investment_period_weightings() {
    return this._investment_periods_data;
  }

  set investment_period_weightings(df) {
    if (df instanceof Series) {
      const out = new DataFrame({ index: this.investment_periods });
      for (const c of this._investment_periods_data.columns) out.set(c, Float64Array.from(df.reindex(this.investment_periods).values));
      this._investment_periods_data = out;
      return;
    }
    if (!df.index.equals(this.investment_periods)) throw new Error("Weightings not defined for all investment periods.");
    const out = df.copy();
    out.index = this.investment_periods;
    for (const c of out.columns) out.set(c, Float64Array.from(out.col(c), Number));
    this._investment_periods_data = out;
  }

  // ------------------------------------------------------------------
  // Adding and removing components
  // ------------------------------------------------------------------

  /**
   * Add components (mirrors `n.add`).
   *
   * @param {string} class_name component class or list name
   * @param {string|string[]} name names
   * @param {object} [kwargs] attributes; scalars, arrays, Series or DataFrames
   * @param {object} [opts] { suffix, overwrite, return_names }
   */
  add(class_name, name, kwargs = {}, opts = {}) {
    const { suffix = "", overwrite = false, return_names = false } = opts;
    const c = this.c.get(class_name);
    const single = isScalar(name) && typeof suffix === "string";
    const names = buildSuffixedNames(name, suffix);
    if (!names.isUnique) throw new Error(`Names for ${c.name} must be unique.`);

    const standardAttrs = new Set(c.defaults.keys());
    const customAttrs = Object.keys(kwargs).filter((k) => !standardAttrs.has(k));
    for (const ca of customAttrs) {
      if (allStandardAttrs.has(ca)) {
        logger.warning(
          `The attribute '${ca}' is a standard attribute for other components but not for ${c.list_name}. This could cause confusion and it should be renamed.`,
        );
      }
    }

    const series = {};
    const staticVals = {};
    const piecewise = {};
    const addSuffix = (s) => {
      s = pyStr(s);
      return typeof suffix === "string" && s.endsWith(suffix) ? s : s + suffix;
    };
    for (let [k, v] of Object.entries(kwargs)) {
      // Intercept piecewise breakpoint data: a dict {x: y} or a DataFrame whose
      // columns are the curve attributes (or (name, attribute) tuples)
      const pwSchema = c._piecewise_schema(k);
      if (pwSchema) {
        if (isPlainObject(v)) v = new Map(Object.entries(v).map(([x, y]) => [Number(x), y]));
        const pw = piecewiseFromAddValue(v, k, pwSchema.x, names, addSuffix);
        if (pw) {
          piecewise[k] = pw;
          continue;
        }
      }
      if (v instanceof Series && single) {
        if (!v.index.equals(this.snapshots)) throw new Error(`Series ${k} has an index which does not align with the passed network snapshots.`);
      } else if (v instanceof Series) {
        if (typeof suffix === "string") v = new Series(v.values, v.index.values.map((s) => String(s).replace(new RegExp(`${escapeRe(suffix)}$`), "") + suffix), v.name);
        if (!v.index.equals(names)) throw new Error(`Series ${k} has an index which does not align with the passed names.`);
      }
      if (v instanceof DataFrame) {
        if (typeof suffix === "string") v = v.renameColumns((s) => String(s).replace(new RegExp(`${escapeRe(suffix)}$`), "") + suffix);
        if (!v.index.equals(this.snapshots)) throw new Error(`DataFrame ${k} has an index which does not align with the passed network snapshots.`);
        if (!v.columns.equals(names)) throw new Error(`DataFrame ${k} has an index which does not align with the passed names.`);
      }

      if (is1dListLike(v) && !(v instanceof Series)) {
        const arr = Array.from(v instanceof Index ? v.values : v);
        if (single) {
          if (arr.length !== this.snapshots.length) {
            throw new Error(`Data for ${k} has length ${arr.length} but expected ${this.snapshots.length} for each snapshot.`);
          }
          v = new Series(arr, this.snapshots, k);
        } else if (arr.length === 1) {
          v = arr[0];
        } else {
          if (arr.length !== names.length) {
            throw new Error(`Data for ${k} has length ${arr.length} but expected ${names.length} for each component name.`);
          }
          v = new Series(arr, names, k);
        }
      }
      if (is2dArray(v)) {
        if (v.length !== this.snapshots.length || v.some((r) => r.length !== names.length)) {
          throw new Error(`Array ${k} has wrong shape, expected (${this.snapshots.length}, ${names.length}).`);
        }
        const data = new Map();
        names.values.forEach((nm, j) => data.set(nm, Float64Array.from(v, (row) => row[j])));
        v = new DataFrame({ index: this.snapshots, columns: names, data });
      }
      if (v !== null && typeof v === "object" && !(v instanceof Series) && !(v instanceof DataFrame)) {
        throw new Error("Dictionaries are not supported as attribute values. Please use Series or DataFrame instead.");
      }

      if (single) {
        if (v instanceof Series) {
          series[k] = new DataFrame({ index: this.snapshots, columns: names, data: { [names.at(0)]: Float64Array.from(v.values, Number) } });
        } else {
          staticVals[k] = v;
        }
      } else if (v instanceof DataFrame) {
        series[k] = v;
      } else if (v instanceof Series) {
        staticVals[k] = Array.from(v.values);
      } else {
        staticVals[k] = v;
      }
    }

    const data = new Map();
    for (const [k, v] of Object.entries(staticVals)) {
      if (Array.isArray(v) || isNumberArray(v)) data.set(k, Array.from(v));
      else data.set(k, new Array(names.length).fill(v === undefined || v === null ? NaN : v));
    }
    let staticDf = new DataFrame({ index: names, columns: [...data.keys()], data });

    // Broadcast to scenarios on stochastic networks (sub-networks are
    // handled by the topology determination)
    let staticIn = staticDf;
    if (this.has_scenarios && c.name !== "SubNetwork") {
      if (Object.keys(piecewise).length) {
        throw new Error("NotImplementedError: Piecewise attribute data is not yet supported for stochastic networks (scenarios).");
      }
      staticIn = broadcastStatic(staticDf, this.scenarios);
      for (const k of Object.keys(series)) series[k] = broadcastDynamic(series[k], this.scenarios);
    }

    this._import_components_from_df(staticIn, c.name, overwrite);

    // Load piecewise breakpoint data (after the static import, so that
    // overwriting an existing component does not drop the new breakpoints)
    const extCol = `${NOMINAL_ATTRS[c.name] ?? "None"}_extendable`;
    const isExtendable = staticDf.has(extCol) ? new Map(names.values.map((nm, i) => [nm, Boolean(staticDf.col(extCol)[i])])) : null;
    for (const [k, v] of Object.entries(piecewise)) importPiecewiseFromDf(this, v, c.name, k, { isExtendable, overwrite });

    for (const [k, v] of Object.entries(series)) this._import_series_from_df(v, c.name, k, overwrite);

    return return_names ? names : null;
  }

  /** Remove components (mirrors `n.remove`). */
  remove(class_name, name, opts = {}) {
    const { suffix = "" } = opts;
    const c = this.c.get(class_name);
    const names = buildSuffixedNames(name, suffix);
    // stochastic networks: remove the components from all scenarios
    const labels = c.static.index.isMulti ? Index.fromProduct([this.scenarios.values, names.values], ["scenario", "name"]) : names;
    // pandas' `drop` raises for unknown labels
    const present = new Set(c.static.index.values.map(labelKey));
    const missing = labels.values.filter((l) => !present.has(labelKey(l)));
    if (missing.length) {
      const repr = (v) => (Array.isArray(v) ? `(${v.map(repr).join(", ")})` : typeof v === "string" ? `'${v}'` : String(v));
      throw new Error(`KeyError: "[${missing.map(repr).join(", ")}] not found in axis"`);
    }
    c.static = c.static.dropRows(labels);
    for (const k of Object.keys(c.dynamic)) {
      const df = c.dynamic[k];
      const drop = df.columns.intersection(labels);
      if (drop.length) c.dynamic[k] = df.dropCols(drop);
    }
    // Drop piecewise breakpoint data
    const nameKeys = new Set(names.values.map(labelKey));
    for (const [k, df] of Object.entries(c.piecewise)) {
      const stale = df.columns.values.filter((t) => nameKeys.has(labelKey(t[0])));
      if (stale.length) c.piecewise[k] = df.loc(null, df.columns.filter((t) => !nameKeys.has(labelKey(t[0]))));
    }
  }

  _import_components_from_df(df, cls_name, overwrite = false) {
    const c = this.c.get(cls_name);
    if (cls_name === "Link" || cls_name === "Process") updatePortsComponentAttrs(this, df.columns.values, cls_name);
    const attrs = c.defaults;

    // index as str (each level of a (scenario, name) index)
    const multi = df.index.isMulti;
    const names = multi ? new Index(df.index.values.map((t) => t.map(pyStr)), ["scenario", "name"]) : new Index(df.index.values.map(pyStr), "name");

    // build typed columns
    const cols = new Map();
    const dtypes = {};
    const seriesOnlyInDf = [];
    for (const col of df.columns) {
      const def = attrs.get(col);
      let arr = Array.from(df.col(col));
      // fillna with default for standard attributes
      if (def && !(typeof def.default === "number" && Number.isNaN(def.default))) {
        arr = arr.map((v) => (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? def.default : v));
      }
      if (def && !def.static) {
        seriesOnlyInDf.push(col);
        cols.set(col, arr);
        continue;
      }
      if (def && col !== "name") {
        const typ = def.typ;
        if (def.type === "string") arr = arr.map((v) => (typeof v === "number" && Number.isNaN(v) ? "" : v));
        if (def.type === "int") arr = arr.map((v) => (typeof v === "number" && Number.isNaN(v) ? 0 : v));
        if (typ === "str") {
          const srcDtype = df.dtypes[col];
          const allInt = srcDtype ? srcDtype === "int" : arr.every((v) => typeof v !== "number" || Number.isInteger(v));
          arr = arr.map((v) =>
            typeof v === "number" ? (Number.isNaN(v) ? "" : allInt ? String(v) : pyFloatRepr(v)) : castValue(v, "str"),
          );
        } else if (def.type === "geometry") {
          // WKT in shapely's canonical form (lossless)
          arr = arr.map((v) => (typeof v === "string" ? canonicalWkt(v) : v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? "" : v));
        } else arr = arr.map((v) => castValue(v, typ));
        dtypes[col] = typToDtype(typ);
        cols.set(col, dtypes[col] === "float" || dtypes[col] === "int" ? Float64Array.from(arr) : arr);
      } else if (col !== "name") {
        const dt = df.dtypes[col] ?? inferDtype(arr);
        dtypes[col] = dt;
        cols.set(col, dt === "float" || dt === "int" ? Float64Array.from(arr, (v) => (v === null || v === undefined ? NaN : Number(v))) : arr);
      }
    }
    for (const [attr, def] of attrs) {
      if (!def.static || attr === "name" || cols.has(attr)) continue;
      const dt = typToDtype(def.typ);
      dtypes[attr] = dt;
      cols.set(attr, dt === "float" || dt === "int" ? new Float64Array(names.length).fill(def.default) : new Array(names.length).fill(def.default));
    }

    const staticCols = [...cols.keys()].filter((k) => !seriesOnlyInDf.includes(k));
    let newStatic = new DataFrame({ index: names, columns: staticCols, data: new Map(staticCols.map((k) => [k, cols.get(k)])), dtypes });

    const oldStatic = c.static;
    const duplicated = oldStatic.index.intersection(newStatic.index);
    if (duplicated.length > 0) {
      if (!overwrite) {
        logger.warning(
          `The following ${c.list_name} are already defined and will be skipped (use overwrite=True to overwrite): ${duplicated.values.join(", ")}`,
        );
        newStatic = newStatic.dropRows(duplicated);
      } else {
        this.remove(cls_name, multi ? duplicated.uniqueLevel("name").values : duplicated.values);
      }
    }

    // pandas only concatenates if the old static frame has rows
    if (multi) c._nameLevel = c.static.index.length > 0 ? unionLevel(c._nameLevel ?? uniqueNames(c.static.index), uniqueNames(names)) : uniqueNames(names);
    let combined = c.static.index.length > 0 ? concatStatic(c.static, newStatic) : newStatic;
    const ordered = sortAttrs(combined.columns, [...attrs.keys()]);
    combined = combined.loc(null, ordered);
    combined.index = new Index(combined.index.values, combined.index.isMulti ? ["scenario", "name"] : "name");
    c.static = combined;

    // series-only attributes given as static values
    for (const k of seriesOnlyInDf) {
      const def = attrs.get(k);
      let dyn = c.dynamic[k].reindex({ columns: combined.index, fill: def.default });
      const vals = cols.get(k);
      const newNames = overwrite ? names : names.difference(duplicated, false);
      for (const nm of newNames) {
        const v = vals[names.getLoc(nm)];
        dyn.col(nm).fill(Number(v));
      }
      c.dynamic[k] = dyn;
    }

    checkForUnknownBuses(this, c);
  }

  _import_series_from_df(df, cls_name, attr, overwrite = false) {
    const c = this.c.get(cls_name);
    const staticIdx = c.static.index;
    if (!overwrite && c.dynamic[attr]) {
      const drop = df.columns.intersection(c.dynamic[attr].columns);
      if (drop.length) df = df.dropCols(drop);
    }
    // column labels as str (each level of (scenario, name) columns)
    const labels = df.columns.values.map((col) => (Array.isArray(col) ? col.map(String) : String(col)));
    df = new DataFrame({
      index: df.index,
      columns: new Index(labels, df.columns.isMulti ? ["scenario", "name"] : "name"),
      data: new Map(df.columns.values.map((col, i) => [labels[i], Float64Array.from(df.col(col), toNumber)])),
    });
    const diff = df.columns.difference(staticIdx);
    if (diff.length > 0) {
      logger.warning(`Components ${diff.values} for attribute ${attr} of ${cls_name} are not in main components dataframe ${c.list_name}`);
    }
    const def = c.defaults.get(attr);
    if (!def || !def.type.includes("series")) {
      if (overwrite || !c.dynamic[attr]) c.dynamic[attr] = df;
      return;
    }
    const missing = this.snapshots.difference(df.index, false);
    if (missing.length) {
      logger.warning(`Snapshots ${missing.values} are missing from ${attr} of ${cls_name}. Filling with default value '${def.default}'`);
      df = df.reindex({ index: this.snapshots, fill: def.default });
    }
    let dyn = c.dynamic[attr];
    let ordered;
    if (!def.static) {
      ordered = sortAttrs(df.columns.union(staticIdx), staticIdx.values);
      dyn = dyn.reindex({ columns: ordered, fill: def.default });
    } else {
      ordered = sortAttrs(df.columns.union(dyn.columns), dyn.columns.values);
      dyn = dyn.reindex({ columns: ordered, fill: NaN });
    }
    // keep the (scenario, name) levels of stochastic columns
    if (df.columns.isMulti || staticIdx.isMulti) dyn.columns = new Index(dyn.columns.values, ["scenario", "name"]);
    const rowPos = df.index.getIndexer(this.snapshots);
    for (const col of df.columns) {
      const src = df.col(col);
      const dst = dyn.col(col);
      for (let i = 0; i < rowPos.length; i++) if (rowPos[i] >= 0) dst[i] = src[rowPos[i]];
    }
    dyn.index = this.snapshots;
    c.dynamic[attr] = dyn;
  }

  // ------------------------------------------------------------------
  // Descriptors
  // ------------------------------------------------------------------

  /** Attribute as a (snapshots x names) frame: time series where given, static values elsewhere. */
  get_switchable_as_dense(component, attr, snapshots = null, inds = null) {
    return this.c.get(component)._as_dynamic(attr, snapshots, inds);
  }

  /** Generator over the snapshots of `get_switchable_as_dense`, one row at a time. */
  *get_switchable_as_iter(component, attr, snapshots, inds = null) {
    const df = this.get_switchable_as_dense(component, attr, snapshots, inds);
    // the series follow the order of `inds` (unique, known names only)
    const cols = inds === null ? df.columns : new Index(asIndex(inds).unique().values, "name").intersection(df.columns);
    for (let i = 0; i < df.index.length; i++) {
      yield new Series(
        Float64Array.from(cols.values, (c) => df.col(c)[i]),
        cols,
        df.index.at(i),
      );
    }
  }

  /** Names of the extendable components of class `c`. */
  get_extendable_i(c) {
    return this.c.get(c).extendables;
  }

  /** Names of the non-extendable components of class `c`. */
  get_non_extendable_i(c) {
    return this.c.get(c).fixed;
  }

  /** Names of the committable components of class `c`. */
  get_committable_i(c) {
    return this.c.get(c).committables;
  }

  /** Boolean Series of the components of class `c` that are active (in `investment_period`). */
  get_active_assets(c, investment_period = null) {
    return this.c.get(c).get_active_assets(investment_period);
  }

  /** Unit of the buses with carrier `bus_carrier` (one unit, else an error). */
  bus_carrier_unit(bus_carrier) {
    if (bus_carrier === null || bus_carrier === undefined) return "carrier dependent";
    const bcs = typeof bus_carrier === "string" ? [bus_carrier] : bus_carrier;
    const buses = this.c.buses.static;
    const carriers = buses.col("carrier");
    const present = new Set(carriers);
    const missing = bcs.filter((b) => !present.has(b));
    if (missing.length) throw new Error(`Bus carriers ${missing} not in network`);
    const units = [...new Set(buses.col("unit").filter((u, i) => bcs.includes(carriers[i])))];
    if (units.length > 1) {
      logger.warning(`Multiple units found for carrier ${bcs}: ${units}`);
      return "carrier dependent";
    }
    return units[0];
  }

  // ------------------------------------------------------------------
  // Branches
  // ------------------------------------------------------------------

  _empty_components() {
    return [...this.components.values()].filter((c) => c.empty).map((c) => c.name);
  }

  _concatBranches(comps) {
    const frames = [];
    for (const cn of comps) {
      const st = this.c.get(cn).static;
      if (st.index.length === 0) continue;
      const f = st.copy();
      f.index = new Index(
        st.index.values.map((n) => [cn, n]),
        ["component", "name"],
      );
      frames.push(f);
    }
    if (!frames.length) return new DataFrame({ index: new Index([], ["component", "name"]) });
    const cols = [];
    const seen = new Set();
    for (const f of frames) for (const c of f.columns) if (!seen.has(c)) seen.add(c) && cols.push(c);
    cols.sort();
    return DataFrame.concatRows(frames, cols);
  }

  /** Merged static data of all branches (sorted by component name like pandas concat sort=True). */
  branches() {
    const comps = [...this.branch_components].filter((c) => !this.c.get(c).empty).sort();
    return this._concatBranches(comps);
  }

  /** Lines and transformers as one `(component, name)` indexed frame. */
  passive_branches() {
    const comps = [...this.passive_branch_components].filter((c) => !this.c.get(c).empty).sort();
    return this._concatBranches(comps);
  }

  /** Links (and processes) as one `(component, name)` indexed frame. */
  controllable_branches() {
    const comps = [...this.controllable_branch_components].filter((c) => !this.c.get(c).empty).sort();
    return this._concatBranches(comps);
  }

  // ------------------------------------------------------------------
  // Copy / merge / slice
  // ------------------------------------------------------------------

  /**
   * Deep copy. With `snapshots` / `investment_periods`, only these are copied.
   */
  copy({ snapshots = null, investment_periods = null, ignore_standard_types = false } = {}) {
    if (snapshots === null && investment_periods === null && !ignore_standard_types) {
      return deepCopyNetwork(this);
    }
    let sns = snapshots === null ? this.snapshots : asIndex(snapshots, "snapshot");
    let periods = investment_periods === null ? this.investment_periods : asIndex(investment_periods, "period");
    if (sns.isMulti && periods.length > 0) {
      // keep snapshots and investment periods consistent with each other
      if (snapshots === null) sns = sns.filter(sns.values.map((t) => periods.has(t[0])));
      else if (investment_periods === null) {
        const used = new Set(sns.values.map((t) => labelKey(t[0])));
        periods = periods.filter(periods.values.map((p) => used.has(labelKey(p))));
      }
    }
    const n = new Network({ ignore_standard_types });
    const others = [...this.all_components].filter((c) => c !== "Bus" && c !== "Carrier").sort();
    for (const cname of ["Bus", "Carrier", ...others]) {
      const comp = this.c.get(cname);
      let st = comp.static;
      if (!ignore_standard_types && this.standard_type_components.has(cname)) {
        st = st.dropRows(n.c.get(cname).standard_types.index);
      }
      if (cname === "Link" || cname === "Process") updatePortsComponentAttrs(n, st.columns.values, cname);
      n.add(cname, st.index.values, frameToKwargs(st));
    }
    if (sns.length > 0) {
      n.set_snapshots(sns);
      for (const comp of this.components.values()) {
        const dyn = n.c.get(comp.list_name).dynamic;
        for (const [k, df] of Object.entries(comp.dynamic)) {
          dyn[k] = df.reindex({ index: sns });
        }
      }
      if (periods.length > 0) n.set_investment_periods(periods);
      const w = this.snapshot_weightings.reindex({ index: n.snapshots });
      n._snapshots_data = w;
      n._investment_periods_data = this.investment_period_weightings.reindex({ index: n.investment_periods });
    }
    n.name = this.name;
    n._crs = { ...this._crs };
    n._meta = structuredClone(this._meta);
    n._linearized_uc = this._linearized_uc;
    n._multi_invest = this._multi_invest;
    n._committable_big_m = this._committable_big_m;
    n._objective = this._objective;
    n._objective_constant = this._objective_constant;
    if (this.now !== undefined) n.now = this.now;
    return n;
  }

  /** Merge another network's components into a copy of this one. */
  merge(other, { components_to_skip = null, inplace = false, with_time = true } = {}) {
    const toSkip = new Set(["Network", "SubNetwork", "LineType", "TransformerType", ...(components_to_skip || [])]);
    const toIterate = [...other.all_components].filter((c) => !toSkip.has(c));
    const iterList = ["Bus", ...toIterate.filter((c) => c !== "Bus").sort()];
    for (const cname of iterList) {
      const oc = other.c.get(cname);
      if (oc.empty) continue;
      if (oc.static.index.intersection(this.c.get(cname).static.index).length > 0) {
        throw new Error(`Component ${cname} has overlapping indices, cannot merge networks.`);
      }
    }
    if (with_time) {
      if (!this.snapshots.equals(other.snapshots)) throw new Error("Snapshots do not agree, cannot merge networks.");
      const a = this.snapshot_weightings;
      const b = other.snapshot_weightings;
      const cols = [...a.columns.values].sort();
      const colsB = [...b.columns.values].sort();
      const same = cols.length === colsB.length && cols.every((c, i) => c === colsB[i] && a.col(c).every((v, j) => v === b.col(c)[j]));
      if (!same) throw new Error("Snapshot weightings do not agree, cannot merge networks.");
    }
    const neu = inplace ? this : this.copy();
    if (other.srid !== neu.srid) {
      logger.warning(`Spatial Reference System Indentifier of networks do not agree: ${neu.srid}, ${other.srid}. Assuming ${neu.srid}.`);
    }
    for (const cname of iterList) {
      const oc = other.c.get(cname);
      if (oc.empty) continue;
      if (cname === "Link" || cname === "Process") updatePortsComponentAttrs(neu, oc.static.columns.values, cname);
      neu.add(cname, oc.static.index.values, frameToKwargs(oc.static));
      if (with_time) {
        for (const [k, v] of Object.entries(oc.dynamic)) neu._import_series_from_df(v, cname, k);
      }
    }
    return inplace ? null : neu;
  }

  /** Rename components of a class (`{old: new}`) in all static, dynamic and referencing data. */
  rename_component_names(component, mapping) {
    this.c.get(component).rename_component_names(mapping);
  }

  /**
   * Slice the network to a subset of buses and/or snapshots.
   */
  slice_network({ buses = null, snapshots = null } = {}) {
    if (buses === null && snapshots === null) throw new Error("Either `buses` or `snapshots` must be provided to slice the network.");
    const busIdx = buses === null ? this.c.buses.static.index : asIndex(typeof buses === "string" ? [buses] : buses);
    const sns = snapshots === null ? this.snapshots : asIndex(snapshots);
    const n = new Network();
    const bst = this.c.buses.static.loc(busIdx.values);
    bst.set("sub_network", "");
    n.add("Bus", bst.index.values, frameToKwargs(bst));
    const busesI = n.c.buses.static.index;
    const rest = [...this.all_components].filter(
      (c) => !this.standard_type_components.has(c) && !this.one_port_components.has(c) && !this.branch_components.has(c) && c !== "Bus" && c !== "SubNetwork",
    );
    for (const c of rest) {
      const st = this.c.get(c).static;
      n.add(c, st.index.values, frameToKwargs(st));
    }
    for (const c of this.standard_type_components) {
      const st = this.c.get(c).static.dropRows(this.c.get(c).standard_types.index);
      n.add(c, st.index.values, frameToKwargs(st));
    }
    for (const c of this.one_port_components) {
      const st = this.c.get(c).static;
      const sel = st.filter(st.col("bus").map((b) => busesI.has(b)));
      n.add(c, sel.index.values, frameToKwargs(sel));
    }
    for (const c of this.branch_components) {
      const st = this.c.get(c).static;
      const sel = st.filter(st.col("bus0").map((b, i) => busesI.has(b) && busesI.has(st.col("bus1")[i])));
      if (c === "Link" || c === "Process") updatePortsComponentAttrs(n, sel.columns.values, c);
      n.add(c, sel.index.values, frameToKwargs(sel));
    }
    n.set_snapshots(sns);
    for (const cname of this.all_components) {
      const nc = n.c.get(cname);
      const oc = this.c.get(cname);
      const i = nc.static.index;
      for (const [k, df] of Object.entries(oc.dynamic)) {
        nc.dynamic[k] = df.reindex({ index: n.snapshots, columns: i.intersection(df.columns) });
      }
    }
    n.name = this.name;
    n._crs = { ...this._crs };
    n.snapshot_weightings = this.snapshot_weightings.reindex({ index: n.snapshots });
    return n;
  }
}

Network._accessorInitialisers = [];
Network._installLegacyAccessors();

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumber(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return NaN;
  return Number(v);
}

function emptyColsData(columns, n, fill) {
  const data = new Map();
  for (const c of columns) data.set(c, new Float64Array(n).fill(typeof fill === "number" ? fill : NaN));
  return data;
}

/** Reindex dynamic frame to new snapshots (broadcasting timesteps for MultiIndex targets). */
function reindexDynamic(df, sns, fill) {
  if (!df.index.isMulti && sns.isMulti) {
    const pos = sns.values.map((t) => df.index.getLoc(t[1]));
    const data = new Map();
    for (const c of df.columns) {
      const a = df.col(c);
      data.set(c, Float64Array.from(pos, (p) => (p < 0 ? fill : a[p])));
    }
    return new DataFrame({ index: sns, columns: df.columns, data, dtypes: df.dtypes });
  }
  return df.reindex({ index: sns, fill });
}

function tileFrame(df, times, newIndex) {
  const data = new Map();
  const n = df.index.length;
  for (const c of df.columns) {
    const a = df.col(c);
    const out = isNumberArray(a) ? new Float64Array(n * times) : new Array(n * times);
    for (let t = 0; t < times; t++) for (let i = 0; i < n; i++) out[t * n + i] = a[i];
    data.set(c, out);
  }
  return new DataFrame({ index: newIndex, columns: df.columns, data, dtypes: df.dtypes });
}

function concatStatic(oldStatic, newStatic) {
  return DataFrame.concatRows([oldStatic, newStatic]);
}

export function frameToKwargs(df) {
  const out = {};
  for (const col of df.columns) out[col] = Array.from(df.col(col));
  return out;
}

export function parseTimestamp(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(s.trim());
  if (!m) return null;
  const [, Y, M, D, h = "0", mi = "0", sec = "0", frac = "0"] = m;
  return Date.UTC(+Y, +M - 1, +D, +h, +mi, +sec, Math.round(Number(`0.${frac}`) * 1000));
}

export function formatTimestamp(ms) {
  const d = new Date(ms);
  const p = (x, w = 2) => String(x).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Extend Link/Process attribute definitions with additional ports
 * (mirrors `pypsa.descriptors._update_ports_component_attrs`).
 */
export function updatePortsComponentAttrs(n, where = null, cName = null) {
  const names = cName === null ? [...n.controllable_branch_components] : Array.isArray(cName) ? cName : [cName];
  for (const name of names) {
    const c = n.c.get(name);
    let ports;
    if (where === null) ports = c.additional_ports;
    else {
      ports = [];
      for (const col of where) {
        const m = RE_PORTS_GE_2.exec(col);
        if (m) ports.push(m[1]);
      }
    }
    ports.sort().reverse();
    const staticAttrs = ["bus", "delay", "cyclic_delay"];
    const dynamicAttrs = [c._coefficient_attr, "p"];
    const unsuffixed = c._unsuffixed_attrs;
    if (!ports.length) continue;
    c.ctype = c.ctype.clone();
    const defaults = c.ctype.defaults;
    let order = [...defaults.keys()];
    for (const i of ports) {
      for (const attr of [...staticAttrs, ...dynamicAttrs]) {
        const target = `${attr}${i}`;
        if (defaults.has(target)) continue;
        const j = unsuffixed.has(attr) ? "" : "1";
        const base = attr + j;
        if (!defaults.has(base)) continue;
        const bdef = defaults.get(base);
        const tdef = { ...bdef, attr: target };
        for (const key of ["description", "status", "unit"]) {
          if (typeof tdef[key] === "string" && tdef[key].length !== 1) {
            tdef[key] = tdef[key].split("1").join(i).split("required").join("optional");
          }
        }
        defaults.set(target, tdef);
        order = order.filter((x) => x !== target);
        order.splice(order.indexOf(base) + 1, 0, target);
        if (dynamicAttrs.includes(attr) && !c.dynamic[target]) {
          c.dynamic[target] = new DataFrame({ index: n.snapshots, columns: [] });
        } else if (staticAttrs.includes(attr) && !c.static.has(target)) {
          const dt = typToDtype(tdef.typ);
          c.static.set(target, dt === "float" || dt === "int" ? new Float64Array(c.static.index.length).fill(tdef.default) : new Array(c.static.index.length).fill(tdef.default));
          c.static.dtypes[target] = dt;
        }
      }
    }
    const reordered = new Map(order.map((k) => [k, defaults.get(k)]));
    c.ctype.defaults = reordered;
  }
}

export function checkForUnknownBuses(n, c, strict = false) {
  const buses = n.c.buses.names;
  for (const attr of c.static.columns) {
    if (!/^bus\d*$/.test(attr)) continue;
    const bus = c.static.col(attr);
    const missing = [];
    const isGe2 = RE_PORTS_GE_2.test(attr) && n.branch_components.has(c.name);
    bus.forEach((b, i) => {
      const s = typeof b === "number" && Number.isNaN(b) ? "nan" : String(b);
      let miss = !buses.has(s);
      if (isGe2) miss = miss && b !== "";
      if (c.name === "GlobalConstraint") miss = miss && b !== "";
      if (miss) missing.push(c.static.index.at(i));
    });
    if (missing.length) {
      const msg =
        `The following ${c.list_name} have buses which are not defined. Add them using n.add() or run ` +
        `n.sanitize() to add them automatically. Components with undefined buses:\n${missing.join(", ")}`;
      if (strict) throw new ConsistencyError(msg);
      logger.warning(msg);
    }
  }
}

export class ConsistencyError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ConsistencyError";
  }
}

function deepCopyNetwork(src) {
  const n = new Network({ ignore_standard_types: true, name: src.name });
  n._pypsa_version = src._pypsa_version;
  n._meta = structuredClone(src._meta);
  n._crs = { ...src._crs };
  n._snapshots_data = copyFrame(src._snapshots_data);
  n._investment_periods_data = copyFrame(src._investment_periods_data);
  n._objective = src._objective;
  n._objective_constant = src._objective_constant;
  n._multi_invest = src._multi_invest;
  n._linearized_uc = src._linearized_uc;
  n._committable_big_m = src._committable_big_m;
  if (src.now !== undefined) n.now = src.now;
  n.iteration = src.iteration;
  if (src.__scenarios_data) n._scenarios_data = copyFrame(src.__scenarios_data);
  if (src._risk_preference) n._risk_preference = { ...src._risk_preference };
  for (const [ln, comp] of src.components) {
    const dst = n.c.get(ln);
    dst.ctype = comp.ctype === dst.ctype ? comp.ctype : comp.ctype.clone();
    dst.static = copyFrame(comp.static);
    if (comp._nameLevel) dst._nameLevel = comp._nameLevel.slice();
    dst.dynamic = {};
    for (const [k, v] of Object.entries(comp.dynamic)) dst.dynamic[k] = copyFrame(v);
    dst.piecewise = {};
    for (const [k, v] of Object.entries(comp.piecewise)) dst.piecewise[k] = copyFrame(v);
  }
  if (src.c.sub_networks.static.has("obj")) {
    // rebuild SubNetwork objects bound to the new network
    if (Network._makeSubNetwork) {
      const st = n.c.sub_networks.static;
      st.set(
        "obj",
        st.index.values.map((name) => Network._makeSubNetwork(n, name)),
      );
      st.dtypes.obj = "object";
    }
  }
  return n;
}

export { isScalar, buildSuffixedNames, pyStr, castValue, labelKey, makeFilled };

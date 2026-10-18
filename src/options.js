// SPDX-License-Identifier: MIT
/**
 * Package options (mirrors `pypsa.options`): `options.params.statistics.round`
 * style access, `get_option(path)`, `set_option(path, value)`,
 * `option_context(path, value, ..., fn)`, `options.reset_all()` and
 * `options.describe()`. The older per-module objects (`statisticsOptions`,
 * `consistencyOptions`, `ioOptions`) are views onto the same values.
 */

const SPEC = {
  "general.allow_network_requests": [true, "Allow network requests (URL inputs of the netCDF and HDF5 importers)."],
  "params.statistics.nice_names": [true, "Default value for the 'nice_names' parameter in statistics module."],
  "params.statistics.drop_zero": [true, "Default value for the 'drop_zero' parameter in statistics module."],
  "params.statistics.round": [5, "Default value for the 'round' parameter in statistics module."],
  "params.add.return_names": [false, "Default value for the 'return_names' parameter in Network.add (return the names of added components)."],
  "params.optimize.model_kwargs": [{}, "Default value for the 'model_kwargs' parameter in optimization module."],
  "params.optimize.solver_name": ["highs", "Default value for the 'solver_name' parameter in optimization module."],
  "params.optimize.solver_options": [{}, "Default value for the 'solver_options' parameter in optimization module."],
  "params.optimize.log_to_console": [null, "Whether to print solver output to console (null: solver default)."],
  "params.optimize.include_objective_constant": [null, "Include capital costs of existing capacity on extendable assets in the objective (null: true with a FutureWarning)."],
  "params.consistency.numerical_tolerance": [1e-9, "Tolerance for numerical comparisons in consistency checks."],
  "optimization.model_snapshot_index": ["auto", "Snapshot dimension of multi-period models (stored for compatibility; PSA.js writes linopy's layout)."],
  "warnings.components_store_iter": [true, "If false, suppresses the deprecation warning when iterating over components (stored for compatibility)."],
  "warnings.attribute_typos": [true, "If false, suppresses warnings about potential typos in component attribute names (stored for compatibility)."],
  "api.legacy_string_dtype": [null, "pandas string dtype handling on import (stored for compatibility; PSA.js has no pandas dtypes)."],
  "api.new_components_api": [false, "New components API (stored for compatibility)."],
};

const clone = (v) => (v !== null && typeof v === "object" ? structuredClone(v) : v);
const values = new Map(Object.entries(SPEC).map(([k, [d]]) => [k, clone(d)]));

function check(path) {
  if (!values.has(path)) throw new Error(`InvalidOptionError: Invalid option '${path}'. Check 'options.describe()' for available options.`);
}

/** Value of an option (`"params.statistics.round"`). */
export function get_option(path) {
  check(path);
  return values.get(path);
}

/** Set an option. */
export function set_option(path, value) {
  check(path);
  values.set(path, value);
}

/**
 * Run `fn` with options temporarily set: `option_context("a.b", 1, "c.d", 2, fn)`
 * or `option_context({"a.b": 1}, fn)`. Restores them afterwards (also when
 * `fn` returns a promise) and returns what `fn` returns.
 */
export function option_context(...args) {
  const fn = args.pop();
  if (typeof fn !== "function") throw new TypeError("option_context: the last argument must be a function");
  const pairs = args.length === 1 && typeof args[0] === "object" ? Object.entries(args[0]) : [];
  if (!pairs.length) {
    if (args.length % 2) throw new Error("ValueError: Arguments must be paired option names and values.");
    for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  }
  const saved = pairs.map(([k]) => [k, get_option(k)]);
  for (const [k, v] of pairs) set_option(k, v);
  const restore = () => {
    for (const [k, v] of saved) values.set(k, v);
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

/** A nested view of the options below `prefix` with attribute access. */
function view(prefix) {
  const children = new Set();
  for (const k of values.keys()) {
    if (!k.startsWith(prefix)) continue;
    children.add(k.slice(prefix.length).split(".")[0]);
  }
  const obj = {};
  for (const name of children) {
    const path = prefix + name;
    if (values.has(path)) {
      Object.defineProperty(obj, name, { get: () => get_option(path), set: (v) => set_option(path, v), enumerable: true });
    } else {
      const sub = view(`${path}.`);
      Object.defineProperty(obj, name, { get: () => sub, set: () => { throw new Error(`InvalidOptionError: '${path}' is a group of options`); }, enumerable: true });
    }
  }
  return obj;
}

/** `pypsa.options`: nested attribute access plus `reset_all()`, `describe()`, `get_option`, `set_option`. */
export const options = Object.assign(view(""), {
  get_option,
  set_option,
  /** Reset all options to their defaults. */
  reset_all() {
    for (const [k, [d]] of Object.entries(SPEC)) values.set(k, clone(d));
  },
  /** Text listing every option with its default and description. */
  describe() {
    return Object.entries(SPEC)
      .map(([k, [d, desc]]) => `${k}:\n    Default: ${JSON.stringify(d)}\n    Description: ${desc}`)
      .join("\n");
  },
});

/** A plain object whose properties alias options (`{prop: path}`). */
function alias(map) {
  const obj = {};
  for (const [prop, path] of Object.entries(map)) {
    Object.defineProperty(obj, prop, { get: () => get_option(path), set: (v) => set_option(path, v), enumerable: true });
  }
  return obj;
}

/** Statistics defaults (`params.statistics.*`). */
export const statisticsOptions = alias({ nice_names: "params.statistics.nice_names", drop_zero: "params.statistics.drop_zero", round: "params.statistics.round" });
/** Consistency check settings (`params.consistency.*`). */
export const consistencyOptions = alias({ numerical_tolerance: "params.consistency.numerical_tolerance" });
/** IO settings (`general.allow_network_requests`). */
export const ioOptions = alias({ allow_network_requests: "general.allow_network_requests" });

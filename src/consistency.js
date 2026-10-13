// SPDX-License-Identifier: MIT
/**
 * Network consistency checks (mirrors `pypsa.consistency`). Problems are
 * logged as warnings, or raised as `ConsistencyError` for the checks listed
 * in `strict`.
 */

import { Network, ConsistencyError, checkForUnknownBuses } from "./network/network.js";
import { NOMINAL_ATTRS, Components } from "./components/components.js";
import { logger } from "./logger.js";

export const consistencyOptions = { numerical_tolerance: 1e-9 };

const RE_PORTS_FILTER = /^bus\d*$/;
const RE_PORTS_GE_2 = /^bus([2-9]|[1-9]\d+)$/;

function logOrRaise(strict, message) {
  if (strict) throw new ConsistencyError(message);
  logger.warning(message);
}

function fmtIndex(labels) {
  return `Index([${labels.map((l) => `'${l}'`).join(", ")}], dtype='object', name='name')`;
}

function busColumns(c) {
  return c.static.columns.values.filter((col) => RE_PORTS_FILTER.test(col));
}

function isNa(v) {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

export function check_for_unknown_buses(n, c, strict = false) {
  checkForUnknownBuses(n, c, strict);
}

export function check_for_disconnected_buses(n, strict = false) {
  const connected = new Set();
  for (const c of n.components.values()) for (const col of busColumns(c)) for (const b of c.static.col(col)) connected.add(b);
  const disconnected = n.c.buses.names.values.filter((b) => !connected.has(b));
  if (disconnected.length) logOrRaise(strict, `The following buses have no attached components, which can break the lopf: {${disconnected.map((b) => `'${b}'`).join(", ")}}`);
}

export function check_for_unknown_carriers(n, c, strict = false) {
  if (!c.static.has("carrier")) return;
  const carriers = n.c.carriers.names;
  const missing = c.static.index.values.filter((_, i) => {
    const v = c.static.col("carrier")[i];
    return !isNa(v) && v !== "" && !carriers.has(v);
  });
  if (missing.length) {
    logOrRaise(strict, `The following ${c.list_name} have carriers which are not defined. Run n.sanitize() to add them. Components with undefined carriers:\n${fmtIndex(missing)}`);
  }
}

export function check_for_zero_impedances(n, c, strict = false) {
  if (!n.passive_branch_components.has(c.name)) return;
  for (const attr of ["x", "r"]) {
    const bad = c.static.index.values.filter((_, i) => c.static.col(attr)[i] === 0);
    if (bad.length) logOrRaise(strict, `The following ${c.list_name} have zero ${attr}, which could break the linear load flow:\n${fmtIndex(bad)}`);
  }
}

export function check_for_zero_s_nom(c, strict = false) {
  if (c.name !== "Transformer") return;
  const bad = c.static.index.values.filter((_, i) => c.static.col("s_nom")[i] === 0);
  if (bad.length) logOrRaise(strict, `The following ${c.list_name} have zero s_nom, which is used to define the impedance and will thus break the load flow:\n${fmtIndex(bad)}`);
}

/** Optimisable phase shifts need finite bounds; inverted bounds are flagged. */
export function check_phase_shift_bounds(c, strict = false) {
  if (!c.static.has("phase_shift_min")) return;
  const lo = c.static.col("phase_shift_min");
  const hi = c.static.col("phase_shift_max");
  const names = c.static.index.values;
  const inverted = names.filter((_, i) => lo[i] > hi[i]);
  if (inverted.length) {
    logOrRaise(
      strict,
      `The following ${c.list_name} have phase_shift_min greater than phase_shift_max; the phase shift is held fixed at phase_shift, which is likely unintended (set phase_shift_min < phase_shift_max to optimise it):\n${fmtIndex(inverted)}`,
    );
  }
  const nonFinite = names.filter((_, i) => lo[i] < hi[i] && !(Number.isFinite(lo[i]) && Number.isFinite(hi[i])));
  if (nonFinite.length) {
    logOrRaise(
      strict,
      `The following ${c.list_name} have an optimisable phase shift (phase_shift_min < phase_shift_max) but a non-finite bound, which leaves the optimised tap angle unbounded:\n${fmtIndex(nonFinite)}`,
    );
  }
}

/** Maintainable components need valid maintenance parameters. */
export function check_maintenance_attributes(n, c, strict = false) {
  if (!c.static.has("maintainable")) return;
  const st = c.static;
  const idx = st.index.values.map((_, i) => i).filter((i) => st.col("maintainable")[i]);
  if (!idx.length) return;
  const names = (pred) => idx.filter(pred).map((i) => st.index.at(i));
  const duration = st.col("maintenance_duration");
  const events = st.col("maintenance_events");
  const pyNum = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));
  const badDuration = names((i) => duration[i] <= 0);
  if (badDuration.length) {
    logOrRaise(strict, `The following ${c.list_name} have maintainable=True but maintenance_duration <= 0, which is invalid for maintenance scheduling:\n${fmtIndex(badDuration)}`);
  }
  const badEvents = names((i) => events[i] <= 0);
  if (badEvents.length) {
    logOrRaise(strict, `The following ${c.list_name} have maintainable=True but maintenance_events <= 0, so no maintenance will be scheduled:\n${fmtIndex(badEvents)}`);
  }
  let horizon = 0;
  for (const w of n.snapshot_weightings.col("generators")) horizon += w;
  const badHorizon = names((i) => duration[i] > horizon);
  if (badHorizon.length) {
    logOrRaise(
      strict,
      `The following ${c.list_name} have maintenance_duration > total weighted snapshot hours (${pyNum(horizon)}), which will cause infeasibility:\n${fmtIndex(badHorizon)}`,
    );
  }
  const badTotal = names((i) => duration[i] * events[i] > horizon);
  if (badTotal.length) {
    logOrRaise(
      strict,
      `The following ${c.list_name} have maintenance_duration * maintenance_events > total weighted snapshot hours (${pyNum(horizon)}), which will cause infeasibility:\n${fmtIndex(badTotal)}`,
    );
  }
  const badMax = names((i) => st.col("p_nom_extendable")[i] && !Number.isFinite(st.col("p_nom_max")[i]));
  if (badMax.length) {
    logOrRaise(
      strict,
      `The following extendable maintainable ${c.list_name} have infinite p_nom_max, which is required to be finite for linearizing the maintenance capacity reduction:\n${fmtIndex(badMax)}`,
    );
  }
}

export function check_time_series(n, c, strict = false) {
  for (const [attr, def] of c.ctype.defaults) {
    if (!def.varying || !def.static) continue;
    const df = c.dynamic[attr];
    if (!df) continue;
    const diff = df.columns.difference(c.static.index);
    if (diff.length) {
      logOrRaise(strict, `The following ${c.list_name} have time series defined for attribute ${attr} in n.${c.list_name}_t, but are not defined in n.${c.list_name}:\n${fmtIndex(diff.values)}`);
    }
    if (!n.snapshots.equals(df.index)) {
      logOrRaise(strict, `The index of the time-dependent Dataframe for attribute ${attr} of n.${c.list_name}_t is not aligned with network snapshots`);
    }
  }
}

export function check_static_power_attributes(n, c, strict = false) {
  if (c.name === "TransformerType" || !n.all_components.has(c.name)) return;
  const attr = ["p_nom", "s_nom", "e_nom"].find((a) => c.ctype.defaults.get(a)?.static);
  if (!attr) return;
  const st = c.static;
  const tol = consistencyOptions.numerical_tolerance;
  const max = st.col(`${attr}_max`);
  const min = st.col(`${attr}_min`);
  const bad = st.index.values.filter((_, i) => max[i] < min[i] - tol);
  if (bad.length) logOrRaise(strict, `The following ${c.list_name} have smaller maximum than minimum expansion limit which can lead to infeasibility:\n${fmtIndex(bad)}`);
  const ext = st.col(`${attr}_extendable`);
  for (const col of [`${attr}_min`, `${attr}_max`]) {
    const v = st.col(col);
    if (st.index.values.some((_, i) => ext[i] && Number.isNaN(v[i]))) logOrRaise(strict, `Encountered nan's in column ${col} of component '${c.name}'.`);
  }
}

export function check_time_series_power_attributes(n, c, strict = false) {
  if (c.name === "TransformerType" || !n.all_components.has(c.name)) return;
  const varying = ["p_max_pu", "e_max_pu"].find((a) => c.ctype.defaults.get(a)?.varying);
  if (!varying) return;
  const attr = varying[0];
  const maxPu = n.get_switchable_as_dense(c.name, `${attr}_max_pu`);
  const minPu = n.get_switchable_as_dense(c.name, `${attr}_min_pu`);
  const snsWhere = (df, col, pred) =>
    df.index.values
      .filter((_, i) => pred(df.col(col)[i]))
      .map(String)
      .join(", ");
  for (const [df, which] of [
    [maxPu, "max"],
    [minPu, "min"],
  ]) {
    for (const col of df.columns) {
      if (df.col(col).some((v) => Number.isNaN(v))) {
        logOrRaise(strict, `The attribute ${attr}_${which}_pu of element ${col} of ${c.list_name} has NaN values for the following snapshots:\n${snsWhere(df, col, Number.isNaN)}`);
      }
    }
  }
  for (const [df, which] of [
    [maxPu, "max"],
    [minPu, "min"],
  ]) {
    for (const col of df.columns) {
      const inf = (v) => v === Infinity || v === -Infinity;
      if (df.col(col).some(inf)) logOrRaise(strict, `The attribute ${attr}_${which}_pu of element ${col} of ${c.list_name} has infinite values for the following snapshots:\n${snsWhere(df, col, inf)}`);
    }
  }
  const tol = consistencyOptions.numerical_tolerance;
  for (const col of maxPu.columns) {
    if (!minPu.has(col)) continue;
    const a = maxPu.col(col);
    const b = minPu.col(col);
    const bad = maxPu.index.values.filter((_, i) => a[i] - b[i] < -tol);
    if (bad.length) {
      logOrRaise(strict, `The element ${col} of ${c.list_name} has a smaller maximum than minimum operational limit which can lead to infeasibility for the following snapshots:\n${bad.join(", ")}`);
    }
  }
}

export function check_dispatch_delays(n, c, strict = false) {
  if ((c.name !== "Link" && c.name !== "Process") || c.static.empty) return;
  const w = n.snapshot_weightings.col("generators");
  let horizon;
  if (n.snapshots.isMulti) {
    const sums = new Map();
    n.snapshots.values.forEach((s, i) => sums.set(s[0], (sums.get(s[0]) ?? 0) + w[i]));
    horizon = Math.min(...sums.values());
  } else horizon = w.reduce((a, b) => a + b, 0);
  for (const col of c.static.columns.values.filter((x) => /^delay\d*$/.test(x))) {
    const v = c.static.col(col);
    const neg = c.static.index.values.filter((_, i) => v[i] < 0);
    if (neg.length) logOrRaise(strict, `Negative delay values in column '${col}' of ${c.name} for assets:\n\n\t${neg.join(", ")}`);
    const large = c.static.index.values.filter((_, i) => v[i] >= horizon);
    if (large.length) logOrRaise(strict, `Delay values in column '${col}' of ${c.name} equal or exceed the total snapshot horizon (${horizon.toFixed(1)}) for assets:\n\n\t${large.join(", ")}`);
  }
}

export function check_cost_consistency(c, strict = false) {
  const st = c.static;
  if (!st.has("capital_cost") || !st.has("overnight_cost")) return;
  const on = st.col("overnight_cost");
  const cc = st.col("capital_cost");
  const list = (a) => a.slice(0, 5).join(", ") + (a.length > 5 ? "..." : "");
  const both = st.index.values.filter((_, i) => !Number.isNaN(on[i]) && cc[i] !== 0);
  if (both.length) {
    logOrRaise(
      strict,
      `Component ${c.name} has assets with both 'overnight_cost' and 'capital_cost' set: ${list(both)}. When 'overnight_cost' is provided, it takes precedence and 'capital_cost' is ignored. Consider setting capital_cost=0 for these assets.`,
    );
  }
  for (const [col, what] of [
    ["discount_rate", "discount_rate"],
    ["lifetime", "lifetime"],
  ]) {
    if (!st.has(col)) continue;
    const v = st.col(col);
    const miss = st.index.values.filter((_, i) => !Number.isNaN(on[i]) && Number.isNaN(v[i]));
    if (miss.length) logOrRaise(true, `Component ${c.name} has assets with 'overnight_cost' set but missing '${what}': ${list(miss)}. Provide ${what} for annuitization.`);
  }
}

export function check_generators(c, strict = false) {
  if (c.name !== "Generator") return;
  const st = c.static;
  const com = st.col("committable");
  const ut = st.col("up_time_before");
  const dt = st.col("down_time_before");
  const pinit = st.col("p_init");
  const bad1 = st.index.values.filter((_, i) => com[i] && ut[i] > 0 && dt[i] > 0);
  if (bad1.length) logOrRaise(strict, `The following committable generators were both up and down before the simulation: ${fmtIndex(bad1)}. This could cause an infeasibility.`);
  const bad2 = st.index.values.filter((_, i) => com[i] && ut[i] === 0 && !Number.isNaN(pinit[i]));
  if (bad2.length) logOrRaise(strict, `The following committable generators were down before the simulation and have a p_init value. The latter will be ignored: ${fmtIndex(bad2)}.`);
  const tol = consistencyOptions.numerical_tolerance;
  const emin = st.col("e_sum_min");
  const emax = st.col("e_sum_max");
  const bad3 = st.index.values.filter((_, i) => emin[i] > emax[i] + tol);
  if (bad3.length) logOrRaise(strict, `The following generators have e_sum_min > e_sum_max, which can lead to infeasibility:\n${fmtIndex(bad3)}.`);
}

export function check_investment_periods(n, strict = false) {
  const gc = n.c.global_constraints.static;
  const periods = new Set(gc.has("investment_period") ? Array.from(gc.col("investment_period")).filter((x) => !isNa(x)) : []);
  if (n.snapshots.isMulti) {
    const sp = new Set(n.snapshots.values.map((s) => s[0]));
    if (![...periods].every((p) => sp.has(p))) {
      const msg = "The global constraints contain investment periods which are not in the set of optimized snapshots.";
      if (strict) throw new Error(msg);
      logOrRaise(strict, msg);
    }
  } else if (periods.size) {
    const msg = "The global constraints contain investment periods but snapshots are not multi-indexed.";
    if (strict) throw new Error(msg);
    logOrRaise(strict, msg);
  }
}

export function check_shapes(n, strict = false) {
  const st = n.c.shapes.static;
  if (st.empty || !st.has("component")) return;
  const comps = new Set(st.col("component"));
  for (const c of comps) {
    if (!n.all_components.has(c)) continue;
    const idx = n.c.get(c).static.index;
    const bad = st.index.values.filter((_, i) => st.col("component")[i] === c && !idx.has(st.col("idx")[i]));
    if (bad.length) logOrRaise(strict, `The following shapes are related to component ${c} and have idx values that are not included in the component's index:\n${bad.join(", ")}`);
  }
}

export function check_nans_for_component_default_attrs(n, c, strict = false) {
  const notNull = new Set();
  for (const [attr, def] of c.ctype.defaults) {
    const d = def.default;
    if (!isNa(d) && d !== "") notNull.add(attr);
  }
  const nanCols = c.static.columns.values.filter((col) => notNull.has(col) && Array.from(c.static.col(col)).some((v) => typeof v === "number" && Number.isNaN(v)));
  if (nanCols.length) logOrRaise(strict, `Encountered nan's in static data for columns [${nanCols.map((x) => `'${x}'`).join(", ")}] of component '${c.name}'.`);
  for (const [key, df] of Object.entries(c.dynamic)) {
    if (!notNull.has(key) || df.columns.length === 0 || df.index.length === 0) continue;
    const cols = df.columns.values.filter((col) => df.col(col).some((v) => Number.isNaN(v)));
    if (cols.length) logOrRaise(strict, `Encountered nan's in varying data '${key}' for columns [${cols.map((x) => `'${x}'`).join(", ")}] of component '${c.name}'.`);
  }
}

export function check_for_missing_carrier_colors(n, strict = false) {
  const st = n.c.carriers.static;
  const missing = st.index.values.filter((_, i) => {
    const v = st.col("color")[i];
    return isNa(v) || v === "";
  });
  if (missing.length) logOrRaise(strict, `The following carriers are missing colors. Run n.sanitize() to assign them. Carriers missing colors:\n${fmtIndex(missing)}`);
}

/** Warn when optimised capacities of committable+extendable assets exceed big-M. */
export function check_big_m_exceeded(n, strict = false) {
  for (const cName of ["Generator", "Link"]) {
    const c = n.c.get(cName);
    if (c.static.empty) continue;
    const comI = c.committables.intersection(c.active_assets);
    if (comI.empty) continue;
    const comExt = comI.intersection(c.extendables.intersection(c.active_assets));
    if (comExt.empty) continue;
    const attr = NOMINAL_ATTRS[cName];
    const st = c.static;
    const [, maxPu] = c.get_bounds_pu("p");
    const details = [];
    for (const nm of comExt) {
      const nomMax = st.at(nm, `${attr}_max`);
      if (!(Number.isFinite(nomMax) && nomMax > 0)) continue;
      let mp = -Infinity;
      if (maxPu.has(nm)) for (const v of maxPu.col(nm)) if (v > mp) mp = v;
      if (!Number.isFinite(mp)) continue;
      const bigM = nomMax * mp;
      const opt = st.at(nm, `${attr}_opt`);
      if (Number.isNaN(opt)) continue;
      if (opt > bigM && opt > 0) details.push(`${nm} (p_nom_opt=${opt.toPrecision(3)}, big_M=${bigM.toPrecision(3)})`);
    }
    if (details.length) logOrRaise(strict, `Optimized capacities exceed big-M bounds for committable extendable ${cName.toLowerCase()}: ${details.join(", ")}.`);
  }
}

const STRICT_OPTIONS = [
  "unknown_buses",
  "unknown_carriers",
  "time_series",
  "static_power_attrs",
  "time_series_power_attrs",
  "nans_for_component_default_attrs",
  "zero_impedances",
  "zero_s_nom",
  "phase_shift_bounds",
  "generators",
  "cost_consistency",
  "dispatch_delays",
  "maintenance",
  "disconnected_buses",
  "investment_periods",
  "shapes",
  "dtypes",
  "scenarios_sum",
  "scenario_invariant_attrs",
  "line_types",
  "transformer_types",
  "slack_bus_consistency",
];

/**
 * Run all consistency checks.
 * @param {object} [opts]
 * @param {string[]} [opts.strict] checks raising errors (default ["dispatch_delays", "maintenance", "phase_shift_bounds"]; "all" for all)
 */
Network.prototype.consistency_check = function consistencyCheck({ check_dtypes = false, strict = null } = {}) {
  let s = strict ?? ["dispatch_delays", "maintenance", "phase_shift_bounds"];
  if (s.includes("all")) s = STRICT_OPTIONS;
  const invalid = s.filter((x) => !STRICT_OPTIONS.includes(x));
  if (invalid.length) throw new Error(`Invalid strict option(s) ${invalid}. Valid options are ${STRICT_OPTIONS}.`);
  this.calculate_dependent_values();
  for (const c of this.components.values()) {
    check_for_unknown_buses(this, c, s.includes("unknown_buses"));
    check_for_unknown_carriers(this, c, s.includes("unknown_carriers"));
    check_time_series(this, c, s.includes("time_series"));
    check_static_power_attributes(this, c, s.includes("static_power_attrs"));
    check_time_series_power_attributes(this, c, s.includes("time_series_power_attrs"));
    check_nans_for_component_default_attrs(this, c, s.includes("nans_for_component_default_attrs"));
    check_for_zero_impedances(this, c, s.includes("zero_impedances"));
    check_for_zero_s_nom(c, s.includes("zero_s_nom"));
    check_phase_shift_bounds(c, s.includes("phase_shift_bounds"));
    check_generators(c, s.includes("generators"));
    check_maintenance_attributes(this, c, s.includes("maintenance"));
    check_cost_consistency(c);
    check_dispatch_delays(this, c, s.includes("dispatch_delays"));
    void check_dtypes;
  }
  check_for_disconnected_buses(this, s.includes("disconnected_buses"));
  check_investment_periods(this, s.includes("investment_periods"));
  check_shapes(this, s.includes("shapes"));
};

Network.prototype.consistency_check_plots = function consistencyCheckPlots({ strict = [] } = {}) {
  const s = strict.includes("all") ? ["unknown_carriers", "missing_carrier_colors"] : strict;
  for (const c of this.components.values()) check_for_unknown_carriers(this, c, s.includes("unknown_carriers"));
  check_for_missing_carrier_colors(this, s.includes("missing_carrier_colors"));
};

// matplotlib qualitative palettes
const PALETTES = {
  tab10: ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"],
  tab20: [
    "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a", "#d62728", "#ff9896", "#9467bd", "#c5b0d5",
    "#8c564b", "#c49c94", "#e377c2", "#f7b6d2", "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d", "#17becf", "#9edae5",
  ],
};

/** Hex colours from a (qualitative) palette, cycling like PyPSA. */
export function generate_colors(n_colors, palette = "tab10") {
  const p = PALETTES[palette];
  if (!p) throw new Error(`Palette '${palette}' is not available in PSA.js (use tab10 or tab20)`);
  return Array.from({ length: n_colors }, (_, i) => p[i % p.length]);
}

/** Add missing buses and carriers and assign carrier colours. */
Network.prototype.sanitize = function sanitize() {
  logger.info("Sanitizing network...");
  this.c.buses.add_missing_buses();
  this.c.carriers.add_missing_carriers();
  this.c.carriers.assign_colors();
  logger.info("Network sanitization complete.");
};

export { ConsistencyError };

Components._generateColors = generate_colors;

Network.prototype._checkBigMExceeded = function checkBigM() {
  check_big_m_exceeded(this);
};

// SPDX-License-Identifier: MIT
/**
 * Stochastic networks (mirrors the scenario parts of `pypsa.network.index`).
 *
 * After `set_scenarios`, static component data is indexed by
 * `(scenario, name)` and time series have `(scenario, name)` columns, both
 * scenario-major in the order the scenarios were given (pandas'
 * `pd.concat(dict.fromkeys(scenarios, df), names=["scenario"])`).
 */

import { Network } from "./network.js";
import { DataFrame, Series } from "../core/frame.js";
import { Index } from "../core/index.js";
import { broadcastStatic, broadcastDynamic, xsStatic, xsDynamic, uniqueNames } from "./scenario_frames.js";

export { broadcastStatic, broadcastDynamic, xsStatic, xsDynamic };

function emptyScenarios() {
  return DataFrame.empty(new Index([], "scenario"), ["weight"], NaN);
}

Object.defineProperties(Network.prototype, {
  _scenarios_data: {
    get() {
      return this.__scenarios_data ?? emptyScenarios();
    },
    set(v) {
      this.__scenarios_data = v;
    },
  },
  scenarios: {
    get() {
      return this._scenarios_data.index;
    },
    set(v) {
      this.set_scenarios(v);
    },
  },
  scenario_weightings: {
    get() {
      return this._scenarios_data;
    },
  },
  has_scenarios: {
    get() {
      return this._scenarios_data.index.length > 0;
    },
  },
  risk_preference: {
    get() {
      return this._risk_preference ?? null;
    },
  },
  has_risk_preference: {
    get() {
      return this.risk_preference !== null;
    },
  },
});

/**
 * Set scenarios to create a stochastic network.
 * @param {object|Map|Array|Series|DataFrame} scenarios scenario -> probability
 *   (object, Map, Series or one-column DataFrame) or a list of names with
 *   equal probabilities
 */
Network.prototype.set_scenarios = function setScenarios(scenarios = null) {
  if (this.has_scenarios) {
    throw new Error("NotImplementedError: Changing scenarios on a network that already has scenarios defined is not yet supported.");
  }
  if (scenarios === null || scenarios === undefined) {
    throw new Error("ValueError: You must pass either `scenarios` or keyword arguments to set_scenarios.");
  }
  let names;
  let weights;
  if (scenarios instanceof DataFrame) {
    if (scenarios.columns.length !== 1) throw new Error("ValueError: `scenarios` DataFrame must have exactly one column.");
    names = scenarios.index.values;
    weights = Array.from(scenarios.col(scenarios.columns.at(0)));
  } else if (scenarios instanceof Series) {
    names = scenarios.index.values;
    weights = Array.from(scenarios.values);
  } else if (scenarios instanceof Map) {
    names = [...scenarios.keys()];
    weights = [...scenarios.values()];
  } else if (Array.isArray(scenarios) || scenarios instanceof Index) {
    names = scenarios instanceof Index ? scenarios.values : scenarios;
    weights = names.map(() => 1 / names.length);
  } else if (typeof scenarios === "object") {
    names = Object.keys(scenarios);
    weights = Object.values(scenarios);
  } else {
    throw new Error("TypeError: Invalid type for `scenarios`. Must be dict, pd.DataFrame, pd.Series, or Sequence. ");
  }
  const total = weights.reduce((a, b) => a + Number(b), 0);
  if (Math.abs(total - 1) > 1e-5) {
    throw new Error(`ValueError: The sum of the weights in \`scenarios\` must be equal to 1. Current sum: ${total}`);
  }
  for (const c of this.components.values()) {
    for (const df of Object.values(c.piecewise)) {
      if (!df.empty) throw new Error("NotImplementedError: Setting scenarios on a network with piecewise attribute data is not yet supported.");
    }
  }
  const index = new Index(names.map(String), "scenario");
  for (const c of this.components.values()) {
    c._nameLevel = uniqueNames(c.static.index);
    c.static = broadcastStatic(c.static, index);
    for (const [k, v] of Object.entries(c.dynamic)) c.dynamic[k] = broadcastDynamic(v, index);
  }
  this._scenarios_data = new DataFrame({ index, columns: ["weight"], data: { weight: Float64Array.from(weights, Number) } });
};

/**
 * Set risk aversion preferences (CVaR) for stochastic optimisation.
 * @param {{alpha: number, omega: number}} opts confidence level and risk weight
 */
Network.prototype.set_risk_preference = function setRiskPreference({ alpha, omega } = {}) {
  if (!this.has_scenarios) {
    throw new Error("ValueError: Risk preferences can only be set for stochastic networks. Please call set_scenarios() first to define scenarios.");
  }
  if (!(alpha > 0 && alpha < 1)) throw new Error(`ValueError: Alpha must be between 0 and 1, got ${alpha}`);
  if (!(omega >= 0 && omega <= 1)) throw new Error(`ValueError: Omega must be between 0 and 1, got ${omega}`);
  this._risk_preference = { alpha, omega };
};

/** Network for a single scenario of a stochastic network (a copy). */
Network.prototype.get_scenario = function getScenario(scenario) {
  if (!this.has_scenarios) throw new Error("ValueError: This method can only be used on a stochastic network with scenarios.");
  if (!this.scenarios.has(scenario)) throw new Error(`KeyError: "Scenario '${scenario}' not found in network scenarios."`);
  const n = this.copy();
  n.name = `${n.name} - Scenario '${scenario}'`;
  n._scenarios_data = emptyScenarios();
  n._risk_preference = null;
  for (const c of n.components.values()) {
    if (!c.static.index.isMulti) continue;
    c.static = xsStatic(c.static, scenario);
    for (const [k, v] of Object.entries(c.dynamic)) c.dynamic[k] = xsDynamic(v, scenario);
  }
  return n;
};

export function copyFrame(df) {
  const data = new Map();
  for (const c of df.columns) data.set(c, df.col(c).slice());
  return new DataFrame({ index: df.index, columns: df.columns, data, dtypes: df.dtypes });
}

/**
 * Deterministic network holding the data of one scenario. Component names
 * active in any scenario are kept (as in PyPSA's stochastic model), while the
 * activity masks follow the scenario's own `active` values.
 */
export function scenarioView(n, scenario) {
  const v = new Network({ ignore_standard_types: true, name: n.name });
  v._pypsa_version = n._pypsa_version;
  v._meta = n._meta;
  v._crs = { ...n._crs };
  v._snapshots_data = n._snapshots_data;
  v._investment_periods_data = n._investment_periods_data;
  if (n.now !== undefined) v.now = n.now;
  for (const [ln, comp] of n.components) {
    const dst = v.c.get(ln);
    dst.ctype = comp.ctype;
    const multi = comp.static.index.isMulti;
    dst.static = multi ? xsStatic(comp.static, scenario) : copyFrame(comp.static);
    dst.dynamic = {};
    for (const [k, df] of Object.entries(comp.dynamic)) {
      dst.dynamic[k] = copyFrame(df.columns.isMulti ? xsDynamic(df, scenario) : df);
    }
    dst.piecewise = comp.piecewise;
    if (multi && comp.static.index.length) dst._activeNamesOverride = comp.active_assets;
  }
  return v;
}

// SPDX-License-Identifier: MIT
/**
 * Convenience and backwards-compatible API of PyPSA networks and components
 * (`n.stats`, `n.equals`, `n.component`, `n.iterate_components`, `n.df`,
 * `n.pnl`, `c.attrs`, `c.units`, ...).
 */

import { Index, labelKey } from "../core/index.js";
import { DataFrame, Series } from "../core/frame.js";
import { Network } from "./network.js";
import { Components } from "../components/components.js";
import { logger } from "../logger.js";

function valuesEqual(a, b) {
  if (a === b) return true;
  const na = a === null || a === undefined || (typeof a === "number" && Number.isNaN(a));
  const nb = b === null || b === undefined || (typeof b === "number" && Number.isNaN(b));
  if (na && nb) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  return false;
}

function indexEqual(a, b) {
  return a.length === b.length && a.values.every((v, i) => labelKey(v) === labelKey(b.values[i]));
}

/** Element-wise equality of two frames (index, columns and values; NaN == NaN). */
export function framesEqual(a, b, path = "frame", log = false) {
  const fail = (msg) => {
    if (log) logger.warning(`${path}: ${msg}`);
    return false;
  };
  if (!(a instanceof DataFrame) || !(b instanceof DataFrame)) return fail("not a DataFrame");
  if (!indexEqual(a.index, b.index)) return fail("index differs");
  if (!indexEqual(a.columns, b.columns)) return fail("columns differ");
  for (const c of a.columns) {
    const x = a.col(c);
    const y = b.col(c);
    for (let i = 0; i < x.length; i++) if (!valuesEqual(x[i], y[i])) return fail(`value differs at [${a.index.at(i)}, ${c}]`);
  }
  return true;
}

Components.prototype.equals = function componentsEquals(other, { log_mode = "silent" } = {}) {
  if (!(other instanceof Components) || other.name !== this.name) return false;
  const log = log_mode !== "silent";
  if (!framesEqual(this.static, other.static, `c.${this.list_name}.static`, log)) return false;
  const ka = Object.keys(this.dynamic).sort();
  const kb = Object.keys(other.dynamic).sort();
  if (ka.join() !== kb.join()) return false;
  return ka.every((k) => framesEqual(this.dynamic[k], other.dynamic[k], `c.${this.list_name}.dynamic.${k}`, log));
};

Object.defineProperties(Components.prototype, {
  /** Attribute definitions (alias of `defaults`). */
  attrs: {
    get() {
      return this.defaults;
    },
  },
  /** Deprecated alias of `static`. */
  df: {
    get() {
      return this.static;
    },
  },
  /** Deprecated alias of `dynamic`. */
  pnl: {
    get() {
      return this.dynamic;
    },
  },
  /** Units of the attributes which have one. */
  units: {
    get() {
      const names = [];
      const vals = [];
      for (const [attr, def] of this.defaults) {
        if (def.unit && def.unit !== "n/a") {
          names.push(attr);
          vals.push(def.unit);
        }
      }
      return new Series(vals, new Index(names, "attribute"), "unit");
    },
  },
  component_names: {
    get() {
      return new Series(this.static.index.values.slice(), new Index(this.static.index.values, "name"), "name");
    },
  },
  timesteps: {
    get() {
      return this.n ? this.n.timesteps : new Index([], "timestep");
    },
  },
  periods: {
    get() {
      return this.n ? this.n.periods : new Index([], "period");
    },
  },
  has_periods: {
    get() {
      return this.n ? this.n.has_periods : false;
    },
  },
});

Object.defineProperty(Network.prototype, "stats", {
  get() {
    return this.statistics;
  },
});

Object.defineProperty(Network.prototype, "component_attrs", {
  get() {
    return Object.fromEntries([...this.components.values()].map((c) => [c.name, c.defaults]));
  },
});

/** Compare two networks (snapshots, weightings and all component data). */
Network.prototype.equals = function networkEquals(other, { log_mode = "silent" } = {}) {
  if (!(other instanceof Network)) {
    logger.warning(`Can only compare two pypsa.Network objects with each other. Got ${typeof other}.`);
    return false;
  }
  const log = log_mode !== "silent";
  let ok = this.name === other.name && indexEqual(this.snapshots, other.snapshots);
  ok = ok && framesEqual(this.snapshot_weightings, other.snapshot_weightings, "n.snapshot_weightings", log);
  ok = ok && indexEqual(this.investment_periods, other.investment_periods);
  ok = ok && framesEqual(this.investment_period_weightings, other.investment_period_weightings, "n.investment_period_weightings", log);
  if (!ok) return false;
  for (const c of this.components.values()) {
    if (c.name === "SubNetwork") continue;
    if (!c.equals(other.c.get(c.name), { log_mode })) return false;
  }
  return true;
};

/** Component container by name (deprecated alias of `n.c[name]`). */
Network.prototype.component = function component(c_name) {
  return this.c.get(c_name);
};

/** Iterate over (non-empty) components. */
Network.prototype.iterate_components = function* iterateComponents(components = null, skip_empty = true) {
  const names = components ?? [...this.all_components];
  for (const name of names) {
    const c = this.c.get(name);
    if (skip_empty && c.static.index.length === 0) continue;
    yield c;
  }
};

/** Deprecated: static data of a component. */
Network.prototype.df = function df(component_name) {
  return this.c.get(component_name).static;
};

/** Deprecated: time-varying data of a component. */
Network.prototype.pnl = function pnl(component_name) {
  return this.c.get(component_name).dynamic;
};

Network.prototype.static = function staticData(component_name) {
  return this.c.get(component_name).static;
};

Network.prototype.dynamic = function dynamicData(component_name) {
  return this.c.get(component_name).dynamic;
};

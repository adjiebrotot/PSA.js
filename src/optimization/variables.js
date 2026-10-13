// SPDX-License-Identifier: MIT
/** Variable definitions (mirrors `pypsa.optimization.variables`). */

import { Index } from "../core/index.js";
import { activityMask, denseValues } from "./common.js";

/** Label accessor for a (snapshot, name) variable restricted to sns x names. */
export function labeler2(v, sns, names) {
  const sp = v.coords[0].getIndexer(sns);
  const npos = v.coords[1].getIndexer(names);
  const nN = v.shape[1];
  return (s, j) => (sp[s] < 0 || npos[j] < 0 ? -1 : v.labels[sp[s] * nN + npos[j]]);
}

/** Label accessor for a (name) variable. */
export function labeler1(v, names) {
  const npos = v.coords[0].getIndexer(names);
  return (j) => (npos[j] < 0 ? -1 : v.labels[npos[j]]);
}

export function define_operational_variables(n, sns, cName, attr) {
  const c = n.c.get(cName);
  if (c.empty) return;
  const names = c.active_assets;
  const mask = activityMask(c, sns, names);
  n.model.add_variables({ name: `${c.name}-${attr}`, dims: ["snapshot", "name"], coords: [sns, names], mask });
}

function defineCommitmentVariable(n, sns, cName, isLinearized, suffix) {
  const c = n.c.get(cName);
  const comI = c.committables.intersection(c.active_assets);
  if (comI.empty) return;
  const mask = activityMask(c, sns, comI);
  const hasModular = comI.intersection(c.modulars).length > 0;
  const isInteger = hasModular && !isLinearized;
  const isBinary = !hasModular && !isLinearized;
  let lower;
  let upper;
  if (hasModular) lower = 0;
  else if (isLinearized) {
    lower = 0;
    upper = 1;
  }
  n.model.add_variables({
    name: `${c.name}-${suffix}`,
    dims: ["snapshot", "name"],
    coords: [sns, new Index(comI.values, "name")],
    mask,
    integer: isInteger,
    binary: isBinary,
    lower,
    upper,
  });
}

export function define_status_variables(n, sns, cName, isLinearized = false) {
  defineCommitmentVariable(n, sns, cName, isLinearized, "status");
}

export function define_start_up_variables(n, sns, cName, isLinearized = false) {
  defineCommitmentVariable(n, sns, cName, isLinearized, "start_up");
}

export function define_shut_down_variables(n, sns, cName, isLinearized = false) {
  defineCommitmentVariable(n, sns, cName, isLinearized, "shut_down");
}

export function define_nominal_variables(n, cName, attr) {
  const c = n.c.get(cName);
  const extI = c.extendables.intersection(c.active_assets);
  if (extI.empty) return;
  n.model.add_variables({ name: `${c.name}-${attr}`, dims: ["name"], coords: [new Index(extI.values, "name")] });
}

export function define_modular_variables(n, cName, attr) {
  const c = n.c.get(cName);
  const modI = c.extendables.intersection(c.modulars).intersection(c.active_assets);
  if (modI.empty) return;
  n.model.add_variables({ name: `${c.name}-n_mod`, dims: ["name"], coords: [new Index(modI.values, "name")], lower: 0, integer: true });
}

export function define_spillage_variables(n, sns) {
  const c = n.c.get("StorageUnit");
  if (c.empty) return;
  const names = c.active_assets;
  const upper = denseValues(c, "inflow", sns, names);
  if (upper.length === 0) return;
  let max = -Infinity;
  for (const v of upper) if (v > max) max = v;
  if (!(max > 0)) return;
  const act = activityMask(c, sns, names);
  const mask = Uint8Array.from(act, (a, k) => (a && upper[k] > 0 ? 1 : 0));
  n.model.add_variables({ name: `${c.name}-spill`, dims: ["snapshot", "name"], coords: [sns, names], lower: 0, upper, mask });
}

export function define_loss_variables(n, sns, cName) {
  const c = n.c.get(cName);
  if (c.empty || !n.passive_branch_components.has(c.name)) return;
  const names = c.active_assets;
  const mask = activityMask(c, sns, names);
  n.model.add_variables({ name: `${c.name}-loss`, dims: ["snapshot", "name"], coords: [sns, names], lower: 0, mask });
}

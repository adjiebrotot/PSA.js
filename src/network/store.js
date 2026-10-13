// SPDX-License-Identifier: MIT
/** ComponentsStore: map of list_name -> Components with attribute access. */

import { COMPONENT_ALIAS_DICT } from "../components/types.js";

export class ComponentsStore extends Map {
  get(key) {
    if (Array.isArray(key)) return key.map((k) => this.get(k));
    if (super.has(key)) return super.get(key);
    if (COMPONENT_ALIAS_DICT[key] && super.has(COMPONENT_ALIAS_DICT[key])) return super.get(COMPONENT_ALIAS_DICT[key]);
    throw new Error(`Network has no components '${key}'`);
  }

  has(key) {
    return super.has(key) || (COMPONENT_ALIAS_DICT[key] !== undefined && super.has(COMPONENT_ALIAS_DICT[key]));
  }

  /** Iterate non-empty components (like iterating `n.components` in PyPSA). */
  *nonEmpty() {
    for (const c of this.values()) if (!c.empty) yield c;
  }

  toString() {
    return (
      "PyPSA Components Store\n======================\n- " +
      [...this.values()].map((v) => `${v.static.index.length} ${v}`).join("\n- ")
    );
  }
}

/** Install `store.buses`, `store.Bus`, ... property accessors. */
export function installStoreAccessors(store) {
  for (const [listName, comp] of Map.prototype.entries.call(store)) {
    Object.defineProperty(store, listName, { get: () => Map.prototype.get.call(store, listName), enumerable: false, configurable: true });
    Object.defineProperty(store, comp.name, { get: () => Map.prototype.get.call(store, listName), enumerable: false, configurable: true });
  }
}

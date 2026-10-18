// SPDX-License-Identifier: MIT
/**
 * Component type registry (mirrors `pypsa.components.types`).
 */

import definitions from "../data/definitions.js";
import { DataFrame } from "../core/frame.js";
import { Index } from "../core/index.js";

function decode(v) {
  if (v && typeof v === "object" && "$float" in v) {
    return v.$float === "nan" ? NaN : v.$float === "inf" ? Infinity : -Infinity;
  }
  return v;
}

export class ComponentType {
  constructor({ name, list_name, description, category, attrs, standard_types }) {
    this.name = name;
    this.list_name = list_name;
    this.description = description;
    this.category = category;
    /** ordered attribute definitions */
    this.defaults = new Map();
    for (const a of attrs) {
      this.defaults.set(a.attr, { ...a, default: decode(a.default) });
    }
    this.standard_types = null;
    if (standard_types) {
      const data = {};
      for (const [col, vals] of Object.entries(standard_types.data)) data[col] = vals.map(decode);
      const dtypes = {};
      const cols = standard_types.columns;
      for (const c of cols) {
        const def = this.defaults.get(c);
        dtypes[c] = def ? typToDtype(def.typ) : "object";
        if (dtypes[c] === "float" || dtypes[c] === "int") data[c] = Float64Array.from(data[c], (x) => (x === null ? NaN : x));
      }
      this.standard_types = new DataFrame({
        index: new Index(standard_types.index, "name"),
        columns: cols,
        data,
        dtypes,
      });
    }
  }

  /** Copy with independent defaults (used for multiport links/processes). */
  clone() {
    const c = Object.create(ComponentType.prototype);
    Object.assign(c, this);
    c.defaults = new Map([...this.defaults].map(([k, v]) => [k, { ...v }]));
    return c;
  }

  toString() {
    return `'${this.name}' Component Type`;
  }
}

export function typToDtype(typ) {
  return typ === "float" ? "float" : typ === "int" ? "int" : typ === "bool" ? "bool" : "object";
}

export const componentTypes = new Map();
export const componentTypesByListName = new Map();
for (const def of definitions.components) {
  const ct = new ComponentType(def);
  componentTypes.set(ct.name, ct);
  componentTypesByListName.set(ct.list_name, ct);
}

export const defaultComponents = [...componentTypes.keys()];

export const allStandardAttrs = new Set();
for (const ct of componentTypes.values()) for (const a of ct.defaults.keys()) allStandardAttrs.add(a);

// Aliases accepted by PyPSA (deprecations.COMPONENT_ALIAS_DICT)
export const COMPONENT_ALIAS_DICT = {
  Bus: "buses",
  Carrier: "carriers",
  Generator: "generators",
  GlobalConstraint: "global_constraints",
  Line: "lines",
  LineType: "line_types",
  Link: "links",
  Load: "loads",
  Process: "processes",
  Shape: "shapes",
  ShuntImpedance: "shunt_impedances",
  StorageUnit: "storage_units",
  Store: "stores",
  SubNetwork: "sub_networks",
  Transformer: "transformers",
  TransformerType: "transformer_types",
};

export function getComponentType(name) {
  if (componentTypes.has(name)) return componentTypes.get(name);
  if (componentTypesByListName.has(name)) return componentTypesByListName.get(name);
  throw new Error(
    `Component type '${name}' not found. Available types are: ${[...componentTypes.keys()].join(", ")}.`,
  );
}

export const PYPSA_REFERENCE_VERSION = definitions.pypsa_version;

/** Release version of the mirrored PyPSA (like `pypsa.__version_base__`). */
export const PYPSA_VERSION = /^\d+\.\d+(?:\.\d+)?(?:[a-z]+\d*)?/.exec(PYPSA_REFERENCE_VERSION)[0];

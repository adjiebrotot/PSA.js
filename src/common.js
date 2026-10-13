// SPDX-License-Identifier: MIT
/** Shared helpers (mirrors parts of `pypsa.common`). */

import { Index, asIndex } from "./core/index.js";

/**
 * Return an Index of the given values, defaulting to the network attribute
 * (e.g. "snapshots"). Mirrors `pypsa.common.as_index`.
 */
export function as_index(n, values, networkAttribute, forceSubset = true) {
  const attr = n[networkAttribute];
  let out;
  if (values === null || values === undefined) {
    return attr;
  } else if (values instanceof Index) {
    out = values.isMulti ? new Index(values.values, attr.names) : new Index(values.values, attr.names[0]);
  } else if (typeof values === "string" || typeof values === "number" || (Array.isArray(values) && attr.isMulti && !Array.isArray(values[0]))) {
    out = new Index([values], attr.isMulti ? attr.names : attr.names[0]);
  } else {
    const arr = Array.from(values);
    out = new Index(arr, attr.isMulti && Array.isArray(arr[0]) ? attr.names : attr.names[0]);
  }
  if (forceSubset && !out.values.every((v) => attr.has(v))) {
    throw new Error(
      `Values must be a subset of the network attribute '${networkAttribute}'. Pass force_subset=False to disable this check.`,
    );
  }
  return out;
}

export function listAsString(list, prefix = "", style = "comma-separated") {
  const arr = Array.from(list);
  if (style === "bulleted-list") return arr.map((x) => `${prefix}- ${x}`).join("\n");
  return arr.join(", ");
}

export { asIndex };

/** True if `x` is a plain options object (used to emulate Python keyword arguments). */
export function isOptions(x) {
  return (
    x !== null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    !(x instanceof Index) &&
    !ArrayBuffer.isView(x) &&
    Object.getPrototypeOf(x) === Object.prototype
  );
}

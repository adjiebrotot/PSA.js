// SPDX-License-Identifier: MIT
/** Carrier nice names (`pypsa.common.normalize_carrier_nice_names`). */

const isNa = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

/** Map carrier nice names (`n.carriers.nice_name`, unique ones) back to carrier names. */
export function normalizeCarrierNiceNames(n, carrier) {
  if (carrier === null || carrier === undefined) return carrier;
  const scalar = typeof carrier === "string";
  if (!scalar && !Array.isArray(carrier)) return carrier;
  const carriers = scalar ? [carrier] : carrier;
  const st = n.c.carriers.static;
  const nice = st.has("nice_name") ? st.col("nice_name") : [];
  // scenario-indexed carriers: the first value per name (`groupby(level="name").first()`)
  const seen = new Set();
  const entries = st.index.values
    .map((k, i) => [st.index.isMulti ? k[k.length - 1] : k, nice[i]])
    .filter(([k]) => (seen.has(k) ? false : seen.add(k)))
    .filter(([, v]) => v !== "" && !isNa(v));
  if (!entries.length) return carrier;
  const counts = new Map();
  for (const [, v] of entries) counts.set(v, (counts.get(v) ?? 0) + 1);
  const toCarrier = new Map(entries.filter(([, v]) => counts.get(v) === 1).map(([k, v]) => [v, k]));
  const out = carriers.map((c) => toCarrier.get(c) ?? c);
  return scalar ? out[0] : out;
}

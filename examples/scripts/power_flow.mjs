// Optimisation followed by linear and non-linear (Newton-Raphson) power flow
// on SciGrid-DE, following PyPSA's "SciGrid LOPF then PF" example.
// Run: node examples/scripts/power_flow.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const n = Network.from_csv_folder(new URL("../networks/scigrid-de/scigrid-de", import.meta.url).pathname);
n.set_snapshots(n.snapshots.slice(0, 2));
const lines = n.c.lines.static;
lines.set("s_max_pu", new Float64Array(lines.index.length).fill(0.7)); // N-1 security margin
for (const l of ["316", "527", "602"]) lines.setAt(l, "s_nom", 1715); // avoid infeasibilities
await n.optimize();

// dispatch as set points; generators control voltage, one is the slack
for (const c of [n.c.generators, n.c.storage_units]) c.dynamic.p_set = c.dynamic.p.copy();
const gens = n.c.generators.static;
gens.set(
  "control",
  Array.from(gens.col("bus"), (b) => (b === "492" ? "Slack" : "PV")),
);

n.lpf();
const loading = Math.max(...lines.index.values.map((l, i) => Math.abs(n.c.lines.dynamic.p0.col(l)[0]) / lines.col("s_nom")[i]));
console.log("max line loading after LPF:", loading.toFixed(3));

const info = n.pf({ use_seed: true });
const conv = info.converged; // snapshots x sub-networks
console.log("Newton-Raphson converged everywhere:", conv.columns.values.every((c) => Array.from(conv.col(c)).every(Boolean)));
const v = n.c.buses.dynamic.v_mag_pu;
const all = v.columns.values.flatMap((b) => Array.from(v.col(b)));
console.log("voltage magnitudes (p.u.):", Math.min(...all).toFixed(4), "to", Math.max(...all).toFixed(4));

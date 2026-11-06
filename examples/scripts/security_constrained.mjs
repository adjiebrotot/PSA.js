// Security-constrained optimal power flow (SCLOPF): dispatch that keeps every
// line within its rating after the outage of any one line (N-1), via the
// branch outage distribution factors, checked by a contingency power flow. Run: node examples/scripts/security_constrained.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const path = new URL("../networks/ac-dc-meshed/ac-dc-meshed", import.meta.url).pathname;
const n = Network.from_csv_folder(path);
n.set_snapshots(n.snapshots.slice(0, 4));
n.c.lines.static.set("s_nom_extendable", n.c.lines.static.index.values.map(() => true));

await n.optimize();
const lopf = n.objective;
const lopfCapacity = Array.from(n.c.lines.static.col("s_nom_opt"));

const outages = n.c.lines.static.index.values;
await n.optimize.optimize_security_constrained({ branch_outages: outages });
console.log("system cost: LOPF", lopf.toFixed(1), "SCLOPF", n.objective.toFixed(1));
console.log("line capacities (MVA), LOPF vs SCLOPF:");
n.c.lines.static.index.values.forEach((l, i) => {
  console.log(`  ${l.padEnd(4)} ${lopfCapacity[i].toFixed(1).padStart(8)} ${n.c.lines.static.col("s_nom_opt")[i].toFixed(1).padStart(8)}`);
});

// check: fix the dispatch and run a linear power flow for every line outage
// in the first snapshot; no line exceeds its capacity in any contingency
n.optimize.fix_optimal_dispatch();
const flows = n.lpf_contingency(n.snapshots.at(0), outages.map((l) => ["Line", l]));
const cap = n.c.lines.static.col("s_nom_opt");
let worst = 0;
flows.index.values.forEach(([, line], r) => {
  for (const col of flows.columns) worst = Math.max(worst, Math.abs(flows.col(col)[r]) / cap[n.c.lines.static.index.getLoc(line)]);
});
console.log("highest post-contingency line loading:", worst.toFixed(4));

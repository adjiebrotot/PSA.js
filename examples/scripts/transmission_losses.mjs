// Transmission losses in a linear optimal power flow: quadratic losses
// r * p^2 approximated by secants or tangents of the loss curve (PyPSA's
// `transmission_losses` option). Run: node examples/scripts/transmission_losses.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const path = new URL("../networks/ac-dc-meshed/ac-dc-meshed", import.meta.url).pathname;
console.log("losses setting                    | objective     | losses (MWh) | generation (MWh)");
for (const losses of [0, 2, 4, { mode: "tangents", segments: 3 }]) {
  const n = Network.from_csv_folder(path);
  n.set_snapshots(n.snapshots.slice(0, 4));
  const lines = n.c.lines.static;
  // the AC lines of the example network have no resistance; assume R/X = 0.3
  const x = lines.col("x");
  lines.set("r", Float64Array.from(lines.col("r"), (r, i) => r || 0.3 * x[i]));
  // the loss curves are linearised up to the maximum capacity, which must be finite
  lines.set("s_nom_max", lines.index.values.map(() => 3000));
  await n.optimize({ transmission_losses: losses });
  const loss = losses ? n.model.variables.get("Line-loss").solution.reduce((s, x) => s + x, 0) : 0;
  const generation = n.statistics.supply({ components: ["Generator"] }).values.reduce((s, x) => s + x, 0);
  console.log(`${JSON.stringify(losses).padEnd(33)} | ${n.objective.toFixed(1).padStart(13)} | ${loss.toFixed(2).padStart(12)} | ${generation.toFixed(1)}`);
}

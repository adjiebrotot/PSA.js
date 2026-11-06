// Capacity expansion of a single-node energy system with wind, solar, a
// battery and hydrogen storage (PyPSA example network "model-energy"),
// followed by the statistics module. Run: node examples/scripts/capacity_expansion.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const n = Network.from_csv_folder(new URL("../networks/model-energy/model-energy", import.meta.url).pathname);
n.set_snapshots(n.snapshots.slice(0, 8 * 14)); // two weeks of 3-hourly data
await n.optimize();

console.log("system cost:", n.objective);
console.log(n.statistics.optimal_capacity().toString());
console.log(n.statistics.capex().toString());
console.log(n.statistics.energy_balance({ groupby: ["carrier", "bus_carrier"] }).toString());
console.log(n.statistics().toString()); // the overview table

// Rolling-horizon dispatch: solve a long period in overlapping windows (here
// 4 snapshots, overlapping by 1), carrying storage levels and unit status
// from one window to the next. Run: node examples/scripts/rolling_horizon.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const path = new URL("../networks/storage-hvdc/storage-hvdc", import.meta.url).pathname;
const n = Network.from_csv_folder(path);
// size the system with perfect foresight, then fix the capacities: rolling
// horizons are for operation
await n.optimize();
n.optimize.fix_optimal_capacities();
await n.optimize();
const perfect = n.objective;
// the largest storage unit
const su = n.c.storage_units.static;
const big = su.index.at(su.col("p_nom").indexOf(Math.max(...su.col("p_nom"))));
const soc = (m) => Array.from(m.c.storage_units.dynamic.state_of_charge.col(big), (v) => v.toFixed(0));

const r = n.copy();
await r.optimize.optimize_with_rolling_horizon({ horizon: 4, overlap: 1 });
const opex = (m) => m.statistics.opex().values.reduce((s, x) => s + x, 0);
console.log("operating cost, perfect foresight:", opex(n).toFixed(1), "(objective", perfect.toFixed(1) + ")");
console.log("operating cost, rolling horizon:  ", opex(r).toFixed(1));
// perfect foresight has cyclic storage over the whole period, the windows
// only carry the level forward
console.log(`state of charge of ${big}, perfect foresight:`, soc(n).join(" "));
console.log(`state of charge of ${big}, rolling horizon:  `, soc(r).join(" "));

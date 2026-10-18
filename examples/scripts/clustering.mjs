// Spatial and temporal clustering: SciGrid-DE reduced by greedy modularity
// and by Ward hierarchical clustering of the bus coordinates, and a network
// resampled to 3-hourly and weekly resolution. Run: node examples/scripts/clustering.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const path = new URL("../networks/scigrid-de/scigrid-de", import.meta.url).pathname;
const n = Network.from_csv_folder(path);
const modularity = n.cluster.spatial.busmap_by_greedy_modularity(20);
console.log("greedy modularity clusters:", new Set(modularity.values).size);

const st = n.c.buses.static;
const { DataFrame } = await import("../../src/index.js");
const xy = new DataFrame({ index: st.index, columns: ["x", "y"], data: new Map([["x", st.col("x")], ["y", st.col("y")]]) });
const hac = n.cluster.spatial.busmap_by_hac(20, { feature: xy });
console.log("Ward clusters:", new Set(hac.values).size);

const me = Network.from_csv_folder(new URL("../networks/model-energy/model-energy", import.meta.url).pathname);
const daily = me.cluster.temporal.resample("D");
const weekly = me.cluster.temporal.resample("W");
console.log("snapshots:", me.snapshots.length, "-> daily", daily.snapshots.length, "-> weekly", weekly.snapshots.length);

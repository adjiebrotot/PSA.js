// Modelling to generate alternatives (MGA): after the cost-optimal solution,
// explore near-optimal designs within 5% of the optimal system cost (PyPSA's
// `n.optimize.optimize_mga`). Run: node examples/scripts/mga.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const path = new URL("../networks/ac-dc-meshed/ac-dc-meshed", import.meta.url).pathname;
const n = Network.from_csv_folder(path);
await n.optimize();
const optimal = n.objective;
const capacity = () => n.statistics.optimal_capacity({ components: ["Generator"], groupby: "carrier" }).toString();
console.log("cost-optimal system cost:", optimal);
console.log(capacity());

// minimise the wind capacity while staying within 5% of the optimal cost
const wind = Object.fromEntries(n.c.generators.static.index.values.filter((g) => g.endsWith("Wind")).map((g) => [g, 1]));
await n.optimize.optimize_mga({ slack: 0.05, weights: { Generator: { p_nom: wind } }, sense: "min" });
console.log("\nless wind (objective = wind capacity):", n.objective);
console.log(capacity());

// ... and maximise it
await n.optimize.optimize_mga({ slack: 0.05, weights: { Generator: { p_nom: wind } }, sense: "max" });
console.log("\nmore wind (objective = -wind capacity):", n.objective);
console.log(capacity());

// a direction in a two-dimensional space: wind against gas capacity
const gas = Object.fromEntries(n.c.generators.static.index.values.filter((g) => g.endsWith("Gas")).map((g) => [g, 1]));
const dimensions = { wind: { Generator: { p_nom: wind } }, gas: { Generator: { p_nom: gas } } };
await n.optimize.optimize_mga_in_direction({ direction: { wind: 1, gas: -1 }, dimensions, slack: 0.05 });
console.log("\nprojection after moving towards (wind +, gas -):", n.optimize.project_solved(dimensions).toString());

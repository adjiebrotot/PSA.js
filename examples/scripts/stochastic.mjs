// Two-stage stochastic optimisation: investments are shared, dispatch is
// decided per scenario; CVaR risk aversion and statistics per scenario.
// (PyPSA example "Stochastic optimisation".) Run: node examples/scripts/stochastic.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const n = Network.from_csv_folder(new URL("../networks/ac-dc-meshed/ac-dc-meshed", import.meta.url).pathname);
n.set_snapshots(n.snapshots.slice(0, 4));
n.set_scenarios({ low: 0.3, high: 0.7 });
n.c.generators.static.setAt(["high", "Manchester Gas"], "marginal_cost", 80); // expensive gas in "high"

await n.optimize();
console.log("expected cost:", n.objective);
console.log(n.statistics.optimal_capacity().toString()); // (component, scenario, carrier)
console.log(n.statistics.opex().toString());

// risk aversion: weight the expected shortfall of the worst 10 % of outcomes
n.set_risk_preference({ alpha: 0.9, omega: 0.5 });
await n.optimize();
console.log("risk-averse objective:", n.objective);

// statistic expressions carry a scenario dimension on stochastic networks
n.optimize.create_model();
const opex = n.optimize.expressions.opex();
console.log("opex expression dims:", opex.dims);

// Multi-period investment planning: capacities are built in investment periods
// 2020, 2030 and 2040 with build years and lifetimes, costs discounted per
// period (PyPSA's multi-investment example). Run: node examples/scripts/multi_investment.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const n = new Network();
n.set_snapshots(Array.from({ length: 6 }, (_, i) => i));
n.investment_periods = [2020, 2030, 2040];
// discounting at 2% per year, each period representing 10 years
const r = 0.02;
const years = [2020, 2030, 2040];
const weight = years.map((y) => Array.from({ length: 10 }, (_, t) => 1 / (1 + r) ** (y - 2020 + t)).reduce((a, b) => a + b, 0));
n.investment_period_weightings.set("years", Float64Array.from([10, 10, 10]));
n.investment_period_weightings.set("objective", Float64Array.from(weight));

n.add("Bus", "bus");
n.add("Carrier", ["coal", "gas", "wind"], { co2_emissions: [0.9, 0.4, 0] });
// snapshots are now (period, timestep) pairs: demand grows from period to period
const demand = [400, 450, 500, 600, 550, 420];
n.add("Load", "load", { bus: "bus", p_set: years.flatMap((_, i) => demand.map((d) => d * (1 + 0.1 * i))) });
for (const [i, by] of years.entries()) {
  n.add("Generator", `coal ${by}`, { bus: "bus", carrier: "coal", build_year: by, lifetime: 30, p_nom_extendable: true, capital_cost: 140, marginal_cost: 25 + 10 * i });
  n.add("Generator", `gas ${by}`, { bus: "bus", carrier: "gas", build_year: by, lifetime: 30, p_nom_extendable: true, capital_cost: 90, marginal_cost: 60 });
  n.add("Generator", `wind ${by}`, { bus: "bus", carrier: "wind", build_year: by, lifetime: 25, p_nom_extendable: true, capital_cost: 160 - 40 * i, p_max_pu: years.flatMap(() => [0.9, 0.6, 0.3, 0.5, 0.8, 0.2]) });
}
// a tightening CO2 budget per period
n.add("GlobalConstraint", "co2", { type: "primary_energy", carrier_attribute: "co2_emissions", sense: "<=", constant: 2e4 });

const [status] = await n.optimize({ multi_investment_periods: true });
console.log("status:", status, "objective:", n.objective.toFixed(1));
console.log(n.statistics.optimal_capacity({ components: ["Generator"], groupby: "carrier" }).toString());
const built = n.c.generators.static;
console.log("capacity built per period:");
built.index.values.forEach((g, i) => {
  const p = built.col("p_nom_opt")[i];
  if (p > 1e-3) console.log(`  ${g.padEnd(10)} ${p.toFixed(1)} MW`);
});

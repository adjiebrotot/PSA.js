// Custom constraints and objectives with the linopy-style expression API:
// a ramp limit (diff), a per-bus capacity cap (groupby), a capex budget from
// the statistic expressions, and a quadratic cost term in the objective.
// Run: node examples/scripts/custom_constraints.mjs
import { Network, Series, Index, logger } from "../../src/index.js";

logger.setLevel("error");

const n = Network.from_csv_folder(new URL("../networks/ac-dc-meshed/ac-dc-meshed", import.meta.url).pathname);
n.set_snapshots(n.snapshots.slice(0, 6));
const m = n.optimize.create_model();

// gas units ramp up by at most 300 MW per hour (from the second snapshot on;
// the first row of `diff` has no predecessor)
const p = m.variables.get("Generator-p");
const gas = p.sel({ name: ["Manchester Gas", "Norway Gas", "Frankfurt Gas"] });
m.add_constraints(gas.diff("snapshot").isel({ snapshot: [1, 2, 3, 4, 5] }).le(300), { name: "gas-ramp" });

// at most 6 GW of generation capacity per bus
const gens = n.c.generators.static;
const busOf = new Series(Array.from(gens.col("bus")), new Index(gens.index.values, "name"), "bus");
m.add_constraints(m.variables.get("Generator-p_nom").groupby(busOf).sum().le(6000), { name: "bus-capacity" });

// capex budget from the statistic expressions (n.optimize.expressions)
m.add_constraints(n.optimize.expressions.capex().sum().le(5e9), { name: "capex-budget" });

let [status] = await n.optimize.solve_model();
console.log(status, "objective:", n.objective);
console.log(n.statistics.optimal_capacity({ groupby: ["bus", "carrier"] }).toString());

// a quadratic cost on a small network: cost = 20 p + 0.05 p^2 for the gas unit
const q = new Network();
q.set_snapshots([0, 1]);
q.add("Bus", "b");
q.add("Generator", "gas", { bus: "b", p_nom: 500 });
q.add("Generator", "import", { bus: "b", p_nom: 500, marginal_cost: 40 });
q.add("Load", "d", { bus: "b", p_set: [300, 400] });
const qm = q.optimize.create_model();
const pg = qm.variables.get("Generator-p").sel({ name: ["gas"] });
qm.set_objective(pg.mul(20).add(pg.mul(pg).mul(0.05)).sum().add(qm.variables.get("Generator-p").sel({ name: ["import"] }).mul(40).sum()));
[status] = await q.optimize.solve_model();
console.log(status, "quadratic objective:", q.objective);
console.log(q.c.generators.dynamic.p.toString()); // gas runs until its marginal cost reaches 40

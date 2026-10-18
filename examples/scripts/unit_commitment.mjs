// Unit commitment with minimum up/down times, start-up costs and ramp limits
// (PyPSA example "Unit commitment"). Run: node examples/scripts/unit_commitment.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const n = new Network();
n.set_snapshots([0, 1, 2, 3, 4, 5]);
n.add("Bus", "bus");
n.add("Generator", "coal", { bus: "bus", committable: true, p_min_pu: 0.3, marginal_cost: 20, p_nom: 10000, min_up_time: 2, start_up_cost: 500, ramp_limit_up: 0.6 });
n.add("Generator", "gas", { bus: "bus", committable: true, p_min_pu: 0.1, marginal_cost: 70, p_nom: 1000, min_down_time: 2, shut_down_cost: 50 });
n.add("Generator", "peak", { bus: "bus", marginal_cost: 200, p_nom: 5000 });
n.add("Load", "load", { bus: "bus", p_set: [4000, 6000, 5000, 800, 3000, 7000] });

await n.optimize();
console.log("objective:", n.objective);
console.log(n.c.generators.dynamic.status.toString()); // on/off decisions
console.log(n.c.generators.dynamic.p.toString());

// the linearised relaxation of the same problem
await n.optimize({ linearized_unit_commitment: true });
console.log("linearised objective:", n.objective);

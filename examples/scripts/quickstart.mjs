// Quickstart: a three-bus network with two generators, optimised with HiGHS.
// (PyPSA user guide: "Quickstart".) Run: node examples/scripts/quickstart.mjs
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const n = new Network({ name: "quickstart" });
n.set_snapshots([0, 1, 2]);
n.add("Bus", ["north", "middle", "south"], { v_nom: 380 });
n.add("Carrier", ["gas", "wind"], { co2_emissions: [0.2, 0] });
n.add("Line", ["north-middle", "middle-south"], { bus0: ["north", "middle"], bus1: ["middle", "south"], x: 0.1, r: 0.01, s_nom: 400 });
n.add("Generator", "wind", { bus: "north", carrier: "wind", p_nom: 300, p_max_pu: [0.9, 0.4, 0.1], marginal_cost: 0 });
n.add("Generator", "gas", { bus: "south", carrier: "gas", p_nom: 500, marginal_cost: 60 });
n.add("Load", "city", { bus: "middle", p_set: [250, 300, 280] });

const [status, condition] = await n.optimize();
console.log(status, condition, "objective:", n.objective);
console.log(n.c.generators.dynamic.p.toString()); // dispatch per snapshot
console.log(n.c.lines.dynamic.p0.toString()); // line flows
console.log(n.c.buses.dynamic.marginal_price.toString()); // nodal prices

// Browser smoke test entry: build, optimise and inspect a network, write and
// read CSV, Excel, netCDF and HDF5 in memory. Results are reported on `window.__psa`.
import { Network, MemoryFolder, logger } from "../../src/index.js";

logger.setLevel("error");

async function run() {
  const out = {};
  const n = new Network({ name: "browser" });
  n.set_snapshots([0, 1, 2]);
  n.add("Bus", ["north", "south"]);
  n.add("Carrier", ["gas", "wind"]);
  n.add("Line", "ns", { bus0: "north", bus1: "south", x: 0.1, s_nom: 400 });
  n.add("Generator", "wind", { bus: "north", carrier: "wind", p_nom_extendable: true, capital_cost: 50, p_max_pu: [0.9, 0.4, 0.1] });
  n.add("Generator", "gas", { bus: "south", carrier: "gas", p_nom: 500, marginal_cost: 60 });
  n.add("Load", "city", { bus: "south", p_set: [250, 300, 280] });
  const [status, condition] = await n.optimize();
  out.status = `${status}/${condition}`;
  out.objective = n.objective;
  out.capacity = Array.from(n.statistics.optimal_capacity().values);
  const csv = n.export_to_csv_folder(new MemoryFolder()).toObject();
  out.csvFiles = Object.keys(csv).sort();
  const m = new Network().import_from_csv_folder(new MemoryFolder(csv));
  out.csvRoundTrip = m.c.generators.static.index.values;
  const xlsx = n.export_to_excel(null);
  out.xlsxBytes = xlsx.length;
  out.xlsxRoundTrip = Network.from_excel(xlsx).c.loads.dynamic.p_set.col("city").length;
  const nc = await n.export_to_netcdf(null);
  out.netcdfBytes = nc.length;
  out.netcdfRoundTrip = (await Network.from_netcdf(nc)).objective;
  const h5 = await n.export_to_hdf5(null);
  out.hdf5Bytes = h5.length;
  out.hdf5RoundTrip = (await Network.from_hdf5(h5)).objective;
  return out;
}

run().then(
  (r) => (window.__psa = { ok: true, ...r }),
  (e) => (window.__psa = { ok: false, error: String(e && e.stack ? e.stack : e) }),
);

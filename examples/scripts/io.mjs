// Import and export: CSV folders, netCDF (PyPSA's layout, needs h5wasm),
// Excel workbooks and PYPOWER cases. Run: node examples/scripts/io.mjs
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { Network, logger } from "../../src/index.js";

logger.setLevel("error");

const dir = mkdtempSync(path.join(os.tmpdir(), "psa-io-"));
try {
  const n = Network.from_csv_folder(new URL("../networks/ac-dc-meshed/ac-dc-meshed", import.meta.url).pathname);
  n.export_to_csv_folder(path.join(dir, "csv"));
  n.export_to_excel(path.join(dir, "network.xlsx"));
  await n.export_to_netcdf(path.join(dir, "network.nc"));
  const fromXlsx = Network.from_excel(path.join(dir, "network.xlsx"));
  const fromNc = await Network.from_netcdf(path.join(dir, "network.nc"));
  console.log("buses:", n.c.buses.static.index.length, fromXlsx.c.buses.static.index.length, fromNc.c.buses.static.index.length);

  // a PYPOWER case (here a tiny 3-bus system given inline)
  const ppc = {
    version: "2",
    baseMVA: 100,
    bus: [
      [1, 3, 0, 0, 0, 0, 1, 1, 0, 345, 1, 1.1, 0.9],
      [2, 1, 90, 30, 0, 0, 1, 1, 0, 345, 1, 1.1, 0.9],
      [3, 1, 100, 35, 0, 0, 1, 1, 0, 345, 1, 1.1, 0.9],
    ],
    gen: [[1, 0, 0, 300, -300, 1, 100, 1, 250, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    branch: [
      [1, 2, 0.01, 0.085, 0.176, 250, 250, 250, 0, 0, 1, -360, 360],
      [2, 3, 0.017, 0.092, 0.158, 250, 250, 250, 0, 0, 1, -360, 360],
      [1, 3, 0.039, 0.17, 0.358, 150, 150, 150, 0, 0, 1, -360, 360],
    ],
  };
  const p = new Network();
  p.import_from_pypower_ppc(ppc);
  p.pf();
  console.log("PYPOWER case: slack injection", p.c.generators.dynamic.p.toString());
} finally {
  rmSync(dir, { recursive: true, force: true });
}

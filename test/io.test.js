import { test } from "node:test";
import { Network } from "../src/index.js";
import { loadFixture, examplePath, assertNetworkMatches } from "./helpers.js";

for (const ex of ["ac-dc-meshed", "storage-hvdc", "model-energy", "scigrid-de"]) {
  test(`import ${ex} matches PyPSA`, () => {
    const n = Network.from_csv_folder(examplePath(ex));
    const fx = loadFixture(`io_${ex}`);
    assertNetworkMatches(n, fx.network, { rtol: 0, atol: 0 });
  });
}

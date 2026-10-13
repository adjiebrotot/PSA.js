// SPDX-License-Identifier: MIT
/** IO parity: CSV import/export and netCDF import/export against PyPSA. */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Network, MemoryFolder, logger } from "../src/index.js";
import { loadFixture, examplePath, assertNetworkMatches, ROOT } from "./helpers.js";

logger.setLevel("error");

const EXAMPLES = ["ac-dc-meshed", "storage-hvdc", "model-energy", "scigrid-de"];
const ncPath = (name) => path.join(ROOT, "test", "fixtures", "netcdf", `${name}.nc`);

function parseCsv(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
}

/** Compare CSV texts cell by cell (numbers within tolerance). */
function assertCsvMatches(actual, expected, where, rtol = 0) {
  if (actual === expected) return;
  const a = parseCsv(actual);
  const b = parseCsv(expected);
  assert.equal(a.length, b.length, `${where}: row count differs`);
  a.forEach((row, i) => {
    assert.equal(row.length, b[i].length, `${where}: column count differs in row ${i}`);
    row.forEach((cell, j) => {
      const other = b[i][j];
      if (cell === other) return;
      const x = Number(cell);
      const y = Number(other);
      if (cell !== "" && other !== "" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= rtol * Math.max(Math.abs(x), Math.abs(y))) return;
      assert.fail(`${where}: cell [${i}, ${j}] differs: PSA.js=${cell} PyPSA=${other}`);
    });
  });
}

function assertExportMatches(n, expected, where, rtol = 0) {
  const folder = n.export_to_csv_folder(new MemoryFolder());
  const files = folder.toObject();
  assert.deepEqual(Object.keys(files).sort(), Object.keys(expected).sort(), `${where}: exported file set differs`);
  for (const [name, text] of Object.entries(expected)) assertCsvMatches(files[name], text, `${where}/${name}`, rtol);
}

for (const ex of EXAMPLES) {
  test(`import ${ex} matches PyPSA`, () => {
    const n = Network.from_csv_folder(examplePath(ex));
    const fx = loadFixture(`io_${ex}`);
    assertNetworkMatches(n, fx.network, { rtol: 0, atol: 0 });
  });

  test(`export ${ex} to CSV matches PyPSA`, () => {
    const n = Network.from_csv_folder(examplePath(ex));
    assertExportMatches(n, loadFixture(`io_${ex}`).export, ex);
  });

  test(`import ${ex} from PyPSA netCDF`, async () => {
    const n = await Network.from_netcdf(ncPath(ex));
    assertNetworkMatches(n, loadFixture(`io_${ex}`).network, { rtol: 0, atol: 0 });
  });

  test(`netCDF round trip ${ex}`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "psajs-"));
    try {
      const n = Network.from_csv_folder(examplePath(ex));
      const fn = path.join(dir, `${ex}.nc`);
      await n.export_to_netcdf(fn);
      const m = await Network.from_netcdf(fn);
      assertNetworkMatches(m, loadFixture(`io_${ex}`).network, { rtol: 0, atol: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("multi-period network from netCDF and CSV export", async () => {
  const fx = loadFixture("io_multiperiod");
  const n = await Network.from_netcdf(ncPath("multiperiod"));
  // compare with PyPSA's own re-import of the file (columns only created in
  // memory, e.g. by calculate_dependent_values, are not stored in netCDF)
  assertNetworkMatches(n, fx.network_nc, { rtol: 0, atol: 0 });
  assertExportMatches(n, fx.export, "multiperiod");
});

test("solved network: netCDF import and CSV export", async () => {
  const fx = loadFixture("io_solved");
  const n = await Network.from_netcdf(ncPath("ac-dc-meshed-solved"));
  assertNetworkMatches(n, fx.network_nc, { rtol: 0, atol: 0 });
  assertExportMatches(n, fx.export, "solved");
  // solving in PSA.js gives the same exported results within solver tolerance
  const m = Network.from_csv_folder(examplePath("ac-dc-meshed"));
  await m.optimize({ include_objective_constant: true });
  assertExportMatches(m, fx.export, "solved-js", 1e-6);
});

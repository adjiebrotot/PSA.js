// SPDX-License-Identifier: MIT
/** IO parity: CSV import/export and netCDF import/export against PyPSA. */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Network, MemoryFolder, logger } from "../src/index.js";
import { loadFixture, examplePath, assertNetworkMatches, assertFrameClose, ROOT } from "./helpers.js";

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

function assertPiecewiseMatches(n, expected, where) {
  for (const c of n.components.values()) {
    for (const [attr, df] of Object.entries(c.piecewise)) {
      const exp = expected[c.list_name]?.[attr];
      if (!exp) {
        assert.ok(df.empty, `${where}: unexpected piecewise data ${c.list_name}.${attr}`);
        continue;
      }
      assertFrameClose(df, exp, { rtol: 0, atol: 0, path: `${where}/${c.list_name}.${attr}` });
    }
  }
  for (const [listName, attrs] of Object.entries(expected)) {
    for (const attr of Object.keys(attrs)) assert.ok(n.c.get(listName).has_piecewise(attr), `${where}: missing ${listName}.${attr}`);
  }
}

test("piecewise data: netCDF and CSV import/export", async () => {
  const fx = loadFixture("io_piecewise");
  const n = await Network.from_netcdf(ncPath("piecewise"));
  assertNetworkMatches(n, fx.network_nc, { rtol: 0, atol: 0 });
  assertPiecewiseMatches(n, fx.piecewise_nc, "netcdf");
  assertExportMatches(n, fx.export, "piecewise");
  const m = new Network();
  m.import_from_csv_folder(new MemoryFolder(fx.export));
  assertPiecewiseMatches(m, fx.piecewise, "csv");
  // PSA.js netCDF round trip, including ragged curves
  const dir = mkdtempSync(path.join(os.tmpdir(), "psajs-pw-"));
  try {
    m.add("Generator", "g4", { bus: "a", p_nom: 10, marginal_cost: new Map([[0, 0], [0.25, 1], [0.5, 2], [1, 8]]) });
    await m.export_to_netcdf(path.join(dir, "pw.nc"));
    const k = await Network.from_netcdf(path.join(dir, "pw.nc"));
    for (const [attr, df] of Object.entries(m.c.generators.piecewise)) {
      const got = k.c.generators.piecewise[attr];
      assert.deepEqual(got.columns.values, df.columns.values, `round trip ${attr} columns`);
      for (const t of df.columns.values) assert.deepEqual(Array.from(got.col(t)), Array.from(df.col(t)), `round trip ${attr} ${t}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

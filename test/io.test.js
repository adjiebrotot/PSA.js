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

/** A network dump without what an exporter skips: empty components and all-default time series. */
function withoutDefaultSeries(expected, n) {
  const out = structuredClone(expected);
  for (const [listName, comp] of Object.entries(out.components)) {
    if (comp.static.index.values.length === 0) {
      delete out.components[listName];
      continue;
    }
    const defaults = n.c.get(listName).defaults;
    for (const [attr, df] of Object.entries(comp.dynamic ?? {})) {
      const def = defaults.get(attr)?.default;
      if (def === undefined) continue;
      if (Object.values(df.data).every((col) => col.every((v) => v === def))) delete comp.dynamic[attr];
    }
  }
  return out;
}

/** The stochastic network of `gen_io.py`, built and solved with PSA.js. */
async function stochasticNetwork() {
  const n = Network.from_csv_folder(examplePath("ac-dc-meshed"));
  n.set_snapshots(n.snapshots.slice(0, 4));
  n.set_scenarios({ low: 0.3, high: 0.7 });
  n.c.generators.static.setAt(["high", "Manchester Gas"], "marginal_cost", 40);
  n.c.generators.dynamic.p_max_pu.set(["high", "Manchester Wind"], Float64Array.of(0.1, 0.2, 0.3, 0.4));
  n.c.loads.dynamic.p_set.set(["low", "London"], Float64Array.of(100, 200, 300, 400));
  await n.optimize({ include_objective_constant: false });
  return n;
}

test("stochastic network: netCDF import, export and round trip", async () => {
  const fx = loadFixture("io_stochastic");
  // PyPSA's export sorts the scenario and component coordinates of this
  // network (xarray aligns them to the sorted MultiIndex levels); importing
  // follows the file
  const n = await Network.from_netcdf(ncPath("stochastic"));
  assert.deepEqual(n.scenarios.values, ["high", "low"]);
  assert.deepEqual(Array.from(n.scenario_weightings.col("weight")), [0.7, 0.3]);
  assertNetworkMatches(n, fx.network_nc, { rtol: 0, atol: 0 });
  // solving in PSA.js gives PyPSA's network within solver tolerance; PSA.js
  // writes the network in its own order, so the round trip preserves it
  const m = await stochasticNetwork();
  assertNetworkMatches(m, fx.network, { rtol: 1e-6, atol: 1e-6 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "psajs-sc-"));
  try {
    await m.export_to_netcdf(path.join(dir, "stochastic.nc"));
    const k = await Network.from_netcdf(path.join(dir, "stochastic.nc"));
    // the series names are written sorted (as PyPSA does)
    assertNetworkMatches(k, withoutDefaultSeries(fx.network, k), { rtol: 1e-6, atol: 1e-6, columnOrder: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => m.export_to_csv_folder(new MemoryFolder()), /not supported in the CSV exporter/);
});

// Excel: PyPSA's workbooks import identically; PSA.js workbooks round-trip
const xlPath = (name) => path.join(ROOT, "test", "fixtures", "excel", `${name}.xlsx`);
const excelFx = loadFixture("io_excel");
for (const [name, fx] of Object.entries(excelFx).filter(([k]) => !k.startsWith("_"))) {
  test(`import ${name} from PyPSA Excel`, () => {
    const n = Network.from_excel(xlPath(name));
    assertNetworkMatches(n, fx.network, { rtol: 0, atol: 0 });
    assertPiecewiseMatches(n, fx.piecewise, `${name} excel`);
  });

  test(`Excel round trip ${name}`, () => {
    const n = Network.from_excel(xlPath(name));
    const m = Network.from_excel(n.export_to_excel(null));
    assertNetworkMatches(m, fx.network, { rtol: 0, atol: 0 });
    assertPiecewiseMatches(m, fx.piecewise, `${name} excel round trip`);
  });
}

test("Excel export keeps unrelated sheets and replaces stale ones", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "psa-xlsx-"));
  try {
    const fn = path.join(dir, "net.xlsx");
    const n = Network.from_csv_folder(examplePath("ac-dc-meshed"));
    n.export_to_excel(fn);
    const m = Network.from_csv_folder(examplePath("ac-dc-meshed"));
    m.remove("Link", m.c.links.static.index.values);
    m.export_to_excel(fn);
    const k = Network.from_excel(fn);
    assert.equal(k.c.links.static.index.length, 0);
    assert.equal(k.c.lines.static.index.length, n.c.lines.static.index.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("float32 netCDF: PyPSA's file and a PSA.js export", async () => {
  const fx = loadFixture("io_float32");
  const n = await Network.from_netcdf(ncPath("ac-dc-meshed-f32"));
  assertNetworkMatches(n, fx.network_nc, { rtol: 0, atol: 0 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "psa-f32-"));
  try {
    const m = await Network.from_netcdf(ncPath("ac-dc-meshed-solved"));
    await m.export_to_netcdf(path.join(dir, "f32.nc"), { float32: true, compression: { zlib: false } });
    const k = await Network.from_netcdf(path.join(dir, "f32.nc"));
    assertNetworkMatches(k, fx.network_nc, { rtol: 0, atol: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shapes: WKT geometries through CSV, netCDF and Excel", async () => {
  const fx = loadFixture("io_shapes");
  const shapes = path.join(ROOT, "test", "networks", "shapes");
  const n = Network.from_csv_folder(shapes);
  assertNetworkMatches(n, fx.network, { rtol: 0, atol: 0 });
  assertExportMatches(n, fx.export, "shapes");
  const fromNc = await Network.from_netcdf(ncPath("shapes"));
  assertNetworkMatches(fromNc, fx.network_nc, { rtol: 0, atol: 0 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "psa-shapes-"));
  try {
    await n.export_to_netcdf(path.join(dir, "shapes.nc"));
    assertNetworkMatches(await Network.from_netcdf(path.join(dir, "shapes.nc")), fx.network_nc, { rtol: 0, atol: 0 });
    assertNetworkMatches(Network.from_excel(n.export_to_excel(null)), fx.network_nc, { rtol: 0, atol: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pure-JS inflate matches zlib on PyPSA's workbook entries", async () => {
  const { inflateRaw } = await import("../src/core/zip.js");
  const zlib = await import("node:zlib");
  const { readFileSync } = await import("node:fs");
  const bytes = new Uint8Array(readFileSync(xlPath("scigrid-de")));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let checked = 0;
  for (let p = 0; p + 30 < bytes.length; p++) {
    if (view.getUint32(p, true) !== 0x04034b50 || view.getUint16(p + 8, true) !== 8) continue;
    const csize = view.getUint32(p + 18, true);
    const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
    const data = bytes.subarray(start, start + csize);
    assert.deepEqual(Buffer.from(inflateRaw(data)), zlib.inflateRawSync(data));
    checked++;
  }
  assert.ok(checked > 5);
});

test("netCDF from and to bytes", async () => {
  const { readFileSync } = await import("node:fs");
  const fx = loadFixture("io_solved");
  const n = await Network.from_netcdf(new Uint8Array(readFileSync(ncPath("ac-dc-meshed-solved"))));
  assertNetworkMatches(n, fx.network_nc, { rtol: 0, atol: 0 });
  const bytes = await n.export_to_netcdf(null);
  assert.ok(bytes instanceof Uint8Array && bytes.length > 1000);
  assertNetworkMatches(await Network.from_netcdf(bytes), fx.network_nc, { rtol: 0, atol: 0 });
});

// HDF5 (pandas HDFStore layout): PyPSA's stores import identically; PSA.js
// stores round-trip (and import in PyPSA: scripts/parity/check_js_hdf5.py)
const h5Path = (name) => path.join(ROOT, "test", "fixtures", "hdf5", `${name}.h5`);
const hdf5Fx = loadFixture("io_hdf5");
for (const [name, fx] of Object.entries(hdf5Fx).filter(([k]) => !k.startsWith("_"))) {
  test(`import ${name} from PyPSA HDF5`, async () => {
    const n = await Network.from_hdf5(h5Path(name));
    assertNetworkMatches(n, fx.network, { rtol: 0, atol: 0 });
    assertPiecewiseMatches(n, fx.piecewise, `${name} hdf5`);
    assert.deepEqual(n.meta, fx.meta);
  });

  test(`HDF5 round trip ${name}`, async () => {
    const n = await Network.from_hdf5(h5Path(name));
    const m = await Network.from_hdf5(await n.export_to_hdf5(null));
    assertNetworkMatches(m, fx.network, { rtol: 0, atol: 0 });
    assertPiecewiseMatches(m, fx.piecewise, `${name} hdf5 round trip`);
    assert.deepEqual(m.meta, fx.meta);
  });
}

test("HDF5 export of a stochastic network raises", async () => {
  const n = await Network.from_netcdf(ncPath("stochastic"));
  await assert.rejects(() => n.export_to_hdf5(null), /NotImplementedError: Stochastic networks are not supported in the HDF5 exporter/);
});

test("netCDF and HDF5 from URLs (local HTTP server)", async () => {
  const http = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const { ioOptions } = await import("../src/index.js");
  const server = http.createServer((req, res) => {
    const file = req.url === "/solved.nc" ? ncPath("ac-dc-meshed-solved") : req.url === "/meta.h5" ? h5Path("ac-dc-meshed-meta") : null;
    if (!file) {
      res.writeHead(404, "Not Found").end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assertNetworkMatches(await Network.from_netcdf(`${base}/solved.nc`), loadFixture("io_solved").network_nc, { rtol: 0, atol: 0 });
    const m = await Network.from_hdf5(`${base}/meta.h5`);
    assertNetworkMatches(m, hdf5Fx["ac-dc-meshed-meta"].network, { rtol: 0, atol: 0 });
    assert.deepEqual(m.meta, hdf5Fx["ac-dc-meshed-meta"].meta);
    await assert.rejects(() => Network.from_hdf5(`${base}/missing.h5`), /ValueError: Failed to retrieve network data from .*missing\.h5: HTTP Error 404/);
    await assert.rejects(() => Network.from_netcdf("ftp://example.com/x.nc"), /ValueError: Invalid URL/);
    assert.throws(() => Network.from_excel(`${base}/x.xlsx`), /ValueError: Excel workbooks at URLs/);
    assert.throws(() => Network.from_csv_folder(`${base}/folder`), /ValueError: CSV folders cannot be read from URLs/);
    ioOptions.allow_network_requests = false;
    await assert.rejects(() => Network.from_netcdf(`${base}/solved.nc`), /ValueError: Network requests are disabled/);
  } finally {
    ioOptions.allow_network_requests = true;
    server.close();
  }
});

test("metadata JSON like Python's json module (NaN, Infinity, float repr)", async () => {
  const { pyJsonLoads, pyJsonDumps } = await import("../src/core/pyjson.js");
  // json.dumps({"a": float("nan"), "b": [float("inf"), -float("inf"), 0.0, 1, 1e-05, 1e16, 2.5], "c": "é\"Infinity"})
  const text = '{"a": NaN, "b": [Infinity, -Infinity, 0.0, 1, 1e-05, 1e+16, 2.5], "c": "\\u00e9\\"Infinity"}';
  const v = pyJsonLoads(text);
  assert.ok(Number.isNaN(v.a));
  assert.deepEqual(v.b, [Infinity, -Infinity, 0, 1, 1e-5, 1e16, 2.5]);
  assert.equal(v.c, 'é"Infinity');
  assert.equal(pyJsonDumps(v), text);
  const n = new Network();
  n.meta = v;
  const folder = new MemoryFolder();
  n.export_to_csv_folder(folder);
  assert.equal(folder.read("meta.json"), text);
  const m = Network.from_csv_folder(folder);
  assert.equal(pyJsonDumps(m.copy().meta), text);
});

test("examples: download, cache, 404 fallback and disabled network requests", { skip: process.platform !== "linux" && "cache location test written for Linux" }, async () => {
  const http = await import("node:http");
  const { readFileSync, existsSync } = await import("node:fs");
  const { examples, options, PYPSA_VERSION } = await import("../src/index.js");
  const served = [];
  const server = http.createServer((req, res) => {
    served.push(req.url);
    const file = req.url === `/v${PYPSA_VERSION}/ac_dc_meshed.nc` ? ncPath("ac-dc-meshed") : req.url === "/latest/storage_hvdc.nc" ? ncPath("storage-hvdc") : null;
    if (!file) {
      res.writeHead(404, "Not Found").end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(path.join(os.tmpdir(), "psajs-cache-"));
  const saved = [process.env.XDG_CACHE_HOME, examples._EXAMPLES_BASE_URL];
  process.env.XDG_CACHE_HOME = dir;
  examples._EXAMPLES_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const expected = await Network.from_netcdf(ncPath("ac-dc-meshed"));
    const n = await examples.ac_dc_meshed();
    assert.equal(n.name, expected.name);
    assert.deepEqual(n.c.buses.static.index.values, expected.c.buses.static.index.values);
    const cached = path.join(dir, "psa.js", "examples", `v${PYPSA_VERSION}`, "ac_dc_meshed.nc");
    assert.ok(existsSync(cached));
    // cached files load without network requests
    options.general.allow_network_requests = false;
    served.length = 0;
    assert.equal((await examples.ac_dc_meshed()).name, expected.name);
    assert.deepEqual(served, []);
    await assert.rejects(() => examples.storage_hvdc(), /ValueError: Network requests are disabled\. .*storage_hvdc\.nc/);
    options.general.allow_network_requests = true;
    // 404 for the version falls back to "latest"
    const s = await examples.storage_hvdc();
    assert.deepEqual(served, [`/v${PYPSA_VERSION}/storage_hvdc.nc`, "/latest/storage_hvdc.nc"]);
    assert.equal(s.name, (await Network.from_netcdf(ncPath("storage-hvdc"))).name);
    await assert.rejects(() => examples.scigrid_de(), /HTTP Error 404/);
    examples.clear_cache();
    assert.ok(!existsSync(cached));
  } finally {
    options.general.allow_network_requests = true;
    if (saved[0] === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved[0];
    examples._EXAMPLES_BASE_URL = saved[1];
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UTM zone WKTs equal pyproj's for all WGS 84 and ETRS89 zones", async () => {
  const { gunzipSync } = await import("node:zlib");
  const { readFileSync } = await import("node:fs");
  const { wktOf } = await import("../src/core/crs.js");
  const fx = JSON.parse(gunzipSync(readFileSync(path.join(ROOT, "test", "fixtures", "crs_utm_wkt.json.gz"))).toString());
  assert.equal(Object.keys(fx.wkt).length, 131);
  for (const [code, wkt] of Object.entries(fx.wkt)) assert.equal(wktOf(Number(code)), wkt, `EPSG:${code}`);
});

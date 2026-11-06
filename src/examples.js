// SPDX-License-Identifier: MIT
/**
 * Example networks (mirrors `pypsa.examples`): PyPSA's published netCDF files,
 * downloaded from data.pypsa.org for the reference PyPSA version and cached
 * on disk under Node.js (`<user cache>/psa.js/examples/v<version>/`).
 * The loaders are async: `const n = await examples.ac_dc_meshed()`.
 */

import { Network } from "./network/network.js";
import { PYPSA_VERSION } from "./components/types.js";
import { get_option } from "./options.js";
import { logger } from "./logger.js";
import "./network/netcdf.js";

function nodeModules() {
  const getBuiltin = globalThis.process?.getBuiltinModule;
  return getBuiltin ? { fs: getBuiltin("node:fs"), path: getBuiltin("node:path"), os: getBuiltin("node:os") } : null;
}

/** The per-user cache directory of PSA.js (like platformdirs' `user_cache_dir`), or null outside Node.js. */
function userCacheDir() {
  const m = nodeModules();
  if (!m) return null;
  const env = globalThis.process.env;
  if (globalThis.process.platform === "win32") return m.path.join(env.LOCALAPPDATA ?? m.path.join(m.os.homedir(), "AppData", "Local"), "psa.js", "Cache");
  if (globalThis.process.platform === "darwin") return m.path.join(m.os.homedir(), "Library", "Caches", "psa.js");
  return m.path.join(env.XDG_CACHE_HOME || m.path.join(m.os.homedir(), ".cache"), "psa.js");
}

function cacheRoot() {
  const dir = userCacheDir();
  return dir === null ? null : nodeModules().path.join(dir, "examples");
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`HTTP Error ${res.status}: ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function loadExample(name) {
  const base = examples._EXAMPLES_BASE_URL;
  const url = `${base}/v${PYPSA_VERSION}/${name}.nc`;
  const fallbackUrl = `${base}/latest/${name}.nc`;
  const root = cacheRoot();
  const m = nodeModules();
  const cache = root === null ? null : m.path.join(root, `v${PYPSA_VERSION}`, `${name}.nc`);
  if (cache !== null && m.fs.existsSync(cache)) return Network.from_netcdf(cache);
  if (!get_option("general.allow_network_requests")) {
    const where = cache === null ? "" : ` or manually place the example file at ${cache}`;
    throw new Error(`ValueError: Network requests are disabled. Enable \`options.general.allow_network_requests\`${where}.`);
  }
  logger.info(`Downloading ${url}${cache === null ? "" : ` to ${cache}`}`);
  let bytes;
  try {
    bytes = await download(url);
  } catch (e) {
    if (e.status !== 404) throw e;
    logger.warning(`404 at ${url}; using ${fallbackUrl}`);
    bytes = await download(fallbackUrl);
  }
  if (cache === null) return Network.from_netcdf(bytes);
  m.fs.mkdirSync(m.path.dirname(cache), { recursive: true });
  m.fs.writeFileSync(cache, bytes);
  return Network.from_netcdf(cache);
}

/** `pypsa.examples`: async loaders of PyPSA's example networks. */
export const examples = {
  /** Base URL of the example files (`pypsa.examples._EXAMPLES_BASE_URL`). */
  _EXAMPLES_BASE_URL: "https://data.pypsa.org/networks/examples",
  /** Meshed AC-DC example network (`examples.ac_dc_meshed()`). */
  ac_dc_meshed: () => loadExample("ac_dc_meshed"),
  /** Storage and HVDC example network. */
  storage_hvdc: () => loadExample("storage_hvdc"),
  /** SciGrid-DE: the German transmission grid (585 buses, 24 snapshots). */
  scigrid_de: () => loadExample("scigrid_de"),
  /** model.energy: single-node capacity expansion for a year at 3-hourly resolution. */
  model_energy: () => loadExample("model_energy"),
  /** Stochastic network with scenario-dependent generator data. */
  stochastic_network: () => loadExample("stochastic_network"),
  /** Carbon management sector-coupled network (PyPSA-Eur, hybrid scenario). */
  carbon_management: () => loadExample("carbon_management"),
  /** Delete the local cache of example networks (Node.js). */
  clear_cache() {
    const root = cacheRoot();
    if (root !== null) nodeModules().fs.rmSync(root, { recursive: true, force: true });
  },
};

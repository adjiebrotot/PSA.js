// Browser smoke test: bundle test/browser/entry.js with esbuild, serve it and
// run it in headless Chromium (playwright-core). Run: npm run test:browser
// (set CHROMIUM_PATH if Chromium is not at /opt/pw-browsers/chromium).
import { build } from "esbuild";
import { chromium } from "playwright-core";
import http from "node:http";
import path from "node:path";
import { mkdtempSync, readFileSync, copyFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "psa-browser-"));

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = "/opt/pw-browsers";
  const linked = path.join(base, "chromium");
  if (existsSync(linked) && !existsSync(path.join(linked, "chrome-linux"))) return linked;
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium-")) : [];
  for (const d of dirs) {
    const p = path.join(base, d, "chrome-linux", "chrome");
    if (existsSync(p)) return p;
  }
  return undefined; // playwright's default
}

try {
  await build({
    entryPoints: [path.join(ROOT, "test", "browser", "entry.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: path.join(dir, "bundle.js"),
    // Node-only code paths behind runtime checks (highs-js' Node loader, the
    // h5wasm Node build used for netCDF files)
    external: ["node:*", "module", "h5wasm/node"],
    logLevel: "warning",
  });
  // highs-js loads highs.wasm next to its module (here: the bundle)
  copyFileSync(path.join(ROOT, "node_modules", "highs", "build", "highs.wasm"), path.join(dir, "highs.wasm"));
  writeFileSync(path.join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><script type="module" src="bundle.js"></script>');
  const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/$/, "/index.html"));
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("page error:", e));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__psa !== undefined, null, { timeout: 120000 });
    const res = await page.evaluate(() => window.__psa);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok || !res.status.startsWith("ok")) process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

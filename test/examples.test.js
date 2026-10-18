// SPDX-License-Identifier: MIT
/** The example scripts in examples/scripts run without errors. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "./helpers.js";

const dir = path.join(ROOT, "examples", "scripts");
const only = process.env.SCENARIO ? new Set(process.env.SCENARIO.split(",")) : null;

for (const fn of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
  if (only && !only.has(`example_${fn.slice(0, -4)}`)) continue;
  test(`example ${fn}`, { timeout: 600000 }, () => {
    const out = execFileSync(process.execPath, [path.join(dir, fn)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.ok(out.length > 0, "example printed nothing");
  });
}

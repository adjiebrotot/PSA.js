// SPDX-License-Identifier: MIT
/** Parity tests: run every scenario in test/scenarios with PSA.js and compare to PyPSA fixtures. */

import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, loadFixture } from "./helpers.js";
import { runScenario, assertRecordMatches } from "./scenario_runner.js";
import { logger } from "../src/index.js";

logger.setLevel(process.env.PSA_LOG_LEVEL ?? "error");

const dir = path.join(ROOT, "test", "scenarios");

/** Whether an executable is on the PATH. */
function onPath(exe) {
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => d && existsSync(path.join(d, exe)));
}
const only = process.env.SCENARIO ? new Set(process.env.SCENARIO.split(",")) : null;

for (const fn of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const name = fn.slice(0, -5);
  if (only && !only.has(name)) continue;
  const scenario = JSON.parse(readFileSync(path.join(dir, fn), "utf8"));
  // scenarios that run solver executables (CBC, GLPK) are skipped without them
  const missing = (scenario.requires ?? []).filter((exe) => !onPath(exe));
  const skip = missing.length ? `requires ${missing.join(", ")}` : false;
  test(`scenario ${name}`, { timeout: scenario.timeout_ms ?? 600000, skip }, async () => {
    const fixture = loadFixture(`scenario_${name}`);
    const tol = scenario.tolerance ?? { rtol: 1e-9, atol: 1e-9 };
    await runScenario(scenario, (key, value) => {
      const expected = fixture.records[key];
      if (!expected) throw new Error(`fixture has no record ${key}`);
      const t = {
        ...tol,
        checkIndexNames: scenario.check_index_names ?? false,
        ...(scenario.record_tolerance?.[key] ?? {}),
        ...(scenario.record_options?.[key] ?? {}),
        path_tolerance: scenario.path_tolerance ?? {},
      };
      assertRecordMatches(value, expected, { ...t, path: key });
    });
  });
}

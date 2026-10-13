// SPDX-License-Identifier: MIT
/** Parity tests: run every scenario in test/scenarios with PSA.js and compare to PyPSA fixtures. */

import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, loadFixture } from "./helpers.js";
import { runScenario, assertRecordMatches } from "./scenario_runner.js";

const dir = path.join(ROOT, "test", "scenarios");
const only = process.env.SCENARIO ? new Set(process.env.SCENARIO.split(",")) : null;

for (const fn of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const name = fn.slice(0, -5);
  if (only && !only.has(name)) continue;
  const scenario = JSON.parse(readFileSync(path.join(dir, fn), "utf8"));
  test(`scenario ${name}`, { timeout: scenario.timeout_ms ?? 600000 }, async () => {
    const fixture = loadFixture(`scenario_${name}`);
    const tol = scenario.tolerance ?? { rtol: 1e-9, atol: 1e-9 };
    await runScenario(scenario, (key, value) => {
      const expected = fixture.records[key];
      if (!expected) throw new Error(`fixture has no record ${key}`);
      const t = { ...tol, ...(scenario.record_tolerance?.[key] ?? {}) };
      assertRecordMatches(value, expected, { ...t, path: key });
    });
  });
}

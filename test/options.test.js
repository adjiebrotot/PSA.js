// SPDX-License-Identifier: MIT
/** Package options (`pypsa.options`): access, contexts and their effect. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Network, options, get_option, set_option, option_context, statisticsOptions, ioOptions, consistencyOptions, logger } from "../src/index.js";
import { examplePath } from "./helpers.js";

logger.setLevel("error");

test("options: nested access, get/set, reset and describe", () => {
  try {
    assert.equal(options.params.statistics.round, 5);
    options.params.statistics.round = 3;
    assert.equal(get_option("params.statistics.round"), 3);
    assert.equal(statisticsOptions.round, 3);
    set_option("general.allow_network_requests", false);
    assert.equal(ioOptions.allow_network_requests, false);
    consistencyOptions.numerical_tolerance = 0;
    assert.equal(options.params.consistency.numerical_tolerance, 0);
    assert.throws(() => get_option("params.nope"), /InvalidOptionError/);
    assert.match(options.describe(), /params\.optimize\.solver_name:\n {4}Default: "highs"/);
  } finally {
    options.reset_all();
  }
  assert.equal(options.params.statistics.round, 5);
  assert.equal(ioOptions.allow_network_requests, true);
});

test("option_context restores values (also for async functions)", async () => {
  const r = option_context("params.statistics.round", 1, "params.add.return_names", true, () => get_option("params.statistics.round"));
  assert.equal(r, 1);
  assert.equal(get_option("params.statistics.round"), 5);
  await option_context({ "params.statistics.drop_zero": false }, async () => {
    await null;
    assert.equal(statisticsOptions.drop_zero, false);
  });
  assert.equal(statisticsOptions.drop_zero, true);
  assert.throws(() => option_context("params.statistics.round", 2, () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(get_option("params.statistics.round"), 5);
});

test("options change the defaults of add and statistics", async () => {
  const n = Network.from_csv_folder(examplePath("ac-dc-meshed"));
  assert.equal(n.add("Bus", "x"), null);
  const names = option_context("params.add.return_names", true, () => n.add("Bus", ["y", "z"]));
  assert.deepEqual(Array.from(names.values ?? names), ["y", "z"]);
  n.set_snapshots(n.snapshots.slice(0, 2));
  await n.optimize({ include_objective_constant: false });
  const oneDecimal = (v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
  const coarse = option_context("params.statistics.round", 1, () => n.statistics.capex());
  const fine = n.statistics.capex();
  assert.ok(Array.from(coarse.values).every(oneDecimal));
  assert.ok(!Array.from(fine.values).every(oneDecimal));
});

test("reset_option and PYPSA_* environment variables", async () => {
  const { reset_option } = await import("../src/index.js");
  set_option("general.allow_network_requests", false);
  options.params.statistics.round = 2;
  reset_option("general.allow_network_requests");
  assert.equal(options.general.allow_network_requests, true);
  assert.equal(options.params.statistics.round, 2);
  options.reset_option("params.statistics.round");
  assert.equal(options.params.statistics.round, 5);
  assert.throws(() => reset_option("params.statistics"), /InvalidOptionError/);
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `import { options } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)}; console.log(JSON.stringify([options.params.statistics.round, options.general.allow_network_requests, options.params.optimize.solver_options, options.params.optimize.solver_name]));`],
    { env: { ...process.env, PYPSA_PARAMS__STATISTICS__ROUND: "3", PYPSA_GENERAL__ALLOW_NETWORK_REQUESTS: "False", PYPSA_PARAMS__OPTIMIZE__SOLVER_OPTIONS: "{'presolve': 'off', 'parallel': True}", PYPSA_PARAMS__OPTIMIZE__SOLVER_NAME: "highs" }, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(out), [3, false, { presolve: "off", parallel: true }, "highs"]);
});

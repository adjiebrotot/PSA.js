// SPDX-License-Identifier: MIT
/** docs/API.md matches the current sources (regenerate with `npm run docs`). */

import { test } from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "./helpers.js";

test("docs/API.md is up to date", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "gen_api_docs.mjs"), "--check"], { stdio: ["ignore", "pipe", "pipe"] });
});

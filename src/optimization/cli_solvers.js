// SPDX-License-Identifier: MIT
/**
 * Command-line solvers (mirrors linopy's `CBC` and `GLPK` classes, Node.js
 * only): the model is written as an LP file (identical to linopy's), the
 * executable (`cbc`, `glpsol`) solves it and its solution file is parsed the
 * way linopy parses it, so results equal PyPSA's with the same solver,
 * including the precision the solvers print (CBC 8, GLPK 6 significant
 * digits).
 */

import { logger } from "../logger.js";

/** Solvers that run an executable on the LP file. */
export const CLI_SOLVERS = { cbc: "cbc", glpk: "glpsol" };

function nodeModules() {
  const getBuiltin = globalThis.process?.getBuiltinModule;
  if (!getBuiltin) return null;
  return { fs: getBuiltin("node:fs"), path: getBuiltin("node:path"), os: getBuiltin("node:os"), cp: getBuiltin("node:child_process") };
}

/** Python's `str()` of an option value as linopy formats it on the command line. */
function pyStr(v) {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** Run `command` (split on spaces like linopy) and return its stdout. */
function run(solverName, command) {
  const { cp } = nodeModules();
  const [exe, ...args] = command.split(" ");
  return new Promise((resolve, reject) => {
    const p = cp.spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    p.on("error", (e) => reject(e.code === "ENOENT" ? new Error(`AssertionError: Solver ${solverName} not installed`) : e));
    p.on("close", () => resolve(out));
  });
}

/** Map solver names (`x12`, `c3`) to labels: values for `x…` and `c…` names. */
function byKind(names, values, prefix) {
  const out = new Map();
  names.forEach((nm, i) => {
    if (nm[0] === prefix) out.set(Number(nm.slice(1)), values[i]);
  });
  return out;
}

const TERMINATION_CONDITIONS = new Set([
  "unknown", "optimal", "time_limit", "iteration_limit", "terminated_by_limit", "suboptimal", "imprecise",
  "unbounded", "infeasible", "infeasible_or_unbounded", "other", "internal_solver_error", "error",
  "user_interrupt", "resource_interrupt", "licensing_problems",
]);
const OK_CONDITIONS = new Set(["optimal", "iteration_limit", "time_limit", "terminated_by_limit", "suboptimal", "imprecise"]);
const WARNING_CONDITIONS = new Set(["unbounded", "infeasible", "infeasible_or_unbounded", "other"]);

/** linopy's `Status.from_termination_condition`: [status, termination_condition]. */
function statusOf(condition) {
  const tc = TERMINATION_CONDITIONS.has(condition) ? condition : "unknown";
  if (OK_CONDITIONS.has(tc)) return ["ok", tc];
  if (WARNING_CONDITIONS.has(tc)) return ["warning", tc];
  if (tc === "internal_solver_error" || tc === "error") return ["error", tc];
  if (tc === "user_interrupt" || tc === "resource_interrupt" || tc === "licensing_problems") return ["aborted", tc];
  return ["unknown", tc];
}

/**
 * linopy's `safe_get_solution`: parse when the status is ok, try when it is
 * unknown (and call it ok on success), else no solution.
 */
function safeGetSolution(state, parse) {
  if (state.status === "ok") return parse();
  if (state.status === "unknown") {
    try {
      logger.warning("Solution status unknown. Trying to parse solution.");
      const sol = parse();
      state.status = "ok";
      logger.warning("Solution parsed successfully.");
      return sol;
    } catch (e) {
      logger.error(`Failed to parse solution: ${e.message}`);
    }
  }
  return { primal: null, dual: null, objective: NaN };
}

/** `cbc -printingOptions all -import problem.lp [-key value ...] -solve -solu solution.sol` */
async function solveCbc(dir, problemFn, options) {
  const { fs, path } = nodeModules();
  const solutionFn = path.join(dir, "solution.sol");
  // linopy creates the (empty) solution file before running the solver
  fs.writeFileSync(solutionFn, "");
  let command = `cbc -printingOptions all -import ${problemFn} `;
  const opts = Object.entries(options);
  if (opts.length) command += `${opts.map(([k, v]) => `-${k} ${pyStr(v)}`).join(" ")} `;
  command += `-solve -solu ${solutionFn} `;
  const output = await run("cbc", command.trim());
  logger.info(output);
  const text = fs.readFileSync(solutionFn, "utf8");
  const firstLine = text.slice(0, text.indexOf("\n") + 1);
  let condition = "unknown";
  let status = "warning";
  if (firstLine.startsWith("Optimal ")) [status, condition] = statusOf("optimal");
  else if (firstLine.includes("Infeasible")) [status, condition] = statusOf("infeasible");
  const state = { status, condition };
  const sol = safeGetSolution(state, () => {
    const m = /^Optimal.* - objective value (-?\d+\.?\d*)$/.exec(firstLine.replace(/\n$/, ""));
    const objective = m ? parseFloat(m[1]) : NaN;
    // pandas.read_csv(sep=r"\s+", skiprows=[0], usecols=[1, 2, 3]) after removing "**" markers
    const names = [];
    const values = [];
    const duals = [];
    for (const line of text.replace(/\*\*\s+/g, "").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4) continue;
      names.push(f[1]);
      values.push(Number(f[2]));
      duals.push(Number(f[3]));
    }
    return { primal: byKind(names, values, "x"), dual: byKind(names, duals, "c"), objective };
  });
  return { status: state.status, termination_condition: state.condition, ...sol };
}

/**
 * pandas `read_fwf` with inferred column specs: columns are the runs of
 * positions that are not blank in any of the first 100 lines; returns the
 * header names and the rows (stripped strings, "" for blanks).
 */
function readFwf(lines) {
  const sample = lines.slice(0, 100);
  const width = Math.max(0, ...sample.map((l) => l.length));
  const mask = new Uint8Array(width + 1);
  for (const l of sample) for (let i = 0; i < l.length; i++) if (l[i] !== " " && l[i] !== "\t") mask[i] = 1;
  const specs = [];
  for (let i = 0; i < width; i++) {
    if (mask[i] && (i === 0 || !mask[i - 1])) specs.push([i, i]);
    if (mask[i]) specs[specs.length - 1][1] = i + 1;
  }
  const split = (l) => specs.map(([a, b]) => l.slice(a, b).trim());
  return { header: split(lines[0] ?? ""), rows: lines.slice(1).map(split) };
}

/** linopy's GLPK objective parsing: the first number after the last "=". */
function parseGlpkObjective(text) {
  const tail = text.slice(text.lastIndexOf("=") + 1);
  const m = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(tail);
  if (!m) throw new Error(`ValueError: Could not parse objective value: '${text}'`);
  return parseFloat(m[0]);
}

const GLPK_CONDITIONS = { "integer optimal": "optimal", "integer undefined": "infeasible_or_unbounded", undefined: "infeasible_or_unbounded" };

/** `glpsol --lp problem.lp --output solution.sol [--key value ...]` */
async function solveGlpk(dir, problemFn, options) {
  const { fs, path } = nodeModules();
  const solutionFn = path.join(dir, "solution.sol");
  fs.writeFileSync(solutionFn, "");
  let command = `glpsol --lp ${problemFn} --output ${solutionFn} `;
  const opts = Object.entries(options);
  if (opts.length) command += `${opts.map(([k, v]) => `--${k} ${pyStr(v)}`).join(" ")} `;
  const output = await run("glpk", command.trim());
  logger.info(output);
  if (!fs.existsSync(solutionFn)) return { status: "warning", termination_condition: "unknown", primal: null, dual: null, objective: NaN };
  const lines = fs.readFileSync(solutionFn, "utf8").split("\n");
  let pos = 0;
  // the blocks of the report are separated by blank lines; linopy drops the
  // last two characters of each block (its final newline and one more)
  const block = () => {
    const out = [];
    while (pos < lines.length && lines[pos] !== "") out.push(`${lines[pos++]}\n`);
    pos++;
    return out.join("").slice(0, -2).split("\n");
  };
  const infoLines = block();
  // glpsol leaves the file empty when it fails (e.g. on an unknown option such
  // as the `--log_to_console` PyPSA passes on), where linopy's read_csv raises
  if (!infoLines.some((l) => l.length)) throw new Error("EmptyDataError: No columns to parse from file");
  const info = new Map();
  for (const l of infoLines) {
    const i = l.indexOf(":");
    if (i >= 0) info.set(l.slice(0, i).trim(), l.slice(i + 1).split(":")[0]);
  }
  const condition = (info.get("Status") ?? "").toLowerCase().trim();
  const objective = parseGlpkObjective(info.get("Objective") ?? "");
  const [status, tc] = statusOf(GLPK_CONDITIONS[condition] ?? condition);
  const state = { status, condition: tc };
  const sol = safeGetSolution(state, () => {
    const rows = readFwf(block());
    let dual = null;
    const iName = rows.header.indexOf("Row name");
    const iMarg = rows.header.indexOf("Marginal");
    const body = rows.rows.slice(1);
    if (iMarg >= 0) {
      // pd.to_numeric(errors="coerce").fillna(0)
      const num = (s) => {
        const v = s === "" ? NaN : Number(s);
        return Number.isNaN(v) ? 0 : v;
      };
      dual = byKind(
        body.map((r) => r[iName]),
        body.map((r) => num(r[iMarg])),
        "c",
      );
    } else logger.warning("Dual values of MILP couldn't be parsed");
    const cols = readFwf(block());
    const jName = cols.header.indexOf("Column name");
    const jAct = cols.header.indexOf("Activity");
    const cbody = cols.rows.slice(1);
    const primal = byKind(
      cbody.map((r) => r[jName]),
      cbody.map((r) => (r[jAct] === "" ? NaN : Number(r[jAct]))),
      "x",
    );
    return { primal, dual, objective };
  });
  return { status: state.status, termination_condition: state.condition, ...sol };
}

/**
 * Solve the LP text with a command-line solver (`"cbc"` or `"glpk"`).
 * Returns `{status, termination_condition, primal, dual, objective}` with
 * label-keyed Maps (`dual` null when the solver gives none).
 */
export async function solveWithCli(solverName, lp, options = {}) {
  const m = nodeModules();
  if (!m) throw new Error(`Solver ${solverName} runs the ${CLI_SOLVERS[solverName]} executable and needs Node.js.`);
  const dir = m.fs.mkdtempSync(m.path.join(m.os.tmpdir(), "psajs-"));
  try {
    const problemFn = m.path.join(dir, "problem.lp");
    m.fs.writeFileSync(problemFn, lp);
    return solverName === "cbc" ? await solveCbc(dir, problemFn, options) : await solveGlpk(dir, problemFn, options);
  } finally {
    m.fs.rmSync(dir, { recursive: true, force: true });
  }
}

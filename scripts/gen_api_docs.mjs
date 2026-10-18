// SPDX-License-Identifier: MIT
/**
 * Generate docs/API.md: the public methods and properties of PSA.js objects
 * (taken from the runtime objects, so the lists are complete) with the JSDoc
 * comment found in front of each definition in the sources.
 *
 * Usage: node scripts/gen_api_docs.mjs [--check]
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "API.md");

const psa = await import(path.join(ROOT, "src", "index.js"));
psa.logger.setLevel("error");

// ----------------------------------------------------------------------
// sources and JSDoc lookup
// ----------------------------------------------------------------------

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".js") ? [p] : [];
  });
}
const SOURCES = sourceFiles(path.join(ROOT, "src")).map((file) => ({ file, text: readFileSync(file, "utf8") }));

/** The JSDoc comment directly in front of `code` in the sources, or "". */
function jsdocOf(code) {
  for (const { text } of SOURCES) {
    const i = text.indexOf(code);
    if (i < 0) continue;
    // drop what precedes the function on its line (`proto.x = `, `static `, `export `)
    let before = text.slice(0, i).replace(/[ \t]*(?:export\s+)?(?:static\s+)?(?:[\w$.]+(?:\[[^\]]*\])?\s*[=:]\s*)?$/, "");
    before = before.replace(/\s+$/, "");
    if (!before.endsWith("*/")) return "";
    const start = before.lastIndexOf("/**");
    if (start < 0) return "";
    return before
      .slice(start + 3, -2)
      .split("\n")
      .map((l) => l.replace(/^\s*\* ?/, ""))
      .join("\n")
      .trim();
  }
  return "";
}

/** The first paragraph of a doc comment on one line. */
const summary = (doc) => doc.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ");

/** `(params)` of a function's source text. */
function signature(src) {
  const open = src.indexOf("(");
  if (open < 0) return "()";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if ("([{".includes(src[i])) depth++;
    else if (")]}".includes(src[i])) depth--;
    if (depth === 0) return src.slice(open, i + 1).replace(/\s+/g, " ");
  }
  return "()";
}

// ----------------------------------------------------------------------
// members of an object
// ----------------------------------------------------------------------

function members(proto, { stopAt = Object.prototype } = {}) {
  const methods = new Map();
  const props = new Map();
  for (let p = proto; p && p !== stopAt && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === "constructor" || name.startsWith("_") || methods.has(name) || props.has(name)) continue;
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (typeof d.value === "function") methods.set(name, d.value);
      else if (d.get) props.set(name, d.get);
    }
  }
  const sorted = (m) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { methods: sorted(methods), props: sorted(props) };
}

const SKIP = new Set(["toString", "repr"]);

/**
 * Markdown of the members of `proto`. Undocumented wrappers take the
 * signature and doc of the same method on `opts.fallback` (`[proto, prefix]`).
 */
function render(title, prefix, proto, intro = "", opts = {}) {
  const { methods, props } = members(proto, opts);
  const [fbProto, fbPrefix] = opts.fallback ?? [null, null];
  const out = [`## ${title}`, ""];
  if (intro) out.push(intro, "");
  if (props.length) {
    out.push("| property | description |", "| --- | --- |");
    for (const [name, get] of props) {
      const doc = summary(jsdocOf(get.toString())).replace(/\|/g, "\\|");
      out.push(`| \`${prefix}${name}\` | ${doc} |`);
    }
    out.push("");
  }
  for (const [name, fn] of methods) {
    if (SKIP.has(name)) continue;
    let src = fn.toString();
    let doc = jsdocOf(src);
    const fb = fbProto?.[name];
    if (!doc && typeof fb === "function") {
      if (/^[^(]*\(\.\.\.args\)/.test(src)) src = fb.toString();
      doc = jsdocOf(fb.toString());
      doc = doc ? `As \`${fbPrefix}${name}\`: ${doc}` : "";
    }
    out.push(`### \`${prefix}${name}${signature(src)}\``, "");
    if (doc) out.push(doc, "");
  }
  return out.join("\n");
}

// ----------------------------------------------------------------------
// document
// ----------------------------------------------------------------------

const n = new psa.Network();
const sections = [
  render("Network", "n.", psa.Network.prototype, "`new Network({ name, snapshots, ... })` or `Network.from_csv_folder(path)`; async loaders `await Network.from_netcdf(path)` and `await Network.from_hdf5(path)`, `Network.from_excel(path)`."),
  render("Components (`n.c.<list_name>`)", "c.", Object.getPrototypeOf(n.c.generators), "Component data: `c.static`, `c.dynamic`, `c.piecewise` and the attribute defaults."),
  render("Optimisation (`n.optimize`)", "n.optimize.", Object.getPrototypeOf(n.optimize._accessor), "`await n.optimize(opts)` builds and solves the model; the methods below are attached to `n.optimize`."),
  render("Statistic expressions (`n.optimize.expressions`)", "n.optimize.expressions.", Object.getPrototypeOf(n.optimize.expressions)),
  render("Statistics (`n.statistics`)", "n.statistics.", Object.getPrototypeOf(n.statistics._accessor), "`n.statistics(opts)` returns the overview table; the methods below are attached to `n.statistics`."),
  render("Clustering (`n.cluster`)", "n.cluster.", Object.getPrototypeOf(n.cluster)),
  render("Spatial clustering (`n.cluster.spatial`)", "n.cluster.spatial.", Object.getPrototypeOf(n.cluster.spatial)),
  render("Temporal clustering (`n.cluster.temporal`)", "n.cluster.temporal.", Object.getPrototypeOf(n.cluster.temporal)),
  render("Network collections (`NetworkCollection`)", "nc.", psa.NetworkCollection.prototype, "", { stopAt: psa.Network.prototype, fallback: [psa.Network.prototype, "n."] }),
  render("Sub-networks (`SubNetwork`)", "sub.", psa.SubNetwork.prototype),
  render("Costs (`costs`, `pypsa.costs`)", "costs.", psa.costs),
  render("Geography (`geo`, `pypsa.geo`)", "geo.", psa.geo),
  render("Example networks (`examples`, `pypsa.examples`)", "examples.", psa.examples, "Async loaders of PyPSA's published example networks (`const n = await examples.ac_dc_meshed()`), cached on disk under Node.js; `options.general.allow_network_requests` must be true unless the file is cached."),
  render("linopy model (`n.model`)", "m.", psa.LinopyModel.prototype),
  render("Variables (`m.variables.get(name)`)", "v.", psa.LinopyVariable.prototype, "Operations on variables act on their expression (coefficient 1); `shift`, `where`, `roll`, `sel` and `isel` keep linopy's Variable semantics.", { fallback: [psa.LinearExpression.prototype, "e."] }),
  render("Linear expressions (`LinearExpression`)", "e.", psa.LinearExpression.prototype),
  render("Quadratic expressions (`QuadraticExpression`)", "q.", psa.QuadraticExpression.prototype, "", { stopAt: psa.LinearExpression.prototype, fallback: [psa.LinearExpression.prototype, "e."] }),
];

const exportsList = Object.keys(psa)
  .sort()
  .map((k) => `- \`${k}\`${typeof psa[k] === "function" && /^[a-z]/.test(k) ? `${signature(psa[k].toString())}: ${summary(jsdocOf(psa[k].toString()))}` : ""}`);

const text = [
  "# PSA.js API reference",
  "",
  "Generated by `npm run docs` (`scripts/gen_api_docs.mjs`) from the runtime objects and the JSDoc comments in `src`; do not edit by hand. Names and arguments follow PyPSA: Python keyword arguments are a trailing options object.",
  "",
  "## Module exports",
  "",
  ...exportsList,
  "",
  ...sections,
]
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd() + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    // missing
  }
  if (current !== text) {
    console.error("docs/API.md is out of date: run `npm run docs`");
    process.exit(1);
  }
  console.log("docs/API.md is up to date");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${text.length} bytes)`);
}

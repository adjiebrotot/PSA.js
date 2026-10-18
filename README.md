# PSA.js

A JavaScript port of [PyPSA](https://github.com/PyPSA/PyPSA) (Python for Power
System Analysis). PyPSA is the source of truth: every feature listed below is
checked against PyPSA by parity tests that run the same scenario in both
libraries and compare the results.

Reference version: PyPSA **v1.4.0** (commit `6c45594` on `master` of the
`adjiebrotot/PyPSA` fork, one fix after the v1.4.0 tag). Networks exported by
PSA.js report `pypsa_version = 1.4.0`.

## Install and use

Requires Node.js >= 22.3 (plain ES modules, no build step). PSA.js also runs
in browsers through a bundler: HiGHS loads its WebAssembly next to the
module (copy `highs.wasm` beside the bundle), CSV folders go through
`MemoryFolder` and Excel workbooks through bytes (`export_to_excel(null)`,
`Network.from_excel(bytes)`); netCDF needs Node.js for now. `npm run
test:browser` bundles a smoke test with esbuild and runs it in headless
Chromium (`test/browser/entry.js`).

```js
import { Network, NetworkCollection, Index } from "psa.js";

const n = Network.from_csv_folder("examples/networks/ac-dc-meshed/ac-dc-meshed");
await n.optimize();                       // HiGHS (WebAssembly)
console.log(n.objective);
console.log(n.statistics.capex().toString());

n.export_to_excel("network.xlsx");        // and Network.from_excel(...)
n.lpf();                                  // linear power flow
n.pf();                                   // Newton-Raphson power flow

await n.export_to_netcdf("out.nc");       // readable by PyPSA / xarray
const m = await Network.from_netcdf("out.nc");

// stochastic optimisation: investments shared, dispatch per scenario
const s = Network.from_csv_folder("examples/networks/ac-dc-meshed/ac-dc-meshed");
s.set_scenarios({ low: 0.3, high: 0.7 });
s.c.generators.static.setAt(["high", "Manchester Gas"], "marginal_cost", 80);
s.set_risk_preference({ alpha: 0.9, omega: 0.5 });   // optional CVaR
await s.optimize();
console.log(s.statistics.optimal_capacity().toString()); // (component, scenario, carrier)

// statistics as linear expressions of the model (n.optimize.expressions)
n.optimize.create_model();
const capex = n.optimize.expressions.capex();          // dims ["group"]
n.model.add_constraints(capex.sum().le(1e9), { name: "capex_budget" });

// collections of networks with combined statistics
const nc = new NetworkCollection([n, m], { index: new Index(["a", "b"], "network") });
console.log(nc.statistics.capex().toString());         // (component, network, carrier)
```

Runnable examples (ported from PyPSA's documentation topics) are in
[`examples/scripts`](examples/scripts): `quickstart`, `capacity_expansion`,
`unit_commitment`, `custom_constraints` (linopy-style API incl. a quadratic
objective), `stochastic`, `clustering`, `power_flow` and `io`, e.g.
`node examples/scripts/quickstart.mjs`. The test suite runs all of them.

API names follow PyPSA (snake_case). Python keyword arguments become a trailing
options object: `n.optimize({ snapshots, multi_investment_periods: true })`.

### Dependencies (JS equivalents of PyPSA's Python stack)

| PyPSA uses            | PSA.js uses                                                        |
| --------------------- | ------------------------------------------------------------------ |
| pandas / xarray       | small bespoke `Index` / `Series` / `DataFrame` (`src/core`)        |
| linopy + highspy      | bespoke linopy-compatible model/LP writer + `highs` (HiGHS WASM)   |
| scipy.sparse          | bespoke sparse LU (`src/linalg/sparse.js`)                         |
| networkx              | bespoke graph / cycle basis (networkx ordering)                    |
| pandas CSV            | `papaparse` + Python-compatible float formatting                   |
| netCDF4 / xarray IO   | `h5wasm` (optional dependency)                                     |

## What is implemented (and parity tested)

- **Data model**: all component types, defaults, standard line/transformer
  types, `add`/`remove`, snapshots, weightings, investment periods, `copy`,
  `merge`, `slice`, multi-port links and processes.
- **IO**: CSV folders (import and byte-identical export), netCDF import/export
  in PyPSA's layout (files written by PSA.js re-import identically in PyPSA),
  including piecewise breakpoint data (`<list>-<attr>-pw.csv`,
  `<list>_pw_<attr>`), Excel workbooks (`import_from_excel`,
  `export_to_excel`; PyPSA's sheet layout, no extra dependency) and PYPOWER
  cases (`import_from_pypower_ppc`).
- **Topology and power flow**: sub-networks, cycle matrices (networkx-ordered
  `bfs-refined` default and `paton` cycle bases), PTDF/BODF, linear power flow,
  contingency analysis, Newton-Raphson AC power flow incl. distributed slack,
  seasonal line ratings.
- **Optimisation**: the LP written by PSA.js is identical to linopy's LP file
  (same labels, row/term order and numbers), so HiGHS returns the same
  solution. Covers operational/extendable/committable constraints, unit
  commitment (MILP and linearised, status history, time-varying start-up and
  shut-down costs), ramp limits incl. big-M for committable+extendable,
  maintenance scheduling, modular capacities, storage units and stores,
  multi-investment periods, all global constraint types, growth limits,
  transmission losses (secants/tangents), transport delays, quadratic costs,
  phase-shifting transformers and voltage angle limits, activity masks,
  rolling horizon, security-constrained OPF (per investment period),
  iterative transmission expansion, optimisation followed by AC power flow,
  MGA, piecewise linear marginal/capital costs and efficiencies (linopy's LP
  tangent-line, incremental and SOS2 formulations, `piecewise_options`; SOS
  constraints are solved through linopy's binary reformulation with
  `reformulate_sos: true`, as HiGHS has no native SOS support), custom
  constraints through a linopy-style expression API (`sel`, `isel`, `sum`,
  `shift`, `roll`, `diff`, `rolling().sum()`, `cumsum`, `where`, `fillna`,
  `groupby().sum()`, with linopy's term layout) and quadratic expressions for
  custom objectives (`x.mul(y)`, `pow(2)`, `m.add_objective(q, {overwrite})`).
- **Statistics**: capex, opex, capacities, supply/withdrawal, energy balance,
  transmission, curtailment, capacity factor, revenue, market value, prices,
  with PyPSA's groupers and rounding/drop_zero semantics.
- **Stochastic networks** (two-stage stochastic programming): `set_scenarios`,
  scenario-indexed component data (`(scenario, name)` rows and time series
  columns), `get_scenario`, the probability-weighted objective with shared
  investment variables, CVaR risk aversion (`set_risk_preference`), quadratic
  costs, unit commitment, multi-investment periods, transmission losses,
  security-constrained OPF and rolling horizons on stochastic networks,
  statistics with a `scenario` level and netCDF import/export. The LP files
  are byte-identical to PyPSA's: PSA.js builds the deterministic model of
  every scenario and merges them in PyPSA's dimension order and numbering
  (see `src/optimization/stochastic.js`).
- **Statistic expressions** (`n.optimize.expressions`): capex, capacity, opex,
  transmission, energy balance, supply, withdrawal, curtailment and
  operation as linopy expressions with the same layout as PyPSA's (dims,
  coordinates, term slots), including multi-investment periods, piecewise
  costs/efficiencies, multi-port components and stochastic networks (a
  `scenario` dimension from scenario-dependent data and the operational
  variables); constraints built from them write the same LP rows.
- **NetworkCollection**: several networks indexed by custom levels, with
  combined component data and statistics.
- **Consistency checks** (`consistency_check`, strict mode, scenario-invariant
  attributes), `sanitize`, carrier colours.
- **Clustering**: spatial (`get_clustering_from_busmap` with all aggregation
  strategies, greedy-modularity and Ward HAC busmaps) and temporal
  (`resample` with fixed and calendar offsets such as `3h`, `W`, `ME`, `QS`,
  `YE`; `downsample`, `from_snapshot_map`, tsam-style `segment`).

## Parity testing

```
npm test                       # run all JS tests against the stored fixtures
SCENARIO=opt_uc npm test       # a single scenario
```

`test/scenarios/*.json` describe operations that both runners execute:
`scripts/parity/run_scenarios.py` (PyPSA, writes `test/fixtures/*.json.gz`) and
`test/scenario_runner.js` (PSA.js). To regenerate fixtures, use a Python
environment with the packages pinned in `scripts/parity/requirements.txt` and
the reference PyPSA checkout installed (with its release tags, `git fetch
--tags`, or a pinned version as described in that file, so that
`pypsa.__version__` resolves):

```
scripts/parity/generate_all.sh          # definitions + every fixture
cd scripts/parity
python run_scenarios.py [scenario ...]   # optimisation/statistics/clustering scenarios
python gen_io.py                         # IO fixtures (CSV + netCDF)
python gen_networks.py                   # network fixtures
python diff_fixtures.py [--rtol 1e-9]    # what changed vs. the committed fixtures
```

Fixtures are deterministic (fixed hash seed, `mtime=0` gzip): with the pinned
environment a full regeneration rewrites every JSON fixture byte-identically
unless PyPSA's behaviour changed. Two exceptions show up in `git status`
without being changes: the netCDF and Excel files (HDF5 metadata and
workbook timestamps differ between runs; the IO tests check their content) and the SOS section of
`scenario_opt_piecewise` (linopy writes it in non-deterministic order; the
comparator treats it as a set). `diff_fixtures.py` compares fixture contents
and reports the latter as the only difference.

The generators pin `PYTHONHASHSEED=0` because PyPSA iterates over Python sets in
places that affect variable order. Tolerances are exact for data/IO and
`1e-6`–`1e-9` for solver results; LP files are compared structurally exactly
with a `1e-12` relative tolerance on numbers (numpy's vectorised `pow` differs
from libm by one ulp on some CPUs).

## Not implemented / known differences

See [`NEXT_STEPS.md`](NEXT_STEPS.md) for the remaining work list. In short:
HDF5 IO, the pandapower importer, plotting, `to_crs`, segmentation of
non-hourly snapshots, non-Ward HAC linkages, k-means busmaps (a seeded approximation,
not scikit-learn's), solvers other than HiGHS.

PyPSA v1.4.0 behaviour that PSA.js mirrors on stochastic networks (likely
upstream bugs): `n.buses_t.p` is all zero after optimisation, voltage angles
are not computed, global constraint duals (`mu`) are not assigned,
`meshed_thresholds` count bus usage over the rows of all scenarios, and
power flow, iterative transmission expansion and spatial clustering are not
available. `n.optimize.expressions` fails for inactive assets in the energy
balance, transmission and curtailment, and for ungrouped operation without
time aggregation (mirrored). See NEXT_STEPS.md for the
full list.

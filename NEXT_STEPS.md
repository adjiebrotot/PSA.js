# Remaining work for the next session

State at hand-off: all PSA.js tests pass (`npm test`: 123 tests: the parity
scenarios, IO tests and the example scripts; `npm run test:browser` passes in
headless Chromium). Reference PyPSA: v1.4.0 (`6c45594`, fork `master`). Work
of the last session is on branch `claude/stoic-gauss-ka4jkc` (no PR opened).

Fixture environment: `scripts/parity/requirements.txt` now also pins
scikit-learn (HAC), openpyxl and python-calamine (Excel), PyTables (HDF5),
PYPOWER and tsam. tsam's metadata caps numpy/pandas below the pins (installing
it normally downgrades them to numpy 2.4.6 / pandas 3.0.5, which moves
solver-derived voltage angles by an ulp), so it is installed with `--no-deps`;
`generate_all.sh` now warns when numpy, pandas, scipy, highspy or linopy differ
from the pins. With the pins every JSON fixture regenerates identically.
`generate_all.sh` regenerates every fixture; `check_js_excel.py` and
`check_js_hdf5.py` (PyPSA reads PSA.js workbooks / HDF5 stores) and the
browser smoke test are run separately.

## 0. Suggested next steps

1. ~~`busmap_by_hac` with complete, average and single linkage~~ done
   (scenario `clustering_hac`; single linkage follows scipy's Kruskal over a
   stable edge sort, so ties resolve identically).
2. ~~HDF5 IO~~ done (see section 2, IO formats).
3. ~~URL inputs~~ done: `from_netcdf` / `from_hdf5` (and the `import_from_*`
   methods) accept http(s) URLs (`fetch`, PyPSA's `_retrieve_from_url`
   errors, `ioOptions.allow_network_requests`); the synchronous Excel and
   CSV loaders raise with instructions (fetch the bytes first).
4. ~~More examples~~ done (`examples/scripts`: `mga`, `security_constrained`,
   `rolling_horizon`, `multi_investment`, `transmission_losses`; their
   numbers were checked against PyPSA) and ~~an API reference~~
   (`docs/API.md`, `npm run docs`).
5. Report the upstream bugs listed in section 3 (PyPSA issues).
6. ~~Stochastic leftovers (components added after `set_scenarios`)~~ done
   (scenario `stochastic_added`); remaining stochastic items in section 2.

## 1. Housekeeping

- [x] Regenerate every fixture in one go (`scripts/parity/generate_all.sh`);
      regeneration is deterministic and leaves the tree clean.
- [x] Add `scripts/parity/generate_all.sh`.
- [x] Track PyPSA v1.4.0: definitions regenerated, `PYPSA_VERSION` 1.4.0, all
      fixtures regenerated, behaviour changes ported (bfs-refined cycle basis,
      UC status history, maintenance, phase shifters, voltage angle limits,
      time-varying start-up/shut-down costs, seasonal ratings, SCLOPF per
      period, piecewise linear costs/efficiencies).
- [x] PyPSA release tags: `pypsa.__version__` resolves to 1.4.0 (the IO test no
      longer masks the exported version).
- [x] CI workflow (`.github/workflows/test.yml`, Node 22 and 24).
- [x] Pinned the Python packages that reproduce the fixtures
      (`scripts/parity/requirements.txt`, verified by a full regeneration) and
      added `scripts/parity/diff_fixtures.py`.
- [x] Fixtures no longer depend on the CPU: the generators disable numpy's
      AVX-512 (SVML) loops, whose `pow`/`exp`/`log` differ from libm by one ulp
      and moved HiGHS to other optimal dual vertices on degenerate LPs.

## 2. Features not yet ported

- [x] **Stochastic optimisation**: `set_scenarios`, scenario-indexed data,
      `get_scenario`, scenario-weighted objective, CVaR, QP, UC, multi-period,
      losses, SCLOPF, rolling horizon, statistics, netCDF IO (scenarios
      `network_stochastic`, `opt_stochastic`, `statistics_stochastic`,
      `io_stochastic`). Remaining:
  - [x] `n.optimize.expressions` on stochastic networks (scenario
        `opt_expressions_stochastic`, 124 records incl. 5 LP files): constants
        follow `c.da` (`(scenario, name)`; time series `(scenario, name,
        snapshot)` or, when only some columns are time-varying,
        `(snapshot, scenario, name)`, see `scenarioMajor`), groupers and
        filters require scenario-invariant values, transmission branches use
        PyPSA's multi-index path, grouped results put MultiIndex dimensions
        first (multi-period snapshots) and a single regroup key before the
        other dimensions.
  - [ ] Assigning duals of custom constraints on stochastic networks (PyPSA
        raises too).
  - [x] Components added after `set_scenarios` (scenario `stochastic_added`,
        29 records incl. the LP file): their static rows follow both
        scenarios' original rows and `MultiIndex.append` sorts the `name`
        level, so PyPSA's `c.da` (and with it the operational variables, their
        bounds and the nodal balance led by that component) becomes
        (snapshot, scenario, name); PSA.js tracks pandas' level order per
        component (`_nameLevel`, `isSnapshotMajor`) and merges the scenario
        models accordingly. Ungrouped statistics follow the static rows, and
        time series of `sign * p` (energy balance with `groupby_time=False`)
        PyPSA's sorted column union. Fixed on the way: time series of such
        components lost their (scenario, name) levels, so e.g. loads added
        after `set_scenarios` were dropped from the nodal balance.
  - [ ] Iterative transmission expansion, power flow and spatial clustering
        raise (they fail or are unsupported in PyPSA v1.4.0 too).
- [x] **NetworkCollection** (scenario `collection`): construction from lists,
      mappings or Series (custom index levels), combined component data and
      statistics with the network levels, PyPSA's price quirks.
- [x] **`n.optimize.expressions`** (scenarios `opt_expressions`,
      `opt_expressions_more`): capex, capacity, opex, transmission, energy
      balance, supply, withdrawal, curtailment and operation as linopy
      expressions with identical layout (dims, coordinates, `_term` slots incl.
      padding), groupers and filters, multi-investment periods, piecewise
      costs and efficiencies (`_split_piecewise` / `_direct_piecewise`),
      multi-port links and processes; constraints built from them give
      byte-identical LP files. The linopy operations (legacy semantics: NaN
      fills, outer joins, `groupby().sum()`, `@`, `merge`) live in
      `src/optimization/statistic_expressions.js`.
- [ ] Piecewise data on stochastic networks (PyPSA raises too).
- [x] **Excel IO** (`import_from_excel` / `export_to_excel`, `Network.from_excel`,
      `new Network("file.xlsx")`): bespoke zip + SpreadsheetML reader/writer
      (`src/core/zip.js`, `src/network/excel.js`), PyPSA's sheet layout incl.
      short sheet names, stacked piecewise sheets and append mode (unrelated
      sheets kept, stale ones removed). Tests: PyPSA workbooks of 7 networks
      import identically and round-trip (`io.test.js`, fixtures in
      `test/fixtures/excel`); `scripts/parity/check_js_excel.py` confirms that
      PyPSA imports PSA.js workbooks identically (run manually; all 7 pass).
      Like the netCDF files, regenerated workbooks differ in metadata bytes.
- [x] `import_from_pypower_ppc` (scenario `io_pypower`: pypower's case9,
      case14, case30 and case39 imported and solved by AC power flow).
- [x] HDF5 (`import_from_hdf5`, `export_to_hdf5`, `Network.from_hdf5`;
      paths or bytes): pandas `HDFStore` layout read and written with h5wasm
      (`src/network/hdf5.js`) and a pickle reader/protocol-0 writer
      (`src/core/pickle.js`) for the PyTables attributes and the pickled
      object arrays of `/meta` and `/crs`. h5wasm cannot write HDF5 array
      member types, so PSA.js writes one column per values block (scalar
      members, as pandas does for data columns) and `/meta`/`/crs` as
      fixed-length strings; pandas reads both. Booleans are stored as uint8
      (pandas casts by the `_dtype` attribute), no shuffle filter (h5wasm
      offers deflate only). Tests: PyPSA stores of 9 networks (incl.
      multi-period, piecewise, shapes, non-ASCII names and a Unicode `meta`)
      import identically and round-trip (`io.test.js`, fixtures in
      `test/fixtures/hdf5`); `scripts/parity/check_js_hdf5.py` confirms that
      PyPSA imports PSA.js stores identically (run manually; all 9 pass).
      Like PyPSA, stochastic networks raise NotImplementedError. `new
      Network("x.nc" | "x.h5")` raises (the loaders are async).
- [x] `import_from_pandapower_net` (scenario `io_pandapower`): reads the JSON
      written by `pandapower.to_json` (path, text or object; test nets in
      `test/networks/pandapower`), all of PyPSA's mapping incl. bus switch
      amalgamation, `extra_line_data`, `use_pandapower_index`; PyPSA's
      failures on unnamed loads (`case9`) and on buses removed twice
      (`example_multivoltage`) are mirrored. `n.remove` now raises for
      unknown names like pandas' `drop`.
- [x] SubNetwork API (scenario `topology_subnetwork_api`): `sub.lpf()`,
      `sub.pf()` (iterations, errors, convergence per snapshot) and PyPSA's
      deprecated accessors (`buses_i()` ... `stores_i()`, `buses()`,
      `generators()`, `loads()`, `shunt_impedances()`, `storage_units()`,
      `stores()`, `component`, `df`, `static`, `pnl`, `dynamic`,
      `iterate_components`), `investment_period_weightings`, `scenarios`;
      `n.optimize.expressions.n`. A fresh diff of `dir()` against PyPSA now
      leaves `n.plot`, `n.explore`, `n.to_crs` and the xarray views `c.da` /
      `c.ds` (and `c.n_save`).
- [x] Small API gaps found by diffing `dir(pypsa.Network())`: deprecated
      `n.cluster` aliases (`busmap_by_hac`, `busmap_by_greedy_modularity`,
      `cluster_spatially_by_*`), `n.statistics.n` / `.is_multi_indexed`,
      `Network.get_network` (raises outside collections). Remaining: `plot`,
      `explore`, `to_crs`.
- [x] Shapes: WKT geometries kept in shapely's canonical form and written
      rounded like `GeoSeries.to_wkt()` (GEOS number formatting, ties to
      even; `src/core/wkt.js`), identical through CSV, netCDF and Excel
      (`test/networks/shapes`, fixture `io_shapes`). Geometric operations
      (areas, buffers, `to_crs`) are not available.
- [x] Browser support: `npm run test:browser` (esbuild bundle in headless
      Chromium, also a CI job): optimisation with HiGHS WASM, statistics,
      CSV via `MemoryFolder`, Excel via bytes (bundled inflate when no zlib),
      netCDF via bytes (h5wasm's browser build and in-memory file system).
- [x] netCDF extras: http(s) URL inputs, `float32` (float64 data variables
      stored as float32 like PyPSA's `typecast_float32`; PyPSA reads the file
      identically to its own) and PyPSA's `compression` dict (`io.test.js`,
      fixture `io_float32`).
- [ ] `to_crs` (coordinate transformation; needs PROJ-accurate projections
      and pyproj's WKT per EPSG code; PyPSA's own `to_crs` swaps the axes, see
      section 3).
- [x] **Clustering** done: calendar offsets in `resample` (`W`, `W-<day>`,
      `ME`, `MS`, `QE[-<month>]`, `QS[-<month>]`, `YE[-<month>]`,
      `YS[-<month>]` and their multiples such as `2W` or `3ME`, with pandas'
      bin edges; scenario `clustering_resample`);
      `busmap_by_greedy_modularity` / `cluster_by_greedy_modularity` (port of
      networkx's CNM algorithm incl. its heap tie-breaking; scenario
      `clustering_modularity`); `busmap_by_hac` / `cluster_by_hac` with Ward,
      complete and average linkage and euclidean/manhattan/cosine metrics
      (port of scikit-learn's connectivity-constrained `ward_tree` and
      `linkage_tree` with its weight-only edge heap and ordered
      `max_merge` / `average_merge`, single linkage via scipy's minimum
      spanning tree and `_single_linkage_label`, component completion,
      `_hc_cut` / `hc_get_heads`; scenario
      `clustering_hac`; the completion compares squared distances computed
      like numpy's BLAS `dot` with FMA, so on CPUs without FMA the fixture
      could differ for coincident buses); `segment` / `get_segment_result`
      for hourly or non-datetime snapshots (tsam's pipeline with one typical
      period: min-max scaling, Ward clustering of neighbouring snapshots,
      segment means; scenario `clustering_segment`).
- [ ] **Clustering** open: `segment` for snapshots that are not hourly (PyPSA
      passes the snapshot count to tsam as hours, so tsam forms several
      periods and only part of the series is segmented, an upstream bug;
      PSA.js raises); `busmap_by_hac` with a callable or precomputed metric
      (PSA.js raises NotImplementedError); parity for
      `busmap_by_kmeans` (a seeded Lloyd/k-means++, not scikit-learn's, whose
      threaded chunk reductions make exact parity unlikely).
- [ ] Plotting (`n.plot`, `n.explore`, statistics plots) — out of scope or a
      separate package.
- [ ] Solvers other than HiGHS; solver option passthrough is only tested for
      basic options. HiGHS' QP solver is slow on larger quadratic problems
      (also true in PyPSA).
- [ ] Deprecated APIs not mirrored (e.g. `n.lopf`, old `n.generators_t`
      style accessors beyond what exists). `dir(pypsa.Network())` and the
      `optimize`, `statistics`, `cluster` and `c` accessors were diffed
      against PSA.js in this session (see the API gaps item above).

## 3. Parity gaps to close

- [ ] `linopy` expression API. Public: `sel`, `isel`, `mul`, `add`, `sub`,
      `sum`, `shift`, `roll`, `diff`, `rolling().sum()`, `cumsum` (one
      dimension, as linopy), `where`, `fillna`, `groupby(series).sum()`,
      `le/ge/eq`, `set_objective` (scenario `opt_linexpr`: term layout incl.
      -1/NaN padding, LP rows, solution), quadratic expressions (`x * y`,
      `expr * var`, `pow(2)`, sums, mixing with linear terms) and quadratic
      objectives via `set_objective` / `add_objective` (scenario
      `opt_quadexpr`), `groupby` with a DataFrame (multi-key) grouper and
      `Variable.fillna` (also after a Variable's `shift` / `where`), centred
      rolling windows (`center`), chains of the operations linopy keeps on a
      Variable (`shift`, `where`, `roll`, `sel`, `isel`: absent slots keep
      coefficient 1 and constant 0 until another operation makes an
      expression), `where` with a condition over dimensions the expression
      lacks (broadcast like xarray). Missing: quadratic constraints (HiGHS
      cannot solve them).
- [x] Statistics: aggregations sum/mean/min/max/median/first/last/std/var/
      prod/count/sem/nunique/skew/kurt (pandas' nanops formulas) and callable
      groupers returning one Series or a list of Series (one index level
      each; a DataFrame raises like pandas). (Done: scenario `statistics_more` covers
      `groupby_method` and `groupby_time` aggregations, aggregation across
      components, ports, carrier/bus-carrier filters, nice names, storage
      capacities and price weightings; the overview table `n.statistics()`
      passes all arguments like PyPSA, the component sets iterate in CPython's
      set order, deprecated `comps` / `aggregate_groups` / `aggregate_time`
      are renamed.)
- [x] Consistency checks: `check_dtypes` (static dtypes judged by the
      column values; scenario `consistency`).
- [ ] SciGrid voltage angles after optimisation use an exact grounded solve while
      PyPSA uses `numpy.linalg.pinv` (differences ~1e-4 rad; documented
      tolerance in `test/scenarios/opt_scigrid_de.json`).
- [ ] Iterative transmission expansion: PyPSA divides by `s_nom_opt` from a
      previous run; on a fresh network (s_nom_opt = 0) this yields x = 0 and
      fails in PyPSA too. The scenario seeds `s_nom_opt`; consider reporting
      upstream.
- [ ] PyPSA v1.4.0 piecewise bugs found while porting (PSA.js mirrors 1, 3
      and 4; consider reporting upstream):
      1. `_normalize_breakpoints` concatenates the per-name `groupby().apply()`
         results with a label-based column union, so breakpoint rows are
         aligned across components: sorting one curve re-orders the rows of
         every other curve (they can end up unsorted or rejected as not
         starting at x=0, e.g. shuffled MultiIndex input).
      2. netCDF export of piecewise data with different breakpoint counts
         truncates the longer curves (all `<list>_pw_<attr>` variables share
         one `breakpoint` dimension aligned to the first one written), so the
         file fails to re-import. PSA.js pads with NaN rows instead; PyPSA
         reads those files correctly.
      3. `_get_breakpoints` raises "Breakpoints must have same size" when the
         piecewise frame has more rows than every selected curve (e.g. a
         longer capital cost curve on a non-extendable component).
      4. `meshed_thresholds` that put the output buses of piecewise links in
         different bus groups define `Link-p1_piecewise` twice ("already
         assigned to model").
- [ ] PyPSA v1.4.0 stochastic-network bugs found while porting (consider
      reporting upstream; PSA.js mirrors 1-4):
      1. `post_processing` groups the bus injections by the first column level,
         which is the scenario, so `n.buses_t.p` is all zero; voltage angles
         are not computed.
      2. Global constraint duals are never assigned (`suffix in
         c.static.index` only checks the scenario level), `mu` stays 0.
      3. `get_bus_counts` counts the rows of all scenarios, so
         `meshed_thresholds` are effectively divided by the number of
         scenarios (SciGrid gets an extra `Bus-meshed-30-nodal_balance`).
      4. In the stochastic model the zero-coefficient maintenance terms of
         `{c}-fix-*` rows reference another scenario's variable (harmless,
         linopy drops zero coefficients).
      5. A scenario named like a component (e.g. scenario and generator
         "peak") crashes `post_processing` (`rename` with a MultiIndex mapper).
      6. The secant-loss error for infinite `s_nom_max` crashes with an
         IndexError while formatting the message.
      7. `lpf`, `pf`, `optimize_and_run_non_linear_powerflow` and
         `optimize_transmission_expansion_iteratively` fail.
      8. netCDF export can reorder scenarios and components (xarray aligns the
         coordinates to sorted MultiIndex levels; see `io_stochastic`).
- [ ] PyPSA v1.4.0 `n.optimize.expressions` bugs found while porting (PSA.js
      mirrors them; consider reporting upstream):
      1. Inactive assets (`active=False`) have no dispatch variables, but
         `energy_balance`/`supply`/`withdrawal` align the port coefficients of
         all assets with `join="exact"` (AlignmentError), `transmission`
         selects inactive branches and `curtailment` inactive fixed assets
         (KeyError).
      2. `groupby_method` other than "sum" is only rejected when ports are
         merged or time is aggregated (e.g. `capex(groupby_method="max")`
         silently sums).
      3. `operation(groupby=False, groupby_time=False)` fails with
         `KeyError: 'const'` for every component except loads and storage
         units: the operation is a plain linopy `Variable`, which
         `linopy.merge` cannot concatenate (even a single one).
- [ ] PyPSA v1.4.0 bugs found this session (not mirrored; consider reporting):
      1. `to_crs` builds `Transformer.from_crs(current, new)` without
         `always_xy=True` and passes (x, y), so for EPSG:4326 (lat/lon axis
         order) longitudes are taken as latitudes: London (-0.13, 51.5) ends
         up at (-1.19e6, 9.26e6) in EPSG:3035, x/y are swapped for EPSG:3857.
      2. `segment` passes `period_duration=len(snapshots)` to tsam, which
         reads it in hours: with 3-hourly snapshots tsam forms three periods
         and the result covers only the first third of the series.
      3. `segment` sets the snapshot weightings to the segment lengths in
         snapshots, dropping the original weightings (3-hourly data loses
         its factor 3).
- [ ] PyPSA bugs/quirks observed (mirrored or worked around in fixtures):
      clustering crashes under pandas 3 copy-on-write (runner patches
      `determine_network_topology`), loss variable order depends on Python's
      hash seed, MILP duals are all zero (HiGHS), zero-reactance lines break
      `pinv` in post-processing.

## 4. Documentation

- [x] API reference: `docs/API.md`, generated by `npm run docs`
      (`scripts/gen_api_docs.mjs`: member lists from the runtime objects,
      JSDoc found by locating each function's source text; wrappers fall back
      to the documented method); `test/docs.test.js` fails when it is stale.
      Examples: thirteen runnable scripts in `examples/scripts` (run by
      `test/examples.test.js`).
- [ ] Publish to npm (package name, versioning tied to PyPSA version).

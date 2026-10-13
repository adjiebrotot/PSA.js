# Remaining work for the next session

State at hand-off: all PSA.js tests pass (`npm test`: 32 parity scenarios plus
IO tests). Reference PyPSA: v1.4.0 (`6c45594`, fork `master`).

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

## 2. Features not yet ported

- [ ] **Stochastic optimisation**: `set_scenarios`, scenario dimension on
      components, scenario-weighted objective, CVaR / `set_risk_preference`,
      stochastic statistics. Currently `set_scenarios` throws.
- [ ] **NetworkCollection** (multi-network statistics).
- [ ] **`n.optimize.expressions`** (statistic expressions on the linopy model,
      incl. `_split_piecewise` / `_direct_piecewise`).
- [ ] Piecewise data on stochastic networks (PyPSA raises too).
- [ ] **IO formats**: Excel (`import_from_excel`/`export_to_excel`, e.g. via
      SheetJS), HDF5 (pandas HDFStore layout), `import_from_pypower_ppc`,
      `import_from_pandapower_net` (likely out of scope without Python).
- [ ] netCDF extras: `float32`, `compression=None`, URL inputs, browser support
      (h5wasm in-memory files), shapes/geometry (WKT) round trip.
- [ ] `to_crs` (coordinate transformation; needs a proj4 equivalent).
- [ ] **Clustering**: `segment` (tsam), `busmap_by_hac`, `busmap_by_greedy_modularity`,
      weekly/monthly resample offsets, parity for `busmap_by_kmeans`
      (current implementation is a seeded Lloyd/k-means++, not scikit-learn).
- [ ] Plotting (`n.plot`, `n.explore`, statistics plots) — out of scope or a
      separate package.
- [ ] Solvers other than HiGHS; solver option passthrough is only tested for
      basic options. HiGHS' QP solver is slow on larger quadratic problems
      (also true in PyPSA).
- [ ] Deprecated APIs not mirrored (e.g. `n.lopf`, old `n.generators_t`
      style accessors beyond what exists) — check `scripts/parity` API diff:
      run `/tmp`-style comparison of `dir(pypsa.Network())` vs PSA.js.

## 3. Parity gaps to close

- [ ] `linopy` expression API: only the subset needed by PyPSA workflows
      (`sel`, `mul`, `add`, `sub`, `sum`, `le/ge/eq`, `set_objective`). Missing:
      `shift`, `groupby`, `rolling`, `where`, quadratic expressions, `diff`.
- [ ] Statistics: `n.statistics(...)` overview table, `aggregate_across_components`,
      `groupby_method` other than sum/mean/min/max, callable groupers with
      multi-index results, the `transmission` default component order follows
      Python set order in PyPSA (PSA.js sorts).
- [ ] Consistency checks: `check_dtypes`, scenario checks (no scenarios yet).
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
- [ ] PyPSA bugs/quirks observed (mirrored or worked around in fixtures):
      clustering crashes under pandas 3 copy-on-write (runner patches
      `determine_network_topology`), loss variable order depends on Python's
      hash seed, MILP duals are all zero (HiGHS), zero-reactance lines break
      `pinv` in post-processing.

## 4. Documentation

- [ ] API reference (JSDoc → generated docs) and examples ported from PyPSA's
      documentation notebooks.
- [ ] Publish to npm (package name, versioning tied to PyPSA version).

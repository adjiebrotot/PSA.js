# Remaining work for the next session

State at hand-off: all PSA.js tests pass (`npm test`: 26 parity scenarios plus
IO tests). Reference PyPSA commit: `1eb9db0` (post v1.2.4).

## 1. Housekeeping (do first)

- [ ] **Regenerate every fixture in one go** with the final runners
      (`run_scenarios.py` with no arguments, `gen_networks.py`, `gen_io.py`) and
      confirm `npm test` still passes. Some fixtures predate later runner fixes
      (pinned `PYTHONHASHSEED=0`, datetime/tuple value serialisation, the
      pandas copy-on-write workaround).
- [ ] Add `scripts/parity/generate_all.sh` (the test error message refers to it).
- [ ] Decide whether to track PyPSA v1.4.0: the fork's `master` moved to v1.4.0
      (352 files changed). Diff `1eb9db0..master`, update
      `src/data/definitions.js` via `scripts/generate_definitions.py`, bump
      `PYPSA_VERSION`, regenerate fixtures and fix what changes.
- [ ] The reference checkout reports `pypsa.__version__ == "0.0"` (no git tags);
      `git fetch --tags` in the PyPSA checkout would make exported
      `pypsa_version` meaningful (the IO test currently masks it).
- [ ] Add a CI workflow (GitHub Actions) running `npm test` on Node 22.

## 2. Features not yet ported

- [ ] **Stochastic optimisation**: `set_scenarios`, scenario dimension on
      components, scenario-weighted objective, CVaR / `set_risk_preference`,
      stochastic statistics. Currently `set_scenarios` throws.
- [ ] **NetworkCollection** (multi-network statistics).
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
- [ ] PyPSA bugs/quirks observed (mirrored or worked around in fixtures):
      clustering crashes under pandas 3 copy-on-write (runner patches
      `determine_network_topology`), loss variable order depends on Python's
      hash seed, MILP duals are all zero (HiGHS), zero-reactance lines break
      `pinv` in post-processing.

## 4. Documentation

- [ ] API reference (JSDoc → generated docs) and examples ported from PyPSA's
      documentation notebooks.
- [ ] Publish to npm (package name, versioning tied to PyPSA version).

"""Execute JSON parity scenarios with PyPSA and store the reference results.

Each scenario in ``test/scenarios/*.json`` is a list of operations that both this
runner (PyPSA, the source of truth) and ``test/scenarios.test.js`` (PSA.js)
interpret.  The recorded outputs become fixtures that the JS tests compare
against.

Usage:  python scripts/parity/run_scenarios.py [scenario-name ...]
"""

from __future__ import annotations

import json
import logging
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pypsa

from common import EXAMPLES, ROOT, dump_network, frame, index_json, series, value, write_fixture

logging.disable(logging.WARNING)
warnings.filterwarnings("ignore")
pypsa.options.params.optimize.log_to_console = False

SCENARIOS = ROOT / "test" / "scenarios"

# Work around read-only arrays under pandas copy-on-write in the pinned PyPSA:
# networks built by clustering can hold read-only column arrays, so in-place
# writes in `determine_network_topology` (`find_slack_bus`) fail. Making the
# static frames writable copies first does not change any result.
_orig_topology = pypsa.Network.determine_network_topology


def _topology_writable(self, *args, **kwargs):
    for c in self.components:
        if not c.static.empty:
            c.static = c.static.copy(deep=True)
    return _orig_topology(self, *args, **kwargs)


pypsa.Network.determine_network_topology = _topology_writable


def decode(v, n):
    """Decode JSON scenario values into python objects."""
    if isinstance(v, dict):
        if "$float" in v:
            return float(v["$float"])
        if "$ts" in v:
            return pd.Timestamp(v["$ts"])
        if "$path" in v:
            return get_path(n, v["$path"])
        if "$date_range" in v:
            return pd.date_range(**v["$date_range"])
        if "$multiindex" in v:
            return pd.MultiIndex.from_tuples([tuple(x) for x in v["$multiindex"]])
        if "$slice" in v:
            return n.snapshots[slice(*v["$slice"])]
        if "$tuple" in v:
            return tuple(decode(x, n) for x in v["$tuple"])
        if "$frame" in v:
            spec = v["$frame"]
            data = np.array([[float(decode(x, n)) for x in row] for row in spec["data"]], dtype=float)
            return pd.DataFrame(data, index=n.snapshots, columns=spec["columns"])
        if "$df" in v:
            spec = v["$df"]
            return pd.DataFrame([[decode(x, n) for x in row] for row in spec["data"]], index=spec["index"], columns=spec["columns"])
        if "$series" in v:
            spec = v["$series"]
            idx = spec.get("index")
            vals = [decode(x, n) for x in spec["values"]]
            return pd.Series(vals, index=n.snapshots if idx is None else idx)
        return {k: decode(x, n) for k, x in v.items()}
    if isinstance(v, list):
        return [decode(x, n) for x in v]
    return v


def to_json(obj):
    if isinstance(obj, pd.DataFrame):
        return {"$type": "frame", **frame(obj)}
    if isinstance(obj, pd.Series):
        return {"$type": "series", **series(obj)}
    if isinstance(obj, pd.Index):
        return {"$type": "index", **index_json(obj)}
    if isinstance(obj, dict):
        return {"$type": "dict", "items": {str(k): to_json(v) for k, v in obj.items()}}
    if isinstance(obj, (list, tuple)):
        return {"$type": "list", "items": [to_json(x) for x in obj]}
    if isinstance(obj, np.ndarray):
        return {"$type": "array", "shape": list(obj.shape), "values": [value(x) for x in obj.ravel()]}
    if hasattr(obj, "toarray"):
        return to_json(np.asarray(obj.toarray()))
    if hasattr(obj, "values") and hasattr(obj, "dims"):  # xarray
        return to_json(obj.to_pandas())
    return {"$type": "value", "value": value(obj)}


def get_path(n, path):
    obj = n
    for p in path:
        if isinstance(p, list):  # call
            name = p[0]
            args = p[1] if len(p) > 1 else []
            kwargs = p[2] if len(p) > 2 else {}
            obj = getattr(obj, name)(*decode(args, n), **decode(kwargs, n))
        elif isinstance(obj, dict) or hasattr(obj, "__getitem__") and (not isinstance(p, str) or not hasattr(obj, p)):
            obj = obj[p]
        else:
            obj = getattr(obj, p)
    return obj


def run(scenario: dict) -> dict:
    state = {"n": None}
    records = {}
    results = {}
    for op in scenario["ops"]:
        if op[0] == "expect_error":
            try:
                _run_op(op[2], state, records, results)
                raised = False
            except Exception:
                raised = True
            records[op[1]] = {"$type": "value", "value": raised}
            continue
        _run_op(op, state, records, results)
    return records


def _run_op(op, state, records, results):
    n = state["n"]
    if True:
        kind = op[0]
        if kind == "load_example":
            n = pypsa.Network(EXAMPLES / op[1] / op[1])
        elif kind == "load_network":
            n = pypsa.Network(ROOT / "test" / "networks" / op[1])
        elif kind == "new_network":
            n = pypsa.Network(**(op[1] if len(op) > 1 else {}))
        elif kind == "set_snapshots":
            n.set_snapshots(decode(op[1], n), **(op[2] if len(op) > 2 else {}))
        elif kind == "set_multi_snapshots":
            n.set_snapshots(pd.MultiIndex.from_tuples([tuple(x) for x in op[1]]))
        elif kind == "set_investment_periods":
            n.set_investment_periods(op[1])
        elif kind == "add":
            opts = op[4] if len(op) > 4 else {}
            n.add(op[1], decode(op[2], n), **opts, **decode(op[3] if len(op) > 3 else {}, n))
        elif kind == "remove":
            n.remove(op[1], op[2])
        elif kind == "set_static":
            _, list_name, attr, mapping = op
            for k, v in mapping.items():
                n.c[list_name].static.loc[k, attr] = decode(v, n)
        elif kind == "set_static_where":
            _, list_name, attr, col, match, v = op
            st = n.c[list_name].static
            st.loc[st[col] == match, attr] = decode(v, n)
        elif kind == "set_static_all":
            _, list_name, attr, v = op
            n.c[list_name].static[attr] = decode(v, n)
        elif kind == "set_dynamic":
            _, list_name, attr, mapping = op
            for k, v in mapping.items():
                n.c[list_name].dynamic[attr].loc[:, k] = decode(v, n)
        elif kind == "set_weightings":
            n.snapshot_weightings.loc[:, op[1]] = decode(op[2], n)
        elif kind == "set_period_weightings":
            n.investment_period_weightings.loc[:, op[1]] = decode(op[2], n)
        elif kind == "call":
            name = op[1]
            args = decode(op[2], n) if len(op) > 2 else []
            kwargs = decode(op[3], n) if len(op) > 3 else {}
            out_key = op[4] if len(op) > 4 else None
            target = n
            for part in name.split("."):
                target = getattr(target, part)
            res = target(*args, **kwargs)
            if out_key:
                results[out_key] = res
        elif kind == "create_model":
            n.optimize.create_model(**decode(op[1] if len(op) > 1 else {}, n))
        elif kind == "add_constraint":
            _, var, dims, sign, rhs, cname = op
            v = n.model.variables[var]
            if isinstance(dims, dict):
                v = v.sel(**decode(dims["sel"], n))
                dims = dims.get("sum", "all")
            expr = v.sum() if dims == "all" else (1 * v if dims is None else v.sum(dim=dims))
            n.model.add_constraints(expr, sign, decode(rhs, n), name=cname)
        elif kind == "add_variable":
            n.model.add_variables(name=op[1])
        elif kind == "solve_model":
            res = n.optimize.solve_model(**decode(op[1] if len(op) > 1 else {}, n))
            if len(op) > 2:
                results[op[2]] = res
        elif kind == "call_replace":
            target = n
            for part in op[1].split("."):
                target = getattr(target, part)
            res = target(*decode(op[2] if len(op) > 2 else [], n), **decode(op[3] if len(op) > 3 else {}, n))
            if len(op) > 4 and op[4]:
                results[op[4]] = res
            n = res.n if hasattr(res, "n") and not isinstance(res, pypsa.Network) else res
        elif kind == "copy":
            n = n.copy(**(op[1] if len(op) > 1 else {}))
        elif kind == "record":
            key, what = op[1], op[2]
            if what == "network":
                records[key] = {"$type": "network", **dump_network(n, skip_standard_types=True)}
            elif what == "result":
                records[key] = to_json(results[op[3]])
            elif what == "result_path":
                records[key] = to_json(get_path(results[op[3]], op[4]))
            elif what == "path":
                records[key] = to_json(get_path(n, op[3]))
            elif what == "model_lp":
                import tempfile, os
                with tempfile.TemporaryDirectory() as d:
                    fn = os.path.join(d, "model.lp")
                    n.model.to_file(fn, io_api="lp", progress=False)
                    records[key] = {"$type": "lp", "text": open(fn).read()}
            elif what == "lp":
                import tempfile, os
                kwargs = decode(op[3] if len(op) > 3 else {}, n)
                m = n.optimize.create_model(**kwargs)
                with tempfile.TemporaryDirectory() as d:
                    fn = os.path.join(d, "model.lp")
                    m.to_file(fn, io_api="lp", progress=False)
                    records[key] = {"$type": "lp", "text": open(fn).read()}
            else:
                raise ValueError(f"unknown record {what}")
        else:
            raise ValueError(f"unknown op {kind}")
    state["n"] = n


def main(names):
    files = sorted(SCENARIOS.glob("*.json"))
    for fn in files:
        name = fn.stem
        if names and name not in names:
            continue
        scenario = json.loads(fn.read_text())
        if scenario.get("skip_python"):
            continue
        records = run(scenario)
        p = write_fixture(f"scenario_{name}", {"records": records}, meta={"scenario": name})
        print("wrote", p.name)


if __name__ == "__main__":
    main(sys.argv[1:])

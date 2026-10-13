"""Helpers to serialise PyPSA (pandas) results to JSON fixtures for PSA.js parity tests."""

from __future__ import annotations

import gzip
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "test" / "fixtures"
EXAMPLES = ROOT / "examples" / "networks"


def label(v):
    if isinstance(v, tuple):
        return [label(x) for x in v]
    if isinstance(v, pd.Timestamp):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def value(v):
    if v is None:
        return None
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        if math.isnan(f):
            return None
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return f
    if isinstance(v, pd.Timestamp):
        return label(v)
    return str(v)


def index_json(idx: pd.Index) -> dict:
    return {"names": [n for n in idx.names], "values": [label(v) for v in idx]}


def frame(df: pd.DataFrame) -> dict:
    return {
        "index": index_json(df.index),
        "columns": [label(c) for c in df.columns],
        "data": {str(label(c)) if not isinstance(c, tuple) else "|".join(map(str, c)): [value(x) for x in df[c].to_numpy()] for c in df.columns},
    }


def series(s: pd.Series) -> dict:
    return {"index": index_json(s.index), "values": [value(x) for x in s.to_numpy()]}


def dump_network(n, include_dynamic=True, skip_standard_types=False) -> dict:
    out = {
        "name": n.name,
        "snapshots": index_json(n.snapshots),
        "snapshot_weightings": frame(n.snapshot_weightings),
        "investment_period_weightings": frame(n.investment_period_weightings),
        "components": {},
    }
    for c in n.components.values():
        st = c.static.drop(columns=["obj"], errors="ignore")
        if skip_standard_types and c.name in ("LineType", "TransformerType"):
            continue
        comp = {"static": frame(st)}
        if include_dynamic:
            comp["dynamic"] = {k: frame(v) for k, v in c.dynamic.items()}
        out["components"][c.list_name] = comp
    return out


def git_rev(path: Path) -> str:
    try:
        return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def write_fixture(name: str, payload: dict, meta: dict | None = None) -> Path:
    import pypsa

    FIXTURES.mkdir(parents=True, exist_ok=True)
    payload = {
        "_meta": {
            "generator": "scripts/parity",
            "pypsa_commit": git_rev(Path(pypsa.__file__).resolve().parents[1]),
            **(meta or {}),
        },
        **payload,
    }
    path = FIXTURES / f"{name}.json.gz"
    data = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
    with gzip.GzipFile(path, "wb", mtime=0) as f:
        f.write(data)
    return path

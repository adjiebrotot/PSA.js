"""Compare regenerated fixtures with the versions committed in git.

Usage: python scripts/parity/diff_fixtures.py [--rev REV] [--rtol RTOL] [fixture ...]

Prints, per fixture, the paths whose values differ (numbers beyond ``rtol``,
strings, structure). LP texts are compared line by line. Exit status is 1 if
any fixture differs.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "test" / "fixtures"


def load_rev(rev: str, rel: str):
    try:
        raw = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{rev}:{rel}"], stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return None
    return json.loads(gzip.decompress(raw))


def num(v):
    if v == "Infinity":
        return math.inf
    if v == "-Infinity":
        return -math.inf
    return v


def lp_lines(text: str) -> list[str]:
    # linopy writes the SOS sets in (non-deterministic) polars group order, so
    # compare them as a set (as test/scenario_runner.js does)
    main, sep, sos = text.partition("\n\nsos\n\n")
    return main.splitlines() + (sorted(sos.splitlines()) if sep else [])


def diff(a, b, path, out, rtol, limit):
    if len(out) >= limit:
        return
    if isinstance(a, dict) and isinstance(b, dict):
        if a.get("$type") == "lp" and b.get("$type") == "lp":
            la, lb = lp_lines(a["text"]), lp_lines(b["text"])
            if la != lb:
                n = sum(x != y for x, y in zip(la, lb)) + abs(len(la) - len(lb))
                first = next((i for i, (x, y) in enumerate(zip(la, lb)) if x != y), min(len(la), len(lb)))
                out.append(f"{path}: LP differs ({len(la)} vs {len(lb)} lines, {n} differ, first at {first}: {la[first:first+1]} -> {lb[first:first+1]})")
            return
        for k in a.keys() | b.keys():
            if k == "_meta":
                continue
            if k not in a or k not in b:
                out.append(f"{path}.{k}: only in {'new' if k in b else 'old'}")
                continue
            diff(a[k], b[k], f"{path}.{k}", out, rtol, limit)
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} -> {len(b)}")
            return
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out, rtol, limit)
        return
    x, y = num(a), num(b)
    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool) and not isinstance(y, bool):
        if x == y or abs(x - y) <= rtol * max(abs(x), abs(y), 1e-300):
            return
        out.append(f"{path}: {a} -> {b}")
        return
    if a != b:
        out.append(f"{path}: {str(a)[:80]!r} -> {str(b)[:80]!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rev", default="HEAD")
    ap.add_argument("--rtol", type=float, default=0.0)
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("names", nargs="*")
    args = ap.parse_args()
    changed = False
    for fn in sorted(FIXTURES.glob("*.json.gz")):
        name = fn.name[: -len(".json.gz")]
        if args.names and name not in args.names:
            continue
        old = load_rev(args.rev, str(fn.relative_to(ROOT)))
        new = json.loads(gzip.decompress(fn.read_bytes()))
        if old is None:
            print(f"{name}: new fixture")
            changed = True
            continue
        out: list[str] = []
        diff(old, new, name, out, args.rtol, args.limit)
        if out:
            changed = True
            print(f"{name}: {len(out)}{'+' if len(out) >= args.limit else ''} differences")
            for line in out:
                print("   ", line)
        else:
            print(f"{name}: identical")
    sys.exit(1 if changed else 0)


if __name__ == "__main__":
    main()

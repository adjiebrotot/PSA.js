"""Pretty-print scenario JSON files with one operation per line.

Usage: python scripts/parity/fmt_scenario.py test/scenarios/foo.json [...]
"""

import json
import sys


def dump(scenario: dict) -> str:
    out = ["{"]
    keys = list(scenario)
    for i, k in enumerate(keys):
        comma = "," if i < len(keys) - 1 else ""
        if k == "ops":
            out.append('  "ops": [')
            ops = scenario["ops"]
            for j, op in enumerate(ops):
                c = "," if j < len(ops) - 1 else ""
                out.append("    " + json.dumps(op) + c)
            out.append("  ]" + comma)
        else:
            out.append(f"  {json.dumps(k)}: {json.dumps(scenario[k])}{comma}")
    out.append("}")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    for fn in sys.argv[1:]:
        with open(fn) as f:
            s = json.load(f)
        with open(fn, "w") as f:
            f.write(dump(s))

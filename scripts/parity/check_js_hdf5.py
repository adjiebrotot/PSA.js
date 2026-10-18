"""Check that HDF5 stores written by PSA.js import in PyPSA exactly like
PyPSA's own stores (the `io_hdf5` fixtures). Needs node and the PSA.js
checkout; not part of `generate_all.sh`.

Usage: python check_js_hdf5.py
"""

import gzip
import json
import logging
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

import pypsa

from common import ROOT, dump_network

logging.disable(logging.WARNING)
warnings.simplefilter("ignore", FutureWarning)

HDF5 = ROOT / "test" / "fixtures" / "hdf5"
SCRIPT = """
import { Network, logger } from "%s/src/index.js";
logger.setLevel("error");
const [src, dst] = process.argv.slice(2);
await (await Network.from_hdf5(src)).export_to_hdf5(dst);
"""


def dump_piecewise(n):
    return {c.list_name: {a: json.loads(df.to_json(orient="split")) for a, df in c.piecewise.items() if not df.empty}
            for c in n.components if any(not df.empty for df in c.piecewise.values())}


def main():
    fixture = json.loads(gzip.decompress((ROOT / "test" / "fixtures" / "io_hdf5.json.gz").read_bytes()))
    failed = 0
    with tempfile.TemporaryDirectory() as d:
        js = Path(d) / "export.mjs"
        js.write_text(SCRIPT % ROOT)
        for name, rec in fixture.items():
            if name.startswith("_"):
                continue
            out = Path(d) / f"{name}.h5"
            subprocess.run(["node", str(js), str(HDF5 / f"{name}.h5"), str(out)], check=True)
            ours, theirs = pypsa.Network(out), pypsa.Network(HDF5 / f"{name}.h5")
            same = (
                json.loads(json.dumps(dump_network(ours))) == rec["network"]
                and ours.meta == rec["meta"]
                and dump_piecewise(ours) == dump_piecewise(theirs)
            )
            failed += not same
            print(f"{name}: {'identical' if same else 'DIFFERENT'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

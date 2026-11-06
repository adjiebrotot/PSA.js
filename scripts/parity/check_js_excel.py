"""Check that Excel workbooks written by PSA.js import in PyPSA exactly like
PyPSA's own workbooks (the `io_excel` fixtures). Needs node and the PSA.js
checkout; not part of `generate_all.sh`.

Usage: python check_js_excel.py
"""

import json
import logging
import subprocess
import sys
import tempfile
from pathlib import Path

import pypsa

from common import ROOT, dump_network

logging.disable(logging.WARNING)

EXCEL = ROOT / "test" / "fixtures" / "excel"
SCRIPT = """
import { Network, logger } from "%s/src/index.js";
logger.setLevel("error");
const [src, dst] = process.argv.slice(2);
Network.from_excel(src).export_to_excel(dst);
"""


def main():
    fixture = json.loads(__import__("gzip").decompress((ROOT / "test" / "fixtures" / "io_excel.json.gz").read_bytes()))
    failed = 0
    with tempfile.TemporaryDirectory() as d:
        js = Path(d) / "export.mjs"
        js.write_text(SCRIPT % ROOT)
        for name, rec in fixture.items():
            if name.startswith("_"):
                continue
            out = Path(d) / f"{name}.xlsx"
            subprocess.run(["node", str(js), str(EXCEL / f"{name}.xlsx"), str(out)], check=True)
            got = json.loads(json.dumps(dump_network(pypsa.Network(out))))
            same = got == rec["network"]
            failed += not same
            print(f"{name}: {'identical' if same else 'DIFFERENT'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

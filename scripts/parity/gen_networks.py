"""Prepare derived input networks (CSV folders) used by parity scenarios.

These networks are produced with PyPSA (source of truth) and stored under
test/networks/<name>/ so that both runners start from identical inputs.
"""

import logging
import shutil
import warnings
from pathlib import Path

import pypsa

from common import EXAMPLES, ROOT

logging.disable(logging.WARNING)
pypsa.options.params.optimize.log_to_console = False
warnings.filterwarnings("ignore")

OUT = ROOT / "test" / "networks"
PYPSA_TEST_DATA = Path(pypsa.__file__).resolve().parents[1] / "test" / "data"


def export(n, name):
    path = OUT / name
    if path.exists():
        shutil.rmtree(path)
    n.export_to_csv_folder(path)
    print("exported", name)


def scigrid_dispatch(nsnapshots):
    n = pypsa.Network(EXAMPLES / "scigrid-de" / "scigrid-de")
    n.set_snapshots(n.snapshots[:nsnapshots])
    n.c.lines.static.s_max_pu = 0.7
    n.c.lines.static.loc[["316", "527", "602"], "s_nom"] = 1715
    n.c.storage_units.static.state_of_charge_initial = 0.0
    n.optimize(n.snapshots, include_objective_constant=False)
    n.c.generators.dynamic.p_set = n.c.generators.dynamic.p
    n.c.storage_units.dynamic.p_set = n.c.storage_units.dynamic.p
    n.model.solver_model = None
    return n


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    # AC-DC meshed with link set points from PyPSA's lpf reference results
    n = pypsa.Network(EXAMPLES / "ac-dc-meshed" / "ac-dc-meshed")
    n_r = pypsa.Network(PYPSA_TEST_DATA / "ac-dc-meshed" / "results-lpf")
    n.c.links.dynamic.p_set = n_r.c.links.dynamic.p_set
    export(n, "ac-dc-lpf")

    # SciGrid with optimised dispatch as set points (lpf / pf inputs)
    n = scigrid_dispatch(4)
    m = n.copy()
    m.c.generators.static.control = "PV"
    f = m.c.generators.static[m.c.generators.static.bus == "492"]
    m.c.generators.static.loc[f.index, "control"] = "PQ"
    export(m, "scigrid-pf")
    export(n, "scigrid-lpf")


if __name__ == "__main__":
    main()

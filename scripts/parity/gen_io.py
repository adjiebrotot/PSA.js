"""Reference fixtures: importing the example CSV networks and exporting them
again (CSV and netCDF) with PyPSA."""

import logging
import tempfile
from pathlib import Path

import pypsa

from common import EXAMPLES, ROOT, dump_network, write_fixture

logging.disable(logging.WARNING)
pypsa.options.params.optimize.log_to_console = False

NETCDF = ROOT / "test" / "fixtures" / "netcdf"
NETCDF.mkdir(parents=True, exist_ok=True)


def export_csv(n):
    with tempfile.TemporaryDirectory() as d:
        n.export_to_csv_folder(d)
        return {p.name: p.read_text() for p in sorted(Path(d).iterdir())}


for ex in ["ac-dc-meshed", "storage-hvdc", "model-energy", "scigrid-de"]:
    n = pypsa.Network(EXAMPLES / ex / ex)
    p = write_fixture(f"io_{ex}", {"network": dump_network(n), "export": export_csv(n)})
    print("wrote", p)
    n.export_to_netcdf(NETCDF / f"{ex}.nc")

# solved network (objective attributes, results) and a multi-period network
n = pypsa.Network(EXAMPLES / "ac-dc-meshed" / "ac-dc-meshed")
n.optimize(include_objective_constant=True)
n.model.solver_model = None
n.export_to_netcdf(NETCDF / "ac-dc-meshed-solved.nc")
write_fixture("io_solved", {"network": dump_network(n), "export": export_csv(n),
                            "network_nc": dump_network(pypsa.Network(NETCDF / "ac-dc-meshed-solved.nc"))})

n = pypsa.Network(snapshots=range(4))
n.investment_periods = [2020, 2030]
n.add("Bus", ["a", "b"])
n.add("Generator", "g", bus="a", p_nom_extendable=True, capital_cost=10, build_year=2020, lifetime=30, p_max_pu=[0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.4, 0.3])
n.add("Line", "ab", bus0="a", bus1="b", x=0.1, s_nom=10)
n.add("Load", "l", bus="b", p_set=5)
n.investment_period_weightings.loc[:, "objective"] = [1.0, 0.5]
n.export_to_netcdf(NETCDF / "multiperiod.nc")
write_fixture("io_multiperiod", {"network": dump_network(n), "export": export_csv(n),
                                 "network_nc": dump_network(pypsa.Network(NETCDF / "multiperiod.nc"))})
print("wrote netcdf fixtures")

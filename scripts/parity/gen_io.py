"""Reference fixtures: importing the example CSV networks and exporting them
again (CSV, netCDF, Excel and HDF5) with PyPSA."""

import logging
import tempfile
from pathlib import Path

import pypsa

from common import EXAMPLES, ROOT, dump_network, frame, write_fixture

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

# piecewise breakpoint data (equal breakpoint counts: PyPSA's netCDF export
# truncates curves when piecewise attributes have different lengths)
def dump_piecewise(n):
    return {c.list_name: {a: frame(df) for a, df in c.piecewise.items() if not df.empty}
            for c in n.components if any(not df.empty for df in c.piecewise.values())}


n = pypsa.Network(snapshots=range(2))
n.add("Bus", ["a", "b"])
n.add("Generator", ["g1", "g2"], bus="a", p_nom=50, marginal_cost={0: 0, 0.5: 10, 1: 30})
n.add("Generator", "g3", bus="a", p_nom_extendable=True, capital_cost={0: 0, 50: 2, 100: 5})
n.add("Link", "l", bus0="a", bus1="b", bus2="b", p_nom=20,
      efficiency={0: 0, 0.5: 0.4, 1: 0.45}, efficiency2={0: 0, 0.5: 0.1, 1: 0.2})
n.add("Load", "d", bus="b", p_set=5)
n.export_to_netcdf(NETCDF / "piecewise.nc")
m = pypsa.Network(NETCDF / "piecewise.nc")
write_fixture("io_piecewise", {"network_nc": dump_network(m), "export": export_csv(n),
                               "piecewise": dump_piecewise(n), "piecewise_nc": dump_piecewise(m)})
# solved stochastic network (scenario coordinate, (scenario, name) data)
n = pypsa.Network(EXAMPLES / "ac-dc-meshed" / "ac-dc-meshed")
n.set_snapshots(n.snapshots[:4])
n.set_scenarios({"low": 0.3, "high": 0.7})
n.c.generators.static.loc[("high", "Manchester Gas"), "marginal_cost"] = 40
n.c.generators.dynamic.p_max_pu.loc[:, ("high", "Manchester Wind")] = [0.1, 0.2, 0.3, 0.4]
n.c.loads.dynamic.p_set.loc[:, ("low", "London")] = [100, 200, 300, 400]
n.optimize(include_objective_constant=False)
n.model.solver_model = None
n.export_to_netcdf(NETCDF / "stochastic.nc")
write_fixture("io_stochastic", {"network": dump_network(n), "network_nc": dump_network(pypsa.Network(NETCDF / "stochastic.nc"))})
# shapes: WKT geometries in shapely's canonical form, exported rounded
n = pypsa.Network(ROOT / "test" / "networks" / "shapes")
n.export_to_netcdf(NETCDF / "shapes.nc")
write_fixture("io_shapes", {"network": dump_network(n), "export": export_csv(n),
                            "network_nc": dump_network(pypsa.Network(NETCDF / "shapes.nc"))})

# float32 netCDF export (values rounded to single precision)
n = pypsa.Network(NETCDF / "ac-dc-meshed-solved.nc")
n.export_to_netcdf(NETCDF / "ac-dc-meshed-f32.nc", float32=True)
write_fixture("io_float32", {"network_nc": dump_network(pypsa.Network(NETCDF / "ac-dc-meshed-f32.nc"))})
print("wrote netcdf fixtures")

# Excel: PyPSA's export of the networks above and PyPSA's re-import of it
EXCEL = ROOT / "test" / "fixtures" / "excel"
EXCEL.mkdir(parents=True, exist_ok=True)
excel_sources = {ex: pypsa.Network(EXAMPLES / ex / ex) for ex in ["ac-dc-meshed", "storage-hvdc", "model-energy", "scigrid-de"]}
excel_sources["ac-dc-meshed-solved"] = pypsa.Network(NETCDF / "ac-dc-meshed-solved.nc")
excel_sources["multiperiod"] = pypsa.Network(NETCDF / "multiperiod.nc")
excel_sources["piecewise"] = pypsa.Network(NETCDF / "piecewise.nc")
excel_records = {}
for name, n in excel_sources.items():
    fn = EXCEL / f"{name}.xlsx"
    if fn.exists():
        fn.unlink()
    n.export_to_excel(fn)
    m = pypsa.Network(fn)
    excel_records[name] = {"network": dump_network(m), "piecewise": dump_piecewise(m)}
write_fixture("io_excel", excel_records)
print("wrote excel fixtures")

# HDF5 (pandas HDFStore / PyTables): PyPSA's export of the networks above and
# PyPSA's re-import of it
HDF5 = ROOT / "test" / "fixtures" / "hdf5"
HDF5.mkdir(parents=True, exist_ok=True)
hdf5_sources = dict(excel_sources)
hdf5_sources["shapes"] = pypsa.Network(NETCDF / "shapes.nc")
hdf5_sources["ac-dc-meshed-meta"] = pypsa.Network(EXAMPLES / "ac-dc-meshed" / "ac-dc-meshed")
hdf5_sources["ac-dc-meshed-meta"].meta = {"note": "Größe €", "values": [1, 2.5, None], "nested": {"a": True}}
hdf5_records = {}
for name, n in hdf5_sources.items():
    fn = HDF5 / f"{name}.h5"
    n.export_to_hdf5(fn)
    m = pypsa.Network(fn)
    hdf5_records[name] = {"network": dump_network(m), "piecewise": dump_piecewise(m), "meta": m.meta}
write_fixture("io_hdf5", hdf5_records)
print("wrote hdf5 fixtures")

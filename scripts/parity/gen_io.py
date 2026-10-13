"""Reference fixtures: importing the example CSV networks."""

import logging

import pypsa

from common import EXAMPLES, dump_network, write_fixture

logging.disable(logging.WARNING)

for ex in ["ac-dc-meshed", "storage-hvdc", "model-energy", "scigrid-de"]:
    n = pypsa.Network(EXAMPLES / ex / ex)
    p = write_fixture(f"io_{ex}", {"network": dump_network(n)})
    print("wrote", p)

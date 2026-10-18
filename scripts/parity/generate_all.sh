#!/usr/bin/env bash
# Regenerate every PyPSA reference fixture used by the PSA.js parity tests.
#
# Requires a Python environment with the reference PyPSA checkout installed
# (e.g. `pip install -e ../PyPSA`). The PyPSA checkout needs its release tags
# (`git fetch --tags`) so that `pypsa.__version__` is meaningful.
#
# Usage: scripts/parity/generate_all.sh
set -euo pipefail

cd "$(dirname "$0")"
export PYTHONHASHSEED=0
# see common.py: use libm instead of numpy's AVX-512 loops
export NPY_DISABLE_CPU_FEATURES="X86_V4 AVX512_ICL AVX512_SPR"

version=$(python -c "import pypsa; print(pypsa.__version__)" 2>/dev/null)
echo "PyPSA ${version}"
case "$version" in
  0.0*) echo "warning: PyPSA version unresolved; run 'git fetch --tags' in the PyPSA checkout" >&2 ;;
esac
# installing tsam with its dependencies downgrades numpy/pandas (see requirements.txt)
python - <<'EOF'
import re, sys
from importlib.metadata import version
for pkg in ("numpy", "pandas", "scipy", "highspy", "linopy"):
    pin = re.search(rf"^{pkg}==(\S+)", open("requirements.txt").read(), re.M)
    if pin and version(pkg) != pin.group(1):
        print(f"warning: {pkg} {version(pkg)} installed, requirements.txt pins {pin.group(1)}", file=sys.stderr)
EOF

python ../generate_definitions.py
python gen_networks.py
python gen_io.py
python run_scenarios.py

"""Make the mqttlog scripts importable as modules from the tests.

They are executable scripts rather than a package, so the directory holding
them goes on sys.path.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

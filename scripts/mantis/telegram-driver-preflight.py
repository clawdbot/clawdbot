#!/usr/bin/env python3
"""Check only cached pinned TDLib; no broker, session, Telegram call, or download."""
import ctypes
import importlib.util
import platform
import sys

prepare = len(sys.argv) == 3 and sys.argv[1] == "--prepare"
spec = importlib.util.spec_from_file_location("telegram_driver", sys.argv[2] if prepare else sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
package, filename, checksum = module.TDLIB_PREBUILT[(platform.system().lower(), platform.machine().lower())]
if prepare:
    # Canonical helper checksum-verifies the pinned public package; no session
    # configuration, broker request, or Telegram authorization is performed.
    module.ensure_prebuilt_tdjson()
root = module.TDLIB_CACHE_ROOT / checksum[:16]
found = list(root.rglob(filename))
if len(found) != 1:
    raise RuntimeError("Pinned TDLib binary is not prepared; prepare it before leasing credentials")
ctypes.CDLL(str(found[0]))
print(found[0])

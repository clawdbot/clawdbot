#!/usr/bin/python3
"""Confine a bundle mutation to the caller's fixed app and private temp roots."""
import os
import subprocess
import sys

PROFILE = '''(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath (param "APP")) (subpath (param "TEMP")))'''

if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit("Usage: mac-bundle-mutation.py <app-root> <temp-root> <command> [args...]")
    app_root, temp_root = sys.argv[1:3]
    # Seatbelt does not revoke already-open writable descriptors. Only the
    # caller's standard I/O belongs across this boundary; paths remain kernel-checked.
    result = subprocess.run(
        ["/usr/bin/sandbox-exec", "-D", f"APP={app_root}", "-D", f"TEMP={temp_root}",
         "-p", PROFILE, *sys.argv[3:]],
        env={**os.environ, "TMPDIR": temp_root},
        close_fds=True,
    )
    raise SystemExit(result.returncode if result.returncode >= 0 else 128 - result.returncode)

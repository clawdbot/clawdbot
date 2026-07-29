---
name: python-debugpy
description: Debug Python with pdb, breakpoint(), post-mortem inspection, and debugpy remote attach.
metadata: { "openclaw": { "requires": { "bins": ["python3"] } } }
---

# Python Debugpy

Use when Python code needs interactive debugging: hidden locals, confusing state mutation, failing tests, subprocesses, long-running services, or remote/headless attach.

Pick the smallest debugger that reaches the bad frame.

## Choose

- `breakpoint()`: local code, source edits ok, fastest path.
- `python3 -m pdb`: no source edit, launch from the beginning.
- `python3 -m pdb -c continue`: stop at an unhandled exception.
- `debugpy`: remote/headless process, DAP client, already-running PID, or service startup race.

## Commands

```bash
python3 -m pdb path/to/script.py arg1
python3 -m pdb -c continue path/to/script.py
python3 -c "import debugpy" || python3 -m pip install debugpy
python3 -m debugpy --listen 127.0.0.1:5678 --wait-for-client path/to/script.py
python3 -m debugpy --listen 127.0.0.1:5678 --wait-for-client -m package.module
python3 -m debugpy --listen 127.0.0.1:5678 --pid <pid>
```

For source-edit attach:

```py
import debugpy

debugpy.listen(("127.0.0.1", 5678))
debugpy.wait_for_client()
debugpy.breakpoint()
```

For post-mortem:

```py
import pdb, sys

try:
    run()
except Exception:
    pdb.post_mortem(sys.exc_info()[2])
    raise
```

## pdb

- Flow: `n`, `s`, `r`, `c`, `q`.
- Stack/source: `w`, `u`, `d`, `a`, `l`, `ll`.
- Values: `p expr`, `pp expr`, `display expr`.
- Breakpoints: `b file.py:42`, `b func`, `b file.py:42, condition`, `cl <num>`.
- Mutate/evaluate: `!statement`; full REPL: `interact`.

## Rules

- Reproduce with the smallest command/test first.
- Disable parallel test workers for pdb; interactive stdin usually breaks inside worker pools.
- Keep `debugpy` in the active env; do not add it as a project dependency unless the project already wants it.
- Bind debug servers to `127.0.0.1`; do not expose `0.0.0.0` unless isolated or tunnelled.
- Use unique ports for parallel sessions.
- Treat `debugpy --pid` as injection; avoid security-sensitive or production targets unless explicitly approved.
- If PID attach fails on Linux, check ptrace/container privileges before changing the target.
- Cleanup before commit: `rg -n 'breakpoint\\(|pdb\\.set_trace|debugpy\\.' --type py`.
- Rerun the normal project test/gate without the debugger.
- `PYTHONBREAKPOINT=0` disables `breakpoint()`.
- If a process is stuck after debugger detach, confirm it is not still paused at a breakpoint.

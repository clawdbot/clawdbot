# OpenClaw #85651 current-upstream drift cure journal

## §0 — 2026-08-24T15:24Z — corrected gate setup and authoritative dispatch baseline

- Destination: `codeagent/openclaw-85651-current-upstream-drift-cure-20260824`
- Reviewed parent: `2891a08d61520623ccf93ddf0a05747d26a615ed`
- Frozen upstream: `a6a9f553d0b304aa4ae520c5c96450201f566765`
- Merge base / PR-creation anchor: `19d44d3f38bf2bbab525cfc1326d23ad98d3cd63`
- Verified savegame: `refs/heads/savegame/20260824-1506Z/85651-label-safe-pre-drift`
  at the reviewed parent.

The first §0 attempt used the product checkout path and failed with exit 127
because the gate is bootstrap-owned. Per the setup correction, the authoritative
run used only the clean bootstrap checkout
`/tmp/openclaw-bootstrap-gates-342cc9c6d190` at
`342cc9c6d190e1ba57d9995d29e394c993a3e79b`, after verifying its tree was clean
and `tools/drift-cure-gate.sh` was executable. The stale dirty shared bootstrap
clone was not touched.

Exact invocation:

```text
OPENCLAW_BOOTSTRAP=/tmp/openclaw-bootstrap-gates-342cc9c6d190 \
  "$OPENCLAW_BOOTSTRAP/tools/drift-cure-gate.sh" \
  a6a9f553d0b304aa4ae520c5c96450201f566765 \
  2891a08d61520623ccf93ddf0a05747d26a615ed \
  19d44d3f38bf2bbab525cfc1326d23ad98d3cd63 \
  <session-artifact-outdir>
```

Authoritative at-dispatch result: 945 files examined; 580 `GENUINE`, 66
`MIXED-CLOBBER`, 299 `SAFE-NEW`, and 0 `FROZEN-STALE`. The prior workorder
snapshot did not provide authoritative FROZEN/MIXED counts, so this run is the
sole baseline. Gate exit 0 permits the exact `--no-ff` back-merge. The 66 mixed
rows are a required post-merge disposition walk, not automatic restoration.

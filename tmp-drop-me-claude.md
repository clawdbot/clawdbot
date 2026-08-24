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

## §1 — 2026-08-24T15:39Z — exact upstream back-merge conflict resolution

Back-merged frozen upstream `a6a9f553d0b304aa4ae520c5c96450201f566765`
with `--no-ff`. Git produced exactly the seven conflicts predicted by the
workorder. Every resolution used stage-1 ancestor, stage-2 reviewed bytes, and
stage-3 upstream bytes; no side-selection strategy was used.

- `src/agents/embedded-agent-runner/compact.hooks.test.ts`: retained the
  reviewed nested-compaction invariant (`disableContinuationTools: true`) and
  absorbed upstream's stronger table-driven final permission-policy/exec-mode
  proof.
- `src/agents/embedded-agent-subscribe.ts`: retained the reviewed extraction to
  canonical `createEmbeddedToolLifecycle`; projected upstream's new nested
  lifecycle provenance into that owner in
  `src/agents/embedded-agent-subscribe.handlers.tools.ts`, preventing nested
  catalog execution from owning the outer block-reply boundary.
- `src/gateway/server-maintenance.ts`: retained delegate-artifact GC constants
  and absorbed upstream telemetry maintenance cadence. Both timer owners and
  their cancellation paths remain present.
- `src/plugins/npm-install-security-scan.release.test.ts`: upstream's generated
  Codex source-region attribution strictly supersedes the reviewed first-region
  approximation by tracking nested region start/end state and rejecting
  unattributed findings. Resolved bytes equal upstream exactly.
- The three `test/vitest/vitest.unit-fast*.config.ts` conflicts resolve to
  upstream exactly. Upstream preserves the reviewed environment-pattern
  intersection while consolidating it into `includeFromEnv`.

Direct Codex contract check was mandatory because the drift touches the Codex
app-server integration. The sibling source was absent and was cloned to
`../codex`; pinned tag `rust-v0.148.0` matches
`extensions/codex/package.json`. Inspected
`codex-rs/app-server-protocol/src/protocol/v2/item.rs` dynamic call params and
response shapes, `codex-rs/app-server/src/bespoke_event_handling.rs` request
projection, and `codex-rs/app-server/tests/suite/v2/dynamic_tools.rs` request /
response lifecycle. The contract carries exact thread, turn, call, namespace,
tool, arguments, content items, and success fields; the absorbed OpenClaw
changes remain aligned with that pinned runtime contract.

## §2 — 2026-08-24T15:46Z — primitive-core preservation correction

The first Gate 2 run rejected
`src/agents/embedded-agent-runner/compact.hooks.test.ts`: the manually combined
test blob preserved both assertions semantically, but the canonical walker
could not reproduce it as reviewed bytes plus an exact clean upstream
projection. This is a real Gate 2 failure, not a waiver candidate.

History localized upstream's conflict to `a435cf6840c` and showed that its
production permission-policy fix is independently covered by new
`src/agents/embedded-agent-runner/run.session-permissions.test.ts` plus the
Codex `session-permission-policy` and `run-attempt-connection` suites. The
conflicting primitive-core change only strengthened an overlapping assertion.
Therefore the mechanically safe resolution is:

1. preserve the reviewed `compact.hooks.test.ts` blob exactly, including the
   nested-compaction continuation-disable proof;
2. retain all upstream production permission-policy bytes and the independent
   upstream tests outside that primitive core;
3. rerun Gate 2 against the committed correction, then run both reviewed and
   upstream permission test owners.

The restored blob is
`9b9a3004ed1fc0050cd96a4768f35526dbf6e79f`, exactly matching reviewed parent
`2891a08d61520623ccf93ddf0a05747d26a615ed`.

## §2.5 — 2026-08-24T16:44Z — touched-test semantic enumeration

Enumerated 558 upstream-touched test/support paths and reduced them to 26 real
candidate-vs-upstream intersections using `git ls-tree` existence checks.
Exact frozen-upstream baseline reproduced all 12 QA Lab failures while reviewed
parent passed 40/40; these are upstream-class and remain outside this lane.

The agents group found one candidate-only failure:
`subagent-announce-delivery.test.ts` auto-merged upstream's
`runDescendantWake` role-policy test against the reviewed descendant-wake
owner, where that obsolete API no longer exists. Exact upstream passed 187/187
and reviewed parent passed 188/188.

Preserved upstream's `operatorRoleActor: { kind: "system" }` contract at the
canonical reviewed `wakeSubagentRunAfterDescendants` boundary by extending its
existing successful-wake test. Removed only the stale delivery-test import and
duplicate old call shape; no production API or behavior changed.

The complete 26-path intersection set produced 2,166 passing assertions, 12
upstream-class QA Lab failures, and 4 skips. The corrected descendant-wake owner
added 5/5 passing sibling assertions. The announce-format E2E owner passed
89/89 with the repository E2E config after removing only its generic global
dist-build setup in an untracked temporary config; that setup failed before
collection because the deliberately unreconciled worktree dependency link
lacks the current `TuiMainScreen` export. The temporary config was deleted.

## §2.7 — 2026-08-24T16:49Z — frozen-wall and mixed disposition

Gate 2.7 at `7af720b791fe780476ce9f279a1e7807e283c3c9` examined 942
reviewer-visible paths: 639 `GENUINE`, 300 `SAFE-NEW`, 3 `MIXED-CLOBBER`, and
zero `FROZEN-STALE`. All three mixed rows were walked line-by-line:

- `subagent-announce-delivery.test.ts` (22 lines): only upstream's obsolete
  `runDescendantWake` import/test call shape. The role-policy assertion is now
  retained at the canonical reviewed wake-owner test.
- `compact.hooks.test.ts` (14 lines): the known overlapping upstream
  permission-policy table. Gate 2 requires exact reviewed bytes; upstream's
  production fix remains independently covered by
  `run.session-permissions.test.ts` and the Codex permission suites.
- `embedded-agent-subscribe.ts` (1 line): upstream's
  `lifecycleProvenance: "nested"` moved with the reviewed lifecycle extraction
  into `embedded-agent-subscribe.handlers.tools.ts`, its canonical owner.

No mixed row is an upstream-only stale blob, so no restoration is warranted.
Gate 2 reran clean at the same SHA: 40 invariants, 0 failures, 2 exact-upstream
projections, and 3 tombstones.

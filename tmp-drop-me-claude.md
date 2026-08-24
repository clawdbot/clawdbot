# PR #85651 latest-upstream drift-cure journal

## §0 — 2026-08-24 rebaseline

- Reviewed candidate and server branch both resolve to `02f6c389e133a8fad28f97ca746661e3e54d4e9e`.
- Frozen upstream is `6fe4e11a786bdd6ba366bb34a0c2e0f91fe3bc85`; merge base is the expected absorbed upstream `a6a9f553d0b304aa4ae520c5c96450201f566765`.
- Server savegame `savegame/20260824-2042Z/85651-reviewed-02f6-pre-latest-drift` resolves to the reviewed candidate SHA.
- Gate 2.7 rebaseline examined 944 files: 628 GENUINE, 299 SAFE-NEW, 17 MIXED-CLOBBER, and 0 FROZEN-STALE.
- The 17-row mixed surface matches the dispatch preview. No stacking-complexity deviation or unpreviewed row appeared, so the frozen inputs remain authoritative.

## §1 — 2026-08-24 frozen-upstream back-merge

- Back-merged exact frozen upstream `6fe4e11a786bdd6ba366bb34a0c2e0f91fe3bc85` with `--no-ff`; Git produced the previewed 259-file delta and six content conflicts.
- `embedded-agent-subscribe.handlers.messages.update.ts` keeps continuation filtering, phase-pending transitions, item identity, and delivery-generation fencing while adopting upstream's cumulative native-commentary snapshot emission.
- `embedded-agent-subscribe.reply-delivery.ts` keeps the generation-tagged async delivery map, retry order, and deferred delivery flow while adding upstream's per-item native-commentary progress dedupe.
- Gateway shutdown keeps upstream's nullable aggregate `GatewayMaintenanceHandles` owner and threads it through lifecycle/close, while retaining the candidate's delegate-artifact cleanup handle and shutdown cleanup.
- `server-close.test.ts` follows the aggregate maintenance shape, including its delegate cleanup timer, and retains the standalone delegate cleanup assertion. `server-runtime-handles.ts` starts with `maintenance: null` and the candidate cleanup handle unset.
- Every resolution was composed from ancestor, candidate, and upstream intent; no file used wholesale side selection.

## §2 — 2026-08-24 primitive-core preservation

- Gate 2 compared reviewed `02f6c389e133a8fad28f97ca746661e3e54d4e9e` with merge checkpoint `326093c8dca84923ef53ffae7a449fd4e1c86c27`, projecting only exact frozen-upstream `6fe4e11a786bdd6ba366bb34a0c2e0f91fe3bc85`.
- All 40 primitive-core invariants passed byte preservation: 37 exact reviewed blobs and three tombstones; zero failures and zero empty patterns.

## §2.5 — 2026-08-24 semantic-conflict enumeration and cure

- Enumerated all 111 test/support paths changed by the 27-commit `a6a9f553..6fe4e11a` upstream delta. Seven intersect the candidate feature surface: Codex dynamic tools, Feishu delivery trace, two commentary/stream-item owners, chat gateway, shutdown, and server-method projection.
- The first focused run found three shutdown failures: the newly aggregated delegate timer remained live in fake-timer assertions because `server-close.ts` cleared only upstream's original aggregate members. The architectural owner is the aggregate maintenance branch, so close now clears `maintenance.delegateArtifactCleanup` before invoking its composite cleanup callback; no test-only workaround was used.
- The exact rerun passed all seven intersections across four Vitest shards: 517 tests.
- Direct pinned Codex `rust-v0.148.0` contract inspection confirmed dynamic calls carry thread, turn, call, namespace, tool, and arguments through `codex-rs/app-server-protocol/src/protocol/v2/item.rs`, are projected in `codex-rs/app-server/src/bespoke_event_handling.rs`, and return typed content plus success in `codex-rs/app-server/tests/suite/v2/dynamic_tools.rs`.

## §2.7 — 2026-08-24 canonical-baseline correction

- The first canonical `19d44d3f` Gate 2.7 run returned zero FROZEN-STALE but seven MIXED-CLOBBER rows, not the protected six-row surface. The unexpected row was `embedded-agent-subscribe.handlers.messages.update.ts`, where the initial conflict resolution had semantically recreated upstream native commentary but dropped five exact post-fork snapshot-selection lines.
- Restored upstream's Responses-vs-native snapshot selection and commentary-data gate verbatim, then routed the selected snapshot through the candidate continuation filter and phase-pending transition owner. This preserves snapshot semantics, item identity, delivery-generation fencing, and continuation filtering without adding a disposition row.
- The focused commentary and stream-item owners pass 22/22 after the correction. Canonical Gate 2.7 must be rerun at the new immutable checkpoint and is not declared green by this entry.

The corrected checkpoint restored the canonical result: 945 files examined, 639 GENUINE, 300 SAFE-NEW, six MIXED-CLOBBER, and zero FROZEN-STALE. All six rows retain their prior reviewed dispositions; exact `a6a9f553..6fe4e11a` path checks confirm the latest drift touched none:

- `subagent-announce-delivery.test.ts` (22): obsolete `runDescendantWake` call shape remains rehomed to the canonical descendant-wake owner, which carries the upstream system-role assertion.
- `compact.hooks.test.ts` (14): exact reviewed primitive-core bytes remain protected by Gate 2; upstream permission behavior remains covered at the session-permission owner and Codex permission suites.
- `code-mode.bridge.lifecycle.test.ts` (2): obsolete flat trust inputs remain rehomed into the reviewed closed `subscriptionToolTrust` object.
- `embedded-agent-subscribe.ts` (1): nested lifecycle provenance remains rehomed with the reviewed extraction into `embedded-agent-subscribe.handlers.tools.ts`.
- `message-tool.test.ts` (2): upstream's retired `withTempDir` name remains replaced by the canonical `withTestDir` helper at both import and call.
- `telegram-emoji-list-gateway.e2e.test.ts` (2): the same canonical `withTestDir` helper replacement remains at the plugin-SDK import and call.

No row contains frozen upstream-only content, so no restoration is warranted. Gate 2 reran at the same checkpoint with all 40 invariants passing and three tombstones.

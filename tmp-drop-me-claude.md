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

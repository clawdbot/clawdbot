# PR #85651 latest-upstream drift-cure journal

## §0 — 2026-08-24 rebaseline

- Reviewed candidate and server branch both resolve to `02f6c389e133a8fad28f97ca746661e3e54d4e9e`.
- Frozen upstream is `6fe4e11a786bdd6ba366bb34a0c2e0f91fe3bc85`; merge base is the expected absorbed upstream `a6a9f553d0b304aa4ae520c5c96450201f566765`.
- Server savegame `savegame/20260824-2042Z/85651-reviewed-02f6-pre-latest-drift` resolves to the reviewed candidate SHA.
- Gate 2.7 rebaseline examined 944 files: 628 GENUINE, 299 SAFE-NEW, 17 MIXED-CLOBBER, and 0 FROZEN-STALE.
- The 17-row mixed surface matches the dispatch preview. No stacking-complexity deviation or unpreviewed row appeared, so the frozen inputs remain authoritative.

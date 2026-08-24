# OpenClaw #85651 third final frozen drift-cure journal

## §0 — 2026-08-24 authoritative rebaseline

- Candidate, tracking branch, and server branch resolve to `9794b4a50a88c59f5cb8061133667b22ca9d5426`.
- Frozen upstream is `0d4e369b1c3df59cd77b59bba87aac17884742b1`; merge base and prior absorbed upstream are exactly `6fe4e11a786bdd6ba366bb34a0c2e0f91fe3bc85`.
- Server savegame `savegame/20260824-2240Z/85651-reviewed-9794-pre-third-drift` resolves to the candidate SHA.
- Authoritative Gate 2.7 rebaseline examined 944 files: 641 GENUINE, 299 SAFE-NEW, four MIXED-CLOBBER, and zero FROZEN-STALE.
- The four mixed paths and counts match the dispatch preview: UI session-management groups 40, cron timer execution 20, assertion baseline 3, and install script test 2.
- The frozen delta contains 22 commits and the merge base matches dispatch. The merge-tree clean preview does not waive per-path semantic composition or the separate chat-history owner audit.

## §1 — pre-merge semantic audit

- `config/assertion-safety-baseline.txt` has independent additive rows: the candidate owns five continuation/storage rows; upstream owns three Matrix/Slack/embedded-stub rows.
- `src/cron/service/timer-execution.ts` composes the candidate `HeartbeatRunResult` contract rehome with upstream effective-agent notification/wake routing and main-session delivery context.
- `test/scripts/install-sh.test.ts` composes the candidate Arch package-manager isolation with upstream npm-probe timing in a separate test location.
- `ui/src/e2e/session-management.groups.e2e.test.ts` composes candidate hover-control pointer-event assertions with upstream command-palette/catalog/search coverage; neither intent replaces the other.
- Upstream moves the bounded raw-tail scan into `src/gateway/session-history-tail.ts` and shares it across chat history, SSE, and HTTP snapshot owners. Both incremental and imported projections retain `includeCommentaryFallbacks: true`; candidate continuation code does not modify these owners, so transcript continuation consumers remain compatible with the centralized projection.
- The only upstream `src/skills` change is `src/skills/discovery/chat-command-invocation.ts`; it is upstream-only and must absorb byte-exact. Candidate `src/skills` and `r: skill` label deltas remain forbidden.

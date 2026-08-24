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

## §2 — merge and preservation gates

- Merge checkpoint `4ae73a4b969639a7182a990dc0264849ff86656b` has first parent `fbcaef0b9ab6f615bcf4c5206a8ed5e7232bdab5` and exact frozen-upstream second parent `0d4e369b1c3df59cd77b59bba87aac17884742b1`.
- Gate 2 passed all 40 primitive-core invariants: zero failures, zero upstream projections, three protected tombstones, and zero empty patterns.
- Canonical-19d Gate 2.7 examined 945 files while this journal is tracked: 639 GENUINE, 300 SAFE-NEW, the canonical six MIXED-CLOBBER rows, and zero FROZEN-STALE. Journal removal must return the terminal count to 944 files and 299 SAFE-NEW.
- The six rows retain their reviewed dispositions: descendant-wake role-policy rehome (22), compaction-hook exact core (14), closed Code Mode trust rehome (2), nested lifecycle provenance rehome (1), message-tool `withTestDir` (2), and Telegram QA `withTestDir` (2). Latest upstream touched none.
- Gate 2.5 enumerated 47 upstream-touched test/support paths and two candidate-feature intersections: install-sh and UI session-management groups. Both files passed, 152/152 tests.
- Direct focused history, cron, HTTP, continuation reconciliation, commentary,
  delivery, and shutdown proof passed 685 tests. The
  `sessions-history-http.test.ts` E2E shard was blocked before collection by
  the existing `TuiMainScreen` dependency export mismatch.
- Five commentary stream-phase assertions failed identically on exact reviewed
  parent `9794b4a` in a directly executed isolated archive (20 pass, same five
  fail), and every local owner/dependency byte is unchanged by the third
  absorb; this is a proven pre-existing candidate baseline, not third-cycle
  drift.

## §3 — direct static and dead-code proof

- Production and test type checks directly reproduce the reviewed-candidate
  dependency baseline: missing `FinishReason.TOO_MANY_TOOL_CALLS`, missing
  named `markdown-it` types, missing `TuiMainScreen`, and their derived
  implicit-any diagnostics. The targeted Oxlint wrapper reaches the same
  plugin-SDK boundary failure before lint collection.
- `check-changed` passed conflict-marker, max-lines, assertion-safety,
  attribution, doctor-registry, extension/plugin-SDK export, duplicate,
  coercion-helper, and dependency-pin guards. Its all-diff formatting spawn hit
  OS `E2BIG`; targeted Oxfmt and direct Oxlint passed the affected owners.
- `git diff --check`, exact upstream `src/skills`, zero candidate `r: skill`
  label delta, merge-parent identity, local/tracking/server identity, and the
  server savegame identity all pass directly.
- Isolated Knip is exactly 6.8.0. Its first production-export scan found one
  stale `ReadSessionMessagesAsyncOptions` re-export in
  `src/gateway/session-transcript-readers.ts`; the type remains owned and
  exported by `session-utils.fs.ts`, and no consumer used the redundant seam.
  Removing that one export is a net-negative, behavior-neutral owner-local
  cure.
- After the cure, all five required isolated Knip 6.8.0 scans pass with zero
  findings: production exports, full exports, script exports, production
  unused files, and full unused files.

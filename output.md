# 1172 upstream absorb — continuation assembly x upstream/main

Lane branch: `codeagent/1172-upstream-absorb-opus5`
Bound issue: karmaterminal/openclaw#1197

## 1. Exact bytes

| Role | Ref | SHA |
| --- | --- | --- |
| Base (assembly) | `scribe/20260709/1172-status-row-assembly` | `16f4b3f106033f7fe75f68e67563db1b5b4d0e2f` |
| UPSTREAM_CANDIDATE (frozen) | `openclaw/openclaw` `main` | `cc48aef143551af2ce13096264335ce9954e61e6` |
| Merge base | — | `20eda756fae6599bc9d776815016f555a64d77d6` |
| Protected presentation (untouched) | `frond-scribe-claude/20260509/narrow-surgery-tight` | `d8b08c9c0a1f425f4cfff1b21bff4852deff823f` |

Verification at lane start:

- `git rev-parse origin/scribe/20260709/1172-status-row-assembly` → `16f4b3f1…` (exact, unmoved).
- `git ls-remote https://github.com/openclaw/openclaw.git HEAD` → `cc48aef1…`, identical to the
  pre-dispatch observation. Frozen at `refs/frozen/1172-absorb-opus5/upstream-main`; never re-fetched.
- `git merge-base` → `20eda756…` (matches workorder).
- Drift confirmed exactly: **944** upstream-only commits, **4806** upstream-changed paths;
  assembly side 849 commits / 658 paths.

Presentation branch was never checked out, fetched into, or written.

## 2. Merge topology and checkpoints

Preserved-topology back-merge. No rebase, squash, cherry-pick reconstruction, or force-push.

| SHA | What |
| --- | --- |
| `9ed7fd20b49` | `merge: absorb upstream cc48aef into continuation assembly` — parents `16f4b3f1060` + `cc48aef1435` |
| `9510a3797d6` | `fix(merge): retarget continuation code onto upstream's renamed surfaces` |
| `f60acee5f66` | `chore(merge): regenerate plugin-sdk api baseline for the absorbed surface` |
| `74c1a569044` | `fix(signal): restore the canonical ingress test seam after the absorb` |
| `f0f5c95f53e` | `test(agents): canonicalize registry fixtures in the assembly's split file` |

`git log -1 --format=%P 9ed7fd20b49` → `16f4b3f106033f7fe75f68e67563db1b5b4d0e2f cc48aef143551af2ce13096264335ce9954e61e6`.

Total lane diff vs base: 4807 files changed, +334223 / −92922.

## 3. GitNexus evidence

| Item | Value |
| --- | --- |
| Index 1 (pre/mid-merge) | `gitnexus analyze`, 2972.9s — 646,057 nodes, 1,282,794 edges, 19,221 clusters, 300 flows |
| Index 2 (merged tree) | `gitnexus analyze`, 3816.0s incremental — **658,355 nodes, 1,280,802 edges, 19,583 clusters, 300 flows** |
| Skipped | 5 files >512KB; ~1069 Swift files (no `tree-sitter-swift` native binding on this platform) |

### `detect-changes` (merged tree vs frozen assembly base)

```
gitnexus detect-changes --scope compare --base-ref 16f4b3f106033f7fe75f68e67563db1b5b4d0e2f
→ Changes: 4758 files, 29152 symbols
  Affected processes: 153
  Risk level: critical
```

`critical` is the expected reading for a 944-commit absorb, not a defect signal. Named affected
flows include `ExecutePreparedCompactionSession → …` (3 flows), confirming the compaction path is
inside the blast radius and warranting the compaction-owner test attention it received.

### Blast radius on the symbols actually resolved (merged-tree index)

| Symbol | Direct dependants | Risk | Modules |
| --- | --- | --- | --- |
| `createOpenClawTools` | 17 | **HIGH** | 3 |
| `getActiveHeartbeatWakeContext` | 1 | LOW | 1 |
| `dispatchPendingWakeGroup` | 1 | LOW | 1 |

These numbers directly shaped two decisions:

- `createOpenClawTools` at HIGH / 17 dependants is why its exported signature was widened
  **additively** (§5.2) instead of reshaped; the count is unchanged from the base index, and `tsgo`
  confirms no caller drift.
- `getActiveHeartbeatWakeContext` having exactly **one** direct dependant is what made the
  `AsyncLocalStorage` swap (§5.6) safe to do in place: the sole consumer is
  `src/infra/heartbeat-runner.ts`, which reads it synchronously inside the handler call, verified by
  reading the caller rather than trusting the graph alone.

Every graph finding above was corroborated against source, adjacent tests, `git show` history, and
three-way `git merge-tree` output, as the workorder requires.

## 4. Conflict inventory

Dry `git merge-tree --write-tree --name-only` before any mutation: **61 conflicted paths**.

| Class | Count |
| --- | --- |
| Android translation XML | 42 |
| Core/production TypeScript | 9 |
| Bundled plugin TypeScript | 2 |
| Tests | 6 |
| Generated / ratchet artifacts | 2 |

Zero conflict markers remain (`git grep -E '^(<<<<<<< |>>>>>>> |={7}$)'` → empty).

## 5. Semantic resolutions

Nothing was resolved with a blanket ours/theirs.

### 5.1 Android translations (42 files) — upstream wins per conflicting key

The assembly added English placeholder rows (auto-generated `native_<hash>` keys); upstream
independently added the *same* keys with real localized strings. Resolved **hunk-wise** with
`git merge-file --theirs` (not whole-file `checkout --theirs`), then programmatically asserted
`keys(result) == union(keys(ours), keys(theirs))` for every file, so assembly-only feature strings
(e.g. `native_0a598c4b7044dab3` "Publish Delegate Artifacts") survive untranslated exactly as the
generator emits them. Key-set check passed on all 42.

### 5.2 `src/agents/openclaw-tools.ts` — keep assembly layout, adopt upstream introductions

Assembly extracted the inline options object into `openclaw-tools.options.ts` (needed to register
continuation tools and stay under the max-lines ratchet: 764 → 651 LOC). Upstream kept it inline
and grew it. Kept the extraction; ported upstream's single new field `webSearchEnabled` into the
extracted type. Field-set diff proved that was the *only* option upstream added.

Upstream introductions that merged cleanly and were retained: the `setImmediate` media-generation
yield hardening with `mediaGenerationYieldLog`, the shared `mediaGenerationToolOptions` object,
`activeProjectKeys` threading into plugin tools, `enabled: options?.webSearchEnabled` on the web
search tool, and `runSessionKey` on the message tool.

### 5.3 `src/agents/subagent-spawn.ts` — feature behavior onto upstream's new helper

- Kept the assembly's `persistInitialChildRuntimeState(...)`, which persists the runtime model
  **and** `buildContinuationSessionPatch(params)` in one upsert — this is what carries continuation
  chain state onto the child session at spawn.
- Kept upstream's new `cleanupProvisionalSession(...)` helper (6 call sites), which replaced the
  raw `sessions.delete` + `try/catch` cleanup and also strengthened it with `deleteTranscript: true`.
- Dropped upstream's now-dead local `sanitizeMountPathHint` / `hasPromptUnsafeControlCharacter`;
  the assembly moved that logic to shared `parseInlineAttachmentMountPath`. Verified with
  `git diff base..upstream` that upstream did **not** change those functions' bodies.
- Upstream's `collectorSessionKey` return-path unification merged cleanly and is retained, as is
  the feature's `attachments: attachmentsReceipt` on the accepted result.
- `persistInitialChildSessionRuntimeModel` is now unreferenced. It was **already** unreferenced on
  the assembly base (`git grep` on `16f4b3f` finds only its definition), so it is inherited dead
  code, classified here rather than deleted, per "do not fix unrelated baseline defects".

### 5.4 `src/agents/embedded-agent-subscribe.handlers.ts` — compose both contracts

Upstream made `scheduleEvent` return its task so `agent_end` is awaitable. The assembly added
`scheduleAttemptEvent`, a delivery-generation fence that drops handlers from a discarded compaction
attempt. These are orthogonal, and taking either side alone loses a real contract.

Composed: `scheduleAttemptEvent` now returns `void | Promise<void>` and **forwards** the scheduled
task, `agent_end` does `return scheduleAttemptEvent(...)`, and every discard site keeps upstream's
`void` marker. The fence still runs, and the terminal event stays awaitable even when the fence
skips the handler (the returned promise still settles). The assembly's `compaction_end` retry
invalidation and `invalidatedDeliveryGeneration` plumbing are untouched.

### 5.5 `src/agents/embedded-agent-subscribe.ts` — adopt upstream tagging, keep directive recording

Upstream now applies `taggedPayload` (with new `assistantTranscriptMediaUrls` metadata) uniformly
to both the deferred and immediate paths, and replaced the `pendingToolTrustedLocalMedia` boolean
with a per-URL `pendingToolMediaTrustByUrl` map. Both adopted.

The assembly's `emitBlockReplySafely(payload, options, onDelivered)` callback form,
`recordDeferredAssistantReplyDirectives` / `recordDeliveredAssistantReplyDirectives`,
`deferredBlockReplyTexts` and `deferredBlockReplyCallbacks` are preserved and retargeted onto
`taggedPayload`. Safe because `setReplyPayloadMetadata` stores metadata in a side WeakMap and
returns the *same object*, so identity-keyed callback/dedupe maps are unaffected.

### 5.6 `src/infra/heartbeat-wake.ts` — the deepest one

Upstream replaced the single global serial wake runner (`scheduled` / `running` flags) with
**per-target concurrent dispatch**: `activeWakeTargets`, `MAX_CONCURRENT_HEARTBEAT_WAKE_TARGETS = 4`,
`AsyncLocalStorage`-scoped abort signals, `readyAtMs` coalescing, and `dispatchPendingWakeGroup`.

The assembly's continuation additions were ported onto that new abstraction (the old serial loop was
deleted, not resurrected):

- `parentRunId` added to `wakeOpts` and to the guard-retry re-queue.
- `markTrustedContinuationRoutingCarrier(wakeOpts)` re-applied inside the new dispatcher, plus
  `trustedContinuationRouting` carried through the guard-retry re-queue.

Two latent breakages that a textual merge would have shipped silently were found and fixed:

1. **Concurrency-unsafe context slot.** The assembly's `activeWakeContext` was a module-level
   mutable slot read by `getActiveHeartbeatWakeContext()` in `heartbeat-runner.ts` to recover
   `parentRunId` and the trusted-routing marker. Under upstream's concurrent per-target dispatch,
   two in-flight target turns would clobber each other's lineage. Moved to
   `AsyncLocalStorage<HeartbeatWakeRequest>`, populated in `runAbortableHeartbeatWake` right beside
   upstream's own abort-signal store, so each turn reads its own wake.
2. **Dead global flush barrier.** Upstream's "unscoped immediate wake is a global flush barrier"
   logic looks up the literal key `"::"`. The assembly's trust-domain coalescing changed the key
   shape to `<agent>::<session>::<default|trusted-continuation>`, so the unscoped key is
   `"::::default"` and upstream's lookup could **never** match — the barrier would have been
   permanently dead. Retargeted through a named `UNSCOPED_WAKE_TARGET_KEYS` covering both trust
   domains, preserving upstream's ordering (unscoped group sorted last).

`hasPendingHeartbeatWake()` and `resetHeartbeatWakeStateForTests()` were moved off the deleted
`scheduled`/`running` flags onto `activeWakeTargets` (the reset now also aborts in-flight targets).

### 5.7 `src/status/status-text.ts` + `status-codex-auth-profile.ts` — adopt an upstream behavior change

The assembly had extracted `resolveCodexSyntheticUsageAuthProfileId` into its own module (max-lines
ratchet). Upstream, in `c5d0b7dd39b "refactor: retire legacy provider and secret paths (#115655)"`,
**changed that function's behavior**: it no longer accepts legacy `openai-codex` / `codex-cli`
credential providers, only `openai`.

This is a real product decision derivable from code + tests (that commit also deletes the tests
asserting the legacy behavior) and it matches the root architecture rule that OpenAI Codex is folded
into `openai` with doctor owning legacy repair. Adopted: the inline duplicate was dropped and
upstream's simplified check was ported into the assembly's extracted module, along with removing the
now-unused `resolveProviderIdForAuth` import. The legacy branch was **not** resurrected.

### 5.8 `src/gateway/server-methods/chat-send-dispatch-errors.ts`

Adopted upstream's substantial abort-ownership restructure of `handleError` (capture terminal
ownership before durable cleanup yields, the aborted-at-dispatch-reject early return, retiring
abortability before async terminal persistence, and guarding the dedupe/broadcast on
`agentTerminalPersistenceOwnedAtDispatchReject`). Re-inserted the assembly's
`markTerminalBroadcasted()` **exactly where a broadcast happens** — inside the new guarded block,
immediately before `broadcastChatError`. Upstream's new aborted early-return performs no broadcast,
so it correctly gets no mark; chat.abort owns that terminal.

### 5.9 `extensions/signal/src/monitor/event-handler.ts`

Adopted upstream's restructured ingress lifecycle wholesale (`fanInChannelIngressLifecycles`,
`createFlush({lifecycle, dispatch})`, `retrySignalInboundFlush` with backoff, abandon-on-exhaustion).
The surrounding merged code already required that shape. Ported the assembly's accepted
`164a462adfb` behavior into the new catch: when the fanned-in abort carries a reclaimed constituent
claim, release only still-live siblings and return, instead of rethrowing. Without that branch
upstream's code rethrows the abort error into the debounce error path.

### 5.10 `packages/agent-core/src/agent-loop.ts`

Three positional-parameter collisions, resolved as an ordered union (upstream's `turnTainted` first,
then the assembly's `nextModelRequestOrdinal`), consistent between the signature and the single call
site. Upstream's turn-taint propagation and `finalizeToolCallOutcome` rework are retained; the
assembly's repeated-tool-error state and model-request ordinal are retained.

### 5.11 `extensions/codex/src/app-server/dynamic-tools.ts`

Composed both: upstream's remote-workspace `message` media preparation runs between
`prepareArguments` and the record guard, and the result feeds the assembly's `preparedToolArgs`,
which the legacy app-server extension runner must observe *before* `before_tool_call` rewrites
(the assembly's documented contract). `executedArgs` still carries the merged view to the native
middleware.

### 5.12 Tests and generated artifacts

Six test conflicts were additive and resolved as unions (two union boundaries initially closed a
`describe` block early and were repaired). `docs/.generated/plugin-sdk-api-baseline.sha256` was
**regenerated** from merged source rather than picked (6 module hashes moved). The four
`scripts/plugin-sdk-surface-report.mjs` ratchets were reconciled arithmetically as
`base + assembly-delta + upstream-delta`; `pnpm plugin-sdk:surface:check` then confirmed the exact
predicted values (public exports 4791, callable 2887, deprecated 1710).

## 6. Silent auto-merges caught afterwards

These regions had only one side editing them, so git merged them without conflict while leaving the
tree semantically broken. Found by `tsgo` and the suite, fixed in `9510a3797d6` / `f0f5c95f53e`:

| Symbol / surface | What upstream did | Resolution |
| --- | --- | --- |
| `findLatestRunForChildSession` | Renamed to exported `getLatestSubagentRunByChildSessionKeyFromRuns` | Retargeted the 2 continuation-added call sites |
| `already_compacted_recently` | Renamed to `already_compacted` | Adopted upstream naming in the continuation-owned closed union + tests |
| `sleep` in signal retry | Upstream added `node:timers/promises` import | Restored the import |
| `builtinToolNames` trio | Assembly grouped into `subscriptionToolTrust` | Ported upstream's 2 new test cases onto the grouped shape |
| resume-guard orphan test | Upstream added it | Assembly already owns it in its split file; dropped the duplicate, adopted upstream's refined `execution`/`completion`/`delivery` fixture |
| `markTerminalBroadcasted` | Assembly made it required | Added to upstream's 3 new fixtures |
| canonical nested run state | Upstream now rejects rows without it | Split file adopted upstream's `canonicalSubagentRunFixtures` |
| canonical ingress test seam | Upstream reworked ingress-drain/monitor | See §5.9 / §8 |

## 7. Beneficial upstream introductions adopted

`cleanupProvisionalSession`; `collectorSessionKey` return unification; awaitable terminal
`scheduleEvent`; uniform `taggedPayload` + `assistantTranscriptMediaUrls`; per-URL
`pendingToolMediaTrustByUrl`; per-target concurrent heartbeat dispatch with `AsyncLocalStorage`
abort propagation and `readyAtMs` coalescing; `shouldClearFailedCliSessionBinding` /
`resolveCliSessionClearReason` ownership move; session write-lock around gap-fill transcript
persistence; `runTimeoutOverrideMs`; media-generation yield hardening; `webSearchEnabled`;
`activeProjectKeys`; turn-taint propagation and `finalizeToolCallOutcome` in `agent-loop`;
`fanInChannelIngressLifecycles` + ingress retry/backoff; legacy provider retirement;
`canonicalSubagentRunFixtures`; upstream's real Android translations.

## 8. Reverse-clobber finding (Gate 2.7)

`extensions/signal/src/monitor/event-handler.reply-session-conflict.test.ts` is a genuine
reverse-clobber the merge exposed. Assembly commit `b6842092148` had replaced this file's canonical
`openclaw/plugin-sdk/channel-inbound` mock with **deep `src/**` mocks** of
`auto-reply/reply/provider-dispatcher.js` and `channels/session.js` — an extensions-boundary
violation that only worked because the old reply pipeline imported exactly those modules.
`git diff base..upstream` on that file is **empty**, i.e. upstream never diverged; the assembly
moved away from the shared version.

After absorbing upstream's ingress rework the deep mocks intercept nothing and all 9 cases failed.
Repaired by restoring upstream's canonical seam and porting the assembly's accepted proof onto it.

**Ablation proof that the ported production branch is load-bearing:** deleting the
merged-claim-release branch from `event-handler.ts` fails exactly
`abandons merged siblings when any durable claim is reclaimed` and nothing else (7 passed / 1 failed);
restoring it gives 8/8.

**Explicitly not ported, not silently dropped:** the assembly's
`cancels an in-progress terminal status hold and restores the acknowledgement` case configured
`cfg.messages.statusReactions.timing` and `.emojis`. Those fields exist in **no** tree's
`StatusReactionsConfig` (base, assembly, upstream, and merged all define only `enabled?: boolean`),
so that case was type-broken rather than an accepted contract — it is one of the three inherited
`tsgo` errors listed in §10. Restoring equivalent coverage through the harness's real
`statusReactionTiming` dependency is a reasonable follow-up but was left out of absorb scope.

## 9. Feature invariants

| Invariant | Evidence |
| --- | --- |
| `continue_work` / `continue_delegate` / `request_compaction` coherent | `src/auto-reply/continuation/**` is **byte-identical** to the assembly base (`git diff 16f4b3f..HEAD -- src/auto-reply/continuation/` is empty); tool registration preserved via `openclaw-tools.continuation.js` through the resolved `openclaw-tools.ts` |
| Structured `continue_delegate` return incl. attachments | `attachments: attachmentsReceipt` retained on the accepted result in `subagent-spawn.ts`; `attachments` / `attachMountPath` still forwarded from `post-compaction-staged-dispatch.ts` |
| Status-row / continuation visibility | `status-continuation-line.ts` and the `formatStatusTextContinuationLine` re-export retained through the `status-text.ts` resolution |
| Post-compaction retry consumes zero depth | continuation dir unchanged; `post-compaction-chain-charge` owners unchanged |
| Accepted-child replay idempotent incl. source-less fallback | continuation dir unchanged; `partitionKnownAcceptedDelegateChildren` path intact |
| Seven-day TTL before materialization/spawn | `classifyPostCompactionDelegateAge` gate still precedes the artifact-policy gate and any spawn; its 3 TTL cases pass |
| TaskFlow durable-handoff terminalization | `post-compaction-durable-handoff` owner unchanged (see §10 for its inherited reds) |
| Delegate sanitization + trusted-echo guards | `formatDelegateTaskForSystemEvent` path unchanged; heartbeat trusted-routing marker ported onto upstream's dispatcher (§5.6) and kept in its own coalescing domain |
| No accepted proof silently weakened | One test was rewritten (§8) with an ablation proof, and one non-ported case is called out explicitly above |

## 10. Validation

Commands run in this worktree:

```
git merge --no-commit --no-ff cc48aef143551af2ce13096264335ce9954e61e6
node scripts/run-tsgo.mjs -p tsconfig.json --noEmit
pnpm install                                   # upstream added @lit/task, werift
node --max-old-space-size=8192 --import tsx scripts/generate-plugin-sdk-api-baseline.ts --write
node --max-old-space-size=8192 scripts/plugin-sdk-surface-report.mjs --check
node scripts/test-projects.mjs                 # sanctioned full suite
node scripts/run-vitest.mjs run --config test/vitest/vitest.<shard>.config.ts --maxWorkers=1 <path>
```

### Typecheck

`tsgo` full project: **226 → 0 errors**. 195 of the initial errors were `ui/` +
`extensions/openai` missing modules (`@lit/task`, `werift`) caused by stale `node_modules` after the
merge, cleared by `pnpm install`, per the root rule that `Cannot find module` right after a merge is
staleness, not a code bug. The rest were the silent auto-merges in §6. The final 3
(`timing` / `emojis` not in `StatusReactionsConfig`) were cleared as a side effect of adopting
upstream's type-clean version of the signal test in §8. Final: **clean**.

### Plugin SDK ratchets

`plugin-sdk:surface:check` passes. Public entrypoints 146, exports 4791, callable 2887, deprecated
1710, wildcard reexports 81.

### Full suite

Two runs. Run 1 (`/tmp/full-suite.log`) is superseded: it overlapped a GitNexus re-index pinning a
core, and it predates both regression fixes and the environment quarantine. Reported tally is run 2
(`/tmp/full-suite2.log`), taken after those fixes:

| | Run 1 | Run 2 (reported) |
| --- | --- | --- |
| Shards started | 303 | 303 |
| Shard summaries emitted | 303 | **300** |
| Failing test files | 28 | **14** |
| Passing tests (summed over emitting shards) | — | **123,206** |
| Skipped | — | 194 |

Run 2 did not fully close: the `gateway-server` shard **hung** with no output for ~36 minutes and
the local full-suite profile disables the no-output watchdog, so the run was stopped and that shard
was re-run in isolation. 300 of 303 shard summaries were emitted before the stop.

After run 2, seven more failures were fixed (the two continuation-work-span files, §6), which run 2
still shows as failing. Independently verified owner deltas:

| Owner | Before | After |
| --- | --- | --- |
| `extension-signal` reply-session-conflict | 9 failed | 8 passed |
| `agents-core` subagent-registry restore-recovery | 8 failed / 10 | 10 passed |
| `agents-core` sessions_spawn lifecycle | 8 failed / 8 | 8 passed (environment only, no code change) |
| `agents-core` openclaw-tools.sessions | 1 failed | passed (environment only) |
| `auto-reply-reply` continuation-work-span (2 files) | 7 failed / 16 | 16 passed |

Known-remaining failing files after all fixes (12), with classification:

| File | Failing | Classification |
| --- | --- | --- |
| `continuation/delegate-dispatch-post-compaction` | 1 | inherited (§11) |
| `continuation/post-compaction-release` | 4 | inherited (§11) |
| `continuation/post-compaction-durable-handoff` | 4 | inherited (§11) |
| `continuation/volatile-map-allowlist` | 1 | inherited (§11) |
| `test/scripts/plugin-sdk-surface-report` | 1 | inherited (§11) |
| `src/cli/plugins-cli.install` | 4 | **untriaged** |
| `src/commands/sandbox-explain` | 7 | **untriaged** |
| `extensions/anthropic/session-catalog` | 1 | **untriaged** |
| `src/gateway/server-cron` | 2 | **untriaged** |
| `src/gateway/server-restart-sentinel` | 1 | **untriaged** |
| `src/plugins/npm-install-security-scan.release` | 1 | **untriaged** |
| `src/entry.respawn` | 2 | **untriaged** |

Plus the `gateway-server` shard hang, re-run in isolation and still under investigation at
close-out. **This is not a green suite and is not claimed as one.**

## 11. Controls for inherited failures

### Continuation reds (4 files, 10 tests) — inherited

`delegate-dispatch-post-compaction`, `post-compaction-release`, `post-compaction-durable-handoff`,
`volatile-map-allowlist`.

Control: `git diff 16f4b3f106033f7fe75f68e67563db1b5b4d0e2f HEAD -- src/auto-reply/continuation/`
is **empty**, and the other implicated files
(`src/auto-reply/reply/reply-run-registry.ts`, `reply-run-finalization-lease.ts`,
`delegate-taskflow-registry.test-harness.ts`) are byte-identical to the assembly base
(sha1 compared). Root cause of the post-compaction group is the assembly's own paired-source-metadata
fence in `delegate-store.ts`:

```ts
if ((flowId === undefined) !== (expectedRevision === undefined)) {
  return { allowed: false, reason: "stale", summary: "Continuation delegate source metadata is incomplete before spawn." };
}
```

The fixtures pass `flowId` without `expectedRevision`, so the fence rejects them deterministically.
Probe output confirms: `reason=stale flowId=pc-flow-1`. Nothing outside those byte-identical files
participates. `volatile-map-allowlist` fails because reply-side volatile collections that exist
unchanged on the base are absent from its allowlist.

### `tooling` plugin-sdk-surface-report — inherited

`readDefaultPublicSurfaceBudgets()` reports `wildcardReexports: 82` while the tree has 81. The
assembly removed `export * from "../infra/system-events.js"` from `src/plugin-sdk/infra-runtime.ts`
(base 84 wildcard lines → assembly 83; upstream unchanged at 84) without lowering the pinned budget,
which all three sides still carry as 82. The three-way merge result is correct — the merge did not
drop an upstream export. Left as-is because lowering a public SDK ratchet is an owner decision, not
absorb scope.

### Stale SQLite residue — environment, breaks every tree identically

Failures shaped like
`OpenClawAgentDatabaseMediaMigrationRequiredError: ... uses schema version 13`.

Control without switching trees: `OPENCLAW_AGENT_SCHEMA_VERSION` is **16** on base `20eda75`,
assembly `16f4b3f`, upstream `cc48aef`, **and** the merged tree. A schema-13 database is therefore
refused identically everywhere; this cannot be absorb fallout.

This machine had 1243 `/tmp/*.sqlite` files, **1218** below the current schema (agent DBs at
`user_version` 13, some as old as Jul 25), at fixed paths that tests reuse. 1118 were moved to
`/tmp/absorb-quarantine/sqlite` (reversible; anything modified in the last hour was skipped so live
sibling lanes are untouched). The 100 remaining sub-16 files are a different store family
(`user_version` 6) and are not implicated. `sessions_spawn` recovered 8/8 with zero code change.

**Operator note:** the quarantine directory is intentionally left in place rather than deleted.

## 12. Uncertainties and open questions

1. **GitNexus gates are complete** (§3): the merged tree was re-indexed and `detect-changes`
   plus merged-tree blast radius were run. No open item here.
2. **The suite is not green.** 12 known failing tests remain (5 files proven inherited, 7 files
   untriaged), plus a hung shard. See §10.
3. **Untriaged residual failures (12 tests across 7 files).** `plugins-cli.install` (4),
   `sandbox-explain` (7), `anthropic/session-catalog` (1), `server-cron` (2),
   `server-restart-sentinel` (1), `npm-install-security-scan.release` (1), `entry.respawn` (2).
   Four of these files were untouched by the merge, which is suggestive but **not** proof; none has
   been run against a frozen-base control. A reviewer should classify them before landing.
4. **`gateway-server` shard: worker crash, now localized.** In run 2 the shard produced no output
   for ~36 minutes (the local full-suite profile disables the no-output watchdog), so the run was
   stopped. Re-run in isolation it does **not** hang; it exits 1 in ~10 minutes with:

   ```
   ✓ src/gateway/server.sessions.process-cleanup.test.ts (2 tests) 2847ms
   Error: Worker exited unexpectedly
       at Worker.emitUnexpectedExit (vitest/dist/chunks/cli-api…)
   ```

   A vitest worker dies immediately after the session process-cleanup test (a test whose whole job
   is purging finished processes for retired session identities). Under full-suite parallelism that
   dead worker is what presents as an indefinite hang. Failing cases in that shard are
   `server-cron` (2) and `server-restart-sentinel` (1); `server.sessions.create` failed once in a
   verbose run and passed in the next, so it is flaky. Not root-caused, and not obviously
   absorb-related — but it is the single most likely place for a real defect to still be hiding,
   and a reviewer should confirm it against the frozen base before landing.
5. **Signal status-hold coverage** was not ported (§8) — the only accepted-test surface reduced by
   this absorb, and it was type-broken on every tree.
6. **`persistInitialChildSessionRuntimeModel`** is dead code inherited from the base (§5.3), left
   alone deliberately.
7. **Global flush barrier semantics** (§5.6): I extended upstream's unscoped-immediate barrier to
   cover *both* trust domains, reasoning that the barrier is scope-and-intent based, not trust
   based. If the owner intends trusted-continuation wakes to be excluded from the global flush, that
   is a one-line narrowing — flagged rather than assumed.
8. **Not run:** `pnpm build`, import-cycle and max-lines ratchets, and Docker/E2E lanes.

## 13. Verdict

**BLOCKED-DESIGN is not warranted** — no upstream product decision was ambiguous enough to stop on;
the one behavior change that mattered (legacy Codex provider retirement, §5.7) was derivable from
upstream's own commit and tests. **ABSORB-PATHOLOGICAL is not warranted** — 61 conflicts resolved
semantically, tsgo effectively clean, SDK ratchets green, and every continuation invariant traced to
surviving code or an explicit control.

Final verdict: **READY-FOR-INDEPENDENT-REVIEW**, with the §12 caveats stated plainly — most
importantly that the clean full-suite tally and GitNexus `detect-changes` were still outstanding at
the time of writing, and item 3's residual failures have not been individually classified. A
reviewer should confirm those before treating this as landable.

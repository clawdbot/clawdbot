# Cael pure-continuation upstream 3376 backmerge journal

Append-only decision record for `scribe/20260821/1172-upstream-3376-backmerge-cael`.
All timestamps are UTC.

## 2026-08-21T23:59:23Z - Phase 0 and Gate 1: frozen inputs, graph baseline, savegame

### Frozen inputs

- Pure-continuation root and initial safe-branch HEAD:
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Assembly ref `origin/scribe/20260709/1172-status-row-assembly`:
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Identical alias `origin/scribe/20260818/1172-upstream-4589-backmerge`:
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Frozen `origin/main`:
  `3376c29800166a3151cbca6b8ab204964e97ac39`.
- Forbidden composite ref:
  `46f4d2115700d574501bb3c4763abf6b2ba977fe`.
- `git merge-base --is-ancestor 46f4d211... c3a0e5a...` exited 1, proving
  the forbidden composite is not in the continuation root.
- The protected assembly, alias, presentation, main, and forbidden-composite
  refs were read before and after the work order's single origin fetch. Every
  required SHA matched exactly.

### Count-label correction

`git rev-list --left-right --count
c3a0e5a314ecbf572911d4b2e84595bd06f64d69...3376c29800166a3151cbca6b8ab204964e97ac39`
returned `1113 873`: assembly-only is 1113 and upstream-only is 873. The work
order's prose inverted the ahead/behind labels. The raw sides are authoritative;
there is no greater-than-ten growth in the upstream-only side.

### Gate 1 savegame

- Immutable savegame:
  `savegame/20260821-1959Z/1172-cael-pure-continuation-pre-3376`.
- `git ls-remote origin` returned
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69` for that exact ref.
- The savegame will not be deleted or moved.

### GitNexus pre-change evidence

- Exact registered worktree:
  `/home/figs/flesh_beast_best_beast/source/WORKTREES/openclaw-1172-upstream-3376-cael`.
- Executing CLI version under the repository Node 22 runtime: `1.6.5`.
- First native-worker analysis aborted after about 70 minutes with
  `double free or corruption (out)`. The CLI-prescribed
  `gitnexus analyze --workers 0` recovery succeeded in 4666.6 seconds.
- Swift parsing was unavailable because `tree-sitter-swift` had no loadable
  native binding. The TypeScript continuation surface was indexed.
- Current index: commit `c3a0e5a`, 751,069 nodes, 1,500,253 edges, 22,068
  clusters, and 300 flows.
- Query:
  `gitnexus query 'continuation tools continue_work continue_delegate request_compaction'
--repo <exact-worktree> --context 'Pure-continuation assembly before
frozen-upstream backmerge' --goal 'Identify owning flows and merge-sensitive
continuation paths' --limit 10`.
  It identified the continuation registration, delegate stores, post-compaction
  dispatch, and request-compaction tool definitions.
- Context:
  `gitnexus context createContinueWorkTool --repo <exact-worktree>
--file src/agents/tools/continue-work-tool.ts`.
  Direct callers are `createOpenClawContinuationTools` and the two
  `continue-work-tool` test factories.
- Impact:
  `gitnexus impact createContinueWorkTool --repo <exact-worktree>
--direction upstream --depth 5 --include-tests --limit 200`.
  It reported six impacted symbols: three direct and three depth-two test/file
  dependents.
- Merge-boundary detection:
  `gitnexus detect-changes --repo <exact-worktree> --scope compare
--base-ref 3376c29800166a3151cbca6b8ab204964e97ac39`.
  It reported 5,908 changed files, 24,110 changed symbols, 151 affected flows,
  and critical risk. This requires complete conflict, auto-resolution,
  intersecting-test, and divergence walks rather than spot checks.

### Deviations and hard stops

- The requested `upstream-divergence-walker` skill is not installed. Its
  discipline will be implemented as an explicit per-file/per-commit semantic
  divergence ledger plus independent divergence review; no gate is waived.
- `.gitnexus/`, `WORKORDER.md`, and the pre-existing untracked `resume.sh` remain
  local and untracked.
- No protected ref, PR #1398 surface, forbidden composite, #121204/#124337
  surface, deployment, service, config, database, or live gateway was touched.

## 2026-08-21T23:03:44Z - Phase 1 pre-resolution merge inventory

Timestamp correction: the preceding section's `23:59:23Z` header is a
transcription error. The successful index timestamp was `15:59:23` PDT, or
`22:59:23Z`. This correction is appended rather than rewriting the journal.

The exact command `git merge --no-ff
3376c29800166a3151cbca6b8ab204964e97ac39` was run from journal tip
`fec23d77520e8881f1e61b3a9ecbb3f53ecac1c2`. It stopped before commit with the
following prospective topology:

- First parent: `fec23d77520e8881f1e61b3a9ecbb3f53ecac1c2`.
- Second parent / `MERGE_HEAD`:
  `3376c29800166a3151cbca6b8ab204964e97ac39`.
- Merge base: `4589d8514ce189b4adb8f0cf20b2a23ae92902d5`.
- Ours changed since merge base: 906 paths.
- Upstream changed since merge base: 5,851 paths.
- Both sides touched: 253 paths.
- Textual conflicts: 61 paths.
- Both-sides-touched paths silently auto-resolved by Git: 192 paths.
- Total staged incoming paths before conflict resolution: 5,851.

No conflict has been resolved at this point. Complete unmerged-path inventory:

```text
extensions/codex/src/app-server/dynamic-tool-build.ts
extensions/copilot/src/tool-bridge.test.ts
scripts/check-temp-path-guardrails.ts
scripts/plugin-sdk-surface-report.mts
scripts/test-projects.test-support.mts
src/agents/agent-tools.ts
src/agents/command/attempt-execution.ts
src/agents/embedded-agent-runner/compact.hooks.test.ts
src/agents/embedded-agent-runner/run/attempt-client-tools.ts
src/agents/embedded-agent-runner/run/attempt-execution-phase.ts
src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts
src/agents/embedded-agent-subscribe.handlers.messages.lifecycle.ts
src/agents/embedded-agent-subscribe.handlers.messages.update.ts
src/agents/embedded-agent-subscribe.reply-delivery.ts
src/agents/openclaw-tools.ts
src/agents/subagents/announce/subagent-announce-delivery.ts
src/agents/subagents/announce/subagent-announce.runtime.ts
src/agents/subagents/announce/subagent-announce.ts
src/agents/subagents/registry/subagent-registry.persistence.resume.test.ts
src/agents/subagents/registry/subagent-registry.persistence.test.ts
src/agents/subagents/registry/subagent-registry-restore.ts
src/agents/subagents/registry/subagent-registry-run-launch.ts
src/agents/subagents/registry/subagent-registry-run-wait.ts
src/agents/subagents/registry/subagent-registry.ts
src/agents/subagents/spawn/subagent-attachments.ts
src/agents/subagents/spawn/subagent-spawn.attachments.test.ts
src/agents/subagents/spawn/subagent-spawn.test.ts
src/agents/subagents/spawn/subagent-spawn.ts
src/agents/tool-display-config.ts
src/audit/audit-event-writer.ts
src/auto-reply/reply/agent-runner-execute.ts
src/auto-reply/reply/agent-runner-execution.ts
src/auto-reply/reply/agent-runner-result-accounting.test.ts
src/auto-reply/reply/agent-runner-result-complete.ts
src/auto-reply/reply/agent-runner-result-payloads.ts
src/auto-reply/reply/get-reply-run.media-only.test.ts
src/auto-reply/reply/queue/types.ts
src/cli/update-cli.test.ts
src/flows/doctor-core-checks.runtime.ts
src/gateway/agent-turn/agent-run-execution-phase.ts
src/gateway/mcp-http.runtime.test.ts
src/gateway/server-restart-sentinel-agent-delivery.ts
src/gateway/server-restart-sentinel.test.ts
src/gateway/server-restart-sentinel.ts
src/gateway/server-runtime-services.test.ts
src/gateway/server-startup-bootstrap.ts
src/infra/infra-store.test.ts
src/infra/session-delivery-queue.recovery.test.ts
src/infra/session-delivery-queue-recovery.ts
src/infra/session-delivery-queue.storage.test.ts
src/infra/session-delivery-queue-storage.ts
src/process/command-queue.state.ts
src/process/command-queue.test-support.ts
src/process/command-queue.test.ts
src/process/command-queue.ts
src/tasks/task-registry.test.ts
test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md
test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md
test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-heartbeat-codex-tool.md
test/scripts/lint-suppressions.test.ts
ui/src/lib/chat/tool-cards.ts
```

Complete both-sides-touched, silently auto-resolved inventory:

```text
apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json
config/assertion-safety-baseline.txt
config/knip.config.ts
docs/tools/subagents.md
extensions/codex/src/app-server/approval-requester.real-binary.live.test.ts
extensions/codex/src/app-server/auth-bridge.test.ts
extensions/codex/src/app-server/computer-use.test.ts
extensions/codex/src/app-server/computer-use.ts
extensions/codex/src/app-server/config.test.ts
extensions/codex/src/app-server/dynamic-tool-build.test.ts
extensions/codex/src/app-server/dynamic-tools.test.ts
extensions/codex/src/app-server/run-attempt-tool-setup.ts
extensions/codex/src/app-server/run-attempt.turn-watches.test.ts
extensions/codex/src/app-server/run-attempt-types.ts
extensions/codex/src/app-server/shared-client.test.ts
extensions/codex/src/app-server/side-question.test.ts
extensions/codex/src/app-server/side-question.ts
extensions/google/transport-stream.test.ts
extensions/signal/src/monitor/event-handler.ts
extensions/telegram/src/bot.create-telegram-bot.test.ts
packages/gateway-protocol/src/schema/agent.ts
scripts/bench-agent-concurrency-worker.ts
scripts/lib/ci-node-test-plan.mts
src/acp/runtime/session-meta.ts
src/agents/agent-command.live-model-switch.test.ts
src/agents/agent-tools.workspace-paths.test.ts
src/agents/bash-tools.exec-workdir.test.ts
src/agents/command/attempt-execution.cli.test.ts
src/agents/command/cli-compaction.ts
src/agents/command/types.ts
src/agents/core-tool-factory-descriptors.ts
src/agents/embedded-agent-runner/compact.hooks.harness.ts
src/agents/embedded-agent-runner/prepared-compaction-runtime.ts
src/agents/embedded-agent-runner/result-fallback-classifier.ts
src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts
src/agents/embedded-agent-runner/run/attempt-tool-prepare.ts
src/agents/embedded-agent-runner/run-orchestrator.ts
src/agents/embedded-agent-runner/run/params.ts
src/agents/embedded-agent-runner/run/payloads.test.ts
src/agents/embedded-agent-runner/run/payloads.ts
src/agents/embedded-agent-runner/run/run-attempt-dispatch.ts
src/agents/embedded-agent-subscribe.handlers.lifecycle.test.ts
src/agents/embedded-agent-subscribe.handlers.lifecycle.ts
src/agents/embedded-agent-subscribe.handlers.tools.completion.ts
src/agents/embedded-agent-subscribe.handlers.tools.results.ts
src/agents/embedded-agent-subscribe.handlers.tools.start.ts
src/agents/embedded-agent-subscribe.handlers.tools.test.ts
src/agents/embedded-agent-subscribe.handlers.types.ts
src/agents/embedded-agent-subscribe.run-state.ts
src/agents/embedded-agent-subscribe.stream-rendering.ts
src/agents/embedded-agent-subscribe.ts
src/agents/internal-events.ts
src/agents/openclaw-tools.session-status.test.ts
src/agents/openclaw-tools.sessions.test.ts
src/agents/sandbox/fs-bridge.test-helpers.ts
src/agents/subagents/announce/subagent-announce-delivery.test.ts
src/agents/subagents/announce/subagent-announce-direct-delivery.ts
src/agents/subagents/announce/subagent-announce-output.ts
src/agents/subagents/announce/subagent-announce.requester-settle-wake.ts
src/agents/subagents/announce/subagent-announce.timeout.test.ts
src/agents/subagents/registry/subagent-registry-lifecycle-announce-cleanup.ts
src/agents/subagents/registry/subagent-registry-lifecycle-completion.ts
src/agents/subagents/registry/subagent-registry-lifecycle-delivery.ts
src/agents/subagents/registry/subagent-registry.lifecycle-retry-grace.e2e.test.ts
src/agents/subagents/registry/subagent-registry-lifecycle.test.ts
src/agents/subagents/registry/subagent-registry-run-recovery.ts
src/agents/subagents/registry/subagent-registry.test.ts
src/agents/subagents/registry/subagent-registry.types.ts
src/agents/subagents/spawn/acp-spawn.test.ts
src/agents/subagents/spawn/subagent-spawn.in-process-gateway.test.ts
src/agents/subagents/spawn/subagent-spawn.runtime.ts
src/agents/subagents/spawn/subagent-spawn.test-helpers.ts
src/agents/system-prompt.test.ts
src/agents/system-prompt.ts
src/agents/tool-display.test.ts
src/agents/tool-error-summary.ts
src/agents/tools/media-generate-background-shared.test.ts
src/agents/tools/media-generate-background-shared.ts
src/agents/tools/sessions-spawn-tool.test.ts
src/agents/transcript-redact.ts
src/auto-reply/get-reply-options.types.ts
src/auto-reply/reply/agent-runner-cli-candidate.ts
src/auto-reply/reply/agent-runner-embedded-candidate.ts
src/auto-reply/reply/agent-runner-fallback-candidate.ts
src/auto-reply/reply/agent-runner-fallback-settlement.ts
src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts
src/auto-reply/reply/agent-runner-result-accounting.ts
src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts
src/auto-reply/reply/agent-runner-run.ts
src/auto-reply/reply/commands-context-report.ts
src/auto-reply/reply/directive-handling.model.test.ts
src/auto-reply/reply/get-reply-run-admission.ts
src/auto-reply/reply/get-reply-run-context.ts
src/auto-reply/reply/get-reply-run-execute.ts
src/auto-reply/reply/get-reply.ts
src/auto-reply/reply/queue.collect.test.ts
src/auto-reply/reply/queue/drain.ts
src/auto-reply/reply/session.init-conflict-retry.test.ts
src/auto-reply/reply/session.test.ts
src/cli/config-cli.test.ts
src/cli/gateway-cli/run.option-collisions.test.ts
src/commands/doctor-session-sqlite.test.ts
src/commands/export-trajectory.test.ts
src/commands/flows.test.ts
src/commands/sandbox-explain.test.ts
src/commands/status.command-report-data.ts
src/commands/status-overview-rows.ts
src/config/sessions/conversation-registry.test.ts
src/config/sessions/session-accessor.conformance.test.ts
src/config/sessions/session-accessor.sqlite-entry.ts
src/config/sessions/session-accessor.sqlite-parent-session.ts
src/config/sessions/session-accessor.sqlite-transcript-write.ts
src/config/sessions/session-accessor.ts
src/config/sessions/session-snapshot-merge.test.ts
src/config/sessions/types.ts
src/config/types.agent-defaults.ts
src/config/zod-schema.agent-defaults.ts
src/cron/isolated-agent/delivery-dispatch.double-announce.test.ts
src/cron/isolated-agent/run-executor.ts
src/cron/service.runs-one-shot-main-job-disables-it.test.ts
src/cron/service/state.ts
src/cron/service/timer-execution.ts
src/cron/service/timer.regression.test.ts
src/gateway/agent-turn/agent-session-persist.ts
src/gateway/agent-turn/agent-turn-service.ts
src/gateway/mcp-http.runtime.ts
src/gateway/server-chat.agent-events.test.ts
src/gateway/server.chat.gateway-server-chat-b.test.ts
src/gateway/server-chat.ts
src/gateway/server-close.test.ts
src/gateway/server-close.ts
src/gateway/server-cron.test.ts
src/gateway/server-cron.ts
src/gateway/server/hooks.agent-trust.test.ts
src/gateway/server/hooks.early-failure.test.ts
src/gateway/server/hooks.ts
src/gateway/server-lifecycle.ts
src/gateway/server-methods/agent.events-and-subagents.test-utils.ts
src/gateway/server-methods/chat.directive-tags.test.ts
src/gateway/server-methods/chat-send-agent-dispatch.ts
src/gateway/server-methods/chat-send-dispatch-errors.test.ts
src/gateway/server-methods/chat-send-dispatch-errors.ts
src/gateway/server-methods/chat-send-handler.ts
src/gateway/server-methods/chat-send-nonagent-finalization.ts
src/gateway/server-methods/chat-send-source-finalization.ts
src/gateway/server-methods/server-methods.test.ts
src/gateway/server-runtime-handles.ts
src/gateway/server-runtime-services.ts
src/gateway/server-runtime-subscriptions.test.ts
src/gateway/server-runtime-subscriptions.ts
src/gateway/server.sessions.compaction.test.ts
src/gateway/server.sessions.reset-cleanup.test.ts
src/gateway/test/server-sessions.test-helpers.ts
src/gateway/tool-resolution.test.ts
src/gateway/tool-resolution.ts
src/infra/delivery-queue-sqlite.ts
src/infra/diagnostic-events.ts
src/infra/heartbeat-runner-config.ts
src/infra/heartbeat-runner-execution.ts
src/infra/heartbeat-runner.returns-default-unset.test.ts
src/infra/heartbeat-runner-scheduler.ts
src/infra/session-delivery-queue-runtime.test.ts
src/infra/state-migrations.legacy-session-store.ts
src/logging/diagnostic-stability.ts
src/logging/diagnostic.test.ts
src/model-picker/apply-session-model-selection.ts
src/plugins/install.test.ts
src/plugins/runtime/index.test.ts
src/process/exec.windows.test.ts
src/sessions/session-state-events.test.ts
src/sessions/session-state-notices.ts
src/state/openclaw-state-db-contract.ts
src/state/openclaw-state-db.generated.d.ts
src/state/openclaw-state-db-schema-additive.ts
src/state/openclaw-state-db.test.ts
src/state/openclaw-state-schema.sql
src/status/summary.ts
src/talk/client-voice-session.ts
src/tasks/task-registry.maintenance.issue-60299.test.ts
src/tasks/task-registry.maintenance.ts
src/tui/embedded-backend.test.ts
src/tui/embedded-backend.ts
src/tui/tui-event-handlers.test.ts
src/tui/tui-event-handlers.ts
test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/codex-dynamic-tools.discord-group.json
test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/codex-dynamic-tools.telegram-direct.json
test/scripts/install-sh.test.ts
test/vitest/vitest.test-shards.mjs
tsdown.config.ts
ui/src/components/form-controls.browser.test.ts
ui/src/e2e/session-management.groups.e2e.test.ts
ui/src/pages/chat/components/chat-tool-cards.node.test.ts
```

Resolution invariant: preserve the pure-continuation behavior rooted at
`c3a0e5a...`, adopt every compatible frozen-upstream change through
`3376c298...`, and resolve each conflict or silent overlap by semantic ownership,
never blanket ours/theirs.

## 2026-08-21T23:32:00Z - Phase 2 partial: extension, script, and subagent semantic ledger

This entry records the completed resolution families while 40 unrelated
conflicts remain unmerged. The unavailable `upstream-divergence-walker` skill is
replaced by stage-blob comparison (`:1/:2/:3`), both-parent history, complete
module/caller reads, direct dependency inspection, and independent read-only
analysis.

### Direct Codex contract proof

- OpenClaw's resolved dependency is `@openai/codex` `0.148.0`.
- Sibling Codex source was cloned only for read-only contract inspection.
- Exact dependency tag `rust-v0.148.0` resolves to
  `3ba0f711642a888aec92a611a3f3b2211157ff89`.
- `codex-rs/protocol/src/dynamic_tools.rs:10-27` defines turn-provided function
  tools, including stable name, description, schema, and deferred-loading state.
- `codex-rs/core/src/tools/spec_plan.rs:1220-1245` registers every dynamic tool in
  the turn registry.
- `codex-rs/core/src/tools/handlers/dynamic.rs:38-81` converts each spec into a
  direct or deferred runtime; `:113-162` requires a success-bearing dynamic-tool
  response and returns a model-visible cancellation error otherwise.
- `codex-rs/app-server/src/dynamic_tools.rs:18-56` bridges app-server responses
  into the active Codex thread and `:59-110` turns invalid or failed responses
  into explicit failed tool output.
- Contract consequence: the merged OpenClaw Codex builder must retain current
  host-capability binding and every continuation callback. Dropping a callback
  silently removes model capability from Codex turns.

### Extension and script conflicts

| Path                                                                                  | Continuation behavior retained                                                                                                 | Upstream behavior retained                                                                                                                                                                    | Resolution and proof                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/codex/src/app-server/dynamic-tool-build.ts`                               | `drainsContinuationDelegateQueue`, `continueWorkOpts`, and `requestCompactionOpts` are forwarded into the coding-tool options. | Named `OpenClawCodingToolsOptions`, `sessionPermissionPolicy`, `claimYieldCompletion`, injected-factory binding, current `createToolSurface`, and fail-loud missing-host-capability behavior. | Upstream's current options/host-capability structure owns the file; the three continuation fields are re-layered into that options object.                                                                 |
| `extensions/copilot/src/tool-bridge.test.ts`                                          | Canonical renamed temp helper `withTestDir`.                                                                                   | Prepared manifest-profile grants, plugin test-runtime registry/reset, and current `promptToolPolicy` assertions.                                                                              | Unioned imports and bodies; upstream-added `withTempDir` call changed to the only exported helper, `withTestDir`.                                                                                          |
| `scripts/check-temp-path-guardrails.ts`                                               | The prior 16 MiB `git ls-files` overflow repair remains semantically covered.                                                  | Shared `listRepoFilesSync` owner with 64 MiB buffer, timeout, normalized sort, and filesystem fallback.                                                                                       | Took the stronger shared scanner and removed the now-unused local buffer constant.                                                                                                                         |
| `scripts/plugin-sdk-surface-report.mts`                                               | Continuation export-budget rationale remains.                                                                                  | Upstream delegation, prompt, guarded-fetch, media, secret-plan, and conversation-binding budget rationale remains.                                                                            | Comment ledgers were unioned. Numeric limits are provisional until the merged tree is complete, then regenerated by `pnpm plugin-sdk:surface:check`; neither parent number can describe the combined tree. |
| `scripts/test-projects.test-support.mts`                                              | Broad central test helpers do not become unknown import graphs.                                                                | Same invariant, plus its required inline explanation.                                                                                                                                         | Removed the duplicate continuation variable/branches and kept one upstream-named `isTestHelper` path.                                                                                                      |
| `test/scripts/lint-suppressions.test.ts`                                              | The continuation `request-compaction-tool.ts` underscore suppression must remain.                                              | Upstream removed the audit `postMessage` suppression with its owning calls.                                                                                                                   | Deliberately left unresolved until `src/audit/audit-event-writer.ts` is resolved; then the allowlist will exactly reflect the final source.                                                                |
| Three `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/*.md` conflicts | Attachment schema bounds remain represented.                                                                                   | Larger project-doc budgets and shared delegation guidance remain represented.                                                                                                                 | Upstream counters are staged only as marker-free placeholders. `pnpm prompt:snapshots:gen` and `pnpm prompt:snapshots:check` must regenerate exact combined counters after all source conflicts close.     |

### Silent extension/test overlap repairs

- `extensions/codex/src/app-server/auth-bridge.test.ts`: two upstream-added calls
  used removed `withTempDir`; changed to canonical `withTestDir`.
- `test/e2e/qa-lab/runtime/telegram-model-picker-prepared-gateway.e2e.test.ts`:
  upstream's new file imported and called removed `withTempDir`; changed both to
  `withTestDir`.
- `src/agents/bash-tools.exec-workdir.test.ts` carries the same silent rename
  hazard and remains assigned to the agent-core resolution family.
- `src/infra/infra-store.test.ts` carries the same conflict/import hazard and
  remains assigned to the runtime-state resolution family.

### Subagent conflicts

| Path                                                                         | Continuation behavior retained                                                                            | Upstream behavior retained                                                                                                            | Resolution                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agents/subagents/announce/subagent-announce.runtime.ts`                 | Continuation spawn params, session patching, initial runtime persistence, and trace normalization.        | Direct lightweight `dispatchGatewayMethodInProcess` owner.                                                                            | Unioned; dispatch now uses the direct upstream module.                                                                                                                                                       |
| `src/agents/subagents/announce/subagent-announce-delivery.ts`                | Continuation-trigger and internal traceparent propagation into durable delivery.                          | Generated-media URL plus attachment evidence, and instance resolver support.                                                          | Queue payload spreads the upstream media object and continuation/trace facts; obsolete normalization import removed.                                                                                         |
| `src/agents/subagents/announce/subagent-announce.ts`                         | Return-route continuation trigger and traceparent.                                                        | Gateway-context resolver for instance-bound completion.                                                                               | All three facts forwarded to delivery.                                                                                                                                                                       |
| `src/agents/subagents/registry/subagent-registry-restore.ts`                 | Accepted-steer exclusion and sticky accepted-launch ownership.                                            | Restore remains dormant until lifecycle activation, uses the authoritative gateway recovery runtime, and fails closed while draining. | Upstream deferred activation owns the structure; continuation guards were ported into `activateRestoredRuns`; obsolete duplicate restore block, generic gateway fallback, and cold-start sweep were removed. |
| `src/agents/subagents/registry/subagent-registry.ts`                         | `clearSubagentRunSteerRestart` callback.                                                                  | Recovery runtime comes only from the active gateway-context resolver.                                                                 | Unioned callbacks; removed obsolete dependency lookup.                                                                                                                                                       |
| `src/agents/subagents/registry/subagent-registry-run-launch.ts`              | Continuation queue, target, fanout, announce, wake, and trace fields.                                     | Gateway-context resolver captured with each launch.                                                                                   | Additive closed registration shape.                                                                                                                                                                          |
| `src/agents/subagents/registry/subagent-registry-run-wait.ts`                | Cycle-breaking `SubagentRunOutcome` owner.                                                                | Current terminal outcome classifier.                                                                                                  | Kept the split type import and upstream classifier.                                                                                                                                                          |
| `src/agents/subagents/registry/subagent-registry.persistence.test.ts`        | Existing persistence coverage.                                                                            | Explicit registry activation after restore.                                                                                           | Imported only used `activateSubagentRegistry`; stale moved helper imports excluded.                                                                                                                          |
| `src/agents/subagents/registry/subagent-registry.persistence.resume.test.ts` | Orphan pruning before announce retry.                                                                     | Success and timeout delivery retries plus lifecycle activation.                                                                       | Both tests retained; the upstream retry remains table-driven.                                                                                                                                                |
| `src/agents/subagents/spawn/subagent-attachments.ts`                         | Canonical shared inline-attachment validation, strict byte accounting, continuation-safe error redaction. | Bounded untrusted staged-path prompt block and explicit file paths in the child prompt.                                               | Shared validator remains the single owner; duplicate upstream decode/validate loop removed; prompt block retained.                                                                                           |
| `src/agents/subagents/spawn/subagent-spawn.ts`                               | Continuation child identity, chain-state requirement, runtime persistence, and extracted collector owner. | Gateway caller's instance resolver and resolver-bound collector start.                                                                | Existing `activateCollectorSubagentRun` remains canonical; resolver is passed into it rather than retaining duplicate inlined collector lifecycle.                                                           |
| `src/agents/subagents/spawn/subagent-spawn-collector.ts`                     | Sticky accepted-launch cleanup and canonical collector lifecycle.                                         | Instance resolver is passed to `startQueuedSubagentRun`.                                                                              | Added the narrow resolver field to the existing owner.                                                                                                                                                       |
| `src/agents/subagents/spawn/subagent-spawn.attachments.test.ts`              | Malformed-shape rejection and materialization-error redaction.                                            | Exact staged paths, untrusted prompt wrapping, ampersand filename, and mount-hint placement.                                          | Both behavior families retained.                                                                                                                                                                             |
| `src/agents/subagents/spawn/subagent-spawn.test.ts`                          | Deterministic continuation child identifiers.                                                             | Canonical user-path resolution assertions.                                                                                            | Both imports retained.                                                                                                                                                                                       |

The resolved subagent subtree contains zero conflict markers and passes
`git diff --cached --check`. No test has been run while unrelated source files
remain unresolved.

## 2026-08-22T01:52:28Z - Phase 2 complete: semantic resolution and focused proof

All 61 textual conflicts are resolved and staged. `git ls-files -u` is empty,
the full tracked tree has zero conflict markers, and all 192 silent
auto-resolutions have a recorded parent-blob classification in the local
evidence ledger. The raw divergence count remains assembly-only `1113`,
upstream-only `873`; the workorder's behind/ahead prose is label-inverted.

### Agent core, runtime, and delivery resolution ledger

| Owner family                    | Pure-continuation behavior retained                                                                                                                  | Frozen-upstream behavior retained                                                                                           | Canonical resolution                                                                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent attempt/tool construction | Continuation tool registration, `continue_work` and compaction options, delegated-queue draining, terminal handoff semantics, and trace propagation. | Current tool-surface/options construction, runtime policy, prompt sanitation, stream preparation, and CLI session handling. | Current upstream construction remains the owner; continuation facts are explicit fields on that single path. The missed CLI branch now sets `allowEmptyAssistantReplyAsSilent` for every subagent lane, matching upstream's embedded and CLI contracts.        |
| Embedded stream/subscription    | Continuation terminal accounting, completion ownership, and extracted message handling.                                                              | Commentary stream state, partial-flush lifecycle, current compaction hooks, and subscription cleanup.                       | One merged stream state and lifecycle; the embedded subscription logger is extracted without a second execution path.                                                                                                                                          |
| Subagent restore/launch         | Sticky accepted-launch ownership, accepted-steer exclusion, deterministic continuation identities, and durable requester completion.                 | Restore remains dormant until Gateway lifecycle activation and uses only the instance-bound recovery runtime.               | Deferred activation owns restore. Continuation FIFO semantics run after activation. Abort confirmation is now assigned from the authoritative termination result rather than inferred from the attempt.                                                        |
| Inline attachment staging       | Shared strict snapshot validation, bounded byte accounting, continuation-safe error redaction, and exact child paths.                                | Prompt-unsafe control rejection, untrusted prompt wrapping, wrapped-path budget, and current portable filename limits.      | Shared inline validation remains canonical. Native staging rejects characters the prompt sanitizer would strip, renders the bounded path block during validation, and prepares each attachment once. Unsafe filename errors do not echo control-bearing input. |
| Auto-reply execution            | Continuation trace, accounting, terminal completion, durable return ownership, and split message-tool outcome owner.                                 | Current queue/session conflict handling, generated-media evidence, and provider dispatcher lifecycle.                       | One execution/accounting path. Message-tool outcome classification is extracted from the oversized owner; no consumer-only fallback was added.                                                                                                                 |
| Restart sentinel                | Managed delegate receipt/projection revalidation, durable queue acknowledgement metadata, trusted system events, and system-agent ownership.         | Adopted agent-turn lifecycle, safe busy retry, generated-media reconciliation, and instance resolver.                       | `server-restart-sentinel-delivery.ts` is the sole delivery owner. The duplicate sentinel implementation was deleted; its canonical function receives the resolver and preserves system-event ownership and durable ack facts.                                  |
| Session delivery queue          | Continuation codec/storage split, exact/filtered drains, managed adoption acknowledgement, and post-compaction delivery.                             | Expected-media attachments, prepared media blocks, settlement lifecycle, and SQLite queue updates.                          | One canonical codec/storage/recovery pipeline; no legacy reader or parallel queue path.                                                                                                                                                                        |
| Audit/runtime services          | Continuation admission facts and runtime-service ownership.                                                                                          | Process-owned bounded audit queue and current Gateway service/subscription lifecycle.                                       | Upstream in-process writer remains; obsolete worker path stays deleted. Runtime and subscription test support is split only to keep the production owners bounded.                                                                                             |
| Process/task queues             | Continuation lane-idle waiter and task-terminal subscription semantics.                                                                              | Ring-buffer command queue, current task registry maintenance, and restart-safe terminal handling.                           | Ring buffer remains the storage owner; dead active-task waiter APIs were removed. Task-terminal test support is extracted without a production seam.                                                                                                           |
| UI tool cards                   | Continuation tool-card completion and display behavior.                                                                                              | Current running-state and rendered card details.                                                                            | Argument-redacted tools never reveal their details through the card projection; other cards retain upstream rendering.                                                                                                                                         |
| Signal/Codex/Copilot            | Continuation reply-session ownership and dynamic continuation callbacks.                                                                             | Signal's current event handling, Codex host capability construction, and Copilot prepared tool policy.                      | Signal retries only at the outer flush boundary. Codex and Copilot use their current host surfaces with continuation facts forwarded explicitly.                                                                                                               |

### Silent-overlap repairs and generated surfaces

- Replaced stale merged references to `withTempDir`, `requestHeartbeat`,
  `upsertSessionEntry`, and obsolete test resolver names with their canonical
  merged-tree owners.
- Removed the obsolete `src/agents/openclaw-tools.options.ts` duplicate and
  retained upstream's deletion of `src/audit/audit-event-writer.worker.ts`.
- Split oversized production/test owners instead of adding max-lines
  suppressions.
- Regenerated all seven prompt snapshots from the merged source.
- Reconciled the exact merged plugin SDK surface to 147 public entrypoints,
  4,354 exports, 2,583 callable exports, 1,139 deprecated exports, and 50
  wildcard reexports.
- Shrink-pruned the assertion-safety file inventory from 4,280 to 4,279 while
  retaining the exact 13,505-assertion budget.
- Restored frozen upstream's additive
  `hasPromptUnsafeControlCharacter` prompt-sanitizer helper, which had been
  silently lost during the initial conflict resolution.

### Focused validation receipts

- Full changed-tree static plan: exit 0 across conflict-marker, max-lines,
  assertion, formatter, prompt-snapshot, SDK surface/export, dead-export,
  production/test typecheck, core/extension/script/UI lint, database,
  import-cycle, webhook, auth, dependency, patch, and boundary guards.
- Restart-sentinel owning suite after canonicalization: 2 files, 160 tests
  passed across `gateway-server` and `gateway-server-isolated`.
- Repaired agent boundaries: 1 shared-core file/8 tests plus 5 agent-support
  files/426 tests passed.
- Exact conflict-family invocation: 16 routed Vitest shards, 43 routed test-file
  executions, and 2,491 tests passed. Covered Codex, Copilot, Signal, scripts,
  agent core, embedded runtime, subagents, audit, auto-reply, Gateway restart
  and services, session delivery, process queue, task registry, and UI tool
  cards.
- Final focused command log:
  `/home/figs/.copilot/session-state/5c4fe97e-8fa2-4146-9b5e-5e1fb9953983/files/phase2-conflict-tests-final.log`.

No protected ref, forbidden composite, deployment surface, live Gateway,
database, PR #1398 branch/artifact, #121204, or #124337 was touched.

## 2026-08-22T02:01:00Z - Gate 2 review boundary

Scope baseline for review: preserve the pure-continuation invariant while
adopting frozen upstream exactly; owner boundaries are agent execution,
subagent lifecycle, durable delivery, Gateway recovery, runtime state, and
their relevant plugin/UI projections. No product/config/protocol/schema or
release contract change is authorized.

- Targeted `node scripts/check-changed.mjs -- <13 repaired owner/test paths>`
  exited 0, including full core production/test typechecks, core lint,
  formatter, dead exports, conflict markers, import cycles, database-first,
  schema-version, dependency, patch, plugin-boundary, and assertion/max-lines
  ratchets.
- The first mandatory autoreview attempt used `--mode uncommitted`. TruffleHog
  passed, then the helper correctly refused two binary paths. Their staged
  blobs are independently byte-identical to frozen upstream:
  - `extensions/crabbox/assets/openclaw-worker-wallpaper.png` =
    `8b17aa794fbb9973c6520a06f8cc8c782ef08b87`
  - `extensions/whatsapp/src/__fixtures__/large-noisy.webp` =
    `15e1c70a9719582baa40c18ca02a578e62cc1080`
- A whole-text synthetic commit still contained inherited upstream fixture data
  that autoreview's secret-like-value heuristic refused without disclosure.
  No value was inspected or exposed.
- The review was therefore scoped reproducibly to the exact semantic-resolution
  delta: Git automatic merge tree
  `33b3da0b693cbc524ebf68ac69294a63c6804242`, synthetic auto-merge commit
  `4d79fd1933d6e76a33b40b78ae74012b339a1904`, and exact staged semantic
  candidate `c4b92d8083175c70870285b419cc10d171432e51`. This covers 102 manually
  resolved/reconciled files and excludes only byte-identical automatic
  upstream projection.
- Mandatory autoreview command:
  `.agents/skills/autoreview/scripts/autoreview --mode commit --commit c4b92d8083175c70870285b419cc10d171432e51 ...`
- Result: one 309,763-byte review pass, TruffleHog clean, no accepted/actionable
  P0 findings, overall patch-correct probability 0.87.
- Review artifacts:
  `/home/figs/.copilot/session-state/5c4fe97e-8fa2-4146-9b5e-5e1fb9953983/files/autoreview-resolution.{txt,json}`.

## 2026-08-22T03:50:19Z - Gate 2.5 focused continuation repair blocked by inherited test routing

### Frozen state and preserved repair

- Candidate remained `b5f1960fd4de5dd7a1c527e52f261c80a4b10f9e`.
- Exact parents remained root
  `fec23d77520e8881f1e61b3a9ecbb3f53ecac1c2` and frozen upstream
  `3376c29800166a3151cbca6b8ab204964e97ac39`.
- The existing uncommitted test-only repair in
  `src/sessions/session-state-notices.test.ts` remains unchanged: its heartbeat
  and system-event mocks expose the merged raw exports. The existing five
  behavior tests fail before that mock correction and pass after it without a
  production seam or new test.
- No production or additional test edit was made during this continuation.

### Exact-parent classification

All seven remaining failure records belong to one inherited frozen-upstream
test-routing defect, not a merged production contract regression:

| Failure surface                                  | Canonical owner result            | Exact-parent evidence                                                                                                                                                                                                                                                       | Classification           |
| ------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `tool-resolution.test.ts` `beforeAll`            | `gateway-core`: 15/15 passed      | Root has no isolated Gateway project. Frozen upstream added `gateway-server-isolated`; candidate and upstream config blobs are both `47e2f1fdb3b3145689b9892c5ae70188dc549a2e`.                                                                                             | Inherited parent failure |
| `server-cron.test.ts` script failure detail      | `gateway-server`: 77/77 passed    | The test is absent from root and present in frozen upstream. The normal server owner passes; only the inherited isolated duplicate times out.                                                                                                                               | Inherited parent failure |
| Three `agent.test.ts` registry/abort assertions  | `gateway-methods`: 290/290 passed | `agent.test.ts`, `agent.ts`, the abort helper, and `chat-abort-handler.ts` are byte-identical across both parents and candidate where present; the mixed-delivery helper is byte-identical to frozen upstream. The duplicate isolated copy alone loses registry visibility. | Inherited parent failure |
| Two `server-methods.test.ts` approval assertions | `gateway-methods`: 214/214 passed | `exec-approval.ts`, `exec-approvals.ts`, approval request delivery, and approval wait response are byte-identical across both parents and candidate. The duplicate isolated copy alone times out or misses the accepted response.                                           | Inherited parent failure |

The routing cause is exact and deterministic. The frozen-upstream isolated
config reads the process-wide `OPENCLAW_VITEST_INCLUDE_FILE` and selects it
before intersecting with `gatewayServerIsolatedTestFiles`. An exact source
snapshot of frozen upstream and the candidate both projected all four unrelated
failure files into `gateway-server-isolated`; the root snapshot has no isolated
project. Candidate narrow runs therefore executed every file twice: the
canonical owner copy passed, then the wrongly admitted isolated copy reproduced
the same timeout or shared-registry assertion. Raising timeouts, weakening
assertions, or changing continuation/approval production code would conceal the
inherited harness defect and is not authorized by this work order.

### Required reruns

- Serial canonical owners:
  - `gateway-core` tool resolution: 1 file, 15 tests passed;
  - `gateway-server` cron: 1 file, 77 tests passed;
  - `gateway-methods` agent plus server methods: 2 files, 504 tests passed.
- Uninterrupted exact 103-file Gate 2.5 set:
  - 30 gateway files passed;
  - 2,747 tests passed;
  - 15 tests skipped;
  - six tests and one suite failed across the same four wrongly admitted
    `gateway-server-isolated` files;
  - final exit 1 after 478.07 seconds.
- Focused and full artifacts:
  `/home/figs/.copilot/session-state/15b894b2-9164-4158-999f-41088235e0a3/files/gate25-{candidate-narrow,owner-serial,full-103.log}`.

Gate 2.5 cannot turn green without repairing an inherited frozen-upstream test
harness defect, while the focused work order permits edits only for
merged-contract regressions. This is the exact blocker; Gate 2.7 and later gates
were not started. Production LOC delta is zero. The preserved test repair is
two added and two removed mock-export lines. No commit or push was made because
the work order conditions those actions on a green Gate 2.5.

Hard stops remain intact: the forbidden composite and the #121204 branch are
not ancestors of the candidate; frozen upstream is an ancestor; protected refs,
deployment, PR #1398, #124337, rebase, squash, amend, and force-push were not
touched.

## 2026-08-22T04:02:00Z - Gate 2.5 scribe disposition accepted

The final-gates work order records the scribe disposition that the six remaining
assertion failures and one suite timeout are controlled inherited
test-routing debt, not candidate production regressions. Gate 2.5 therefore
closes on canonical once-per-owner execution while preserving the complete red
umbrella receipt. No production or harness change is authorized merely to make
the duplicate execution green.

Independent verification confirmed:

- `src/sessions/session-state-notices.ts` imports the merged raw boundaries
  `requestHeartbeatRaw` and `enqueueSystemEventRaw`. The preserved test-only
  repair makes the two `vi.mock` factories expose those exact keys; the focused
  owner command `node scripts/run-vitest.mjs
src/sessions/session-state-notices.test.ts` passed all 5 tests.
- The candidate and frozen-upstream
  `test/vitest/vitest.gateway-server-isolated.config.ts` blobs are both
  `47e2f1fdb3b3145689b9892c5ae70188dc549a2e`; the pure-continuation parent has
  no such file. That config gives `OPENCLAW_VITEST_INCLUDE_FILE` precedence over
  its one-file `gatewayServerIsolatedTestFiles` ownership list, admitting
  unrelated Gate 2.5 files into a second isolated execution.
- Canonical owner receipts remain exact:
  `gateway-core` passed 15/15 tool-resolution assertions,
  `gateway-server` passed 77/77 cron assertions, and `gateway-methods` passed
  504/504 agent plus server-method assertions.
- The uninterrupted 103-file umbrella receipt remains preserved at 2,747
  passed, 15 skipped, 6 failed, and one failed suite. Every failure is in the
  wrongly admitted `gateway-server-isolated` duplicate; canonical copies pass.

The accepted Gate 2.5 semantic evidence is therefore 596/596 assertions across
the four canonical owner files, plus the repaired 5/5 session-state notice
owner assertions. Production LOC delta remains zero. The only candidate code
change is the two-line mock-key correction; the journal is append-only.

## 2026-08-22T04:36:00Z - Gate 2.7 classification and cure

The first classifier attempt incorrectly supplied the latest pure-continuation
tip `c3a0e5a...` as `PRCREATE`. That made every intentional line removed
anywhere in the long-lived feature look post-fork and over-classified 419 MIXED
rows; 262 were byte-identical to that supplied root. The runbook defines the
fallback baseline as the shared merge base, so the authoritative pass uses
`4589d8514ce189b4adb8f0cf20b2a23ae92902d5`. This correction changes only
Layer C ranking; baseline-independent Layer B was identical.

The corrected exact-object pass examined 914 reviewer-visible files from frozen
upstream `3376c298...` to candidate `fe76bcf488...`:

- 289 `SAFE-NEW`;
- 596 `GENUINE`;
- one `FROZEN-STALE`;
- 28 `MIXED-CLOBBER`.

### Actionable rows

- `src/agents/sanitize-for-prompt.test.ts` was byte-identical to historical
  upstream `0f5984f4e11` and omitted frozen upstream's
  `hasPromptUnsafeControlCharacter` contract coverage. Its production helper was
  already restored during semantic resolution, so the zero-feature-byte Layer B
  cure restores the frozen-upstream import and eight-character table exactly.
  This protects the native attachment filename boundary without adding a test
  seam.
- The changed static gate exposed one candidate-parent assertion-budget debt:
  `agent-runner-result-complete.ts` carried four non-const assertions while
  frozen upstream permitted three. `EmbeddedAgentRunResult.meta.executionTrace`
  is structurally narrower than `TraceExecutionView`; removing that unnecessary
  cast and import passes core typecheck. The required shrink-only baseline update
  lowers the repository total from 13,505 to 13,504. This is a net-negative type
  repair, not a baseline increase.

### MIXED row closure

Every corrected Layer C row was compared against the shared merge base, pure
root, frozen upstream, automatic merge tree, exact candidate, introducing
history, owner callers, and tests. Four disjoint read-only reviews were then
checked directly at the consequential boundaries.

| Rows                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagent-attachments.ts`, `subagent-spawn.ts`, `subagent-spawn.attachments.test.ts`, `subagent-registry-restore.ts`, `attempt-execution.ts`, `tool-display-config.ts` | Intentional continuation overlays: shared inline validation remains canonical; native prompt-safe path rendering is additive; resolver-bound spawn/restore ownership is stronger; display entries moved to owner-scoped modules.                                                           |
| Three Codex prompt snapshots                                                                                                                                           | Deterministic regenerated character/token counters over the combined tool surface; no prompt body or tool schema dropped.                                                                                                                                                                  |
| Telegram QA, Codex auth, and Copilot bridge tests                                                                                                                      | Canonical test helper rename from removed `withTempDir` to `withTestDir`; no assertion dropped.                                                                                                                                                                                            |
| Embedded message lifecycle, attempt stream preparation, execution phase, and client tools                                                                              | State moved to `lifecycle-state.ts`; tool trust fields were grouped into one closed `subscriptionToolTrust` object and extended with trusted local-media names. All callers retain the frozen-upstream fields.                                                                             |
| `session-state-notices.test.ts`                                                                                                                                        | Frozen-upstream coalesced-wake behavior retained; descendant `fe76bcf488...` corrects only its merged raw export keys.                                                                                                                                                                     |
| Session-delivery queue storage and restart sentinel                                                                                                                    | Canonical owner extraction: media/durable queue fields remain in the queue codec and restart delivery moved to `server-restart-sentinel-delivery.ts`; no delivery branch was removed.                                                                                                      |
| Heartbeat scheduler-owner, Gateway runtime-subscription, conversation-registry, and trajectory tests                                                                   | Raw/Core helper renames or extracted test registration; assertions and behavior remain. The scheduler-owner test already imports and invokes `requestHeartbeatRaw` at the candidate.                                                                                                       |
| Plugin SDK surface report                                                                                                                                              | Reconciled combined-surface budgets and rationale; executable surface check owns the numbers.                                                                                                                                                                                              |
| Accounting test, trace owner, result completion, and assertion baseline                                                                                                | Both upstream context-token and continuation scheduler mocks are present; trace type/function export differences are active continuation diagnostics, and the result-complete missing-line signal is a structural rewrite. The only unsafe residue was the unnecessary cast removed above. |

No MIXED row requires an upstream-content restoration. The two initial repair
owners pass 17/17 prompt-sanitizer assertions and 14/14 accounting assertions.
Production delta for the Gate 2.7 cure is net -1 line; no production path,
timeout, assertion, or harness was changed to green duplicate isolated-project
execution.

## 2026-08-22T04:59:00Z - Gate 2.7 exact-head PASS

The final classifier ran against committed and pushed head
`cad7ff3918aa94ca06e4a494342666758ee2140d`, frozen upstream
`3376c29800166a3151cbca6b8ab204964e97ac39`, and merge-base Layer C baseline
`4589d8514ce189b4adb8f0cf20b2a23ae92902d5`.

- 913 reviewer-visible files examined;
- 289 `SAFE-NEW`;
- 597 `GENUINE`;
- 27 `MIXED-CLOBBER`, all covered by the preceding disposition;
- zero `FROZEN-STALE`;
- exit 0.

The prior `agent-runner-trace.ts` MIXED row disappeared because the view type is
now owner-local exactly as frozen upstream intended; the actively consumed
trace merge function remains exported. The assertion baseline now records
4,279 files and 13,504 grandfathered assertions. Changed production, test,
typecheck, lint, dead-export, database, import-cycle, dependency, patch, and
boundary gates all pass.

Durable artifacts:
`/home/figs/.copilot/session-state/fb697b5e-c2b3-42f8-89e8-904d36834ca0/files/gate-2.7-final.{log,exit}`
and
`/home/figs/.copilot/session-state/fb697b5e-c2b3-42f8-89e8-904d36834ca0/files/gate-2.7-final/classification.tsv`.

## 2026-08-22T05:06:00Z - Gate 3 tracked formatting repair

The first full `pnpm check` reached its final format stage after all preflight
guards, production/test typechecks, and core/extension/script lint passed. It
found one tracked candidate defect: `src/agents/internal-events.ts` retained a
type import before its module comment, contrary to the current import sorter.
The formatter moves that import below the module comment without changing code
or runtime bytes.

The same formatter invocation also named local untracked GitNexus skills and
workorder/dispatch files. They are required local tooling, explicitly excluded
from candidate history, and are not candidate failures. Full committed-tree
format proof must ignore only those exact untracked paths while leaving every
tracked file visible.

## 2026-08-22T06:25:00Z - Gate 3 full-suite failure classification and repairs

The full local static/build pass on `8e2a304f88f...` completed successfully:
`pnpm tsgo`, `pnpm check:test-types`, `pnpm check`, `pnpm build`, and
`pnpm check:docs` all exited 0. The initial `pnpm check` run first found and
repaired one tracked import-order defect in `src/agents/internal-events.ts`;
local untracked workorders and GitNexus material remain outside candidate
history.

The canonical `pnpm test` graph then ran 548 leaf shards with local parallelism 8. Its per-shard summaries totaled 128,651 passed, 409 skipped, and 62 failed
assertions; 12 processes exited without a summary. The run ended after 2,036.30
seconds with 19 failed shards. Repeated `Worker exited unexpectedly` records and
one Microsoft Teams shard with no output for eight minutes establish broad host
contention, but every assertion failure was still treated as actionable until
serial owner proof classified it.

### Root-cause repairs

- The extracted Gateway terminal-subscription test body used a
  `.test-support.ts` suffix not recognized by the task-boundary scanner, so raw
  task-registry test calls appeared to be production imports. Renaming it to the
  canonical `.test-harness.ts` suffix restores the intended test-only boundary;
  no allowlist grew.
- The cross-session continuation test's fallback mock omitted the current
  `attempts` result field. The real fallback entry tried to map that missing
  array, returned an error payload, and never reached bracket handling. The mock
  now returns `attempts: []` and supplies the raw assistant final that owns
  bracket recovery after visible-payload sanitization.
- The merged shared inline-attachment validator applied portable filesystem
  filename rules to ACP images even though ACP forwards only media type and
  bytes. The shared owner now exposes a closed `portable-file |
transport-only` usage mode. Native staging retains all portable and
  prompt-safe checks; ACP retains structural name checks while allowing ignored
  format/markup characters, matching frozen upstream.
- Release-dispatch tests inspected a bare fixture repository by cwd. The
  repository's `safe.bareRepository=explicit` policy rejects that form, so the
  test now uses explicit `--git-dir=.` for the two bare-repository reads.
- Filesystems on this host can report a Date-based `utimes` result 0.001 ms
  below the requested timestamp. Boundary-artifact mtime repair now requests
  two milliseconds of headroom, preserving its promised full millisecond above
  the newest input.
- Capability provider loading intentionally omits a config field when no config
  exists. Its test now expects `undefined` rather than an invented empty object.
- The publishable-plugin scanner saw a reviewed Codex process-containment
  execution site in a newly named shared generated chunk. Generated chunks
  already carry exact `//#region` source attribution and the packaged source is
  scanned with exact reviewed-layout counts. The scanner now accepts a generated
  duplicate only when its rule and attributed source path match an existing
  reviewed source finding; unknown source regions remain critical. Volatile
  chunk names no longer need new allowlist entries.
- Four UI browser tests used `file://` fixtures under host `/tmp`, which the
  available confined Chromium could not read. Stateless fixtures now use
  `page.setContent`; the installed-window test uses a loopback HTTP fixture so
  Chromium still supplies genuine `display-mode: standalone`.
- The Anthropic catalog test now compares the observed transcript mtime after
  `utimes`, not the requested Date value, preserving the exact cache
  invalidation assertion across sub-millisecond filesystem rounding.

The complete named-failure replay ran serially through 11 canonical Vitest
projects and passed 589/589 assertions. Additional shared/native attachment
owner proof passed 173/173 assertions. No timeout was raised, no assertion was
weakened, and no product path was changed to compensate for Gate 2.5's duplicate
isolated-project routing.

### Final full-suite repair details

The 548-shard parallel run's 62 assertion failures and 12 worker exits were
replayed through their canonical owners with one Vitest worker. This separated
load-induced process loss from nine deterministic owner defects:

- `server-runtime-subscriptions.task-terminals.test-support.ts` was an extracted
  test body with a suffix the task-boundary scanner intentionally treats as
  production. It is now named `.test-harness.ts`, matching the canonical
  test-only suffix; the scanner allowlist remains unchanged.
- `subagent-announce.crosssession-gate.test.ts` mocked the old model-fallback
  result shape without `attempts`. Current `runEmbeddedAgentEntry` maps that
  array before returning the selected result, so the stale mock failed before
  bracket continuation handling. The mock now returns `attempts: []` and the
  four cases provide the raw assistant final used after visible-payload
  sanitization.
- Shared inline attachment preparation had made portable filesystem names
  unconditional. ACP transports only image bytes and MIME type and never stages
  or renders the caller's filename. A closed `portable-file | transport-only`
  mode restores that owner split: native subagent staging keeps portable and
  prompt-safe checks, while ACP keeps structural name validation without
  rejecting ignored bidi or markup characters.
- The release-dispatch fixture now marks its bare repository explicitly with
  `--git-dir=.` when reading refs, satisfying `safe.bareRepository=explicit`.
- Boundary artifact mtime repair now requests two milliseconds of headroom
  because this filesystem reports Date-based `utimes` 0.001 ms below the
  requested value; the owner contract still requires a full millisecond above
  the newest input.
- Capability manifest loading correctly preserves absent config as `undefined`;
  the stale test expectation no longer invents `{}`.
- The package security scan now uses generated chunk `//#region` attribution to
  recognize only exact rule IDs from already-reviewed packaged source. Unknown
  source regions remain critical; volatile bundler chunk names no longer need
  allowlist expansion.
- Four browser-style tests now inject stateless fixtures with
  `page.setContent`, avoiding a confined Chromium's inaccessible host `/tmp`.
  The installed-window case serves the same fixture over a loopback HTTP server
  so it still proves Chromium's real standalone display mode.
- The Anthropic catalog cache assertion compares the filesystem-observed mtime,
  not the requested Date value that may round by 0.001 ms.

Focused final receipts:

- task boundary 5/5 and Gateway subscription owners 54/54;
- release and boundary tooling 47/47;
- continuation cross-session gate 4/4;
- shared/native/ACP attachment owners 173/173;
- capability and package security owners 165/165;
- Control UI browser owners 27/27;
- Microsoft Teams owners 40/40;
- Anthropic catalog owner 57/57;
- TUI PTY owner 63/63;
- bundled provider auth parity 20/20.

All named assertion failures from the parallel run are green. Its unsummarized
worker exits remain host-pressure evidence; Gate 3g's mandated single-worker
full graph is the authoritative whole-suite rerun.

## 2026-08-22T07:31:00Z - Gate 3g first fallback run

Mode-B was not dispatched. The final-gates work order records that its accepted
163-shard digest is SHA-pinned to `f94f945...`, not this candidate's current
planner graph. Current workflow run `32539751228` independently demonstrates
the older Mode-B surface and is not candidate evidence. Per the explicit
workorder, Gate 3g uses local `scripts/prepush-ci.sh`; Mode-B tooling is not
changed in this lane.

The first Gate 3g run used `OPENCLAW_PREPUSH_SKIP_MACOS=1`,
`OPENCLAW_VITEST_MAX_WORKERS=1`, `OPENCLAW_TEST_PROJECTS_SERIAL=1`, and a
6,144 MiB Node heap. It passed:

- `pnpm check`;
- strict build and plugin SDK export checks;
- UI raw-window guard;
- protocol generation and Swift drift check;
- plugin asset build;
- the single-worker extension suite: 5,341 passed, 57 skipped.

It then ran the single-worker unit suite and stopped after 9,430 passed, 15
skipped, and four failed assertions:

- Node workspace transfer asserted exact `0644`/`0755` modes even though Git
  preserves only executable-bit identity and checkout applies the host umask.
  Assertions now check `mode & 0o111`, protecting the actual Git contract.
- Two Git backup assertions inspected a bare fixture by cwd, which
  `safe.bareRepository=explicit` correctly rejects. They now pass the fixture as
  explicit `--git-dir`, including the negative no-ref assertion that previously
  passed for the wrong safety-policy error.

The focused owners now pass 27/27 assertions. The first Gate 3g log and exit
receipt are
`/home/figs/.copilot/session-state/fb697b5e-c2b3-42f8-89e8-904d36834ca0/files/gate-3g-prepush.{log,exit}`.

## 2026-08-22T09:47:00Z - Gate 3g second-run correction and portal repair

The second Gate 3g run at `1618911fbf5cc1cd8098770d2066f89d72769374`
was stopped by this driver after its full-suite phase had progressed through
the auto-reply shards. A contemporaneous status message incorrectly called the
run contaminated by edits; no source edit occurred after that run started.
This append-only correction supersedes that statement. The partial run is valid
evidence for every completed preceding phase and failure, but it is not a
complete Gate 3g receipt because the owned process was stopped before the
remaining shards.

The partial run passed `pnpm check`, strict build, protocol generation and Swift
check, plugin assets, all 5,341 extension assertions with 57 skipped, and the
previously failing unit tests. It then exposed one deterministic Gateway
failure: the portal proxy promised a localhost dual-stack dial but depended on
the host resolver returning both loopback families. This host resolves
`localhost` only to IPv4 even though an IPv6-only `::1` listener works.

The portal connection owner now supplies the fixed loopback pair `127.0.0.1`
and `::1` to Node's `autoSelectFamily` dial for both HTTP and WebSocket
connections. The destination remains strictly loopback; no network trust
surface expands. Both routed portal owner copies pass 20/20 assertions.

### Direct Codex contract evidence

The package scan touches Codex runtime evidence, so the mandatory direct sibling
inspection used `../codex` tag `rust-v0.148.0^{}` at
`3ba0f711642a888aec92a611a3f3b2211157ff89`.

- `codex-rs/core/src/spawn.rs:90-136` deliberately gives spawned shell work a
  parent-death signal on Linux and `kill_on_drop(true)`.
- `codex-rs/core/src/exec.rs:989-1042` terminates and, after a grace period,
  kills the full process group on timeout, cancellation, and Ctrl-C.
- `codex-rs/app-server/src/request_processors/process_exec_processor.rs:397-408`
  exposes the app-server process kill control.

OpenClaw's bounded `ps` inspection in
`extensions/codex/src/app-server/transport-process-containment.ts` therefore
implements a real lifecycle contract. The package scanner still requires its
exact reviewed source finding; it suppresses a generated duplicate only when
the chunk itself attributes the same rule to that source region.

## 2026-08-22T14:15:29Z - Gate 3g immutable failure and owner-boundary repairs

The complete Gate 3g fallback ran from immutable pushed head
`aa02de3419ba94e3e4885a27fe6f9703a3cc844b` with
`OPENCLAW_PREPUSH_SKIP_MACOS=1`, `OPENCLAW_VITEST_MAX_WORKERS=1`,
`OPENCLAW_TEST_PROJECTS_SERIAL=1`, and a 6,144 MiB Node heap. It completed all
548 full-suite shards in 10,945.73 seconds and exited 1. The durable receipt is
`/home/figs/.copilot/session-state/fb697b5e-c2b3-42f8-89e8-904d36834ca0/files/gate-3g-prepush-final-2.log`.

Failure classification and canonical owner proof:

- `unit-fast` reported five failures because the global pattern-file input was
  admitted by all three unit-fast projects, and bare
  `import "./*.test-support.js"` dependencies were not classified as stateful.
  The three configs now intersect pattern-file inputs with their owned file
  lists, and helper discovery recognizes both `from` and bare imports. The
  routing regression passes 14/14; the complete unit-fast owner passes 1,295
  files with 14,562 assertions and 7 skipped.
- `subagent-registry-lifecycle.test.ts` proved that delete cleanup retired a row
  after an accepted steer dispatch had taken ownership. Cleanup now preserves
  and persists that authoritative row. The complete lifecycle owner passes
  150/150.
- The TUI synchronized-row assertion was transient under the 548-shard run;
  its complete PTY owner passed 63/63 unchanged.
- Microsoft Teams entered a host-pressure timeout cascade after a long no-output
  interval. Its unchanged complete owner passed 91 files and 1,433 assertions.
- The auto-reply shard had one worker exit plus stale continuation fallback
  fixtures. Nine mocks now return the current `attempts` field. The trace owner
  removes only exact cross-source duplicates now that run-entry also projects
  outer fallback attempts, while preserving repeated attempts within either
  source. The raw continuation fixture now pins its supplied active config
  snapshot, and the topology contract follows the current lazy loader owner in
  `subagent-announce-deps.ts`. The complete auto-reply owner passes 250 files
  with 5,092 assertions, 2 skipped, and 1 todo.

The repair batch adds 25 net production lines across the accepted-steer owner
and trace merge, 15 net test-runner tooling lines, and 42 net test lines. The
positive production delta records two owner invariants that cannot be expressed
by downstream guards: accepted dispatch authority survives cleanup, and one
fallback attempt observed through two metadata sources renders once.

`node scripts/check-changed.mjs -- <18 changed paths>` exits 0 across production
and test typechecks, formatter, core/script lint, dead exports, import cycles,
database/schema, dependency, patch, plugin-boundary, and repository ratchets.
Focused routing and lifecycle owners pass 14/14 and 150/150. Mandatory
uncommitted autoreview used Codex `gpt-5.6-sol` at high reasoning, passed
TruffleHog, and returned no accepted/actionable findings with patch-correct
probability 0.99.

## 2026-08-22T19:27:00Z - Current-upstream absorb: frozen inputs, savegame, merge topology

Lane: `codeagent/continuation-current-upstream-absorb`. This section is the
append-only record for absorbing current upstream
`23854c39fc7d87b659d5ae1ab86a97880f2fd210` onto the accepted continuation
candidate `2f08a3b375d55525570c23a49829b4976838b390`.

### Frozen inputs and pre-mutation verification

- Base (exact, workorder-pinned): `2f08a3b375d55525570c23a49829b4976838b390`.
- Upstream target (exact, workorder-pinned):
  `23854c39fc7d87b659d5ae1ab86a97880f2fd210`
  (`fix: show WebChat attachments from active runs [AI-assisted] (#127879)`).
- `git merge-base 2f08a3b3 23854c39` returned
  `3376c29800166a3151cbca6b8ab204964e97ac39` exactly. The merge-base is the
  frozen upstream the previous lane absorbed, so this is a true three-way merge
  with a correct common ancestor rather than a re-parented frozen tree. That is
  the structural reason the frozen-wall reverse-clobber class from the GATES
  runbook does not apply mechanically here; it was still audited empirically
  below rather than assumed away.
- `git rev-list --left-right --count 2f08a3b3...23854c39` returned `1123 177`.
  The upstream-only side is 177 commits, matching the work order.
- `git diff --name-only 3376c298 23854c39 | wc -l` returned `1165`, matching the
  work order's file-drift figure.
- `git merge-base --is-ancestor 46f4d2115700d574501bb3c4763abf6b2ba977fe
2f08a3b3` exited 1. The forbidden composite is not an ancestor of the base and
  therefore cannot become one through this merge, whose only new parent is
  upstream.
- `git fetch upstream` was run before reasoning about the target.
  `git merge-base --is-ancestor 23854c39 upstream/main` exited 0, proving the
  pinned target is genuinely on upstream `main` (upstream tip at fetch time was
  `d0700b3bc26bc409e4d7aaaf38f7e1d71053b2f3`; later upstream flux is context
  only, never the authority for this pinned absorb).
- Tracked tree was clean at start (`git status --porcelain` empty).

### Gate 1 savegame

- Immutable savegame ref:
  `savegame/20260822-1927Z/continuation-current-upstream-absorb-pre-23854c39`.
- `git ls-remote origin` resolved that ref to
  `2f08a3b375d55525570c23a49829b4976838b390`. It will not be deleted or moved.

### Pre-mutation conflict inventory

`git merge-tree --write-tree --name-only 2f08a3b3 23854c39` was run before any
mutation. It reported 45 files requiring three-way content resolution and 8
textual conflicts:

1. `extensions/codex/src/app-server/side-question.ts`
2. `scripts/plugin-sdk-surface-report.mts`
3. `src/agents/command/attempt-execution.ts`
4. `src/agents/embedded-agent-runner/run/source-reply-payloads.ts`
5. `src/agents/transcript-redact.test.ts`
6. `src/cli/config-cli.test.ts`
7. `src/plugins/capability-provider-runtime.test.ts`
8. `test/scripts/package-mac-app.test.ts`

Highest-risk continuation surfaces in that set were reported before mutation:
`attempt-execution.ts` (the CLI/embedded run-dispatch owner that carries the
continuation's traceparent scoping and admission wrapper),
`source-reply-payloads.ts` (reply-item shape), and `side-question.ts` (the /btw
fork's continuation-tool suppression).

### Merge topology

`git merge --no-ff 23854c39fc7d87b659d5ae1ab86a97880f2fd210` produced
`d54403ab018178fe8d946eecc44b86258c1b1def` with exactly two parents:

- parent 1 `2f08a3b375d55525570c23a49829b4976838b390` (continuation candidate)
- parent 2 `23854c39fc7d87b659d5ae1ab86a97880f2fd210` (current upstream)

No squash, no rebase, no fast-forward.

## 2026-08-22T19:40:00Z - Conflict resolution ledger

Every conflict was resolved by reading the three-way `zdiff3` base side and
applying upstream's exact delta onto the continuation side. No file used
wholesale `--ours` or `--theirs`.

- `src/agents/command/attempt-execution.ts`. The conflict hunk spanned 132 lines
  on the continuation side because the continuation wraps the CLI dispatch in
  `withLocalSessionPlacementTurnAdmission` plus
  `runWithDiagnosticTraceparent`, and adds the fork-store claim/restore/persist
  callbacks and the generated-media retry guard. Diffing the base side against
  the upstream side showed upstream's entire delta in that region was one added
  line, `contextWindow: params.sessionEntry?.contextWindow,` directly after
  `chatType`. That single line was inserted into the continuation side at the
  matching position and indentation; everything else on the continuation side
  was preserved verbatim. The embedded-runner branch of the same file already
  carried the identical field through clean auto-merge, so both dispatch paths
  now pass the session context window.
- `src/agents/embedded-agent-runner/run/source-reply-payloads.ts`. Upstream
  widened `sourceReplyMirror` with `transcriptOwner?: true`; the continuation
  added a sibling `preserveTextWhitespace?: boolean` field. Both were kept. The
  mirror-construction body had already auto-merged upstream's
  `...(payload.transcriptOwner ? { transcriptOwner: true as const } : {})`
  projection, so the type and its producer agree.
- `extensions/codex/src/app-server/side-question.ts`. The continuation adds
  `disableContinuationTools: true` so a `/btw` fork cannot expose continuation
  or compaction controls it does not own; upstream added
  `...(toolConstructionPlan ? { toolConstructionPlan } : {})`. Both were kept.
  `toolConstructionPlan` is bound earlier in the same function by
  `resolveCodexNodePlacementToolConstructionPlan`, so upstream's spread resolves.
- `scripts/plugin-sdk-surface-report.mts`. Two budget ceilings conflicted. These
  are additive counters, so both deltas from the shared base were summed rather
  than either side being chosen: public exports `4337 + 17 (continuation) + 3
(upstream) = 4357`, public function exports `2578 + 5 + 3 = 2586`. Upstream's
  two justification comments were kept alongside the continuation's. The summed
  ceilings are verified empirically by `pnpm plugin-sdk:surface:check`; they are
  not an operator estimate.
- `src/agents/transcript-redact.test.ts`. Both sides appended new test blocks at
  the same anchor with an empty base side, so this is a pure additive union. The
  continuation's `continue_delegate` transcript-boundary redaction test and both
  of upstream's new tests (source-assignment preservation in tool results, and
  broad assignment masking for non-tool messages) are all present. No upstream
  assertion was weakened, reordered, or removed.
- `src/cli/config-cli.test.ts`. Union of both added imports; the continuation's
  `useHermeticOpenclawEnv` sorts before upstream's `ConfigMutationConflictError`
  under the repository's import ordering.
- `src/plugins/capability-provider-runtime.test.ts`. The continuation had
  narrowed `expectManifestRegistryLoad` to `OpenClawConfig | undefined`;
  upstream widened it to `OpenClawConfig | Record<string, never> | undefined`.
  Upstream's signature was taken because it is the only one that types all three
  live call sites in the merged file: `expectManifestRegistryLoad(0, params.cfg)`,
  `(0, undefined)`, and `(0, {})`. Taking the continuation's narrower signature
  would have forced a change to upstream's own new `{}` call site, which the
  work order forbids.
- `test/scripts/package-mac-app.test.ts`. Both sides fixed the same host leak:
  a system corepack with a cached pnpm satisfies the detection this negative
  test needs to fail. The continuation stripped `/usr/bin:/bin` from `PATH`;
  upstream kept the realistic `PATH` and instead pointed `COREPACK_HOME` at an
  empty temp dir with `COREPACK_ENABLE_NETWORK=0`. Upstream's current fix was
  restored in full because it neutralizes corepack without shrinking the `PATH`
  the helper is supposed to be exercised against, so it proves strictly more
  than the continuation's workaround while fixing the same flake. This is a
  restoration of upstream's fix, not a weakening of it; no assertion changed.

## 2026-08-22T19:45:00Z - Silent-overlap and reverse-clobber audit

Rather than assume the correct merge-base makes reverse clobber impossible, the
whole absorb surface was walked mechanically.

Partition of the drift, computed against the shared base `3376c298`:

- upstream-touched files: 1165
- continuation-touched files: 930
- both-sides-touched (the entire silent-overlap risk surface): 45
- upstream-only files: 1120

Layer-A equivalent: every one of the 1120 upstream-only files is byte-identical
to upstream in the merge head. `git diff --name-only HEAD 23854c39` intersected
with the upstream-only set returned 0 files. There is no pure clobber anywhere
outside the 45 both-sides files.

Layer-B/C equivalent for the 45 both-sides files: for each file, every line
upstream added between `3376c298` and `23854c39` was checked for presence in the
merge head. Across all 45 files, exactly 3 upstream-added lines are absent, and
all 3 are deliberate and accounted for:

- `scripts/plugin-sdk-surface-report.mts`: the literals `4340,` and `2581,` are
  absent because they were summed with the continuation's deltas into `4357,`
  and `2586,` as recorded above. Dropping upstream's smaller ceiling is the
  correct resolution for an additive budget; keeping it verbatim would have
  under-counted the continuation's own exports.
- `src/agents/command/attempt-execution.ts`: upstream's
  `contextWindow: params.sessionEntry?.contextWindow,` at 12-space indentation
  is absent only as that exact byte string. The same field is present at 14-space
  indentation because the continuation nests the CLI call one level deeper inside
  its admission wrapper. Confirmed present at both the CLI and embedded call
  sites.

No `FROZEN-STALE` class file exists in this absorb, and no `MIXED-CLOBBER` row
survived triage: the only three candidate rows are the three explained lines
above.

### Gate 2.5 semantic-conflict surface

Upstream changed 397 test files in the 177-commit delta. Intersecting that set
with the both-sides-touched set gives 21 test files that are semantic-conflict
candidates (upstream changed the test while the continuation also changed it):
`extensions/clickclack/src/accounts.test.ts`,
`extensions/codex/src/app-server/dynamic-tool-build.test.ts`,
`extensions/codex/src/app-server/side-question.test.ts`,
`extensions/telegram/src/bot.create-telegram-bot.test.ts`,
`src/agents/session-tool-result-guard.test.ts`,
`src/agents/subagents/announce/subagent-announce.format.e2e.test.ts`,
`src/agents/subagents/announce/subagent-announce.requester-settle-wake.test.ts`,
`src/agents/tools/sessions-spawn-tool.test.ts`,
`src/agents/transcript-redact.test.ts`,
`src/auto-reply/reply/commands-system-prompt.test.ts`,
`src/cli/config-cli.test.ts`, `src/cli/daemon-cli/install.test.ts`,
`src/commands/onboard-non-interactive.gateway-health-auth.test.ts`,
`src/commands/status.test.ts`, `src/gateway/config-reload.test.ts`,
`src/gateway/server-methods/server-methods.test.ts`,
`src/logging/diagnostic.test.ts`,
`src/plugins/capability-provider-runtime.test.ts`,
`src/state/openclaw-state-db.test.ts`, `test/scripts/package-mac-app.test.ts`,
`ui/src/components/form-controls.browser.test.ts`.
These are the owner tests run locally; the remaining 376 upstream-changed test
files are covered by the broad Mode-B dispatch rather than a local monolithic
loop, per the work order.

### Deviations

- The work order forbids `scripts/prepush-ci.sh` as the broad completion gate
  and forbids a local monolithic full-suite loop. The standing dispatch policy's
  generic `node --import tsx scripts/test-projects.mts` completion signal is
  therefore superseded for this lane by the workorder's Mode-B instruction. This
  is recorded as an explicit, workorder-directed deviation, not a skipped gate.
- `pnpm install --frozen-lockfile` required `CI=true` and a `node_modules` purge
  because the upstream absorb changed the virtual-store layout. One retry was
  needed after a transient `ERR_PNPM_ENOENT` importing from the host's shared
  pnpm store (`/home/figs/actions-runner/_work/_temp/openclaw-local-ci-pnpm-store`,
  shared with the local CI runner, which was idle). The retry installed cleanly.
  No repository dependency, lockfile, patch, or store configuration was changed.
- GitNexus index artifacts and any generated guidance stay untracked and out of
  the candidate diff.

## 2026-08-23T09:04:00Z - Continuation drift-cure restart: Phase 0 through Phase 2

Lane:
`frond-scribe/20260823/assembly-85651-continuation-drift-cure`.
This section starts a new append-only cycle in the inherited continuation
journal. Earlier entries remain unchanged.

### Workorder readback and stop boundary

- Durable workorder:
  `/home/figs/flesh_beast_best_beast/WORKTREES/frond-scribe-continuation-gates-workorder/dispatch-substrate/20260823/openclaw-85651-continuation-drift-cure/continuation-drift-cure-lane-workorder-v1.md`.
- SHA-256:
  `babe8b9d69e26e8be65f1f2104eb00895e288cd61668c8a3681feedbcbadb69b`.
- Title:
  `Workorder: Safe continuation drift-cure candidate for openclaw/openclaw#85651`.
- Version: `v1`.
- GitHub Copilot CLI `1.0.81-7`, model `gpt-5.6-sol`, quality/maximum
  effort, seat Ronan, tmux `oc-85651-continuation-cure-20260823`.
- The presentation ref is read-only in this lane, and this lane stops at the
  Gate 5 intent boundary.
- Presentation movement, upstream PR mutation, force-push, rebase, squash,
  deployment, runtime smoke, feature proof fire, and generic behavioral proof
  fire remain forbidden.

### Remote-current authority

- `karmaterminal/openclaw-bootstrap` default branch:
  `6dd6c3a7712c8ae02937a29054525b2ddacb89c1`.
- Bootstrap blobs:
  - `RUNBOOKS/ENTRYPOINT.md`:
    `8f6c1dd926a06be117e893e18eeb5be8a2568368`;
  - `RUNBOOKS/PR-DRIFT-CURE-GATES-RUNBOOK.md`:
    `e42d5eedbf52cb1d0fa307749b83c8625899c26e`;
  - `RUNBOOKS/PR-PRESENTATION-RUNBOOK.md`:
    `5602b721b079d3ea251f5e1692846baca9911c7d`;
  - `RUNBOOKS/PROOF-CORPUS-METHOD.md`:
    `a0366079fb0dc6659c21747d6cdfc05e073c1204`;
  - `RUNBOOKS/PRINCE-CODE-AGENT-RUNBOOK.md`:
    `ac3a38df91bd7636a8cec839e34b659cf65a6ab5`;
  - branch naming authority:
    `7b4a4d4d4a0cb1a37a4c3f42a634483ae63a5a24`;
  - Mode-B workflow:
    `a66cf30c9e7a0cc44438feba884129ccc0706a47`;
  - deploy workflow, read for the embargo and live schema only:
    `61d09fb4e911160f0d8244642b30e98ce692737a`;
  - Gate 2 walker:
    `4e86ba83621cec98573c5173d91e426f72e1d321`;
  - Gate 2 primitive inventory:
    `8e475b7a1a2bf14a0dda4640bd221fff867f4c1b`;
  - Gate 2.7 classifier:
    `90e4caddbe9f40248510d376bc00558ec75bcdcb`;
  - Gate 2.7 operator notes:
    `cbe52f1cdbe16f29afcc52a654d6cac8c31968c8`.
- `karmaterminal/frond-scribe` default branch:
  `49b50571d16704c2ac6017404cecb27ee5bc8b80`.
- Frond-scribe blobs:
  - drift-cure skill:
    `5adbf9ab956adf258ac72b992beda5bd42090692`;
  - GitNexus review skill:
    `cc6059aebe81a98b5226b7a1c9675a609ceeffab`.
- The frond-scribe default branch advanced after workorder authorship, but both
  required skill blobs are unchanged. Bootstrap remained at the authored
  commit.
- Local authority checkouts differed from remote-current authority. They are
  stale and excluded. The exact bootstrap authority is checked out detached at
  `6dd6c3a7712c8ae02937a29054525b2ddacb89c1` for every gate invocation.

### Target policy and watchdogs

- Fork policy source:
  `karmaterminal/openclaw@aab800a7e47c2b977a65e452a4208d81080c53de`.
- Fork `AGENTS.md` blob:
  `fcfb6cd04655ad61210e852bea30a43a91b087b7`;
  `VISION.md`:
  `890075593f71ebef4fc7243dbbb6c438ae53f0d5`;
  PR template:
  `e902c4789b21765ea16dfb75e436db5801b6450b`.
- `.github/copilot-instructions.md` and
  `.github/process_bootstrap.xml` are absent from remote-current fork and
  upstream trees, not merely missing locally.
- The fork has no active branch protection or repository rulesets. The
  candidate still uses normal non-force fast-forward pushes only.
- Upstream main is protected against deletion/non-fast-forward movement,
  requires linear history plus `clownfish/exact-merge` and
  `openclaw/ci-gate`; this lane does not mutate upstream.
- The in-agent watchdog started with a 60-second inspection loop, five-minute
  heartbeat, 15-minute no-progress alert, and 30-minute blocker.
- The independent dispatcher watchdog started with a ten-minute inspection,
  20-minute status request, 30-minute evidence capture, and 45-minute
  intervention alert.
- Both preserve phase, candidate, command, local/remote head, and tmux state.
  Neither can approve a gate or move presentation.

### Initial substrate and re-baseline

- Presentation ref and live PR head:
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Accepted continuation ref and exact source:
  `09b553e5fc7c2b3a26954046c1d9f52c55af4b40`.
- The presentation tip is an ancestor of the accepted source.
- Forbidden deployed composite:
  `6e6da7bba079b0fc50d134b96657cda683985837`.
  It was not selected, merged, rebased, cherry-picked, or used for conflict
  resolution.
- Fresh upstream:
  `bfad1bf454138d57b51106376b5d7cffd9b948f0`.
- Old merge base:
  `23854c39fc7d87b659d5ae1ab86a97880f2fd210`.
- Upstream distance after that base: 75 commits, versus the workorder snapshot
  of 32.
- Accepted feature-side paths: 929, exactly matching the workorder snapshot.
- Upstream-drift paths: 488.
- Shared paths: 34.
- Live PR state after GitHub computed mergeability:
  `mergeable=false`, `mergeable_state=dirty`.
- The first geometry command stopped before classification because `comm`
  inherited a different locale than the generated `LC_ALL=C` sorted files.
  The rerun pinned `LC_ALL=C` on both sort and intersection; no ref or source
  mutation occurred.
- At-dispatch Gate 2.7 over the accepted source examined all 929 paths:
  289 `SAFE-NEW`, 312 `GENUINE`, 328 `MIXED-CLOBBER`, zero
  `FROZEN-STALE`, exit 0. The current threshold therefore does not require a
  stale-workorder pause. MIXED rows remain a later per-row disposition surface,
  not acceptance evidence.

### Authentication and durable checkpoints

- Candidate/savegame write identity:
  `ronan-dandelion-cult`, with live `write` permission to
  `karmaterminal/openclaw`.
- Push URL:
  `https://github.com/karmaterminal/openclaw.git`.
- `scribe-dandelion-cult` is reserved for the later Mode-B dispatch and
  receipts. `ronan-auth` has not been loaded or used.
- Gate 1 immutable savegame:
  `savegame/20260823-0902Z/pr-85651-pre-continuation-drift-cure`
  resolves remotely to
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Candidate branch:
  `frond-scribe/20260823/assembly-85651-continuation-drift-cure`.
- Its initial local and remote checkpoint both resolve exactly to accepted
  source `09b553e5fc7c2b3a26954046c1d9f52c55af4b40`.
- Dedicated clean worktree:
  `/home/figs/flesh_beast_best_beast/source/WORKTREES/openclaw-85651-continuation-drift-cure-candidate-20260823`.
- The long Phase 0 notification exceeded the Discord payload limit and returned
  HTTP 400. The mandatory readback had already landed, and a compact authority
  receipt succeeded immediately afterward. This reporting failure changed no
  gate or repository state.

Next operation: freeze upstream again immediately before motion, recompute if
it moved, inventory the prospective merge, then back-merge that one full SHA
with verbose history and semantic per-file conflict resolution.

## 2026-08-23T09:14:22Z - Phase 3 upstream freeze and prospective merge

The Phase 0 through Phase 2 substrate and complete pre-motion inventories were
committed and remotely verified at
`3c97e98ccb2785ef49acc2bc86f7acffc02f4a44`. The copied Gate 2.7 text removes
only terminal whitespace inherited from truncated upstream commit subjects so
the candidate remains `git diff --check` clean; classifier fields and counts
are unchanged.

### Frozen upstream

- Phase 1 measured:
  `bfad1bf454138d57b51106376b5d7cffd9b948f0`.
- The mandatory immediate pre-motion fetch advanced upstream to:
  `3cb52f4bb869959dcd06cb6d4d33e34db3b6a665`.
- The frozen SHA contains three additional upstream commits:
  - `87665fab10162bb87430d3c1106d3c6c3fa6110b`
    `fix(talk): preserve accepted work on relay detach (#121894)`;
  - `69ae91878397f21c7ff79d9aecb6d7b449a68288`
    `perf(state): avoid duplicate ownership reads in cached transactions (#128161)`;
  - `3cb52f4bb869959dcd06cb6d4d33e34db3b6a665`
    `fix(macos): preserve externally owned attach-only gateway (#128134)`.
- Because upstream moved before freeze, every geometry input was recomputed.
  The old merge base remains
  `23854c39fc7d87b659d5ae1ab86a97880f2fd210`; upstream distance is now 78;
  accepted feature-side paths remain 929; upstream-drift paths are now 499;
  shared paths remain 34.
- The source Gate 2.7 classifier was rerun against frozen
  `3cb52f4bb869959dcd06cb6d4d33e34db3b6a665`: 289 `SAFE-NEW`, 312
  `GENUINE`, 328 `MIXED-CLOBBER`, zero `FROZEN-STALE`, exit 0. No width
  threshold pause is required.

### Prospective merge shape

`git merge-tree --write-tree --name-only
3c97e98ccb2785ef49acc2bc86f7acffc02f4a44
3cb52f4bb869959dcd06cb6d4d33e34db3b6a665` returned the expected conflict exit
and named exactly four textual conflicts:

1. `src/agents/embedded-agent-runner/run/attempt-client-tools.ts`;
2. `src/agents/embedded-agent-subscribe.handlers.ts`;
3. `src/infra/heartbeat-runner-scheduler.ts`;
4. `src/infra/heartbeat-wake.ts`.

The applicable root, `src/agents`, and
`src/agents/embedded-agent-runner/run` guides are read. Resolution will inspect
the merge-base, accepted source, frozen upstream, and staged merge candidate
for every conflict, then trace each owner to its callers and tests. No
whole-file ours/theirs routing is permitted. All 34 shared paths remain in the
broader silent-overlap and Gate 2.7 disposition walk even when Git reports no
textual conflict.

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

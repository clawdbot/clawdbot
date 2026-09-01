import path from "node:path";
import { normalizeModuleId } from "vite/module-runner";

// Exact source publications, not a naming convention. Keep symbol and string keys
// distinct; override stores and production singletons have separate lifecycle owners.
const publications: Record<string, string | symbol> = {
  "extensions/google/vertex-adc.ts": Symbol.for("openclaw.google.vertexAdcTestApi"),
  "extensions/memory-lancedb/lancedb-runtime.ts": Symbol.for(
    "openclaw.memoryLanceDbRuntimeTestApi",
  ),
  "packages/ai/src/transports/openai-responses-transport.ts":
    "openclawOpenAIResponsesTransportTestApi",
  "src/agents/agent-hooks/compaction-safeguard.ts": Symbol.for(
    "openclaw.compactionSafeguardTestApi",
  ),
  "src/agents/agent-tools.before-tool-call.wrapper.ts": Symbol.for(
    "openclaw.beforeToolCallBlockedErrorTestApi",
  ),
  "src/agents/apply-patch.ts": Symbol.for("openclaw.applyPatchTestApi"),
  "src/agents/auth-profiles/external-auth.ts": Symbol.for("openclaw.externalAuthTestApi"),
  "src/agents/auth-profiles/oauth.ts": Symbol.for("openclaw.oauthTestApi"),
  "src/agents/auth-profiles/runtime-snapshots.ts": Symbol.for(
    "openclaw.runtimeAuthSnapshotsTestApi",
  ),
  "src/agents/auth-profiles/store.ts": Symbol.for("openclaw.authProfileStoreTestApi"),
  "src/agents/auth-profiles/usage.ts": Symbol.for("openclaw.authProfileUsageTestApi"),
  "src/agents/bash-process-registry.ts": Symbol.for("openclaw.bashProcessRegistryTestApi"),
  "src/agents/cli-auth-epoch.ts": Symbol.for("openclaw.cliAuthEpochTestApi"),
  "src/agents/cli-backends.ts": Symbol.for("openclaw.cliBackendsTestApi"),
  "src/agents/cli-credentials.ts": Symbol.for("openclaw.cliCredentialsTestApi"),
  "src/agents/cli-runner/prepare.ts": Symbol.for("openclaw.cliRunnerPrepareTestApi"),
  "src/agents/command/attempt-execution.helpers.ts": Symbol.for(
    "openclaw.attemptExecutionHelpersTestApi",
  ),
  "src/agents/compaction.ts": Symbol.for("openclaw.compactionTestApi"),
  "src/agents/embedded-agent-runner/context-engine-maintenance.ts": Symbol.for(
    "openclaw.contextEngineMaintenanceTestApi",
  ),
  "src/agents/embedded-agent-runner/extra-params.ts": Symbol.for("openclaw.extraParamsTestApi"),
  "src/agents/embedded-agent-runner/run/auth-plan.ts": Symbol.for(
    "openclaw.embeddedRunAuthPlanTestApi",
  ),
  "src/agents/embedded-agent-runner/runs.ts": Symbol.for("openclaw.embeddedRunsTestApi"),
  "src/agents/embedded-agent-subscribe.handlers.messages.update.ts": Symbol.for(
    "openclaw.embeddedSubscribeMessagesTestApi",
  ),
  "src/agents/embedded-agent-tool-media.ts": Symbol.for("openclaw.embeddedSubscribeToolsTestApi"),
  "src/agents/mcp-ui-resource.ts": Symbol.for("openclaw.mcpUiResourceTestApi"),
  "src/agents/media-generation-task-status-shared.ts": Symbol.for(
    "openclaw.mediaGenerationDuplicateGuardTestApi",
  ),
  "src/agents/models-config.plan.ts": Symbol.for("openclaw.modelsConfigPlanTestApi"),
  "src/agents/models-config.ts": Symbol.for("openclaw.modelsConfigTestApi"),
  "src/agents/prepared-model-runtime.ts": Symbol.for("openclaw.preparedModelRuntimeTestApi"),
  "src/agents/session-suspension.ts": Symbol.for("openclaw.sessionSuspensionTestApi"),
  "src/agents/sessions/tools/bash.ts": Symbol.for("openclaw.bashToolTestApi"),
  "src/agents/subagents/announce/subagent-announce-delivery.ts": Symbol.for(
    "openclaw.subagentAnnounceDeliveryTestApi",
  ),
  "src/agents/subagents/announce/subagent-announce-output.ts": Symbol.for(
    "openclaw.subagentAnnounceOutputTestApi",
  ),
  "src/agents/subagents/registry/subagent-registry.ts": Symbol.for(
    "openclaw.subagentRegistryTestApi",
  ),
  "src/agents/subagents/spawn/subagent-spawn.ts": Symbol.for("openclaw.subagentSpawnTestApi"),
  "src/agents/subagents/swarm/swarm-scheduler.ts": Symbol.for("openclaw.swarmSchedulerTestApi"),
  "src/agents/tool-search.ts": Symbol.for("openclaw.toolSearchTestApi"),
  "src/agents/tools/agent-step.ts": Symbol.for("openclaw.agentStepTestApi"),
  "src/agents/tools/ask-user-tool.ts": Symbol.for("openclaw.askUserToolTestApi"),
  "src/agents/tools/image-tool.ts": Symbol.for("openclaw.imageToolTestApi"),
  "src/agents/tools/model-config.helpers.ts": Symbol.for("openclaw.modelConfigHelpersTestApi"),
  "src/agents/tools/structured-output-tool.ts": Symbol.for("openclaw.structuredOutputToolTestApi"),
  "src/agents/tools/web-fetch.ts": Symbol.for("openclaw.webFetchTestApi"),
  "src/agents/utils/tools-manager.ts": Symbol.for("openclaw.toolsManagerTestApi"),
  "src/agents/workspace-legacy-state.ts": Symbol.for("openclaw.workspaceLegacyStateTestApi"),
  "src/agents/worktrees/run-lease.ts": Symbol.for("openclaw.worktreeRunLeaseTestApi"),
  "src/auto-reply/reply/agent-runner-memory.ts": Symbol.for("openclaw.agentRunnerMemoryTestApi"),
  "src/auto-reply/reply/agent-runner-session-reset.ts": Symbol.for(
    "openclaw.agentRunnerSessionResetTestApi",
  ),
  "src/auto-reply/reply/commands-login.ts": Symbol.for("openclaw.commandsLoginTestApi"),
  "src/auto-reply/reply/queue/enqueue.ts": Symbol.for("openclaw.queueEnqueueTestApi"),
  "src/auto-reply/reply/reply-run-registry.registry.ts": Symbol.for(
    "openclaw.replyRunRegistryTestApi",
  ),
  "src/auto-reply/reply/stage-sandbox-media.ts": Symbol.for("openclaw.stageSandboxMediaTestApi"),
  "src/auto-reply/usage-bar/template.ts": Symbol.for("openclaw.usageBarTemplateTestApi"),
  "src/cli/command-secret-gateway.ts": Symbol.for("openclaw.commandSecretGatewayTestApi"),
  "src/cli/gateway-cli/run.ts": Symbol.for("openclaw.gatewayRunTestApi"),
  "src/commands/backup-shared.ts": Symbol.for("openclaw.backupPlanTestApi"),
  "src/commands/doctor-auth-migration-receipts.ts": Symbol.for(
    "openclaw.authProfileMigrationReceiptsTestApi",
  ),
  "src/commands/doctor-heartbeat-main-session-repair.ts": Symbol.for(
    "openclaw.doctorHeartbeatMainSessionRepairTestApi",
  ),
  "src/commands/doctor-sandbox.ts": Symbol.for("openclaw.doctorSandboxTestApi"),
  "src/commands/doctor-session-snapshots.ts": Symbol.for("openclaw.doctorSessionSnapshotsTestApi"),
  "src/commands/doctor-whatsapp-responsiveness.ts": Symbol.for(
    "openclaw.doctorWhatsappResponsivenessTestApi",
  ),
  "src/commands/doctor/shared/codex-native-assets.ts": Symbol.for(
    "openclaw.codexNativeAssetsTestApi",
  ),
  "src/commands/doctor/shared/codex-route-session-repair.ts": Symbol.for(
    "openclaw.codexRouteSessionRepairTestApi",
  ),
  "src/commands/doctor/shared/plugin-dependency-cleanup.ts": Symbol.for(
    "openclaw.pluginDependencyCleanupTestApi",
  ),
  "src/commands/doctor/shared/stale-auth-order.ts": Symbol.for("openclaw.staleAuthOrderTestApi"),
  "src/commands/doctor/shared/stale-oauth-profile-shadows.ts": Symbol.for(
    "openclaw.staleOAuthProfileShadowsTestApi",
  ),
  "src/commands/onboard-non-interactive/local.ts": Symbol.for(
    "openclaw.onboardNonInteractiveLocalTestApi",
  ),
  "src/commands/status.command.ts": Symbol.for("openclaw.statusCommandTestApi"),
  "src/cron/schedule.ts": Symbol.for("openclaw.cronScheduleTestApi"),
  "src/cron/service/active-run-cancellation.ts": Symbol.for("openclaw.activeCronTaskRunTestApi"),
  "src/cron/service/timer.ts": Symbol.for("openclaw.cronTimerTestApi"),
  "src/cron/session-reaper.ts": Symbol.for("openclaw.cronSessionReaperTestApi"),
  "src/entry.compile-cache.ts": Symbol.for("openclaw.entryCompileCacheTestApi"),
  "src/flows/doctor-health-contributions.ts": Symbol.for(
    "openclaw.doctorHealthContributionsTestApi",
  ),
  "src/infra/exec-approvals-store.ts": Symbol.for("openclaw.execApprovalsStoreTestApi"),
  "src/infra/session-cost-usage-cache-runtime.ts": Symbol.for("openclaw.sessionCostUsageTestApi"),
  "src/infra/session-delivery-queue-runtime.ts": Symbol.for(
    "openclaw.sessionDeliveryQueueRuntimeTestApi",
  ),
  "src/logging/diagnostic-run-activity.ts": Symbol.for("openclaw.diagnosticRunActivityTestApi"),
  "src/logging/diagnostic.ts": Symbol.for("openclaw.diagnosticTestApi"),
  "src/logging/secret-redaction-registry.ts": Symbol.for("openclaw.secretRedactionRegistryTestApi"),
  "src/media-understanding/runner.ts": Symbol.for("openclaw.mediaUnderstandingRunnerTestApi"),
  "src/media/playback-transcode.ts": Symbol.for("openclaw.playbackTranscodeTestApi"),
  "src/media/store.ts": Symbol.for("openclaw.mediaStoreTestApi"),
  "src/model-catalog/remote-overlay.ts": Symbol.for("openclaw.remoteModelCatalogOverlayTestApi"),
  "src/node-host/invoke.ts": Symbol.for("openclaw.nodeHostInvokeTestApi"),
  "src/node-host/plugin-node-host.ts": Symbol.for("openclaw.nodeHostPluginTestApi"),
  "src/plugin-state/plugin-state-store.sqlite.ts": Symbol.for("openclaw.pluginStateSqliteTestApi"),
  "src/plugin-state/plugin-state-store.ts": Symbol.for("openclaw.pluginStateStoreTestApi"),
  "src/plugins/memory-runtime.ts": Symbol.for("openclaw.memoryRuntimeTestApi"),
  "src/sessions/session-lifecycle-admission.ts": Symbol.for(
    "openclaw.sessionLifecycleAdmissionTestApi",
  ),
  "src/sessions/session-upstream-monitor.ts": Symbol.for("openclaw.sessionUpstreamMonitorTestApi"),
  "src/sessions/user-turn-transcript.ts": Symbol.for("openclaw.userTurnTranscriptTestApi"),
  "src/skills/lifecycle/install.ts": Symbol.for("openclaw.skillsInstallTestApi"),
  "src/skills/lifecycle/upload-store.ts": Symbol.for("openclaw.skillUploadStoreTestApi"),
  "src/skills/runtime/refresh.ts": Symbol.for("openclaw.skillsRefreshTestApi"),
  "src/skills/runtime/remote-skills.ts": Symbol.for("openclaw.remoteNodeSkillsTestApi"),
  "src/system-agent/agent-turn.ts": Symbol.for("openclaw.systemAgentTurnTestApi"),
  "src/system-agent/assistant-timeout.ts": Symbol.for("openclaw.systemAgentTimeoutTestApi"),
  "src/talk/client-voice-confirmation.ts": Symbol.for("openclaw.clientVoiceConfirmationTestApi"),
  "src/talk/client-voice-session.ts": Symbol.for("openclaw.clientVoiceSessionTestApi"),
  "src/tasks/generated-media-task-activity.ts": Symbol.for(
    "openclaw.generatedMediaTaskActivityTestApi",
  ),
  "src/tasks/task-flow-registry.store.ts": Symbol.for("openclaw.taskFlowRegistryStoreTestApi"),
  "src/tasks/task-flow-registry.ts": Symbol.for("openclaw.taskFlowRegistryTestApi"),
  "src/tasks/task-registry.ts": Symbol.for("openclaw.taskRegistryTestApi"),
};

// Vite's EvaluatedModuleNode.file is a normalized, query-free filesystem path.
// Store only paths and keys: this table must never retain published API values.
export const repositoryTestApiPublications: ReadonlyMap<string, string | symbol> = new Map(
  Object.entries(publications).map(([source, key]) => [
    normalizeModuleId(path.resolve(import.meta.dirname, "..", source)),
    key,
  ]),
);

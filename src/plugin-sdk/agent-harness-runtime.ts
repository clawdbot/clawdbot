// Lightweight runtime surface for plugin-owned agent harnesses.
// Keep heavyweight tool construction out of this module so harness imports can
// register quickly inside gateway startup and Docker e2e runs.

export type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
} from "../agents/harness/types.js";
export type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../agents/pi-embedded-runner/run/types.js";
export type { CompactEmbeddedPiSessionParams } from "../agents/pi-embedded-runner/compact.js";
export type { EmbeddedPiCompactResult } from "../agents/pi-embedded-runner/types.js";
export type { AnyAgentTool } from "../agents/tools/common.js";
export type { MessagingToolSend } from "../agents/pi-embedded-messaging.types.js";
export type { AgentApprovalEventData } from "../infra/agent-events.js";
export type { ExecApprovalDecision } from "../infra/exec-approvals.js";
export type { NormalizedUsage } from "../agents/usage.js";
export type {
  CodexAppServerExtensionContext,
  CodexAppServerExtensionFactory,
  CodexAppServerExtensionRuntime,
  CodexAppServerToolResultEvent,
  CodexAppServerToolResultHandlerResult,
} from "../plugins/codex-app-server-extension-types.js";

export { VERSION as OPENCLAW_VERSION } from "../version.js";
export { formatErrorMessage } from "../infra/errors.js";
export { log as embeddedAgentLog } from "../agents/pi-embedded-runner/logger.js";
export { resolveEmbeddedAgentRuntime } from "../agents/pi-embedded-runner/runtime.js";
export { resolveUserPath } from "../utils.js";
export { callGatewayTool } from "../agents/tools/gateway.js";
export { isMessagingTool, isMessagingToolSendAction } from "../agents/pi-embedded-messaging.js";
export {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "../agents/pi-embedded-subscribe.tools.js";
export { normalizeUsage } from "../agents/usage.js";
export { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
export { resolveSessionAgentIds } from "../agents/agent-scope.js";
export { resolveModelAuthMode } from "../agents/model-auth.js";
export { supportsModelTools } from "../agents/model-tool-support.js";
export { resolveAttemptSpawnWorkspaceDir } from "../agents/pi-embedded-runner/run/attempt.thread-helpers.js";
export { buildEmbeddedAttemptToolRunContext } from "../agents/pi-embedded-runner/run/attempt.tool-run-context.js";
export {
  abortEmbeddedPiRun as abortAgentHarnessRun,
  clearActiveEmbeddedRun,
  queueEmbeddedPiMessage as queueAgentHarnessMessage,
  setActiveEmbeddedRun,
} from "../agents/pi-embedded-runner/runs.js";
export { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
export { normalizeProviderToolSchemas } from "../agents/pi-embedded-runner/tool-schema-runtime.js";
export { resolveSandboxContext } from "../agents/sandbox.js";
export { isSubagentSessionKey } from "../routing/session-key.js";
export { acquireSessionWriteLock } from "../agents/session-write-lock.js";
export { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
export {
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
} from "../agents/harness/prompt-compaction-hook-helpers.js";
export { createCodexAppServerToolResultExtensionRunner } from "../agents/harness/codex-app-server-extensions.js";
export {
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessBeforeMessageWriteHook,
} from "../agents/harness/hook-helpers.js";
export {
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "../agents/harness/lifecycle-hook-helpers.js";

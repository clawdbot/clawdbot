// Public agent harness surface for plugins that replace the low-level agent runtime.
// Keep model/vendor-specific protocol code in the plugin that registers the harness.

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
export type { MessagingToolSend } from "../agents/pi-embedded-messaging.js";
export type { AgentApprovalEventData } from "../infra/agent-events.js";
export type { ExecApprovalDecision } from "../infra/exec-approvals.js";
export type { NormalizedUsage } from "../agents/usage.js";

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
export { createOpenClawCodingTools } from "../agents/pi-tools.js";
export { resolveSandboxContext } from "../agents/sandbox.js";
export { isSubagentSessionKey } from "../routing/session-key.js";
export { acquireSessionWriteLock } from "../agents/session-write-lock.js";
export { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

// Lightweight runtime surface for plugin-owned agent harnesses.
// Keep heavyweight tool construction out of this module so harness imports can
// register quickly inside gateway startup and Docker e2e runs.

import { formatToolDetail, resolveToolDisplay } from "../agents/tool-display.js";
import { redactToolDetail } from "../logging/redact.js";
import { truncateUtf16Safe } from "../utils.js";

export const TOOL_PROGRESS_OUTPUT_MAX_CHARS = 8_000;

export type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResultClassification,
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
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  AgentToolResultMiddlewareHarness,
  AgentToolResultMiddlewareOptions,
  AgentToolResultMiddlewareResult,
  AgentToolResultMiddlewareRuntime,
  OpenClawAgentToolResult,
} from "../plugins/agent-tool-result-middleware-types.js";
export type {
  CodexAppServerExtensionContext,
  CodexAppServerExtensionFactory,
  CodexAppServerExtensionRuntime,
  CodexAppServerToolResultEvent,
  CodexAppServerToolResultHandlerResult,
} from "../plugins/codex-app-server-extension-types.js";
export type {
  NativeHookRelayEvent,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "../agents/harness/native-hook-relay.js";

export { VERSION as OPENCLAW_VERSION } from "../version.js";
export { formatErrorMessage } from "../infra/errors.js";
export { formatApprovalDisplayPath } from "../infra/approval-display-paths.js";
export { emitAgentEvent } from "../infra/agent-events.js";
export { log as embeddedAgentLog } from "../agents/pi-embedded-runner/logger.js";
export { resolveEmbeddedAgentRuntime } from "../agents/pi-embedded-runner/runtime.js";
export { resolveUserPath } from "../utils.js";
export { callGatewayTool } from "../agents/tools/gateway.js";
export { formatToolAggregate } from "../auto-reply/tool-meta.js";
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
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/pi-tools.before-tool-call.js";
export {
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
} from "../agents/harness/prompt-compaction-hook-helpers.js";
export { createCodexAppServerToolResultExtensionRunner } from "../agents/harness/codex-app-server-extensions.js";
export { createAgentToolResultMiddlewareRunner } from "../agents/harness/tool-result-middleware.js";
export {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  buildHarnessContextEngineRuntimeContext,
  buildHarnessContextEngineRuntimeContextFromUsage,
  finalizeHarnessContextEngineTurn,
  isActiveHarnessContextEngine,
  runHarnessContextEngineMaintenance,
} from "../agents/harness/context-engine-lifecycle.js";
export {
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessBeforeMessageWriteHook,
} from "../agents/harness/hook-helpers.js";
export {
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "../agents/harness/lifecycle-hook-helpers.js";
export {
  buildNativeHookRelayCommand,
  registerNativeHookRelay,
} from "../agents/harness/native-hook-relay.js";

/**
 * Derive the same compact user-facing tool detail that Pi uses for progress logs.
 */
export function inferToolMetaFromArgs(toolName: string, args: unknown): string | undefined {
  const display = resolveToolDisplay({ name: toolName, args });
  return formatToolDetail(display);
}

/**
 * Prepare verbose tool output for user-facing progress messages.
 */
export function formatToolProgressOutput(
  output: string,
  options?: { maxChars?: number },
): string | undefined {
  const trimmed = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!trimmed) {
    return undefined;
  }
  const redacted = redactToolDetail(trimmed);
  const maxChars = options?.maxChars ?? TOOL_PROGRESS_OUTPUT_MAX_CHARS;
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${truncateUtf16Safe(redacted, maxChars)}\n...(truncated)...`;
}

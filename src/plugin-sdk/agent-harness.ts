import { getChildLogger } from "../logging/logger.js";
import type { RunEmbeddedPiAgentParams } from "../agents/pi-embedded-runner/run/params.js";

export { resolveUserPath } from "../utils.js";
export { resolveSandboxContext } from "../agents/sandbox/context.js";
export { createOpenClawCodingTools } from "../agents/pi-tools.js";
export {
  abortEmbeddedPiRun as abortAgentHarnessRun,
  clearActiveEmbeddedRun,
  queueEmbeddedPiMessage as queueAgentHarnessMessage,
  setActiveEmbeddedRun,
  waitForActiveEmbeddedRuns as disposeRegisteredAgentHarnesses,
} from "../agents/pi-embedded-runner/runs.js";
export { supportsModelTools } from "../agents/model-tool-support.js";
export { resolveModelAuthMode } from "../agents/model-auth.js";
export { resolveSessionAgentIds } from "../agents/agent-scope.js";
export { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
export { isSubagentSessionKey } from "../sessions/session-key-utils.js";
export {
  acquireSessionWriteLock,
  type SessionLockInspection,
} from "../agents/session-write-lock.js";
export { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
export { callGatewayTool, type GatewayCallOptions } from "../agents/tools/gateway.js";
export {
  type NormalizedUsage,
  normalizeUsage,
} from "../agents/usage.js";
export {
  type MessagingToolSend,
  isMessagingTool,
  isMessagingToolSendAction,
} from "../agents/pi-embedded-messaging.js";
export {
  extractToolResultMediaPaths as extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "../agents/pi-embedded-subscribe.tools.js";
export type { AnyAgentTool } from "../plugins/types.js";
export type {
  EmbeddedPiCompactResult as EmbeddedRunAttemptResult,
  EmbeddedPiCompactResult,
} from "../agents/pi-embedded-runner/types.js";
export type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult as EmbeddedPiAttemptResult,
} from "../agents/pi-embedded-runner/run/types.js";
export type { CompactEmbeddedPiSessionParams } from "../agents/pi-embedded-runner/compact.js";
export type { ExecApprovalDecision } from "../infra/exec-approvals.js";
export { VERSION as OPENCLAW_VERSION } from "../version.js";
export { formatErrorMessage } from "./error-runtime.js";

export const embeddedAgentLog = getChildLogger({ subsystem: "agent-harness" });

export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  config?: unknown;
};

export type AgentHarnessSupportResult =
  | { supported: true; priority?: number }
  | { supported: false; reason?: string };

export type AgentHarness = {
  id: string;
  label: string;
  supports: (ctx: AgentHarnessSupportContext) => AgentHarnessSupportResult;
  runAttempt: (params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>;
  compact?: (
    params: CompactEmbeddedPiSessionParams,
  ) => Promise<EmbeddedPiCompactResult | undefined>;
  reset?: (params: { sessionFile?: string }) => Promise<void> | void;
  dispose?: () => Promise<void> | void;
};

export type AgentApprovalEventData = {
  phase?: "requested" | "resolved";
  kind?: "exec" | "plugin";
  status?: "pending" | "approved" | "denied" | "failed" | "unavailable";
  title?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  path?: string;
  toolName?: string;
  message?: string;
};

export function buildEmbeddedAttemptToolRunContext(
  params: Pick<
    RunEmbeddedPiAgentParams,
    | "prompt"
    | "sessionFile"
    | "sessionId"
    | "sessionKey"
    | "runId"
    | "senderId"
    | "senderName"
    | "senderUsername"
    | "senderE164"
    | "messageChannel"
    | "messageProvider"
    | "messageTo"
    | "messageThreadId"
    | "currentChannelId"
    | "currentThreadTs"
    | "currentMessageId"
    | "replyToMode"
    | "hasRepliedRef"
    | "groupId"
    | "groupChannel"
    | "groupSpace"
    | "spawnedBy"
    | "senderIsOwner"
    | "disableMessageTool"
    | "requireExplicitMessageTarget"
    | "allowGatewaySubagentBinding"
  >,
) {
  return {
    prompt: params.prompt,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderIsOwner: params.senderIsOwner,
    disableMessageTool: params.disableMessageTool,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  };
}

export function resolveAttemptSpawnWorkspaceDir(params: {
  sandbox:
    | {
        enabled?: boolean;
        workspaceDir?: string;
        workspaceAccess?: "ro" | "rw";
      }
    | null
    | undefined;
  resolvedWorkspace: string;
}): string {
  if (
    params.sandbox?.enabled &&
    params.sandbox.workspaceAccess !== "rw" &&
    params.sandbox.workspaceDir
  ) {
    return params.sandbox.workspaceDir;
  }
  return params.resolvedWorkspace;
}

export function normalizeProviderToolSchemas<T>(params: { tools: T[] }): T[] {
  return params.tools;
}

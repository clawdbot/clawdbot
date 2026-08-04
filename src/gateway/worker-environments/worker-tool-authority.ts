import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { logWarn } from "../../logger.js";
import {
  WORKER_LOCAL_TOOL_NAMES,
  type WorkerLocalToolName,
  type WorkerToolAuthority,
} from "../../worker/tool-authority.js";

function resolveWorkerCapabilityProfile(params: {
  modelRef: { provider: string; model: string };
  turn: SessionPlacementTurnParams;
}) {
  const turn = params.turn;
  const sandboxSessionKey =
    turn.sandboxSessionKey?.trim() || turn.sessionKey?.trim() || turn.sessionId;
  const sandbox = resolveSandboxRuntimeStatus({
    cfg: turn.config,
    sessionKey: sandboxSessionKey,
    agentId: turn.agentId,
  });
  return resolveConversationCapabilityProfile({
    config: turn.config,
    sessionKey: sandboxSessionKey,
    runSessionKey:
      turn.sessionKey && turn.sessionKey !== sandboxSessionKey ? turn.sessionKey : undefined,
    sessionId: turn.sessionId,
    runId: turn.runId,
    agentId: turn.agentId,
    agentDir: turn.agentDir,
    agentAccountId: turn.agentAccountId,
    messageProvider: turn.messageProvider,
    messageChannel: turn.messageChannel,
    chatType: turn.chatType,
    messageTo: turn.messageTo,
    messageThreadId: turn.messageThreadId,
    currentChannelId: turn.currentChannelId,
    currentMessagingTarget: turn.currentMessagingTarget,
    currentThreadTs: turn.currentThreadTs,
    currentMessageId: turn.currentMessageId,
    groupId: turn.groupId,
    groupChannel: turn.groupChannel,
    groupSpace: turn.groupSpace,
    memberRoleIds: turn.memberRoleIds,
    spawnedBy: turn.spawnedBy,
    senderId: turn.senderId,
    senderName: turn.senderName,
    senderUsername: turn.senderUsername,
    senderE164: turn.senderE164,
    senderIsOwner: turn.senderIsOwner,
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
    workspaceDir: turn.workspaceDir,
    cwd: turn.cwd,
    isCanonicalWorkspace: turn.isCanonicalWorkspace,
    promptMode: turn.promptMode,
    skillsSnapshot: turn.skillsSnapshot,
    sandboxToolPolicy: sandbox.sandboxed ? sandbox.toolPolicy : undefined,
    runtimeToolAllowlist: turn.toolsAllow,
    inheritRuntimeToolAllowlist: true,
    runtimePluginToolGrant: turn.runtimePluginToolGrant,
    inputProvenance: turn.inputProvenance,
    trustedInternalHandoff: turn.trustedInternalHandoff,
    scheduledToolPolicy: turn.scheduledToolPolicy,
  });
}

/** Resolves the final fixed worker surface at the trusted Gateway handoff boundary. */
export function resolveWorkerToolAuthority(params: {
  modelRef: { provider: string; model: string };
  turn: SessionPlacementTurnParams;
}): WorkerToolAuthority {
  const turn = params.turn;
  if (turn.disableTools === true || turn.modelRun === true || turn.promptMode === "none") {
    return { allowedToolNames: [] };
  }
  const runtimeCappedTools = applyEmbeddedAttemptToolsAllow(
    WORKER_LOCAL_TOOL_NAMES.map((name) => ({ name })),
    turn.toolsAllow,
  );
  const projected: WorkerLocalToolName[] = projectConversationToolNames({
    capabilityProfile: resolveWorkerCapabilityProfile(params),
    toolNames: runtimeCappedTools.map((tool) => tool.name),
    warn: logWarn,
  });
  return { allowedToolNames: projected };
}

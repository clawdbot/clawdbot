import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { readToolAllowlistIntersection } from "../../agents/tool-policy.js";
import type { FollowupRun } from "./queue.js";

/** Fingerprints the complete model-facing tool authority owned by one queued turn. */
export function resolveFollowupRunToolAuthorityFingerprint(
  run: FollowupRun,
  route?: { provider: string; model: string },
): string {
  const execution = run.run;
  const provider = route?.provider ?? execution.provider;
  const model = route?.model ?? execution.model;
  const policySessionKey = execution.runtimePolicySessionKey ?? execution.sessionKey;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: execution.config,
    sessionKey: policySessionKey,
  });
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: execution.config,
    sessionId: execution.sessionId,
    sessionKey: policySessionKey,
    runSessionKey: execution.sessionKey,
    sandboxSessionKey: policySessionKey,
    agentId: execution.agentId,
    agentDir: execution.agentDir,
    agentAccountId: execution.agentAccountId,
    modelProvider: provider,
    modelId: model,
    messageProvider: execution.messageProvider,
    messageChannel: run.originatingChannel,
    chatType: execution.chatType,
    conversationToolPolicy: execution.conversationToolPolicy,
    groupId: execution.groupId,
    groupChannel: execution.groupChannel,
    groupSpace: execution.groupSpace,
    memberRoleIds: execution.memberRoleIds,
    spawnedBy: execution.spawnedBy,
    senderId: execution.senderId,
    senderName: execution.senderName,
    senderUsername: execution.senderUsername,
    senderE164: execution.senderE164,
    senderIsOwner: execution.senderIsOwner,
    workspaceDir: execution.workspaceDir,
    cwd: execution.cwd,
    sandboxToolPolicy: sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined,
    inputProvenance: execution.inputProvenance,
    trustedInternalHandoff: execution.trustedInternalHandoff,
    scheduledToolPolicy: execution.scheduledToolPolicy,
    runtimePluginToolGrant: execution.runtimePluginToolGrant,
  });
  return createHash("sha256")
    .update(
      stableStringify({
        provider,
        model,
        policy: capabilityProfile.policy,
        toolsAllow: run.toolsAllow,
        toolsAllowIntersection: run.toolsAllow
          ? readToolAllowlistIntersection(run.toolsAllow)
          : undefined,
        disableTools: run.disableTools === true,
        sessionFile: execution.sessionFile,
        agentDir: execution.agentDir,
        workspaceDir: execution.workspaceDir,
        cwd: execution.cwd,
        toolOverrides: execution.toolOverrides,
        execOverrides: execution.execOverrides,
        elevatedLevel: execution.elevatedLevel,
        bashElevated: execution.bashElevated,
        traceAuthorized: execution.traceAuthorized === true,
        approvalReviewerDeviceId: execution.approvalReviewerDeviceId,
        authProfileId: execution.authProfileId,
        clientCaps: [...new Set(execution.clientCaps ?? [])].toSorted(),
        toolBindings: execution.toolBindings,
      }),
    )
    .digest("hex");
}

import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { readToolAllowlistIntersection } from "../../agents/tool-policy.js";
import type { FollowupRun } from "./queue.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityProjector,
  ReplyToolAuthorityRoute,
} from "./reply-run-registry.contracts.js";

type ReplyToolAuthoritySnapshot = {
  originatingChannel: FollowupRun["originatingChannel"];
  toolsAllow: FollowupRun["toolsAllow"];
  toolsAllowIntersection: readonly string[][] | undefined;
  disableTools: boolean;
  run: FollowupRun["run"];
};

function snapshotFollowupRunToolAuthority(run: FollowupRun): ReplyToolAuthoritySnapshot {
  return {
    originatingChannel: run.originatingChannel,
    toolsAllow: run.toolsAllow,
    toolsAllowIntersection: run.toolsAllow
      ? readToolAllowlistIntersection(run.toolsAllow)
      : undefined,
    disableTools: run.disableTools === true,
    run: {
      ...run.run,
      clientCaps: run.run.clientCaps ? [...run.run.clientCaps] : undefined,
      memberRoleIds: run.run.memberRoleIds ? [...run.run.memberRoleIds] : undefined,
    },
  };
}

function applyReplyToolAuthorityOverlay(
  snapshot: ReplyToolAuthoritySnapshot,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthoritySnapshot {
  return {
    ...snapshot,
    originatingChannel: overlay.originatingChannel,
    toolsAllow: overlay.toolsAllow,
    toolsAllowIntersection: overlay.toolsAllow
      ? readToolAllowlistIntersection(overlay.toolsAllow)
      : undefined,
    disableTools: overlay.disableTools,
    run: {
      ...snapshot.run,
      messageProvider: overlay.messageProvider,
      chatType: overlay.chatType,
      agentAccountId: overlay.agentAccountId,
      conversationToolPolicy: overlay.conversationToolPolicy,
      groupId: overlay.groupId,
      groupChannel: overlay.groupChannel,
      groupSpace: overlay.groupSpace,
      memberRoleIds: overlay.memberRoleIds,
      spawnedBy: overlay.spawnedBy,
      senderId: overlay.senderId,
      senderName: overlay.senderName,
      senderUsername: overlay.senderUsername,
      senderE164: overlay.senderE164,
      senderIsOwner: overlay.senderIsOwner,
      inputProvenance: overlay.inputProvenance,
      trustedInternalHandoff: overlay.trustedInternalHandoff,
      scheduledToolPolicy: overlay.scheduledToolPolicy,
      runtimePluginToolGrant: overlay.runtimePluginToolGrant,
      traceAuthorized: overlay.traceAuthorized,
      approvalReviewerDeviceId: overlay.approvalReviewerDeviceId,
      clientCaps: overlay.clientCaps,
      toolBindings: overlay.toolBindings,
    },
  };
}

function resolveReplyToolAuthoritySnapshotFingerprint(
  snapshot: ReplyToolAuthoritySnapshot,
  route?: ReplyToolAuthorityRoute,
): string {
  const execution = snapshot.run;
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
    messageChannel: snapshot.originatingChannel,
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
        toolsAllow: snapshot.toolsAllow,
        toolsAllowIntersection: snapshot.toolsAllowIntersection,
        disableTools: snapshot.disableTools,
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

/** Fingerprints the complete model-facing tool authority owned by one queued turn. */
export function resolveFollowupRunToolAuthorityFingerprint(
  run: FollowupRun,
  route?: ReplyToolAuthorityRoute,
): string {
  return resolveReplyToolAuthoritySnapshotFingerprint(snapshotFollowupRunToolAuthority(run), route);
}

/** Projects a new inbound turn against one active run's frozen owner authority. */
export function createFollowupRunToolAuthorityProjector(
  run: FollowupRun,
): ReplyToolAuthorityProjector {
  const snapshot = snapshotFollowupRunToolAuthority(run);
  return (overlay, route) =>
    resolveReplyToolAuthoritySnapshotFingerprint(
      applyReplyToolAuthorityOverlay(snapshot, overlay),
      route,
    );
}

import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { cloneConfigWithResolutionFacts } from "../../config/resolution-facts.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { RuntimeMsgContext } from "../templating.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRoute,
  ReplyToolAuthoritySnapshot,
} from "./reply-run-registry.contracts.js";

export type ReplyToolAuthorityInput = {
  originatingChannel?: FollowupRun["originatingChannel"];
  toolsAllow?: string[];
  disableTools?: boolean;
  run: Partial<
    Pick<
      FollowupRun["run"],
      | "config"
      | "sessionId"
      | "sessionKey"
      | "runtimePolicySessionKey"
      | "agentId"
      | "agentDir"
      | "agentAccountId"
      | "provider"
      | "model"
      | "messageProvider"
      | "chatType"
      | "conversationToolPolicy"
      | "groupId"
      | "groupChannel"
      | "groupSpace"
      | "memberRoleIds"
      | "spawnedBy"
      | "senderId"
      | "senderName"
      | "senderUsername"
      | "senderE164"
      | "senderIsOwner"
      | "workspaceDir"
      | "cwd"
      | "inputProvenance"
      | "trustedInternalHandoff"
      | "scheduledToolPolicy"
      | "runtimePluginToolGrant"
      | "sessionFile"
      | "permissionMode"
      | "toolOverrides"
      | "execOverrides"
      | "elevatedLevel"
      | "bashElevated"
      | "traceAuthorized"
      | "approvalReviewerDeviceId"
      | "authProfileId"
      | "clientCaps"
      | "toolBindings"
    >
  > &
    Pick<FollowupRun["run"], "sessionId" | "sessionFile" | "workspaceDir" | "provider" | "model">;
};

/** Projects current inbound facts against the active run's frozen authority snapshot. */
export function resolveInboundReplyToolAuthorityOverlay(params: {
  ctx: RuntimeMsgContext;
  sessionEntry?: Pick<SessionEntry, "permissionMode" | "spawnedBy" | "toolOverrides">;
  senderIsOwner: boolean;
  toolsAllow?: string[];
  disableTools: boolean;
}): ReplyToolAuthorityOverlay {
  const { ctx } = params;
  return {
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    originatingChannel: ctx.OriginatingChannel,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: ctx.OriginatingChannel,
      provider: ctx.Provider ?? ctx.Surface,
    }),
    chatType: normalizeChatType(ctx.ChatType),
    agentAccountId: ctx.AccountId,
    conversationToolPolicy: ctx.ConversationToolPolicy,
    groupId: resolveGroupSessionKey(ctx)?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    memberRoleIds: Array.isArray(ctx.MemberRoleIds)
      ? ctx.MemberRoleIds.map((roleId) => normalizeOptionalString(roleId)).filter(
          (roleId): roleId is string => Boolean(roleId),
        )
      : undefined,
    spawnedBy: normalizeOptionalString(params.sessionEntry?.spawnedBy),
    senderId: normalizeOptionalString(ctx.SenderId),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164: normalizeOptionalString(ctx.SenderE164),
    senderIsOwner: params.senderIsOwner,
    inputProvenance: ctx.InputProvenance,
    trustedInternalHandoff: undefined,
    scheduledToolPolicy: undefined,
    runtimePluginToolGrant: undefined,
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    traceAuthorized:
      params.senderIsOwner || (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
    approvalReviewerDeviceId: normalizeOptionalString(ctx.ApprovalReviewerDeviceId),
    clientCaps: ctx.GatewayClientCaps,
    toolBindings: ctx.GatewayRunToolBindings,
  };
}

function snapshotFollowupRunToolAuthority(run: ReplyToolAuthorityInput): ReplyToolAuthorityInput {
  const toolsAllow = run.toolsAllow ? [...run.toolsAllow] : undefined;
  const intersection = run.toolsAllow
    ? readToolAllowlistIntersection(run.toolsAllow)?.map((restriction) => restriction.slice())
    : undefined;
  if (toolsAllow && intersection) {
    attachToolAllowlistIntersection(toolsAllow, intersection);
  }
  return {
    originatingChannel: run.originatingChannel,
    toolsAllow,
    disableTools: run.disableTools === true,
    run: {
      ...run.run,
      config: run.run.config ? cloneConfigWithResolutionFacts(run.run.config) : undefined,
      conversationToolPolicy: structuredClone(run.run.conversationToolPolicy),
      inputProvenance: structuredClone(run.run.inputProvenance),
      scheduledToolPolicy: structuredClone(run.run.scheduledToolPolicy),
      runtimePluginToolGrant: structuredClone(run.run.runtimePluginToolGrant),
      trustedInternalHandoff: structuredClone(run.run.trustedInternalHandoff),
      toolOverrides: structuredClone(run.run.toolOverrides),
      execOverrides: structuredClone(run.run.execOverrides),
      bashElevated: structuredClone(run.run.bashElevated),
      toolBindings: structuredClone(run.run.toolBindings),
      clientCaps: run.run.clientCaps ? [...run.run.clientCaps] : undefined,
      memberRoleIds: run.run.memberRoleIds ? [...run.run.memberRoleIds] : undefined,
    },
  };
}

function applyReplyToolAuthorityOverlay(
  snapshot: ReplyToolAuthorityInput,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthorityInput {
  return {
    ...snapshot,
    originatingChannel: overlay.originatingChannel,
    toolsAllow: overlay.toolsAllow,
    disableTools: overlay.disableTools,
    run: {
      ...snapshot.run,
      permissionMode: overlay.permissionMode,
      toolOverrides: overlay.toolOverrides,
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

function resolveReplyToolAuthorityInputFingerprint(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
): string {
  const execution = snapshot.run;
  const provider = route?.provider ?? execution.provider;
  const model = route?.model ?? execution.model;
  const policySessionKey = execution.runtimePolicySessionKey ?? execution.sessionKey;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: execution.config,
    agentId: execution.agentId,
    sessionKey: execution.sessionKey,
    classificationSessionKey: policySessionKey,
  });
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: execution.config,
    sessionId: execution.sessionId,
    // Capability identity follows execution, not the independent sandbox policy owner.
    sessionKey: execution.sessionKey,
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
        toolsAllowIntersection: snapshot.toolsAllow
          ? readToolAllowlistIntersection(snapshot.toolsAllow)
          : undefined,
        disableTools: snapshot.disableTools === true,
        sessionFile: execution.sessionFile,
        agentDir: execution.agentDir,
        workspaceDir: execution.workspaceDir,
        cwd: execution.cwd,
        permissionMode: execution.permissionMode,
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
  run: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
): string {
  return resolveReplyToolAuthorityInputFingerprint(snapshotFollowupRunToolAuthority(run), route);
}

/** Capture execution policy once; incoming overlays replace only caller-owned facts. */
export function prepareReplyToolAuthority(
  run: ReplyToolAuthorityInput,
  narrow?: (input: ReplyToolAuthorityInput) => ReplyToolAuthorityInput,
): ReplyToolAuthoritySnapshot {
  const snapshot = snapshotFollowupRunToolAuthority(run);
  return {
    fingerprint: (route) => resolveReplyToolAuthorityInputFingerprint(snapshot, route),
    project: (overlay, route) => {
      const incoming = applyReplyToolAuthorityOverlay(snapshot, overlay);
      return resolveReplyToolAuthorityInputFingerprint(narrow ? narrow(incoming) : incoming, route);
    },
  };
}

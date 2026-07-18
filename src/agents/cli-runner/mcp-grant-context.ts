import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { McpLoopbackRequestContext } from "../../gateway/mcp-grant-store.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { RunCliAgentParams } from "./types.js";

export function normalizeOptionalMcpContextValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function buildCliMcpExecSession(
  sessionEntry: RunCliAgentParams["sessionEntry"],
): McpLoopbackRequestContext["execSession"] {
  const execSession = {
    execHost: normalizeOptionalMcpContextValue(sessionEntry?.execHost),
    execSecurity: normalizeOptionalMcpContextValue(sessionEntry?.execSecurity),
    execAsk: normalizeOptionalMcpContextValue(sessionEntry?.execAsk),
    execNode: normalizeOptionalMcpContextValue(sessionEntry?.execNode),
  };
  return Object.values(execSession).some(Boolean) ? execSession : undefined;
}

export function buildCliMcpExecOverrides(
  execOverrides: RunCliAgentParams["execOverrides"],
): McpLoopbackRequestContext["execOverrides"] {
  if (!execOverrides) {
    return undefined;
  }
  const scopedOverrides = {
    ...(execOverrides.host !== undefined ? { host: execOverrides.host } : {}),
    ...(execOverrides.security !== undefined ? { security: execOverrides.security } : {}),
    ...(execOverrides.ask !== undefined ? { ask: execOverrides.ask } : {}),
    ...(execOverrides.node !== undefined ? { node: execOverrides.node } : {}),
  };
  return Object.keys(scopedOverrides).length > 0 ? scopedOverrides : undefined;
}

export function buildCliMcpBashElevated(
  bashElevated: RunCliAgentParams["bashElevated"],
): McpLoopbackRequestContext["bashElevated"] {
  if (!bashElevated) {
    return undefined;
  }
  return {
    enabled: bashElevated.enabled,
    allowed: bashElevated.allowed,
    defaultLevel: bashElevated.defaultLevel,
    ...(bashElevated.fullAccessAvailable !== undefined
      ? { fullAccessAvailable: bashElevated.fullAccessAvailable }
      : {}),
    ...(bashElevated.fullAccessBlockedReason !== undefined
      ? { fullAccessBlockedReason: bashElevated.fullAccessBlockedReason }
      : {}),
  };
}

export function buildCliMcpChannelContext(
  channelContext: RunCliAgentParams["channelContext"],
  senderId?: string | null,
): McpLoopbackRequestContext["channelContext"] {
  const resolvedSenderId =
    normalizeOptionalMcpContextValue(senderId ?? undefined) ??
    normalizeOptionalMcpContextValue(channelContext?.sender?.id);
  const chatId = normalizeOptionalMcpContextValue(channelContext?.chat?.id);
  if (!resolvedSenderId && !chatId) {
    return undefined;
  }
  return {
    ...(resolvedSenderId ? { sender: { id: resolvedSenderId } } : {}),
    ...(chatId ? { chat: { id: chatId } } : {}),
  };
}

export function resolveCliMcpMessageProvider(
  run: Pick<RunCliAgentParams, "messageProvider" | "messageChannel">,
): string | undefined {
  return normalizeMessageChannel(run.messageProvider ?? run.messageChannel) ?? undefined;
}

export function resolveCliMcpSessionKey(
  run: Pick<RunCliAgentParams, "sessionKey">,
  config: OpenClawConfig,
  agentId: string,
): string {
  return canonicalizeMainSessionAlias({
    cfg: config,
    agentId,
    sessionKey: run.sessionKey?.trim() || "main",
  });
}

export function buildCliMcpGrantContext(params: {
  run: RunCliAgentParams;
  config: OpenClawConfig;
  requireExplicitMessageTarget: boolean;
  agentId: string;
  modelProvider: string;
  modelId: string;
  toolsAllow?: string[];
}): McpLoopbackRequestContext {
  const sessionKey = resolveCliMcpSessionKey(params.run, params.config, params.agentId);
  const clientCaps = uniqueStrings(
    (params.run.clientCaps ?? []).map((cap) => cap.trim()).filter(Boolean),
  );
  const execSession = buildCliMcpExecSession(params.run.sessionEntry);
  const execOverrides = buildCliMcpExecOverrides(params.run.execOverrides);
  const bashElevated = buildCliMcpBashElevated(params.run.bashElevated);
  const channelContext = buildCliMcpChannelContext(params.run.channelContext, params.run.senderId);
  const senderName = normalizeOptionalMcpContextValue(params.run.senderName ?? undefined);
  const senderUsername = normalizeOptionalMcpContextValue(params.run.senderUsername ?? undefined);
  const senderE164 = normalizeOptionalMcpContextValue(params.run.senderE164 ?? undefined);
  const groupId = normalizeOptionalMcpContextValue(params.run.groupId ?? undefined);
  const groupChannel = normalizeOptionalMcpContextValue(params.run.groupChannel ?? undefined);
  const groupSpace = normalizeOptionalMcpContextValue(params.run.groupSpace ?? undefined);
  const spawnedBy = normalizeOptionalMcpContextValue(params.run.spawnedBy ?? undefined);
  return {
    sessionKey,
    runtimePolicySessionKey: normalizeOptionalMcpContextValue(params.run.runtimePolicySessionKey),
    agentId: params.agentId,
    sessionId: normalizeOptionalMcpContextValue(params.run.sessionId),
    runId: normalizeOptionalMcpContextValue(params.run.runId),
    // Restricted runs get their allowlist stamped into the grant; the
    // loopback server enforces it on tools/list and tools/call.
    ...(params.toolsAllow ? { toolsAllow: params.toolsAllow } : {}),
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    messageProvider: resolveCliMcpMessageProvider(params.run),
    clientCaps: clientCaps.length > 0 ? clientCaps : undefined,
    currentChannelId: normalizeOptionalMcpContextValue(params.run.currentChannelId),
    currentThreadTs: normalizeOptionalMcpContextValue(params.run.currentThreadTs),
    currentMessageId:
      params.run.currentMessageId == null
        ? undefined
        : normalizeOptionalMcpContextValue(String(params.run.currentMessageId)),
    currentInboundAudio: params.run.currentInboundAudio === true ? true : undefined,
    accountId: normalizeOptionalMcpContextValue(params.run.agentAccountId),
    inboundEventKind: params.run.currentInboundEventKind,
    sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.run.taskSuggestionDeliveryMode,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget ? true : undefined,
    senderIsOwner: params.run.senderIsOwner === true,
    nodeExecAllowed: true,
    ...(execSession ? { execSession } : {}),
    ...(execOverrides ? { execOverrides } : {}),
    ...(bashElevated ? { bashElevated } : {}),
    ...(params.run.trigger ? { trigger: params.run.trigger } : {}),
    ...(normalizeOptionalMcpContextValue(params.run.approvalReviewerDeviceId)
      ? { approvalReviewerDeviceId: params.run.approvalReviewerDeviceId?.trim() }
      : {}),
    ...(channelContext ? { channelContext } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
    ...(senderE164 ? { senderE164 } : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupChannel ? { groupChannel } : {}),
    ...(groupSpace ? { groupSpace } : {}),
    ...(spawnedBy ? { spawnedBy } : {}),
  };
}

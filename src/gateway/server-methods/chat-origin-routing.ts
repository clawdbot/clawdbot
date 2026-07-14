import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../../packages/gateway-protocol/src/schema.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayCliClient,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main",
  "direct",
  "dm",
  "group",
  "channel",
  "cron",
  "run",
  "subagent",
  "acp",
  "thread",
  "topic",
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

type ChatSendDeliveryEntry = {
  route?: ChannelRouteRef;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

type ChatSendOriginatingRoute = {
  originatingChannel: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  explicitDeliverRoute: boolean;
};

export type ChatSendExplicitOrigin = {
  originatingChannel?: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string;
};

function normalizeOptionalText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeExplicitChatSendOrigin(
  params: ChatSendExplicitOrigin,
): { ok: true; value?: ChatSendExplicitOrigin } | { ok: false; error: string } {
  const originatingChannel = normalizeOptionalText(params.originatingChannel);
  const originatingTo = normalizeOptionalText(params.originatingTo);
  const accountId = normalizeOptionalText(params.accountId);
  const messageThreadId = normalizeOptionalText(params.messageThreadId);
  const hasAnyExplicitOriginField = Boolean(
    originatingChannel || originatingTo || accountId || messageThreadId,
  );
  if (!hasAnyExplicitOriginField) {
    return { ok: true };
  }
  const normalizedChannel = normalizeMessageChannel(originatingChannel);
  if (!normalizedChannel) {
    return {
      ok: false,
      error: "originatingChannel is required when using originating route fields",
    };
  }
  if (!originatingTo) {
    return {
      ok: false,
      error: "originatingTo is required when using originating route fields",
    };
  }
  return {
    ok: true,
    value: {
      originatingChannel: normalizedChannel,
      originatingTo,
      ...(accountId ? { accountId } : {}),
      ...(messageThreadId ? { messageThreadId } : {}),
    },
  };
}

export function validateChatSelectedAgent(params: {
  cfg: OpenClawConfig;
  requestedSessionKey: string;
  agentId?: string;
}): { ok: true; agentId?: string } | { ok: false; error: string } {
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  if (!agentId) {
    return { ok: true };
  }
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return { ok: false, error: `Unknown agent id "${params.agentId}"` };
  }
  const requestedSessionKey = params.requestedSessionKey.trim();
  const parsed = parseAgentSessionKey(requestedSessionKey);
  if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
    return {
      ok: false,
      error: `agentId "${params.agentId}" does not match session key "${params.requestedSessionKey}"`,
    };
  }
  if (requestedSessionKey.toLowerCase() === "global") {
    return { ok: true, agentId };
  }
  if (resolveSessionStoreKey({ cfg: params.cfg, sessionKey: requestedSessionKey }) === "global") {
    return { ok: true, agentId };
  }
  if (!parsed || normalizeAgentId(parsed.agentId) !== agentId) {
    return {
      ok: false,
      error: `agentId "${params.agentId}" does not match session key "${params.requestedSessionKey}"`,
    };
  }
  return { ok: true, agentId };
}

export function resolveRequestedChatAgentId(params: {
  cfg?: OpenClawConfig;
  requestedSessionKey: string;
  agentId?: string;
}): string | undefined {
  const explicitAgentId = normalizeOptionalText(params.agentId);
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  if (!params.cfg) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(params.requestedSessionKey.trim());
  if (
    !parsed?.agentId ||
    resolveSessionStoreKey({ cfg: params.cfg, sessionKey: params.requestedSessionKey }) !== "global"
  ) {
    return undefined;
  }
  return normalizeAgentId(parsed.agentId);
}

export function resolveChatSendActiveScopeKey(params: {
  sessionKey: string;
  agentId?: string;
  mainKey?: string;
}): string {
  if (params.sessionKey !== "global" || !params.agentId) {
    return params.sessionKey;
  }
  return (
    scopeLegacySessionKeyToAgent({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      mainKey: params.mainKey,
    }) ?? params.sessionKey
  );
}

export function resolveChatSendOriginatingRoute(params: {
  client?: { mode?: string | null; id?: string | null } | null;
  deliver?: boolean;
  entry?: ChatSendDeliveryEntry;
  explicitOrigin?: ChatSendExplicitOrigin;
  hasConnectedClient?: boolean;
  mainKey?: string;
  sessionKey: string;
}): ChatSendOriginatingRoute {
  if (params.explicitOrigin?.originatingChannel && params.explicitOrigin.originatingTo) {
    return {
      originatingChannel: params.explicitOrigin.originatingChannel,
      originatingTo: params.explicitOrigin.originatingTo,
      ...(params.explicitOrigin.accountId ? { accountId: params.explicitOrigin.accountId } : {}),
      ...(params.explicitOrigin.messageThreadId
        ? { messageThreadId: params.explicitOrigin.messageThreadId }
        : {}),
      explicitDeliverRoute: params.deliver === true,
    };
  }
  if (params.deliver !== true) {
    return { originatingChannel: INTERNAL_MESSAGE_CHANNEL, explicitDeliverRoute: false };
  }

  const sessionDeliveryContext = deliveryContextFromSession(params.entry);
  const routeChannelCandidate = normalizeMessageChannel(
    sessionDeliveryContext?.channel ?? params.entry?.lastChannel ?? params.entry?.origin?.provider,
  );
  const routeToCandidate = sessionDeliveryContext?.to ?? params.entry?.lastTo;
  const routeAccountIdCandidate =
    sessionDeliveryContext?.accountId ??
    params.entry?.lastAccountId ??
    params.entry?.origin?.accountId ??
    undefined;
  const routeThreadIdCandidate =
    sessionDeliveryContext?.threadId ??
    params.entry?.lastThreadId ??
    params.entry?.origin?.threadId;
  if (params.sessionKey.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
    return { originatingChannel: INTERNAL_MESSAGE_CHANNEL, explicitDeliverRoute: false };
  }

  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  const sessionScopeHead = sessionScopeParts[0];
  const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
  const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => (part ?? "").trim().toLowerCase())
    .filter(Boolean);
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === routeChannelCandidate;
  const isFromWebchatClient = isWebchatClient(params.client);
  const isFromGatewayCliClient = isGatewayCliClient(params.client);
  const hasClientMetadata =
    (typeof params.client?.mode === "string" && params.client.mode.trim().length > 0) ||
    (typeof params.client?.id === "string" && params.client.id.trim().length > 0);
  const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
  const isConfiguredMainSessionScope =
    normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey;
  const canInheritConfiguredMainRoute =
    isConfiguredMainSessionScope &&
    params.hasConnectedClient &&
    (isFromGatewayCliClient || !hasClientMetadata);

  // Webchat never inherits external delivery. Main-session inheritance is CLI-only
  // unless an old caller omitted client metadata entirely.
  const canInheritDeliverableRoute = Boolean(
    !isFromWebchatClient &&
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    ((!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape)) ||
      canInheritConfiguredMainRoute),
  );
  const hasDeliverableRoute =
    canInheritDeliverableRoute &&
    routeChannelCandidate &&
    routeChannelCandidate !== INTERNAL_MESSAGE_CHANNEL &&
    typeof routeToCandidate === "string" &&
    routeToCandidate.trim().length > 0;

  if (!hasDeliverableRoute) {
    return { originatingChannel: INTERNAL_MESSAGE_CHANNEL, explicitDeliverRoute: false };
  }

  return {
    originatingChannel: routeChannelCandidate,
    originatingTo: routeToCandidate,
    accountId: routeAccountIdCandidate,
    messageThreadId: routeThreadIdCandidate,
    explicitDeliverRoute: true,
  };
}

function isAcpSessionKey(sessionKey: string | undefined): boolean {
  return Boolean(sessionKey?.split(":").includes("acp"));
}

export function explicitOriginTargetsAcpSession(
  origin: ChatSendExplicitOrigin | undefined,
): boolean {
  if (!origin?.originatingChannel || !origin.originatingTo || !origin.accountId) {
    return false;
  }
  const channel = normalizeMessageChannel(origin.originatingChannel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel,
    accountId: origin.accountId,
    conversationId: origin.originatingTo,
  });
  return isAcpSessionKey(binding?.targetSessionKey);
}

export function explicitOriginTargetsPluginBinding(
  origin: ChatSendExplicitOrigin | undefined,
): boolean {
  if (!origin?.originatingChannel || !origin.originatingTo || !origin.accountId) {
    return false;
  }
  const channel = normalizeMessageChannel(origin.originatingChannel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel,
    accountId: origin.accountId,
    conversationId: origin.originatingTo,
  });
  return isPluginOwnedSessionBindingRecord(binding);
}

export function normalizeOptionalChatSystemReceipt(
  value: unknown,
): { ok: true; receipt?: string } | { ok: false; error: string } {
  if (value == null) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "systemProvenanceReceipt must be a string" };
  }
  const sanitized = sanitizeChatSendMessageInput(value);
  if (!sanitized.ok) {
    return sanitized;
  }
  const receipt = sanitized.message.trim();
  return { ok: true, receipt: receipt || undefined };
}

export function isAcpBridgeClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const info = client?.connect?.client;
  return (
    info?.id === GATEWAY_CLIENT_NAMES.CLI &&
    info?.mode === GATEWAY_CLIENT_MODES.CLI &&
    info?.displayName === "ACP" &&
    info?.version === "acp"
  );
}

export function hasGatewayAdminScope(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

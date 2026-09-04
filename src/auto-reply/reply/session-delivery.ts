// Resolves persisted delivery route fields for session-bound replies.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";

type LegacyMainDeliveryRetirement = {
  key: string;
  entry: SessionEntry;
};

function resolveSessionKeyChannelHint(sessionKey?: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return undefined;
  }
  const head = normalizeOptionalLowercaseString(parsed.rest.split(":")[0]);
  if (!head || head === "main" || head === "cron" || head === "subagent" || head === "acp") {
    return undefined;
  }
  return normalizeMessageChannel(head);
}

function isMainSessionKey(sessionKey?: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return normalizeLowercaseStringOrEmpty(sessionKey) === "main";
  }
  return normalizeLowercaseStringOrEmpty(parsed.rest) === "main";
}

const DIRECT_SESSION_MARKERS = new Set(["direct", "dm"]);
const THREAD_SESSION_MARKERS = new Set(["thread", "topic"]);

function hasStrictDirectSessionTail(parts: string[], markerIndex: number): boolean {
  const peerId = normalizeOptionalString(parts[markerIndex + 1]);
  if (!peerId) {
    return false;
  }
  const tail = parts.slice(markerIndex + 2);
  if (tail.length === 0) {
    return true;
  }
  return (
    tail.length === 2 &&
    THREAD_SESSION_MARKERS.has(tail[0] ?? "") &&
    Boolean(normalizeOptionalString(tail[1]))
  );
}

function isDirectSessionKey(sessionKey?: string): boolean {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return false;
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  const parts = scoped.split(":").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  if (DIRECT_SESSION_MARKERS.has(parts[0] ?? "")) {
    return hasStrictDirectSessionTail(parts, 0);
  }
  const channel = normalizeMessageChannel(parts[0]);
  if (!channel || !isDeliverableMessageChannel(channel)) {
    return false;
  }
  if (DIRECT_SESSION_MARKERS.has(parts[1] ?? "")) {
    return hasStrictDirectSessionTail(parts, 1);
  }
  return Boolean(normalizeOptionalString(parts[1])) && DIRECT_SESSION_MARKERS.has(parts[2] ?? "")
    ? hasStrictDirectSessionTail(parts, 2)
    : false;
}

function isExternalRoutingChannel(channel?: string): channel is string {
  return Boolean(
    channel && channel !== INTERNAL_MESSAGE_CHANNEL && isDeliverableMessageChannel(channel),
  );
}

export function resolveSessionDeliveryRoute(params: {
  originatingChannelRaw?: string;
  originatingToRaw?: string;
  toRaw?: string;
  persistedLastTo?: string;
  persistedLastChannel?: string;
  sessionKey?: string;
  isInterSession?: boolean;
}): { channel: string | undefined; to: string | undefined } {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);
  const establishedExternalChannel = isExternalRoutingChannel(persistedChannel)
    ? persistedChannel
    : isExternalRoutingChannel(sessionKeyChannelHint)
      ? sessionKeyChannelHint
      : undefined;

  // Webchat can own a direct/main session only before an external route exists;
  // otherwise dashboard turns would redirect subsequent channel replies.
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
    !establishedExternalChannel &&
    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
  ) {
    return {
      channel: params.originatingChannelRaw,
      to: params.originatingToRaw || params.toRaw,
    };
  }

  // Preserve channel and destination together so inter-session/internal turns
  // cannot redirect an established external conversation to the dashboard.
  const preserveExternalRoute = Boolean(
    establishedExternalChannel &&
    (params.isInterSession || !isExternalRoutingChannel(originatingChannel)),
  );
  return {
    channel: preserveExternalRoute
      ? params.isInterSession
        ? (persistedChannel ?? establishedExternalChannel)
        : establishedExternalChannel
      : params.originatingChannelRaw || params.persistedLastChannel,
    to:
      (preserveExternalRoute && params.persistedLastTo) ||
      params.originatingToRaw ||
      params.toRaw ||
      params.persistedLastTo,
  };
}

export function maybeRetireLegacyMainDeliveryRoute(params: {
  sessionCfg: { dmScope?: string } | undefined;
  sessionKey: string;
  legacyMain?: SessionEntry;
  agentId: string;
  mainKey: string;
  isGroup: boolean;
  ctx: MsgContext;
}): LegacyMainDeliveryRetirement | undefined {
  const dmScope = params.sessionCfg?.dmScope ?? "main";
  if (dmScope === "main" || params.isGroup) {
    return undefined;
  }
  const canonicalMainSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey,
  });
  if (params.sessionKey === canonicalMainSessionKey) {
    return undefined;
  }
  const legacyMain = params.legacyMain;
  if (!legacyMain) {
    return undefined;
  }
  const legacyRouteKey = deliveryContextKey(deliveryContextFromSession(legacyMain));
  if (!legacyRouteKey) {
    return undefined;
  }
  const activeDirectRouteKey = deliveryContextKey(
    normalizeDeliveryContext({
      channel: params.ctx.OriginatingChannel as string | undefined,
      to: params.ctx.OriginatingTo || params.ctx.To,
      accountId: params.ctx.AccountId,
      threadId: params.ctx.MessageThreadId,
    }),
  );
  if (!activeDirectRouteKey || activeDirectRouteKey !== legacyRouteKey) {
    return undefined;
  }
  if (legacyMain.delivery?.kind !== "external") {
    return undefined;
  }
  return {
    key: canonicalMainSessionKey,
    entry: {
      ...legacyMain,
      delivery: { kind: "none" },
    },
  };
}

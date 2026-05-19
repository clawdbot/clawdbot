import type { SessionEntry } from "../../config/sessions.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";

export type LegacyMainDeliveryRetirement = {
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

export function resolveLastChannelRaw(params: {
  originatingChannelRaw?: string;
  persistedLastChannel?: string;
  sessionKey?: string;
  isInterSession?: boolean;
}): string | undefined {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  // WebChat should own reply routing for direct-session UI turns, but only when
  // the session has no established external delivery route. If the session was
  // created via an external channel (e.g. Telegram, iMessage), webchat/dashboard
  // access must not overwrite the persisted route — doing so causes subagent
  // completion events to be delivered to the dashboard instead of the original
  // channel. See: https://github.com/openclaw/openclaw/issues/47745
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);
  const hasEstablishedExternalRoute =
    isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);
  // Inter-session messages (sessions_send) always arrive with channel=webchat,
  // but must never overwrite an already-established external delivery route.
  // Without this guard, a sessions_send call resets lastChannel to webchat,
  // causing subsequent Discord (or other external) deliveries to be lost.
  // See: https://github.com/openclaw/openclaw/issues/54441
  if (params.isInterSession && hasEstablishedExternalRoute) {
    return persistedChannel || sessionKeyChannelHint;
  }
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
    !hasEstablishedExternalRoute &&
    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
  ) {
    return params.originatingChannelRaw;
  }
  let resolved = params.originatingChannelRaw || params.persistedLastChannel;
  // Internal/non-deliverable sources should not overwrite previously known
  // external delivery routes (or explicit channel hints from the session key).
  if (!isExternalRoutingChannel(originatingChannel)) {
    if (isExternalRoutingChannel(persistedChannel)) {
      resolved = persistedChannel;
    } else if (isExternalRoutingChannel(sessionKeyChannelHint)) {
      resolved = sessionKeyChannelHint;
    }
  }
  return resolved;
}

export function resolveLastToRaw(params: {
  originatingChannelRaw?: string;
  originatingToRaw?: string;
  toRaw?: string;
  persistedLastTo?: string;
  persistedLastChannel?: string;
  sessionKey?: string;
  isInterSession?: boolean;
}): string | undefined {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);
  const hasEstablishedExternalRouteForTo =
    isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);
  // Inter-session messages must not replace a persisted external `to` with
  // webchat-scoped identifiers (e.g. session keys). Preserve the established
  // external destination so deliveries continue routing to the correct channel.
  // See: https://github.com/openclaw/openclaw/issues/54441
  if (params.isInterSession && hasEstablishedExternalRouteForTo && params.persistedLastTo) {
    return params.persistedLastTo;
  }
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
    !hasEstablishedExternalRouteForTo &&
    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
  ) {
    return params.originatingToRaw || params.toRaw;
  }
  // When the turn originates from an internal/non-deliverable source, do not
  // replace an established external destination with internal routing ids
  // (e.g., session/webchat ids).
  if (!isExternalRoutingChannel(originatingChannel)) {
    const hasExternalFallback =
      isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);
    if (hasExternalFallback && params.persistedLastTo) {
      return params.persistedLastTo;
    }
  }

  return params.originatingToRaw || params.toRaw || params.persistedLastTo;
}

export function maybeRetireLegacyMainDeliveryRoute(params: {
  sessionCfg: { dmScope?: string } | undefined;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
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
  const legacyMain = params.sessionStore[canonicalMainSessionKey];
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
  if (
    legacyMain.route === undefined &&
    legacyMain.deliveryContext === undefined &&
    legacyMain.lastChannel === undefined &&
    legacyMain.lastTo === undefined &&
    legacyMain.lastAccountId === undefined &&
    legacyMain.lastThreadId === undefined
  ) {
    return undefined;
  }
  return {
    key: canonicalMainSessionKey,
    entry: {
      ...legacyMain,
      route: undefined,
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    },
  };
}

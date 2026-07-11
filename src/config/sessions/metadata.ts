// Session metadata derives stable origin, group, and display fields from message context.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import {
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { buildGroupDisplayName, resolveGroupSessionKey } from "./group.js";
import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";

function isSystemEventProvider(provider?: string): boolean {
  return provider === "heartbeat" || provider === "cron-event" || provider === "exec-event";
}

// Origin updates merge sparse channel metadata without deleting previously known fields.
const mergeOrigin = (
  existing: SessionOrigin | undefined,
  next: SessionOrigin | undefined,
): SessionOrigin | undefined => {
  if (!existing && !next) {
    return undefined;
  }
  const merged: SessionOrigin = existing ? { ...existing } : {};
  // A provider/surface/account change is a fresh channel identity (e.g. a dmScope:"main" session
  // moving Slack -> Telegram, or between Slack accounts). Channel-keyed fields belong to the prior
  // channel; drop them so an inbound that omits them does not keep reactions, native threading, and
  // status reads pointed at the previous channel.
  const nextProvider = next?.provider;
  const nextIsDeliverableChannel =
    nextProvider != null &&
    nextProvider !== INTERNAL_MESSAGE_CHANNEL &&
    !isInternalNonDeliveryChannel(nextProvider) &&
    !isSystemEventProvider(nextProvider);
  const channelChanged =
    existing != null &&
    nextIsDeliverableChannel &&
    ((existing.provider != null && nextProvider !== existing.provider) ||
      (existing.surface != null && next?.surface != null && next.surface !== existing.surface) ||
      (existing.accountId != null &&
        next?.accountId != null &&
        next.accountId !== existing.accountId));
  if (channelChanged) {
    delete merged.nativeChannelId;
    delete merged.nativeDirectUserId;
    delete merged.accountId;
    delete merged.threadId;
  }
  if (next?.label) {
    merged.label = next.label;
  }
  if (next?.provider) {
    merged.provider = next.provider;
  }
  if (next?.surface) {
    merged.surface = next.surface;
  }
  if (next?.chatType) {
    merged.chatType = next.chatType;
  }
  if (next?.from) {
    merged.from = next.from;
  }
  if (next?.to) {
    merged.to = next.to;
  }
  if (next?.nativeChannelId) {
    merged.nativeChannelId = next.nativeChannelId;
  }
  if (next?.nativeDirectUserId) {
    merged.nativeDirectUserId = next.nativeDirectUserId;
  }
  if (next?.accountId) {
    merged.accountId = next.accountId;
  }
  if (next?.threadId != null && next.threadId !== "") {
    merged.threadId = next.threadId;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

/** Derives session origin metadata from an inbound message context. */
function deriveSessionOrigin(
  ctx: MsgContext,
  opts?: { skipSystemEventOrigin?: boolean },
): SessionOrigin | undefined {
  if (opts?.skipSystemEventOrigin && isSystemEventProvider(ctx.Provider)) {
    return undefined;
  }
  const label = normalizeOptionalString(resolveConversationLabel(ctx));
  const providerRaw =
    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
    ctx.Surface ||
    ctx.Provider;
  const provider = normalizeMessageChannel(providerRaw);
  const surface = normalizeOptionalLowercaseString(ctx.Surface);
  const chatType = normalizeChatType(ctx.ChatType) ?? undefined;
  const from = normalizeOptionalString(ctx.From);
  const to = normalizeOptionalString(
    typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To,
  );
  const nativeChannelId = normalizeOptionalString(ctx.NativeChannelId);
  const nativeDirectUserId = normalizeOptionalString(ctx.NativeDirectUserId);
  const accountId = normalizeOptionalString(ctx.AccountId);
  const threadId = ctx.MessageThreadId ?? undefined;

  const origin: SessionOrigin = {};
  if (label) {
    origin.label = label;
  }
  if (provider) {
    origin.provider = provider;
  }
  if (surface) {
    origin.surface = surface;
  }
  if (chatType) {
    origin.chatType = chatType;
  }
  if (from) {
    origin.from = from;
  }
  if (to) {
    origin.to = to;
  }
  if (nativeChannelId) {
    origin.nativeChannelId = nativeChannelId;
  }
  if (nativeDirectUserId) {
    origin.nativeDirectUserId = nativeDirectUserId;
  }
  if (accountId) {
    origin.accountId = accountId;
  }
  if (threadId != null && threadId !== "") {
    origin.threadId = threadId;
  }

  return Object.keys(origin).length > 0 ? origin : undefined;
}

export function snapshotSessionOrigin(entry?: SessionEntry): SessionOrigin | undefined {
  if (!entry?.origin) {
    return undefined;
  }
  return { ...entry.origin };
}

function deriveGroupSessionPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null {
  const resolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  if (!resolution?.channel) {
    return null;
  }

  const channel = resolution.channel;
  const subject = params.ctx.GroupSubject?.trim();
  const space = params.ctx.GroupSpace?.trim();
  const explicitChannel = params.ctx.GroupChannel?.trim();
  const subjectLooksChannel = Boolean(subject?.startsWith("#"));
  // Channel-looking subjects become `groupChannel` only for channel-capable providers; ordinary
  // group chats keep the subject as human-readable metadata.
  const normalizedChannel =
    subjectLooksChannel && resolution.chatType !== "channel" ? normalizeChannelId(channel) : null;
  const isChannelProvider = Boolean(
    normalizedChannel &&
    getLoadedChannelPlugin(normalizedChannel)?.capabilities.chatTypes.includes("channel"),
  );
  const nextGroupChannel =
    explicitChannel ??
    (subjectLooksChannel && subject && (resolution.chatType === "channel" || isChannelProvider)
      ? subject
      : undefined);
  const nextSubject = nextGroupChannel ? undefined : subject;

  const patch: Partial<SessionEntry> = {
    chatType: resolution.chatType ?? "group",
    channel,
    groupId: resolution.id,
  };
  if (nextSubject) {
    patch.subject = nextSubject;
  }
  if (nextGroupChannel) {
    patch.groupChannel = nextGroupChannel;
  }
  if (space) {
    patch.space = space;
  }

  const displayName = buildGroupDisplayName({
    provider: channel,
    subject: nextSubject ?? params.existing?.subject,
    groupChannel: nextGroupChannel ?? params.existing?.groupChannel,
    space: space ?? params.existing?.space,
    id: resolution.id,
    key: params.sessionKey,
  });
  if (displayName) {
    patch.displayName = displayName;
  }

  return patch;
}

export function deriveSessionMetaPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
  skipSystemEventOrigin?: boolean;
}): Partial<SessionEntry> | null {
  const groupPatch = deriveGroupSessionPatch(params);
  const origin = deriveSessionOrigin(params.ctx, {
    skipSystemEventOrigin: params.skipSystemEventOrigin,
  });
  if (!groupPatch && !origin) {
    return null;
  }

  const patch: Partial<SessionEntry> = groupPatch ? { ...groupPatch } : {};
  const mergedOrigin = mergeOrigin(params.existing?.origin, origin);
  if (mergedOrigin) {
    patch.origin = mergedOrigin;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

/**
 * Derives the last-route/delivery patch for an inbound routing update. Route
 * updates must not refresh activity timestamps; idle/daily reset evaluation
 * relies on updatedAt from actual session turns (#49515). Shared by the file
 * store and the SQLite accessor so both backends apply one routing policy.
 */
export function deriveLastRoutePatch(params: {
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: SessionEntry["route"];
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  existing: SessionEntry | undefined;
  sessionKey: string;
}): Partial<SessionEntry> {
  const { channel, to, accountId, threadId, ctx, existing } = params;
  const explicitContext = normalizeDeliveryContext(params.deliveryContext);
  const inlineContext = normalizeDeliveryContext({
    channel,
    to,
    accountId,
    threadId,
  });
  const routeContext = deliveryContextFromChannelRoute(params.route);
  const mergedInput = mergeDeliveryContext(
    routeContext,
    mergeDeliveryContext(explicitContext, inlineContext),
  );
  const explicitDeliveryContext = params.deliveryContext;
  const explicitThreadFromDeliveryContext =
    explicitDeliveryContext != null && Object.hasOwn(explicitDeliveryContext, "threadId")
      ? explicitDeliveryContext.threadId
      : undefined;
  const explicitThreadValue =
    explicitThreadFromDeliveryContext ??
    (threadId != null && threadId !== "" ? threadId : undefined);
  const explicitRouteProvided = Boolean(
    routeContext?.channel ||
    routeContext?.to ||
    explicitContext?.channel ||
    explicitContext?.to ||
    inlineContext?.channel ||
    inlineContext?.to,
  );
  const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
  const fallbackContext = clearThreadFromFallback
    ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
    : deliveryContextFromSession(existing);
  const merged = mergeDeliveryContext(mergedInput, fallbackContext);
  const normalized = normalizeSessionDeliveryFields({
    route: params.route,
    deliveryContext: {
      channel: merged?.channel,
      to: merged?.to,
      accountId: merged?.accountId,
      threadId: merged?.threadId,
    },
  });
  const metaPatch = ctx
    ? deriveSessionMetaPatch({
        ctx,
        sessionKey: params.sessionKey,
        existing,
        groupResolution: params.groupResolution,
      })
    : null;
  const basePatch: Partial<SessionEntry> = {
    route: normalized.route,
    deliveryContext: normalized.deliveryContext,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
  return metaPatch ? { ...basePatch, ...metaPatch } : basePatch;
}

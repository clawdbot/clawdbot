import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import {
  buildConversationRef,
  normalizeConversationPeerId,
} from "../../routing/conversation-ref.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveGroupSessionKey } from "./group.js";
import { deriveSessionOrigin } from "./metadata.js";
import type { GroupKeyResolution, SessionEntry } from "./types.js";

export type ConversationKind = "channel" | "direct" | "group";

/** Stable transport address independent from the local session holding model context. */
export type ConversationIdentity = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: ConversationKind;
  peerId: string;
  deliveryTarget: string;
  parentConversationRef?: string;
  threadId?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  metadata?: Record<string, unknown>;
};

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeText(value);
}

function normalizeKind(value: unknown): ConversationKind {
  const normalized = normalizeChatType(typeof value === "string" ? value : undefined);
  if (normalized === "channel") {
    return "channel";
  }
  if (normalized === "group") {
    return "group";
  }
  return "direct";
}

function resolvePairedOriginPeerId(params: {
  entry: SessionEntry;
  deliveryContext?: DeliveryContext;
  deliveryTarget: string;
  kind: ConversationKind;
}): string | undefined {
  if (params.kind !== "direct") {
    return undefined;
  }
  const origin = params.entry.origin;
  const originFrom = normalizeText(origin?.from);
  const originTo = normalizeText(origin?.to);
  const originChannel = normalizeText(origin?.provider)?.toLowerCase();
  const deliveryChannel = normalizeText(params.deliveryContext?.channel)?.toLowerCase();
  if (
    !originFrom ||
    originTo !== params.deliveryTarget ||
    !originChannel ||
    originChannel !== deliveryChannel ||
    normalizeChatType(origin?.chatType) !== params.kind ||
    (normalizeAccountId(origin?.accountId) ?? "default") !==
      (normalizeAccountId(params.deliveryContext?.accountId) ?? "default") ||
    normalizeThreadId(origin?.threadId) !== normalizeThreadId(params.deliveryContext?.threadId)
  ) {
    return undefined;
  }
  return originFrom;
}

/** Builds one stable transport address from authoritative channel route facts. */
export function buildConversationIdentity(params: {
  channel?: string;
  accountId?: string;
  kind: ConversationKind;
  peerId?: string;
  deliveryTarget?: string;
  parentConversationRef?: string;
  threadId?: string | number;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}): ConversationIdentity | null {
  const channel = normalizeText(params.channel)?.toLowerCase();
  const rawPeerId = normalizeText(params.peerId);
  if (!channel || !rawPeerId) {
    return null;
  }
  const peerId = normalizeConversationPeerId(channel, rawPeerId);
  if (!peerId) {
    return null;
  }
  // A normalized peer id identifies a conversation but is not necessarily a
  // routable transport address. Exact-address tools require authoritative egress facts.
  const deliveryTarget = normalizeText(params.deliveryTarget);
  if (!deliveryTarget) {
    return null;
  }
  const accountId = normalizeAccountId(params.accountId) ?? "default";
  const rawParent = normalizeText(params.parentConversationRef);
  const parentConversationRef = rawParent
    ? rawParent.startsWith("conv_")
      ? rawParent
      : buildConversationRef({
          channel,
          accountId,
          kind: params.kind,
          peerId: normalizeConversationPeerId(channel, rawParent),
        })
    : undefined;
  const threadId = normalizeThreadId(params.threadId);
  return {
    conversationRef: buildConversationRef({
      channel,
      accountId,
      kind: params.kind,
      peerId,
      parentConversationRef,
      threadId,
    }),
    channel,
    accountId,
    kind: params.kind,
    peerId,
    deliveryTarget,
    ...(parentConversationRef ? { parentConversationRef } : {}),
    ...(threadId ? { threadId } : {}),
    ...(normalizeText(params.nativeChannelId)
      ? { nativeChannelId: normalizeText(params.nativeChannelId) }
      : {}),
    ...(normalizeText(params.nativeDirectUserId)
      ? { nativeDirectUserId: normalizeText(params.nativeDirectUserId) }
      : {}),
    ...(normalizeText(params.label) ? { label: normalizeText(params.label) } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

/** Derives a transport address from the canonical route snapshot persisted on a session. */
export function conversationIdentityFromSessionEntry(
  entry: SessionEntry,
): ConversationIdentity | null {
  // Explicit route snapshots own their populated fields, while persisted
  // origin/last-route facts fill gaps such as an omitted account id.
  const deliveryContext = mergeDeliveryContext(
    normalizeDeliveryContext(entry.deliveryContext),
    deliveryContextFromSession(entry),
  );
  const kind = normalizeKind(entry.chatType);
  const routeTarget = normalizeText(deliveryContext?.to);
  const deliveryTarget =
    routeTarget ?? (kind === "direct" ? normalizeText(entry.origin?.from) : undefined);
  const routeOwnsTarget = Boolean(routeTarget);
  const channel = routeOwnsTarget
    ? deliveryContext?.channel
    : (normalizeText(entry.origin?.provider) ?? normalizeText(entry.channel));
  // Outbound routes can use an alias for delivery while `origin.from` carries
  // the canonical peer. Trust it only when both snapshots are fully paired.
  const pairedOriginPeerId = routeTarget
    ? resolvePairedOriginPeerId({
        entry,
        deliveryContext,
        deliveryTarget: routeTarget,
        kind,
      })
    : undefined;
  return buildConversationIdentity({
    channel,
    accountId: routeOwnsTarget ? deliveryContext?.accountId : entry.origin?.accountId,
    kind,
    // Native ids remain descriptive metadata and cannot redirect a stored conversation ref.
    peerId: pairedOriginPeerId ?? deliveryTarget,
    deliveryTarget,
    threadId: routeOwnsTarget ? deliveryContext?.threadId : entry.origin?.threadId,
    nativeChannelId: entry.origin?.nativeChannelId,
    nativeDirectUserId: entry.origin?.nativeDirectUserId,
    label: entry.displayName ?? entry.label,
  });
}

/** Derives the same stable address from live inbound channel facts. */
export function conversationIdentityFromMsgContext(params: {
  ctx: MsgContext;
  deliveryContext?: DeliveryContext;
  groupResolution?: GroupKeyResolution | null;
}): ConversationIdentity | null {
  const route = deriveSessionOrigin(params.ctx);
  const explicitDeliveryContext = normalizeDeliveryContext(params.deliveryContext);
  const routeDeliveryContext = normalizeDeliveryContext({
    channel: route?.provider,
    to: route?.to,
    accountId: route?.accountId,
    threadId: route?.threadId,
  });
  const deliveryContext = mergeDeliveryContext(explicitDeliveryContext, routeDeliveryContext);
  const groupResolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  const kind = groupResolution?.chatType ?? normalizeKind(params.ctx.ChatType);
  const directIngressTarget = kind === "direct" ? normalizeText(params.ctx.From) : undefined;
  // An explicit delivery context is already a paired route. Otherwise direct ingress
  // addresses the sender (`From`), while OriginatingTo can describe the local endpoint.
  const useDirectIngressTarget = Boolean(directIngressTarget && !explicitDeliveryContext?.to);
  const deliveryTarget = useDirectIngressTarget
    ? directIngressTarget
    : (normalizeText(deliveryContext?.to) ??
      normalizeText(params.ctx.OriginatingTo) ??
      normalizeText(params.ctx.To));
  const channel = useDirectIngressTarget
    ? (normalizeText(route?.provider) ??
      normalizeText(params.ctx.OriginatingChannel) ??
      normalizeText(params.ctx.Provider))
    : (deliveryContext?.channel ??
      groupResolution?.channel ??
      normalizeText(route?.provider) ??
      normalizeText(params.ctx.OriginatingChannel) ??
      normalizeText(params.ctx.Provider));
  return buildConversationIdentity({
    channel,
    accountId: useDirectIngressTarget
      ? (route?.accountId ?? params.ctx.AccountId)
      : (deliveryContext?.accountId ?? route?.accountId ?? params.ctx.AccountId),
    kind,
    peerId: deliveryTarget,
    deliveryTarget,
    threadId: useDirectIngressTarget
      ? (route?.threadId ?? params.ctx.MessageThreadId)
      : (deliveryContext?.threadId ?? params.ctx.MessageThreadId),
    nativeChannelId: params.ctx.NativeChannelId ?? route?.nativeChannelId,
    nativeDirectUserId: params.ctx.NativeDirectUserId ?? route?.nativeDirectUserId,
    label: normalizeText(resolveConversationLabel(params.ctx)) ?? route?.label,
  });
}

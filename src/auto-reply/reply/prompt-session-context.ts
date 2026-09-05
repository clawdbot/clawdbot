import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { GroupKeyResolution, SessionEntry } from "../../config/sessions/types.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { TemplateContext } from "../templating.js";
import {
  normalizeEffectiveReplyTarget,
  resolveEffectiveReplyRoute,
} from "./effective-reply-route.js";
import { extractExplicitGroupId } from "./group-id.js";

type ReplyConversationFields = Pick<
  TemplateContext,
  | "Provider"
  | "Surface"
  | "ChatType"
  | "OriginatingChannel"
  | "OriginatingTo"
  | "AccountId"
  | "MessageThreadId"
  | "GroupSubject"
  | "GroupChannel"
  | "GroupSpace"
>;

export type PreparedReplyConversation = {
  fields: ReplyConversationFields;
  group: {
    channel?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    accountId?: string;
  };
  activation?: SessionEntry["groupActivation"];
};

function normalizePromptRouteChannel(raw?: string | null): string | undefined {
  const normalized = normalizeOptionalString(raw);
  return normalized && normalized !== "none" ? normalized : undefined;
}

function resolvePersistedPromptProvider(entry?: SessionEntry): string | undefined {
  return normalizePromptRouteChannel(sessionDeliveryChannel(entry));
}

function resolvePersistedPromptSurface(entry?: SessionEntry): string | undefined {
  return (
    normalizePromptRouteChannel(sessionDeliveryOrigin(entry)?.surface) ??
    resolvePersistedPromptProvider(entry)
  );
}

/** Prepares descriptive conversation facts without borrowing execution or sender authority. */
export function prepareReplyConversation(params: {
  ctx: ReplyConversationFields &
    Pick<TemplateContext, "From" | "InternalTurnSource" | "InputProvenance">;
  sessionEntry?: SessionEntry;
  groupResolution?: GroupKeyResolution;
  isHeartbeat?: boolean;
}): PreparedReplyConversation {
  const { ctx, sessionEntry, groupResolution } = params;
  const isSystemEvent = params.isHeartbeat === true || ctx.InternalTurnSource !== undefined;
  const route = isSystemEvent
    ? resolveEffectiveReplyRoute({ ctx, entry: sessionEntry })
    : undefined;
  const persisted = deliveryContextFromSession(sessionEntry);
  const currentChannel = normalizeMessageChannel(
    groupResolution?.channel ?? ctx.OriginatingChannel,
  );
  const currentTo = normalizeEffectiveReplyTarget(
    groupResolution?.id ?? ctx.OriginatingTo,
    currentChannel,
    ctx.MessageThreadId,
  );
  const hasCurrentRoute = Boolean(groupResolution || ctx.OriginatingChannel || ctx.OriginatingTo);
  // Compare the current tuple before inheritance fills omitted coordinates. An
  // explicit different route must lose both stored room names and activation.
  const ownsConversation =
    !isSystemEvent ||
    !hasCurrentRoute ||
    Boolean(
      currentChannel &&
      currentTo &&
      channelRouteTargetsMatchExact({
        left: {
          channel: currentChannel,
          to: currentTo,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
        },
        right: {
          channel: normalizeMessageChannel(persisted?.channel),
          to: normalizeEffectiveReplyTarget(
            persisted?.to,
            normalizeMessageChannel(persisted?.channel),
            persisted?.threadId,
          ),
          accountId: persisted?.accountId,
          threadId: persisted?.threadId,
        },
      }),
    );
  const conversationEntry = ownsConversation ? sessionEntry : undefined;
  const inherited = isSystemEvent ? conversationEntry : undefined;
  const origin = sessionDeliveryOrigin(inherited);
  const chatType =
    normalizeChatType(ctx.ChatType) ??
    groupResolution?.chatType ??
    normalizeChatType(inherited?.chatType) ??
    normalizeChatType(origin?.chatType);
  const isSharedChat = chatType === "group" || chatType === "channel";
  const fields: ReplyConversationFields = {
    Provider: ctx.Provider,
    Surface: ctx.Surface,
    ChatType: ctx.ChatType,
    OriginatingChannel: ctx.OriginatingChannel,
    OriginatingTo: ctx.OriginatingTo,
    AccountId: ctx.AccountId,
    MessageThreadId: ctx.MessageThreadId,
    GroupSubject: ctx.GroupSubject,
    GroupChannel: ctx.GroupChannel,
    GroupSpace: ctx.GroupSpace,
  };
  if (isSystemEvent) {
    fields.Provider =
      normalizePromptRouteChannel(ctx.Provider) ??
      normalizePromptRouteChannel(ctx.OriginatingChannel) ??
      resolvePersistedPromptProvider(inherited);
    fields.Surface =
      normalizePromptRouteChannel(ctx.Surface) ??
      normalizePromptRouteChannel(ctx.OriginatingChannel) ??
      resolvePersistedPromptSurface(inherited);
    fields.ChatType = chatType;
    fields.OriginatingChannel ??= inherited ? (route?.channel ?? persisted?.channel) : undefined;
    fields.OriginatingTo ??= inherited ? (route?.to ?? persisted?.to) : undefined;
    fields.AccountId ??= inherited ? (route?.accountId ?? persisted?.accountId) : undefined;
    fields.MessageThreadId ??= inherited ? (persisted?.threadId ?? origin?.threadId) : undefined;
    fields.GroupSubject =
      normalizeOptionalString(ctx.GroupSubject) ??
      (isSharedChat ? normalizeOptionalString(inherited?.subject) : undefined);
    fields.GroupChannel =
      normalizeOptionalString(ctx.GroupChannel) ??
      (isSharedChat ? normalizeOptionalString(inherited?.groupChannel) : undefined);
    fields.GroupSpace =
      normalizeOptionalString(ctx.GroupSpace) ??
      (isSharedChat ? normalizeOptionalString(inherited?.space) : undefined);
  }
  const channel =
    groupResolution?.channel ??
    (isSystemEvent ? fields.OriginatingChannel : undefined) ??
    fields.Provider;
  const rawGroupId = normalizeOptionalString(ctx.From);
  return {
    fields,
    group: {
      channel,
      groupId: isSystemEvent
        ? normalizeEffectiveReplyTarget(
            inherited?.groupId ?? groupResolution?.id ?? fields.OriginatingTo,
            normalizeMessageChannel(channel),
            fields.MessageThreadId,
          )
        : (groupResolution?.id ?? extractExplicitGroupId(rawGroupId) ?? rawGroupId),
      groupChannel:
        normalizeOptionalString(fields.GroupChannel) ??
        normalizeOptionalString(fields.GroupSubject),
      groupSpace: normalizeOptionalString(fields.GroupSpace),
      accountId: fields.AccountId,
    },
    activation: conversationEntry?.groupActivation,
  };
}

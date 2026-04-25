import type { SlackMessageEvent } from "../../types.js";
import type { SlackMessageChangedEvent, SlackMessageDeletedEvent } from "../types.js";

type SupportedSubtype = "message_changed" | "message_deleted";

export type SlackMessageSubtypeHandler = {
  subtype: SupportedSubtype;
  eventKind: SupportedSubtype;
  describe: (channelLabel: string) => string;
  contextKey: (event: SlackMessageEvent) => string;
  resolveSenderId: (event: SlackMessageEvent) => string | undefined;
  resolveChannelId: (event: SlackMessageEvent) => string | undefined;
  resolveChannelType: (event: SlackMessageEvent) => string | null | undefined;
};

const changedHandler: SlackMessageSubtypeHandler = {
  subtype: "message_changed",
  eventKind: "message_changed",
  describe: (channelLabel) => `Slack message edited in ${channelLabel}.`,
  contextKey: (event) => {
    const changed = event as SlackMessageChangedEvent;
    const channelId = changed.channel ?? "unknown";
    const messageId =
      changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts ?? "unknown";
    return `slack:message:changed:${channelId}:${messageId}`;
  },
  resolveSenderId: (event) => {
    const changed = event as SlackMessageChangedEvent;
    return (
      changed.message?.user ??
      changed.previous_message?.user ??
      changed.message?.bot_id ??
      changed.previous_message?.bot_id
    );
  },
  resolveChannelId: (event) => (event as SlackMessageChangedEvent).channel,
  resolveChannelType: () => undefined,
};

const deletedHandler: SlackMessageSubtypeHandler = {
  subtype: "message_deleted",
  eventKind: "message_deleted",
  describe: (channelLabel) => `Slack message deleted in ${channelLabel}.`,
  contextKey: (event) => {
    const deleted = event as SlackMessageDeletedEvent;
    const channelId = deleted.channel ?? "unknown";
    const messageId = deleted.deleted_ts ?? deleted.event_ts ?? "unknown";
    return `slack:message:deleted:${channelId}:${messageId}`;
  },
  resolveSenderId: (event) => {
    const deleted = event as SlackMessageDeletedEvent;
    return deleted.previous_message?.user ?? deleted.previous_message?.bot_id;
  },
  resolveChannelId: (event) => (event as SlackMessageDeletedEvent).channel,
  resolveChannelType: () => undefined,
};

const SUBTYPE_HANDLER_REGISTRY: Record<SupportedSubtype, SlackMessageSubtypeHandler> = {
  message_changed: changedHandler,
  message_deleted: deletedHandler,
};

export function resolveSlackMessageSubtypeHandler(
  event: SlackMessageEvent,
): SlackMessageSubtypeHandler | undefined {
  const subtype = event.subtype;
  if (subtype !== "message_changed" && subtype !== "message_deleted") {
    return undefined;
  }
  return SUBTYPE_HANDLER_REGISTRY[subtype];
}

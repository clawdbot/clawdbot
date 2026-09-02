// Slack plugin module implements message subtype handlers behavior.
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMessageChangedEvent, SlackMessageDeletedEvent } from "../types.js";

type SupportedSubtype = "message_changed" | "message_deleted";

type SlackMessageSubtypeHandler = {
  eventKind: SupportedSubtype;
  describe: (channelLabel: string) => string;
  contextKey: (event: SlackMessageEvent) => string;
  resolveSenderId: (event: SlackMessageEvent) => string | undefined;
  resolveThreadTs: (event: SlackMessageEvent) => string | undefined;
};

function resolveNestedThreadTs(event: SlackMessageEvent): string | undefined {
  const changed = event as SlackMessageChangedEvent;
  const message = changed.message?.thread_ts ? changed.message : changed.previous_message;
  if (!message) {
    return undefined;
  }
  return resolveSlackThreadContext({
    message: { type: "message", channel: event.channel, ...message },
    replyToMode: "off",
  }).replyToId;
}

const changedHandler: SlackMessageSubtypeHandler = {
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
  resolveThreadTs: resolveNestedThreadTs,
};

const deletedHandler: SlackMessageSubtypeHandler = {
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
  resolveThreadTs: resolveNestedThreadTs,
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

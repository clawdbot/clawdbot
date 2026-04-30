import type { APIMessage, APIUser } from "discord-api-types/v10";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChannelMessage, Message as DiscordMessage, type Message } from "../internal/discord.js";
import { resolveDiscordMessageText, type DiscordChannelInfo } from "./message-utils.js";

function mergeFetchedDiscordMessage(base: Message, fetched: APIMessage): Message {
  const baseRawData = readMessageRawData(base);
  const baseFallback = readMessageFallback(base);
  const rawData = {
    ...baseRawData,
    ...fetched,
    id: fetched.id ?? baseRawData.id ?? baseFallback.id,
    channel_id: fetched.channel_id ?? baseRawData.channel_id ?? baseFallback.channel_id,
    content: fetched.content ?? baseRawData.content ?? baseFallback.content,
    author: fetched.author ?? baseRawData.author ?? baseFallback.author,
    attachments: fetched.attachments ?? baseRawData.attachments ?? baseFallback.attachments,
    embeds: fetched.embeds ?? baseRawData.embeds ?? baseFallback.embeds,
    mentions: fetched.mentions ?? baseRawData.mentions ?? baseFallback.mentions,
    mention_roles: fetched.mention_roles ?? baseRawData.mention_roles ?? baseFallback.mention_roles,
    mention_everyone:
      fetched.mention_everyone ?? baseRawData.mention_everyone ?? baseFallback.mention_everyone,
    timestamp: fetched.timestamp ?? baseRawData.timestamp ?? baseFallback.timestamp,
    tts: fetched.tts ?? baseRawData.tts ?? false,
    pinned: fetched.pinned ?? baseRawData.pinned ?? false,
    type: fetched.type ?? baseRawData.type ?? 0,
    message_snapshots:
      fetched.message_snapshots ?? baseRawData.message_snapshots ?? baseFallback.message_snapshots,
    sticker_items:
      (fetched as { sticker_items?: unknown }).sticker_items ??
      (baseRawData as { sticker_items?: unknown }).sticker_items ??
      baseFallback.sticker_items,
  } as APIMessage;
  const hydrated = new DiscordMessage(readMessageClient(base), rawData);
  copyRuntimeMessageFields(base, hydrated);
  return hydrated;
}

function readMessageClient(message: Message): ConstructorParameters<typeof DiscordMessage>[0] {
  return (message as unknown as { client: ConstructorParameters<typeof DiscordMessage>[0] }).client;
}

function readMessageRawData(message: Message): Partial<APIMessage> {
  try {
    const rawData = message.rawData as APIMessage | undefined;
    return rawData && typeof rawData === "object" ? rawData : {};
  } catch {
    return {};
  }
}

type MessageFallback = Partial<Omit<APIMessage, "message_snapshots" | "sticker_items">> & {
  channel_id: string;
  sticker_items?: APIMessage["sticker_items"];
  message_snapshots?: APIMessage["message_snapshots"];
};

function readMessageFallback(message: Message): MessageFallback {
  const value = message as unknown as {
    id?: unknown;
    channelId?: unknown;
    channel_id?: unknown;
    content?: unknown;
    author?: unknown;
    attachments?: unknown;
    embeds?: unknown;
    mentionedUsers?: unknown;
    mentionedRoles?: unknown;
    mentionedEveryone?: unknown;
    timestamp?: unknown;
    stickers?: unknown;
    sticker_items?: unknown;
    message_snapshots?: unknown;
  };
  return {
    id: typeof value.id === "string" ? value.id : "",
    channel_id: readString(value.channel_id) ?? readString(value.channelId) ?? "",
    content: typeof value.content === "string" ? value.content : "",
    author: normalizeApiUser(value.author),
    attachments: Array.isArray(value.attachments) ? value.attachments : [],
    embeds: Array.isArray(value.embeds) ? value.embeds : [],
    mentions: normalizeApiUsers(value.mentionedUsers),
    mention_roles: normalizeStringArray(value.mentionedRoles),
    mention_everyone: value.mentionedEveryone === true,
    timestamp: readString(value.timestamp) ?? "1970-01-01T00:00:00.000Z",
    sticker_items: Array.isArray(value.sticker_items)
      ? (value.sticker_items as APIMessage["sticker_items"])
      : Array.isArray(value.stickers)
        ? (value.stickers as APIMessage["sticker_items"])
        : undefined,
    message_snapshots: Array.isArray(value.message_snapshots)
      ? (value.message_snapshots as APIMessage["message_snapshots"])
      : undefined,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
}

function normalizeApiUsers(value: unknown): APIUser[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const user = normalizeApiUser(entry);
        return user.id ? [user] : [];
      })
    : [];
}

function normalizeApiUser(value: unknown): APIUser {
  if (!value || typeof value !== "object") {
    return {
      id: "",
      username: "",
      discriminator: "0",
      global_name: null,
      avatar: null,
    };
  }
  const input = value as {
    id?: unknown;
    username?: unknown;
    global_name?: unknown;
    globalName?: unknown;
    discriminator?: unknown;
    avatar?: unknown;
    bot?: unknown;
  };
  return {
    id: readString(input.id) ?? "",
    username: readString(input.username) ?? "",
    discriminator: readString(input.discriminator) ?? "0",
    global_name: readString(input.global_name) ?? readString(input.globalName) ?? null,
    avatar: input.avatar === null ? null : (readString(input.avatar) ?? null),
    ...(typeof input.bot === "boolean" ? { bot: input.bot } : {}),
  };
}

function copyRuntimeMessageFields(source: Message, target: Message): void {
  const channelDescriptor = Object.getOwnPropertyDescriptor(source, "channel");
  if (channelDescriptor) {
    Object.defineProperty(target, "channel", channelDescriptor);
  }
}

function shouldHydrateDiscordMessage(params: { message: Message }) {
  let currentText = "";
  try {
    currentText = resolveDiscordMessageText(params.message, {
      includeForwarded: true,
    });
  } catch {
    return true;
  }
  if (!currentText) {
    return true;
  }
  const hasMentionMetadata =
    (params.message.mentionedUsers?.length ?? 0) > 0 ||
    (params.message.mentionedRoles?.length ?? 0) > 0 ||
    params.message.mentionedEveryone;
  if (hasMentionMetadata) {
    return false;
  }
  return /<@!?\d+>|<@&\d+>|@everyone|@here/u.test(currentText);
}

export async function hydrateDiscordMessageIfNeeded(params: {
  client: { rest: Parameters<typeof getChannelMessage>[0] };
  message: Message;
  messageChannelId: string;
  channelInfo?: DiscordChannelInfo | null;
}): Promise<Message> {
  void params.channelInfo;
  if (!shouldHydrateDiscordMessage({ message: params.message })) {
    return params.message;
  }
  try {
    const fetched = (await getChannelMessage(
      params.client.rest,
      params.messageChannelId,
      params.message.id,
    )) as APIMessage | null | undefined;
    if (!fetched) {
      return params.message;
    }
    logVerbose(`discord: hydrated inbound payload via REST for ${params.message.id}`);
    return mergeFetchedDiscordMessage(params.message, fetched);
  } catch (err) {
    logVerbose(`discord: failed to hydrate message ${params.message.id}: ${String(err)}`);
    return params.message;
  }
}

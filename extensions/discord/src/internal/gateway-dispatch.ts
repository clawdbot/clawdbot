import { GatewayDispatchEvents, type APIMessage, type APIUser } from "discord-api-types/v10";
import type { Client } from "./client.js";
import { Guild, Message, User } from "./structures.js";

type VoicePluginAdapter = {
  onVoiceServerUpdate?: (data: unknown) => void;
  onVoiceStateUpdate?: (data: unknown) => void;
};

export function dispatchVoiceGatewayEvent(client: Client, type: string, data: unknown): void {
  const guildId = readGuildId(data);
  if (!guildId) {
    return;
  }
  const adapters = client.getPlugin<{ adapters?: Map<string, VoicePluginAdapter> }>(
    "voice",
  )?.adapters;
  const adapter = adapters?.get(guildId);
  const voiceServerUpdate: string = GatewayDispatchEvents.VoiceServerUpdate;
  const voiceStateUpdate: string = GatewayDispatchEvents.VoiceStateUpdate;
  if (type === voiceServerUpdate) {
    adapter?.onVoiceServerUpdate?.(data);
  }
  if (type === voiceStateUpdate) {
    adapter?.onVoiceStateUpdate?.(data);
  }
}

export function mapGatewayDispatchData(client: Client, type: string, data: unknown): unknown {
  const messageCreate: string = GatewayDispatchEvents.MessageCreate;
  const reactionAdd: string = GatewayDispatchEvents.MessageReactionAdd;
  const reactionRemove: string = GatewayDispatchEvents.MessageReactionRemove;
  if (type === messageCreate) {
    return createMessageDispatchData(client, data as MessageCreatePayload);
  }
  if (type === reactionAdd || type === reactionRemove) {
    return createReactionDispatchData(client, data as ReactionPayload);
  }
  return data;
}

type MessageCreatePayload = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: APIUser;
  member?: { roles?: string[] };
};

function createMessageDispatchData(client: Client, data: MessageCreatePayload) {
  const message = new Message(client, data as APIMessage);
  return {
    ...data,
    id: data.id,
    channel_id: data.channel_id,
    channelId: data.channel_id,
    message,
    author: message.author ?? (data.author ? new User(client, data.author) : null),
    member: data.member,
    rawMember: data.member,
    guild: data.guild_id ? new Guild<true>(client, data.guild_id) : null,
  };
}

type ReactionPayload = {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  member?: { user?: unknown; roles?: string[] };
};

function createReactionDispatchData(client: Client, data: ReactionPayload) {
  const userRaw =
    data.member?.user && typeof data.member.user === "object"
      ? ({ id: data.user_id, username: "", ...data.member.user } as APIUser)
      : ({ id: data.user_id, username: "" } as APIUser);
  return {
    ...data,
    user: new User(client, userRaw),
    rawMember: data.member,
    guild: data.guild_id ? new Guild<true>(client, data.guild_id) : null,
    message: new Message<true>(client, {
      id: data.message_id,
      channelId: data.channel_id,
    }),
  };
}

function readGuildId(data: unknown): string | undefined {
  return data &&
    typeof data === "object" &&
    typeof (data as { guild_id?: unknown }).guild_id === "string"
    ? (data as { guild_id: string }).guild_id
    : undefined;
}

import {
  GatewayDispatchEvents,
  type APIMessage,
  type APIReaction,
  type GatewayPresenceUpdateDispatchData,
  type GatewayThreadUpdateDispatchData,
} from "discord-api-types/v10";
import type { Client } from "./client.js";
import { Guild, Message, User } from "./structures.js";

export type DiscordMessageDispatchData = {
  id?: string;
  channel_id: string;
  channelId?: string;
  guild_id?: string;
  message: Message;
  author: User | null;
  member?: { roles?: string[]; nick?: string | null; nickname?: string | null };
  rawMember?: { roles?: string[]; nick?: string | null; nickname?: string | null };
  guild?: Guild | null;
  channel?: unknown;
};

export type DiscordReactionDispatchData = {
  user_id?: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  emoji: APIReaction["emoji"];
  burst?: boolean;
  type?: number;
  user: User;
  rawMember?: { roles?: string[] };
  guild?: Guild | null;
  message: Message<true> | { fetch(): Promise<{ author?: User | null }> };
  rawMessage?: APIMessage;
};

export abstract class BaseListener {
  abstract readonly type: string;
  abstract handle(data: unknown, client: Client): Promise<void> | void;
}

export abstract class ReadyListener extends BaseListener {
  readonly type = GatewayDispatchEvents.Ready;
}

export abstract class ResumedListener extends BaseListener {
  readonly type = GatewayDispatchEvents.Resumed;
}

export abstract class MessageCreateListener extends BaseListener {
  readonly type = GatewayDispatchEvents.MessageCreate;
  abstract override handle(data: DiscordMessageDispatchData, client: Client): Promise<void> | void;
}

export abstract class InteractionCreateListener extends BaseListener {
  readonly type = GatewayDispatchEvents.InteractionCreate;
}

export abstract class MessageReactionAddListener extends BaseListener {
  readonly type = GatewayDispatchEvents.MessageReactionAdd;
  abstract override handle(data: DiscordReactionDispatchData, client: Client): Promise<void> | void;
}

export abstract class MessageReactionRemoveListener extends BaseListener {
  readonly type = GatewayDispatchEvents.MessageReactionRemove;
  abstract override handle(data: DiscordReactionDispatchData, client: Client): Promise<void> | void;
}

export abstract class PresenceUpdateListener extends BaseListener {
  readonly type = GatewayDispatchEvents.PresenceUpdate;
  abstract override handle(
    data: GatewayPresenceUpdateDispatchData,
    client: Client,
  ): Promise<void> | void;
}

export abstract class ThreadUpdateListener extends BaseListener {
  readonly type = GatewayDispatchEvents.ThreadUpdate;
  abstract override handle(
    data: GatewayThreadUpdateDispatchData,
    client: Client,
  ): Promise<void> | void;
}

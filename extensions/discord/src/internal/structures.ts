import {
  type APIChannel,
  type APIEmbed,
  type APIGuild,
  type APIGuildMember,
  type APIMessage,
  type APIRole,
  type APIUser,
  type MessageType,
} from "discord-api-types/v10";
import {
  createChannelMessage,
  createUserDmChannel,
  deleteChannelMessage,
  editChannelMessage,
  getChannelMessage,
  pinChannelMessage,
  unpinChannelMessage,
} from "./api.js";
import { serializePayload, type MessagePayload } from "./payload.js";
import type { RequestClient } from "./rest.js";

type RawOrId<T> = T | string | { id: string; channelId?: string };
export type StructureClient = {
  rest: RequestClient;
  fetchUser(id: string): Promise<User>;
};

export class Base {
  constructor(protected client: StructureClient) {}
}

export class User<IsPartial extends boolean = false> extends Base {
  protected _rawData: APIUser | null;
  readonly id: string;

  constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIUser) {
    super(client);
    this._rawData = typeof rawDataOrId === "string" ? null : rawDataOrId;
    this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
  }

  get rawData(): Readonly<APIUser> {
    if (!this._rawData) {
      throw new Error("Partial Discord user has no raw data");
    }
    return this._rawData;
  }
  get partial(): IsPartial {
    return (this._rawData === null) as IsPartial;
  }
  get username() {
    return this._rawData?.username ?? "";
  }
  get globalName() {
    return this._rawData?.global_name;
  }
  get discriminator() {
    return this._rawData?.discriminator;
  }
  get bot() {
    return this._rawData?.bot;
  }
  get avatar() {
    return this._rawData?.avatar;
  }
  get avatarUrl() {
    return this.avatar ? `https://cdn.discordapp.com/avatars/${this.id}/${this.avatar}.png` : null;
  }
  toString(): string {
    return `<@${this.id}>`;
  }
  async fetch(): Promise<User> {
    return this.client.fetchUser(this.id);
  }
  async createDm() {
    return await createUserDmChannel(this.client.rest, this.id);
  }
  async send(data: MessagePayload): Promise<Message> {
    const dm = await this.createDm();
    const message = await createChannelMessage(this.client.rest, dm.id, {
      body: serializePayload(data),
    });
    return new Message(this.client, message);
  }
}

export class Role<IsPartial extends boolean = false> extends Base {
  protected _rawData: APIRole | null;
  readonly id: string;
  constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIRole) {
    super(client);
    this._rawData = typeof rawDataOrId === "string" ? null : rawDataOrId;
    this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
  }
  get name() {
    return this._rawData?.name ?? "";
  }
}

export class Guild<IsPartial extends boolean = false> extends Base {
  protected _rawData: APIGuild | null;
  readonly id: string;
  constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIGuild) {
    super(client);
    this._rawData = typeof rawDataOrId === "string" ? null : rawDataOrId;
    this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
  }
  get name() {
    return this._rawData?.name ?? "";
  }
}

export class GuildMember extends Base {
  constructor(
    client: StructureClient,
    public rawData: APIGuildMember,
  ) {
    super(client);
  }
  get user() {
    return this.rawData.user ? new User(this.client, this.rawData.user) : null;
  }
  get roles() {
    return (this.rawData.roles ?? []) as Array<string | Role>;
  }
  get nickname() {
    return this.rawData.nick ?? undefined;
  }
}

export class Message<IsPartial extends boolean = false> extends Base {
  protected _rawData: APIMessage | null;
  readonly id: string;
  readonly channelId: string;

  constructor(client: StructureClient, rawDataOrIds: RawOrId<APIMessage>) {
    super(client);
    this._rawData =
      typeof rawDataOrIds === "string" || !("author" in rawDataOrIds) ? null : rawDataOrIds;
    this.id = typeof rawDataOrIds === "string" ? rawDataOrIds : rawDataOrIds.id;
    this.channelId =
      typeof rawDataOrIds === "string"
        ? ""
        : "channel_id" in rawDataOrIds
          ? rawDataOrIds.channel_id
          : (rawDataOrIds.channelId ?? "");
  }

  get rawData(): Readonly<APIMessage> {
    if (!this._rawData) {
      throw new Error("Partial Discord message has no raw data");
    }
    return this._rawData;
  }
  get partial(): IsPartial {
    return (this._rawData === null) as IsPartial;
  }
  get message(): Message<IsPartial> {
    return this;
  }
  get channel_id() {
    return this.channelId;
  }
  get guild_id() {
    return (this._rawData as { guild_id?: string } | null)?.guild_id;
  }
  get guild() {
    return this.guild_id ? new Guild<true>(this.client, this.guild_id) : null;
  }
  get webhookId() {
    return this.webhook_id;
  }
  get webhook_id() {
    return (this._rawData as { webhook_id?: string | null } | null)?.webhook_id ?? null;
  }
  get member() {
    const member = (this._rawData as { member?: APIGuildMember } | null)?.member;
    return member ? new GuildMember(this.client, member) : null;
  }
  get rawMember() {
    return (this._rawData as { member?: APIGuildMember } | null)?.member;
  }
  get content() {
    return this._rawData?.content ?? "";
  }
  get author() {
    return this._rawData?.author ? new User(this.client, this._rawData.author) : null;
  }
  get embeds(): APIEmbed[] {
    return this._rawData?.embeds ?? [];
  }
  get attachments() {
    return this._rawData?.attachments ?? [];
  }
  get stickers() {
    return this._rawData?.sticker_items ?? [];
  }
  get mentionedUsers() {
    return (this._rawData?.mentions ?? []).map((user) => new User(this.client, user));
  }
  get mentionedRoles() {
    return this._rawData?.mention_roles ?? [];
  }
  get mentionedEveryone() {
    return this._rawData?.mention_everyone ?? false;
  }
  get timestamp() {
    return this._rawData?.timestamp;
  }
  get type(): MessageType | undefined {
    return this._rawData?.type;
  }
  get messageReference() {
    return this._rawData?.message_reference;
  }
  get referencedMessage() {
    return this._rawData?.referenced_message
      ? new Message(this.client, this._rawData.referenced_message)
      : null;
  }
  get thread() {
    return this._rawData?.thread ? channelFactory(this.client, this._rawData.thread) : null;
  }
  async fetch(): Promise<Message> {
    const raw = await getChannelMessage(this.client.rest, this.channelId, this.id);
    return new Message(this.client, raw);
  }
  async delete(): Promise<void> {
    await deleteChannelMessage(this.client.rest, this.channelId, this.id);
  }
  async edit(data: MessagePayload): Promise<Message> {
    const raw = await editChannelMessage(this.client.rest, this.channelId, this.id, {
      body: serializePayload(data),
    });
    return new Message(this.client, raw);
  }
  async reply(data: MessagePayload): Promise<Message> {
    const raw = await createChannelMessage(this.client.rest, this.channelId, {
      body: {
        ...serializePayload(data),
        message_reference: { message_id: this.id, fail_if_not_exists: false },
      },
    });
    return new Message(this.client, raw);
  }
  async pin(): Promise<void> {
    await pinChannelMessage(this.client.rest, this.channelId, this.id);
  }
  async unpin(): Promise<void> {
    await unpinChannelMessage(this.client.rest, this.channelId, this.id);
  }
}

export type DiscordChannel = APIChannel & {
  rawData?: APIChannel;
  guildId?: string;
  guild?: Guild;
  name?: string;
  parentId?: string | null;
};

export function channelFactory(
  _client: StructureClient,
  channelData: APIChannel,
  _partial?: boolean,
): DiscordChannel {
  return {
    ...channelData,
    rawData: channelData,
    guildId: "guild_id" in channelData ? channelData.guild_id : undefined,
    guild:
      "guild_id" in channelData && typeof channelData.guild_id === "string"
        ? new Guild<true>(_client, channelData.guild_id)
        : undefined,
    parentId: "parent_id" in channelData ? channelData.parent_id : undefined,
  } as DiscordChannel;
}

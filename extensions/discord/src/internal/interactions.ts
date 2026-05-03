import {
  ComponentType,
  InteractionResponseType,
  InteractionType,
  type APIApplicationCommandInteraction,
  type APIApplicationCommandInteractionDataOption,
  type APIChannel,
  type APIInteraction,
  type APIInteractionDataResolvedChannel,
  type APIMessage,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
  type APIUser,
} from "discord-api-types/v10";
import {
  createInteractionCallback,
  createWebhookMessage,
  deleteWebhookMessage,
  editWebhookMessage,
  getWebhookMessage,
} from "./api.js";
import { OptionsHandler } from "./interaction-options.js";
import {
  InteractionResponseController,
  needsComponentsV2Query,
  type InteractionResponseState,
} from "./interaction-response.js";
import { extractModalFields, ModalFields } from "./modal-fields.js";
import { serializePayload, type MessagePayload } from "./payload.js";
import { assertDiscordInteractionPayload } from "./schemas.js";
import {
  channelFactory,
  Guild,
  Message,
  User,
  type DiscordChannel,
  type StructureClient,
} from "./structures.js";

export { OptionsHandler } from "./interaction-options.js";
export { ModalFields } from "./modal-fields.js";

type InteractionClient = StructureClient & {
  options: { clientId: string };
  componentHandler: {
    waitForMessageComponent(
      message: Message,
      timeoutMs: number,
    ): Promise<
      | { success: true; customId: string; message: Message; values?: string[] }
      | { success: false; message: Message; reason: "timed out" }
    >;
  };
  fetchChannel(id: string): Promise<DiscordChannel>;
};

type Modal = {
  serialize: () => unknown;
};

type ComponentData = Record<string, unknown>;

export type RawInteraction = APIInteraction & {
  token: string;
  member?: { user?: APIUser; roles?: string[] };
  guild_id?: string;
  channel_id?: string;
  channel?: unknown;
  data?: {
    custom_id?: string;
    component_type?: number;
    values?: string[];
    components?: unknown[];
    options?: APIApplicationCommandInteractionDataOption[];
    resolved?: {
      channels?: Record<string, APIInteractionDataResolvedChannel>;
      roles?: Record<string, { id: string; name?: string }>;
      users?: Record<string, { id: string; username?: string; discriminator?: string }>;
    };
  };
  message?: unknown;
};

type CommandRawInteraction = APIApplicationCommandInteraction & RawInteraction;
type MessageComponentRawInteraction = APIMessageComponentInteraction & RawInteraction;
type ModalSubmitRawInteraction = APIModalSubmitInteraction & RawInteraction;

function toCommandRawInteraction(rawData: RawInteraction): CommandRawInteraction {
  return rawData as CommandRawInteraction;
}

function toMessageComponentRawInteraction(rawData: RawInteraction): MessageComponentRawInteraction {
  return rawData as MessageComponentRawInteraction;
}

function toModalSubmitRawInteraction(rawData: RawInteraction): ModalSubmitRawInteraction {
  return rawData as ModalSubmitRawInteraction;
}

function readInteractionUser(rawData: RawInteraction, client: InteractionClient): User | null {
  const directUser = "user" in rawData ? rawData.user : undefined;
  if (directUser && typeof directUser === "object" && "id" in directUser) {
    return new User(client, directUser);
  }
  const memberUser = rawData.member?.user;
  if (memberUser && typeof memberUser === "object" && typeof memberUser.id === "string") {
    const user = { ...memberUser } as APIUser;
    if (typeof user.username !== "string") {
      user.username = "";
    }
    return new User(client, user);
  }
  return null;
}

export class BaseInteraction {
  readonly id: string;
  readonly token: string;
  readonly user: User | null;
  readonly userId: string;
  readonly guild: Guild | null;
  readonly channel: DiscordChannel | null;
  message: Message | null = null;
  private readonly response = new InteractionResponseController();

  constructor(
    public client: InteractionClient,
    public rawData: RawInteraction,
  ) {
    this.id = rawData.id;
    this.token = rawData.token;
    this.user = readInteractionUser(rawData, client);
    this.userId = this.user?.id ?? "";
    this.guild = rawData.guild_id ? new Guild<true>(client, rawData.guild_id) : null;
    this.channel =
      "channel" in rawData && rawData.channel
        ? channelFactory(client, rawData.channel as APIChannel)
        : null;
  }

  get acknowledged(): boolean {
    return this.response.acknowledged;
  }

  get responseState(): InteractionResponseState {
    return this.response.state;
  }

  set responseState(nextState: InteractionResponseState) {
    this.response.state = nextState;
  }

  protected async callback(type: InteractionResponseType, data?: unknown) {
    this.response.recordCallback(type);
    return await createInteractionCallback(
      this.client.rest,
      this.id,
      this.token,
      data === undefined ? { type } : { type, data },
    );
  }

  async reply(payload: MessagePayload): Promise<unknown> {
    const action = this.response.nextReplyAction();
    if (action === "edit") {
      return await this.editReply(payload);
    }
    if (action === "follow-up") {
      return await this.followUp(payload);
    }
    return await this.callback(
      InteractionResponseType.ChannelMessageWithSource,
      serializePayload(payload),
    );
  }

  async defer(options?: { ephemeral?: boolean }): Promise<unknown> {
    return await this.callback(
      InteractionResponseType.DeferredChannelMessageWithSource,
      options?.ephemeral ? { flags: 64 } : undefined,
    );
  }

  async acknowledge(): Promise<unknown> {
    return await this.defer();
  }

  async editReply(payload: MessagePayload): Promise<unknown> {
    const body = serializePayload(payload);
    const query = needsComponentsV2Query(body) ? { with_components: true } : undefined;
    const result = query
      ? await editWebhookMessage(
          this.client.rest,
          this.client.options.clientId,
          this.token,
          "@original",
          { body },
          query,
        )
      : await editWebhookMessage(
          this.client.rest,
          this.client.options.clientId,
          this.token,
          "@original",
          { body },
        );
    this.response.recordReplyEdit();
    return result;
  }

  async deleteReply(): Promise<unknown> {
    return await deleteWebhookMessage(
      this.client.rest,
      this.client.options.clientId,
      this.token,
      "@original",
    );
  }

  async fetchReply(): Promise<unknown> {
    return await getWebhookMessage(
      this.client.rest,
      this.client.options.clientId,
      this.token,
      "@original",
    );
  }

  async replyAndWaitForComponent(payload: MessagePayload, timeoutMs = 300_000) {
    const result = await this.reply(payload);
    const rawMessage = isRawMessage(result) ? result : await this.fetchReply();
    if (!isRawMessage(rawMessage)) {
      throw new Error("Discord interaction reply did not return a message");
    }
    const message = new Message(this.client, rawMessage as APIMessage);
    return await this.client.componentHandler.waitForMessageComponent(message, timeoutMs);
  }

  async followUp(payload: MessagePayload): Promise<unknown> {
    const body = serializePayload(payload);
    return await createWebhookMessage(
      this.client.rest,
      this.client.options.clientId,
      this.token,
      { body },
      needsComponentsV2Query(body) ? { with_components: true } : undefined,
    );
  }
}

export class CommandInteraction extends BaseInteraction {
  readonly options: OptionsHandler;
  constructor(
    client: InteractionClient,
    rawData: APIApplicationCommandInteraction & RawInteraction,
  ) {
    super(client, rawData);
    this.options = new OptionsHandler(
      rawData.data.options,
      client,
      rawData.data.resolved?.channels,
    );
  }
}

export class AutocompleteInteraction extends CommandInteraction {
  async respond(choices: Array<{ name: string; value: string | number }>): Promise<unknown> {
    return await this.callback(InteractionResponseType.ApplicationCommandAutocompleteResult, {
      choices,
    });
  }
}

export class BaseComponentInteraction extends BaseInteraction {
  readonly values: string[];

  constructor(client: InteractionClient, rawData: APIMessageComponentInteraction & RawInteraction) {
    super(client, rawData);
    this.message =
      rawData.message && typeof rawData.message === "object"
        ? new Message(client, rawData.message)
        : null;
    this.values = Array.isArray(rawData.data.values) ? rawData.data.values.map(String) : [];
  }

  async update(payload: MessagePayload): Promise<unknown> {
    return await this.callback(InteractionResponseType.UpdateMessage, serializePayload(payload));
  }
  async acknowledge(): Promise<unknown> {
    return await this.callback(InteractionResponseType.DeferredMessageUpdate);
  }
  async showModal(modal: Modal): Promise<unknown> {
    return await this.callback(InteractionResponseType.Modal, modal.serialize());
  }

  async editAndWaitForComponent(
    payload: MessagePayload,
    message: Message | null = this.message,
    timeoutMs = 300_000,
  ) {
    if (!message) {
      return null;
    }
    const editedMessage = await message.edit(payload);
    return await this.client.componentHandler.waitForMessageComponent(editedMessage, timeoutMs);
  }
}

export class ButtonInteraction extends BaseComponentInteraction {}
export class StringSelectMenuInteraction extends BaseComponentInteraction {}
export class UserSelectMenuInteraction extends BaseComponentInteraction {}
export class RoleSelectMenuInteraction extends BaseComponentInteraction {}
export class MentionableSelectMenuInteraction extends BaseComponentInteraction {}
export class ChannelSelectMenuInteraction extends BaseComponentInteraction {}

export class ModalInteraction extends BaseInteraction {
  readonly fields: ModalFields;
  constructor(client: InteractionClient, rawData: APIModalSubmitInteraction & RawInteraction) {
    super(client, rawData);
    this.fields = new ModalFields(
      extractModalFields(rawData.data.components ?? []),
      rawData.data.resolved,
      client,
    );
  }
  async acknowledge(): Promise<unknown> {
    return await this.callback(InteractionResponseType.DeferredMessageUpdate);
  }
}

export function createInteraction(client: InteractionClient, rawData: RawInteraction) {
  assertDiscordInteractionPayload(rawData);
  if (rawData.type === InteractionType.ApplicationCommandAutocomplete) {
    return new AutocompleteInteraction(client, toCommandRawInteraction(rawData));
  }
  if (rawData.type === InteractionType.ApplicationCommand) {
    return new CommandInteraction(client, toCommandRawInteraction(rawData));
  }
  if (rawData.type === InteractionType.ModalSubmit) {
    return new ModalInteraction(client, toModalSubmitRawInteraction(rawData));
  }
  if (rawData.type === InteractionType.MessageComponent) {
    const componentRawData = toMessageComponentRawInteraction(rawData);
    switch (rawData.data?.component_type) {
      case ComponentType.Button:
        return new ButtonInteraction(client, componentRawData);
      case ComponentType.StringSelect:
        return new StringSelectMenuInteraction(client, componentRawData);
      case ComponentType.UserSelect:
        return new UserSelectMenuInteraction(client, componentRawData);
      case ComponentType.RoleSelect:
        return new RoleSelectMenuInteraction(client, componentRawData);
      case ComponentType.MentionableSelect:
        return new MentionableSelectMenuInteraction(client, componentRawData);
      case ComponentType.ChannelSelect:
        return new ChannelSelectMenuInteraction(client, componentRawData);
      default:
        return new BaseComponentInteraction(client, componentRawData);
    }
  }
  return new BaseInteraction(client, rawData);
}

export function parseComponentInteractionData(
  component: { customIdParser: (id: string) => { data: ComponentData } },
  customId: string,
): ComponentData {
  return component.customIdParser(customId).data;
}

function isRawMessage(value: unknown): value is { id: string; channel_id: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { channel_id?: unknown }).channel_id === "string"
  );
}

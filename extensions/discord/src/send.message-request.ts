// Discord plugin module implements send.message request behavior.
import { randomBytes } from "node:crypto";
import { MessageFlags, type APIAllowedMentions, type APIEmbed } from "discord-api-types/v10";
import {
  Embed,
  serializePayload,
  type MessagePayloadFile,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "./internal/discord.js";

const SUPPRESS_EMBEDS_FLAG = MessageFlags.SuppressEmbeds;
export const SUPPRESS_NOTIFICATIONS_FLAG = MessageFlags.SuppressNotifications;

type DiscordSendComponentFactory = (text: string) => TopLevelComponents[];
export type DiscordSendComponents = TopLevelComponents[] | DiscordSendComponentFactory;
export type DiscordSendEmbeds = Array<APIEmbed | Embed>;
export type DiscordAllowedMentions = APIAllowedMentions;

export function createDiscordMessageNonce(): string {
  return randomBytes(12).toString("hex");
}

export function resolveDiscordSendComponents(params: {
  components?: DiscordSendComponents;
  text: string;
  isFirst: boolean;
}): TopLevelComponents[] | undefined {
  if (!params.components || !params.isFirst) {
    return undefined;
  }
  return typeof params.components === "function"
    ? params.components(params.text)
    : params.components;
}

function normalizeDiscordEmbeds(embeds?: DiscordSendEmbeds): Embed[] | undefined {
  if (!embeds?.length) {
    return undefined;
  }
  return embeds.map((embed) => (embed instanceof Embed ? embed : new Embed(embed)));
}

export function resolveDiscordSendEmbeds(params: {
  embeds?: DiscordSendEmbeds;
  isFirst: boolean;
}): Embed[] | undefined {
  if (!params.embeds || !params.isFirst) {
    return undefined;
  }
  return normalizeDiscordEmbeds(params.embeds);
}

function buildDiscordMessagePayload(params: {
  text: string;
  components?: TopLevelComponents[];
  embeds?: Embed[];
  allowedMentions?: DiscordAllowedMentions;
  flags?: number;
  files?: MessagePayloadFile[];
}): MessagePayloadObject {
  const payload: MessagePayloadObject = {};
  const hasV2 = hasV2Components(params.components);
  const trimmed = params.text.trim();
  if (!hasV2 && trimmed) {
    payload.content = params.text;
  }
  if (params.components?.length) {
    payload.components = params.components;
  }
  if (!hasV2 && params.embeds?.length) {
    payload.embeds = params.embeds;
  }
  if (params.allowedMentions) {
    payload.allowed_mentions = params.allowedMentions;
  }
  if (params.flags !== undefined) {
    payload.flags = params.flags;
  }
  if (params.files?.length) {
    payload.files = params.files;
  }
  return payload;
}

export function resolveDiscordMessageFlags(params: {
  silent?: boolean;
  suppressEmbeds?: boolean;
}): number | undefined {
  let flags = 0;
  if (params.suppressEmbeds) {
    flags |= SUPPRESS_EMBEDS_FLAG;
  }
  if (params.silent) {
    flags |= SUPPRESS_NOTIFICATIONS_FLAG;
  }
  return flags || undefined;
}

type DiscordMessageRequestParams = {
  text: string;
  components?: TopLevelComponents[];
  embeds?: Embed[];
  allowedMentions?: DiscordAllowedMentions;
  files?: MessagePayloadFile[];
  flags?: number;
  replyTo?: string;
} & ({ endpoint: "create-message"; nonce?: string } | { endpoint: "forum-thread"; nonce?: never });

export function buildDiscordMessageRequest(params: DiscordMessageRequestParams) {
  const payload = buildDiscordMessagePayload(params);
  const nonce =
    params.endpoint === "create-message"
      ? (params.nonce ?? createDiscordMessageNonce())
      : undefined;
  return stripUndefinedFields({
    ...serializePayload(payload),
    ...(params.replyTo
      ? { message_reference: { message_id: params.replyTo, fail_if_not_exists: false } }
      : {}),
    nonce,
    enforce_nonce: nonce ? true : undefined,
  });
}

export function stripUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function hasV2Components(components?: TopLevelComponents[]): boolean {
  return Boolean(components?.some((component) => "isV2" in component && component.isV2));
}

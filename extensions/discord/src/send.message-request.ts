import type { APIEmbed } from "discord-api-types/v10";
import {
  Embed,
  serializePayload,
  type MessagePayloadFile,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "./internal/discord.js";

export const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;

export type DiscordSendComponentFactory = (text: string) => TopLevelComponents[];
export type DiscordSendComponents = TopLevelComponents[] | DiscordSendComponentFactory;
export type DiscordSendEmbeds = Array<APIEmbed | Embed>;

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

export function buildDiscordMessagePayload(params: {
  text: string;
  components?: TopLevelComponents[];
  embeds?: Embed[];
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
  if (params.flags !== undefined) {
    payload.flags = params.flags;
  }
  if (params.files?.length) {
    payload.files = params.files;
  }
  return payload;
}

export function buildDiscordMessageRequest(params: {
  text: string;
  components?: TopLevelComponents[];
  embeds?: Embed[];
  files?: MessagePayloadFile[];
  flags?: number;
  replyTo?: string;
}) {
  const payload = buildDiscordMessagePayload(params);
  return stripUndefinedFields({
    ...serializePayload(payload),
    ...(params.replyTo
      ? { message_reference: { message_id: params.replyTo, fail_if_not_exists: false } }
      : {}),
  });
}

export function stripUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function hasV2Components(components?: TopLevelComponents[]): boolean {
  return Boolean(components?.some((component) => "isV2" in component && component.isV2));
}

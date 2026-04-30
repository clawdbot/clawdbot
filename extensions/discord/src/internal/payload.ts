import { MessageFlags, type APIEmbed } from "discord-api-types/v10";
import { Embed } from "./embeds.js";

export type MessagePayloadFile = {
  name: string;
  data: Blob | Uint8Array | ArrayBuffer;
  description?: string;
  duration_secs?: number;
  waveform?: string;
};
export type MessagePayloadObject = {
  content?: string;
  embeds?: Array<APIEmbed | Embed>;
  components?: TopLevelComponents[];
  allowedMentions?: unknown;
  allowed_mentions?: unknown;
  flags?: number;
  tts?: boolean;
  files?: MessagePayloadFile[];
  poll?: unknown;
  ephemeral?: boolean;
  stickers?: [string, string, string] | [string, string] | [string];
};
export type MessagePayload = string | MessagePayloadObject;
export type TopLevelComponents = {
  isV2?: boolean;
  serialize: () => unknown;
};

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function serializeAnyComponent(component: { serialize: () => unknown }): unknown {
  return component.serialize();
}

function payloadHasV2Components(payload: MessagePayloadObject): boolean {
  return Boolean(payload.components?.some((component) => component.isV2));
}

function normalizePayloadFlags(payload: MessagePayloadObject): number | undefined {
  const flags = payload.ephemeral ? (payload.flags ?? 0) | MessageFlags.Ephemeral : payload.flags;
  if (!payloadHasV2Components(payload)) {
    return flags;
  }
  if (payload.content || payload.embeds?.length) {
    throw new Error("Discord Components V2 payloads cannot include content or embeds");
  }
  return (flags ?? 0) | MessageFlags.IsComponentsV2;
}

export function serializePayload(payload: MessagePayload) {
  if (typeof payload === "string") {
    return { content: payload };
  }
  const flags = normalizePayloadFlags(payload);
  return clean({
    content: payload.content,
    embeds: payload.embeds?.map((entry) => ("serialize" in entry ? entry.serialize() : entry)),
    components: payload.components?.map((entry) => serializeAnyComponent(entry)),
    allowed_mentions: payload.allowed_mentions ?? payload.allowedMentions,
    flags,
    tts: payload.tts,
    files: payload.files,
    poll: payload.poll,
    sticker_ids: payload.stickers,
  });
}

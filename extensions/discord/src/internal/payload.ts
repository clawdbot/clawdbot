// Discord plugin module implements payload behavior.
import {
  ComponentType,
  MessageFlags,
  type APIEmbed,
  type APIMessageTopLevelComponent,
} from "discord-api-types/v10";
import { Embed } from "./embeds.js";
import { stripUndefinedFields as clean } from "./undefined-fields.js";

export type MessagePayloadFile = {
  name: string;
  data: Blob | Uint8Array | ArrayBuffer;
  contentType?: string;
  description?: string;
  duration_secs?: number;
  waveform?: string;
};
export type MessagePayloadObject = {
  content?: string;
  embeds?: Array<APIEmbed | Embed>;
  components?: Array<TopLevelComponents | APIMessageTopLevelComponent>;
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

export function hasDiscordV2Components(components?: MessagePayloadObject["components"]): boolean {
  return Boolean(
    components?.some(
      (component) =>
        ("isV2" in component && component.isV2) ||
        ("type" in component && component.type !== ComponentType.ActionRow),
    ),
  );
}

function normalizePayloadFlags(payload: MessagePayloadObject): number | undefined {
  const flags = payload.ephemeral ? (payload.flags ?? 0) | MessageFlags.Ephemeral : payload.flags;
  if (!hasDiscordV2Components(payload.components)) {
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
    components: payload.components?.map((entry) =>
      "serialize" in entry ? entry.serialize() : entry,
    ),
    allowed_mentions: payload.allowed_mentions ?? payload.allowedMentions,
    flags,
    tts: payload.tts,
    files: payload.files,
    poll: payload.poll,
    sticker_ids: payload.stickers,
  });
}

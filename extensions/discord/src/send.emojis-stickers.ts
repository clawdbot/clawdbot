// Discord plugin module implements send.emojis stickers behavior.
import type { RESTGetAPIGuildEmojisResult } from "discord-api-types/v10";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { createGuildEmoji, createGuildSticker, listGuildEmojis } from "./internal/discord.js";
import { normalizeEmojiName, resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordAssetUploadOpts,
  DiscordEmojiUpload,
  DiscordReactOpts,
  DiscordStickerUpload,
} from "./send.types.js";
import { DISCORD_MAX_EMOJI_BYTES, DISCORD_MAX_STICKER_BYTES } from "./send.types.js";

export async function listGuildEmojisDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<RESTGetAPIGuildEmojisResult> {
  const rest = resolveDiscordRest(opts);
  return await listGuildEmojis(rest, guildId);
}

export async function uploadEmojiDiscord(
  payload: DiscordEmojiUpload,
  opts: DiscordAssetUploadOpts,
) {
  const rest = resolveDiscordRest(opts);
  // Security: the sender-scoped read policy must reach the loader, or a permitted sender could
  // upload host-local bytes from outside their allowed media roots.
  const media = await loadWebMediaRaw(
    payload.mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes: DISCORD_MAX_EMOJI_BYTES,
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
    }),
  );
  const contentType = normalizeOptionalLowercaseString(media.contentType);
  if (
    !contentType ||
    !["image/png", "image/jpeg", "image/jpg", "image/gif"].includes(contentType)
  ) {
    throw new Error("Discord emoji uploads require a PNG, JPG, or GIF image");
  }
  const image = `data:${contentType};base64,${media.buffer.toString("base64")}`;
  const roleIds = normalizeStringEntries(payload.roleIds ?? []);
  return await createGuildEmoji(rest, payload.guildId, {
    body: {
      name: normalizeEmojiName(payload.name, "Emoji name"),
      image,
      roles: roleIds.length ? roleIds : undefined,
    },
  });
}

export async function uploadStickerDiscord(
  payload: DiscordStickerUpload,
  opts: DiscordAssetUploadOpts,
) {
  const rest = resolveDiscordRest(opts);
  // Security: same sender-scoped media boundary as emoji uploads.
  const media = await loadWebMediaRaw(
    payload.mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes: DISCORD_MAX_STICKER_BYTES,
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
    }),
  );
  const contentType = normalizeOptionalLowercaseString(media.contentType);
  if (!contentType || !["image/png", "image/apng", "application/json"].includes(contentType)) {
    throw new Error("Discord sticker uploads require a PNG, APNG, or Lottie JSON file");
  }
  return await createGuildSticker(rest, payload.guildId, {
    multipartStyle: "form",
    body: {
      name: normalizeEmojiName(payload.name, "Sticker name"),
      description: normalizeEmojiName(payload.description, "Sticker description"),
      tags: normalizeEmojiName(payload.tags, "Sticker tags"),
      files: [
        {
          data: media.buffer,
          fieldName: "file",
          name: media.fileName ?? "sticker",
          contentType,
        },
      ],
    },
  });
}

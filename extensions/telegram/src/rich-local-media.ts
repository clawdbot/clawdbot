import { InputFile } from "grammy";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isGifMedia, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { isVoiceNoteMedia } from "./rich-block-model.js";
import { telegramRichMediaReference, type TelegramInputRichMessageMedia } from "./rich-message.js";
import { buildOutboundMediaLoadOptions, getImageMetadata, loadWebMedia } from "./send.runtime.js";

const MAX_RICH_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 10_000;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;
const LOCAL_MEDIA_SOURCE_RE = /^(?:(?:[fF][iI][lL][eE]:\/\/)?\/(?!\/)|[A-Za-z]:[\\/])/u;
const LOCAL_MEDIA_TAG_RE =
  /<(img|video|audio)\b([^>]*?)\bsrc\s*=\s*(?:(["'])([^"']+)\3|([^\s"'=<>`]+))([^>]*)>/giu;
const LOCAL_MARKDOWN_IMAGE_RE =
  /!\[([^\]\n]*)\]\(((?:(?:[fF][iI][lL][eE]:\/\/)?\/(?!\/)|[A-Za-z]:[\\/])[^\s)"]+)(?:\s+"([^"\n]*)")?\)/gu;

type RichMediaType = "photo" | "video" | "audio" | "voice_note";
type RichMediaElementType = Exclude<RichMediaType, "voice_note">;

export type TelegramRichLocalMedia = TelegramInputRichMessageMedia & {
  /** Original local source, resent as legacy media when Telegram rejects the rich upload. */
  source: string;
  fileName: string;
};

function unsupportedRichLocalMediaError(source: string): Error {
  return new Error(
    `Telegram rich messages can embed local photos, videos, and audio only: ${source}`,
  );
}

export function isTelegramRichLocalMediaSource(source: string): boolean {
  return LOCAL_MEDIA_SOURCE_RE.test(source.trim());
}

function richMediaTypeForTag(tag: string): RichMediaElementType {
  const normalizedTag = tag.toLowerCase();
  return normalizedTag === "img" ? "photo" : normalizedTag === "video" ? "video" : "audio";
}

function richMediaElementType(type: RichMediaType): RichMediaElementType {
  return type === "voice_note" ? "audio" : type;
}

function richLocalMediaFilename(params: {
  fileName?: string;
  contentType?: string;
  type: RichMediaType;
}): string {
  if (params.fileName) {
    return params.fileName;
  }
  const extension =
    extensionForMime(params.contentType) ??
    (params.type === "photo" ? ".jpg" : params.type === "video" ? ".mp4" : ".ogg");
  return `${params.type}${extension}`;
}

async function isRichPhoto(media: { buffer: Buffer }): Promise<boolean> {
  if (media.buffer.length === 0 || media.buffer.length > MAX_RICH_PHOTO_BYTES) {
    return false;
  }
  try {
    const metadata = await getImageMetadata(media.buffer);
    const width = metadata?.width;
    const height = metadata?.height;
    if (typeof width !== "number" || typeof height !== "number") {
      return false;
    }
    const shorterSide = Math.min(width, height);
    const longerSide = Math.max(width, height);
    return (
      width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM &&
      shorterSide > 0 &&
      longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO
    );
  } catch {
    return false;
  }
}

function buildFigure(
  media: TelegramInputRichMessageMedia,
  params?: { alt?: string; caption?: string },
) {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const alt = params?.alt ? ` alt="${escape(params.alt)}"` : "";
  const caption = params?.caption ? `<figcaption>${escape(params.caption)}</figcaption>` : "";
  const elementType = richMediaElementType(media.media.type);
  const tag = elementType === "photo" ? "img" : elementType;
  return `<figure><${tag} src="${telegramRichMediaReference(media)}"${alt}/>${caption}</figure>`;
}

export async function resolveTelegramRichLocalMedia(params: {
  text: string;
  mediaUrls?: readonly string[];
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{
  text: string;
  media: TelegramRichLocalMedia[];
  unconsumedMediaUrls: string[];
}> {
  const media: TelegramRichLocalMedia[] = [];
  const cache = new Map<string, Promise<TelegramRichLocalMedia | undefined>>();
  let nextId = 0;
  const resolve = async (source: string) => {
    const key = source.trim();
    const cached = cache.get(key);
    if (cached) {
      return await cached;
    }
    const pending = (async () => {
      const loaded = await loadWebMedia(
        key,
        buildOutboundMediaLoadOptions({
          maxBytes: params.maxBytes,
          mediaAccess: params.mediaAccess,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
        }),
      );
      const kind = kindFromMime(loaded.contentType ?? undefined);
      const isGif = isGifMedia({ contentType: loaded.contentType, fileName: loaded.fileName });
      const type =
        kind === "image" && !isGif && (await isRichPhoto(loaded))
          ? "photo"
          : kind === "video" && !isGif
            ? "video"
            : kind === "audio"
              ? isVoiceNoteMedia(loaded.fileName ?? key)
                ? "voice_note"
                : "audio"
              : undefined;
      if (!type) {
        return undefined;
      }
      nextId += 1;
      const fileName = richLocalMediaFilename({
        fileName: loaded.fileName,
        contentType: loaded.contentType,
        type,
      });
      const entry: TelegramRichLocalMedia = {
        id: `media${nextId}`,
        source: key,
        fileName,
        media: { type, media: new InputFile(loaded.buffer, fileName) },
      };
      media.push(entry);
      return entry;
    })();
    cache.set(key, pending);
    return await pending;
  };

  let result = "";
  let cursor = 0;
  for (const match of params.text.matchAll(LOCAL_MEDIA_TAG_RE)) {
    const [raw, tag = "", before = "", quote = "", quotedSource, unquotedSource, after = ""] =
      match;
    const source = quotedSource ?? unquotedSource ?? "";
    const index = match.index ?? 0;
    result += params.text.slice(cursor, index);
    cursor = index + raw.length;
    if (!isTelegramRichLocalMediaSource(source)) {
      result += raw;
      continue;
    }
    const resolved = await resolve(source);
    if (!resolved) {
      throw unsupportedRichLocalMediaError(source);
    }
    if (richMediaElementType(resolved.media.type) !== richMediaTypeForTag(tag)) {
      throw new Error(`Telegram rich media element does not match local file type: ${source}`);
    }
    const outputQuote = quote || '"';
    result += `<${tag}${before}src=${outputQuote}${telegramRichMediaReference(resolved)}${outputQuote}${after}>`;
  }
  result += params.text.slice(cursor);

  let markdown = "";
  cursor = 0;
  for (const match of result.matchAll(LOCAL_MARKDOWN_IMAGE_RE)) {
    const [raw, alt, source = "", caption] = match;
    const index = match.index ?? 0;
    markdown += result.slice(cursor, index);
    cursor = index + raw.length;
    const resolved = await resolve(source);
    if (!resolved) {
      throw unsupportedRichLocalMediaError(source);
    }
    markdown += buildFigure(resolved, { alt, caption });
  }
  markdown += result.slice(cursor);

  const unconsumedMediaUrls: string[] = [];
  const appended: string[] = [];
  for (const source of params.mediaUrls ?? []) {
    if (!isTelegramRichLocalMediaSource(source)) {
      unconsumedMediaUrls.push(source);
      continue;
    }
    const resolved = await resolve(source);
    if (!resolved) {
      unconsumedMediaUrls.push(source);
      continue;
    }
    appended.push(buildFigure(resolved));
  }
  return {
    text: appended.length ? `${markdown.trimEnd()}\n\n${appended.join("\n\n")}` : markdown,
    media,
    unconsumedMediaUrls,
  };
}

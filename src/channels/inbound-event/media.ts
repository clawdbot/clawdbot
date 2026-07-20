import { kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
/**
 * Channel inbound media normalization.
 *
 * Converts plugin attachment metadata into aligned prompt/context media payload fields.
 */
import { normalizeOptionalString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { InboundMediaFacts } from "../turn/types.js";

/**
 * Attachment metadata accepted from channel plugins before core normalization.
 */
export type ChannelInboundMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: InboundMediaFacts["kind"] | null;
  transcribed?: boolean | null;
  messageId?: string | null;
};

export type MediaPlaceholderTextFact = Readonly<
  Pick<ChannelInboundMediaInput, "contentType" | "kind" | "path" | "url">
>;

type MediaPlaceholderKind = "attachment" | "audio" | "document" | "image" | "sticker" | "video";

function resolveMediaPlaceholderKind(media: MediaPlaceholderTextFact): MediaPlaceholderKind {
  if (media.kind && media.kind !== "unknown") {
    return media.kind;
  }
  return (
    kindFromMime(media.contentType) ??
    kindFromMime(mimeTypeFromFilePath(media.url)) ??
    kindFromMime(mimeTypeFromFilePath(media.path)) ??
    "attachment"
  );
}

const PLURAL_MEDIA_PLACEHOLDER_LABELS: Readonly<Record<MediaPlaceholderKind, string>> = {
  image: "images",
  video: "videos",
  audio: "audio attachments",
  document: "files",
  sticker: "stickers",
  attachment: "attachments",
};

/** Renders structured media facts for channel surfaces that can carry text only. */
export function formatMediaPlaceholderText(media: readonly MediaPlaceholderTextFact[]): string {
  if (media.length === 0) {
    return "";
  }
  const kinds = media.map(resolveMediaPlaceholderKind);
  const firstKind = kinds[0] ?? "attachment";
  const kind = kinds.every((candidate) => candidate === firstKind)
    ? firstKind
    : kinds.includes("attachment")
      ? "attachment"
      : "document";
  const tag = `<media:${kind}>`;
  return media.length === 1
    ? tag
    : `${tag} (${media.length} ${PLURAL_MEDIA_PLACEHOLDER_LABELS[kind]})`;
}

/**
 * Environment payload fields consumed by prompt/context builders for inbound media attachments.
 */
export type ChannelInboundMediaPayload = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  MediaTranscribedIndexes?: number[];
};

/**
 * Replaces an optimistic media placeholder, or appends to real caption text,
 * when transport media could not be materialized for the agent turn.
 */
export function formatInboundMediaUnavailableText(params: {
  body?: string | null;
  mediaPlaceholder?: string | null;
  notice: string;
}): string {
  const body = params.body?.trim() ?? "";
  const placeholder = params.mediaPlaceholder?.trim() ?? "";
  const notice = params.notice.trim();
  if (!body || (placeholder && body === placeholder)) {
    return notice;
  }
  return `${body}\n\n${notice}`;
}

function alignedStrings(values: Array<string | undefined>): string[] | undefined {
  if (!values.some(Boolean)) {
    return undefined;
  }
  // Preserve indexes across parallel Media* arrays so transcribed indexes and
  // media metadata continue to refer to the same attachment.
  return values.map((value) => value ?? "");
}

function normalizeKind(value: InboundMediaFacts["kind"] | null | undefined) {
  return value ?? undefined;
}

function mediaType(media: InboundMediaFacts): string | undefined {
  return media.contentType ?? media.kind;
}

/**
 * Normalizes plugin-provided attachment facts into the channel turn media shape.
 */
export function toInboundMediaFacts(
  media: readonly ChannelInboundMediaInput[] | null | undefined,
  defaults: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
    transcribed?: (media: ChannelInboundMediaInput, index: number) => boolean;
  } = {},
): InboundMediaFacts[] {
  if (!Array.isArray(media)) {
    return [];
  }
  return media.map((entry, index) => ({
    path: normalizeString(entry.path),
    url: normalizeString(entry.url),
    contentType: normalizeString(entry.contentType),
    kind: normalizeKind(entry.kind) ?? defaults.kind,
    transcribed: entry.transcribed === true || defaults.transcribed?.(entry, index) === true,
    messageId: normalizeString(entry.messageId) ?? defaults.messageId,
  }));
}

/**
 * Projects inbound attachment facts into transcript history without transient turn-only flags.
 */
export function toHistoryMediaEntries(
  media: readonly ChannelInboundMediaInput[] | null | undefined,
  defaults: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
  } = {},
): HistoryMediaEntry[] {
  return toInboundMediaFacts(media, defaults).map((entry) => ({
    path: entry.path,
    url: entry.url,
    contentType: entry.contentType,
    kind: entry.kind,
    messageId: entry.messageId,
  }));
}

/**
 * Builds prompt environment media fields while keeping single-item legacy fields populated.
 */
export function buildChannelInboundMediaPayload(
  media: readonly InboundMediaFacts[] | null | undefined,
): ChannelInboundMediaPayload {
  const entries = Array.isArray(media) ? media : [];
  const transcribedIndexes = entries
    .map((item, index) => (item.transcribed ? index : undefined))
    .filter((index): index is number => index !== undefined);
  return {
    MediaPath: entries[0]?.path,
    MediaUrl: entries[0]?.url ?? entries[0]?.path,
    MediaType: entries[0] ? mediaType(entries[0]) : undefined,
    MediaPaths: alignedStrings(entries.map((item) => item.path)),
    MediaUrls: alignedStrings(entries.map((item) => item.url ?? item.path)),
    MediaTypes: alignedStrings(entries.map(mediaType)),
    MediaTranscribedIndexes: transcribedIndexes.length > 0 ? transcribedIndexes : undefined,
  };
}

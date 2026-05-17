import type { HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { InboundMediaFacts } from "../turn/types.js";

export type ChannelInboundMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: InboundMediaFacts["kind"] | null;
  transcribed?: boolean | null;
  messageId?: string | null;
};

export type ChannelInboundMediaPayload = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  MediaTranscribedIndexes?: number[];
};

function alignedStrings(values: Array<string | undefined>): string[] | undefined {
  if (!values.some(Boolean)) {
    return undefined;
  }
  return values.map((value) => value ?? "");
}

function normalizeString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeKind(value: InboundMediaFacts["kind"] | null | undefined) {
  return value ?? undefined;
}

function mediaType(media: InboundMediaFacts): string | undefined {
  return media.contentType ?? media.kind;
}

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

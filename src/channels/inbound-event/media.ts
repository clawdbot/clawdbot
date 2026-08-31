import { kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
/** Channel inbound media normalization and compatibility projection. */
import type { HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import { resolveLocalMediaPath } from "../../media/local-media-path.js";
import {
  normalizeMediaFacts,
  projectMediaFacts,
  type MediaFactLegacyProjection,
} from "../../media/media-facts.js";
import { probeMediaFilesWithinBudget, type MediaProbeKind } from "../../media/media-probe.js";
import type { InboundMediaFacts } from "../turn/types.js";

const MAX_INBOUND_MEDIA_PROBES = 8;
const INBOUND_MEDIA_PROBE_CONCURRENCY = 2;
const INBOUND_MEDIA_PROBE_BUDGET_MS = 3000;

/** Attachment metadata accepted from channel plugins before core normalization. */
export type ChannelInboundMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  fileName?: string | null;
  kind?: InboundMediaFacts["kind"] | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  transcribed?: boolean | null;
  messageId?: string | null;
};

export type MediaPlaceholderTextFact = Readonly<
  Pick<ChannelInboundMediaInput, "contentType" | "kind" | "path" | "url">
>;

type MediaPlaceholderKind =
  | Exclude<NonNullable<InboundMediaFacts["kind"]>, "unknown">
  | "attachment";

function resolveMediaPlaceholderKind(media: MediaPlaceholderTextFact): MediaPlaceholderKind {
  if (media.kind && media.kind !== "unknown") {
    return media.kind;
  }
  const inferredKind =
    kindFromMime(media.contentType) ??
    kindFromMime(mimeTypeFromFilePath(media.url)) ??
    kindFromMime(mimeTypeFromFilePath(media.path));
  return inferredKind && inferredKind !== "unknown" ? inferredKind : "attachment";
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
 * Legacy environment fields consumed by prompt/context builders.
 * @deprecated Pass ordered `InboundMediaFacts[]` as the context's `media` field.
 */
export type ChannelInboundMediaPayload = {
  [Key in keyof MediaFactLegacyProjection]: MediaFactLegacyProjection[Key];
};

/** Appends an unavailable-media notice to real caption text, or returns the notice alone. */
export function formatInboundMediaUnavailableText(params: {
  body?: string | null;
  notice: string;
}): string {
  const body = params.body?.trim() ?? "";
  const notice = params.notice.trim();
  if (!body) {
    return notice;
  }
  return `${body}\n\n${notice}`;
}

/** Normalizes plugin-provided attachments into ordered runtime facts. */
export function toInboundMediaFacts(
  media: readonly ChannelInboundMediaInput[] | null | undefined,
  defaults: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
    transcribed?: (media: ChannelInboundMediaInput, index: number) => boolean;
  } = {},
): InboundMediaFacts[] {
  return normalizeMediaFacts(media, defaults);
}

function resolveProbeKind(media: InboundMediaFacts): MediaProbeKind | undefined {
  const kind =
    media.kind ?? kindFromMime(media.contentType) ?? kindFromMime(mimeTypeFromFilePath(media.path));
  return kind === "audio" || kind === "video" ? kind : undefined;
}

type InboundMediaProbeCandidate = {
  fact: InboundMediaFacts;
  index: number;
  kind: MediaProbeKind;
  localPath: string;
};

/** Adds best-effort audio/video metadata without probing URL-only media. */
export async function toInboundMediaFactsWithMetadata(
  media: readonly ChannelInboundMediaInput[] | null | undefined,
  defaults: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
    transcribed?: (media: ChannelInboundMediaInput, index: number) => boolean;
  } = {},
): Promise<InboundMediaFacts[]> {
  const facts = toInboundMediaFacts(media, defaults);
  const enriched = [...facts];
  const candidates: InboundMediaProbeCandidate[] = [];
  for (const [index, fact] of facts.entries()) {
    const kind = resolveProbeKind(fact);
    const localPath = fact.path ? resolveLocalMediaPath(fact.path) : undefined;
    if (kind && localPath) {
      candidates.push({ fact, index, kind, localPath });
    }
  }
  const metadata = await probeMediaFilesWithinBudget(
    candidates.map((candidate) => ({ filePath: candidate.localPath, kind: candidate.kind })),
    {
      budgetMs: INBOUND_MEDIA_PROBE_BUDGET_MS,
      concurrency: INBOUND_MEDIA_PROBE_CONCURRENCY,
      maxProbes: MAX_INBOUND_MEDIA_PROBES,
    },
  );
  for (const [candidateIndex, candidate] of candidates.entries()) {
    enriched[candidate.index] = { ...candidate.fact, ...metadata[candidateIndex] };
  }
  return enriched;
}

/** Projects facts into history without transient turn-only fields. */
export function toHistoryMediaEntries(
  media: readonly ChannelInboundMediaInput[] | null | undefined,
  defaults: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
  } = {},
): HistoryMediaEntry[] {
  return toInboundMediaFacts(media, defaults).map((entry) => {
    const historyEntry: HistoryMediaEntry = {
      path: entry.path,
      url: entry.url,
      contentType: entry.contentType,
      kind: entry.kind,
      messageId: entry.messageId,
    };
    if (entry.durationMs) {
      historyEntry.durationMs = entry.durationMs;
    }
    if (entry.width) {
      historyEntry.width = entry.width;
    }
    if (entry.height) {
      historyEntry.height = entry.height;
    }
    return historyEntry;
  });
}

/**
 * Builds the legacy singular/plural environment projection.
 * @deprecated Pass ordered facts as `media`; use `toInboundMediaFacts` to normalize inputs.
 */
export function buildChannelInboundMediaPayload(
  media: readonly InboundMediaFacts[] | null | undefined,
): ChannelInboundMediaPayload {
  return projectMediaFacts(media);
}

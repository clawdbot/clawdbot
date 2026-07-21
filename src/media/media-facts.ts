import type { MediaKind } from "@openclaw/media-core/constants";
import { kindFromMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** One ordered runtime attachment; array position is its alignment identity. */
export type MediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaKind;
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
};

export type MediaFactInput = {
  [Key in keyof MediaFact]?: MediaFact[Key] | null;
};

type MediaFactDefaults<TInput extends MediaFactInput = MediaFactInput> = {
  kind?: MediaKind;
  messageId?: string;
  workspaceDir?: string;
  transcribed?: (media: TInput, index: number) => boolean;
};

export type MediaFactLegacyProjection = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  MediaTranscribedIndexes?: number[];
};

type MediaFactSource = MediaFactLegacyProjection & {
  media?: readonly MediaFactInput[];
  MediaStaged?: boolean | null;
  MediaWorkspaceDir?: string | null;
};

function normalizeMediaFact<TInput extends MediaFactInput>(
  media: TInput,
  index: number,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact {
  const workspaceDir = normalizeOptionalString(media.workspaceDir) ?? defaults.workspaceDir;
  const contentType = normalizeOptionalString(media.contentType);
  return {
    path: normalizeOptionalString(media.path),
    url: normalizeOptionalString(media.url),
    contentType,
    kind: media.kind ?? defaults.kind ?? kindFromMime(contentType),
    transcribed: media.transcribed === true || defaults.transcribed?.(media, index) === true,
    messageId: normalizeOptionalString(media.messageId) ?? defaults.messageId,
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

/** True when a consumer must use the already-staged legacy path projection. */
export function hasStagedMediaProjection(source: MediaFactSource): boolean {
  return source.MediaStaged === true || Boolean(normalizeOptionalString(source.MediaWorkspaceDir));
}

export function normalizeMediaFacts<TInput extends MediaFactInput>(
  media: readonly TInput[] | null | undefined,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact[] {
  return Array.isArray(media)
    ? media.map((entry, index) => normalizeMediaFact(entry, index, defaults))
    : [];
}

// Empty slots exist only to keep legacy parallel-array positions aligned;
// presence/counting sites must ignore them or blank projections ({MediaPaths: [""]})
// route media-less messages into inbound-media handling.
function isMeaningfulMediaFact(fact: MediaFact): boolean {
  return Boolean(
    fact.path?.trim() ||
    fact.url?.trim() ||
    fact.contentType ||
    (fact.kind && fact.kind !== "unknown"),
  );
}

/** Resolves facts and drops alignment-only empty slots for presence/count consumers. */
export function resolveMeaningfulMediaFacts(source: MediaFactSource): MediaFact[] {
  return resolveMediaFacts(source).filter(isMeaningfulMediaFact);
}

/** Normalizes canonical facts or, for compatibility callers, legacy parallel fields. */
export function resolveMediaFacts(source: MediaFactSource): MediaFact[] {
  const canonical = normalizeMediaFacts(source.media);
  const paths = Array.isArray(source.MediaPaths) ? source.MediaPaths : [];
  const urls = Array.isArray(source.MediaUrls) ? source.MediaUrls : [];
  const types = Array.isArray(source.MediaTypes) ? source.MediaTypes : [];
  const count = Math.max(
    canonical.length,
    paths.length,
    urls.length,
    types.length,
    source.MediaPath || source.MediaUrl ? 1 : 0,
  );
  const transcribed = new Set(source.MediaTranscribedIndexes ?? []);
  return Array.from({ length: count }, (_, index) => {
    const fact = canonical[index];
    return normalizeMediaFact(
      {
        path: fact?.path ?? paths[index] ?? (index === 0 ? source.MediaPath : undefined),
        url:
          fact?.url ??
          urls[index] ??
          (paths.length > 0 || index === 0 ? source.MediaUrl : undefined),
        contentType:
          fact?.contentType ??
          normalizeOptionalString(types[index]) ??
          (count === 1 ? source.MediaType : undefined),
        kind: fact?.kind,
        transcribed: fact?.transcribed === true || transcribed.has(index),
        messageId: fact?.messageId,
        workspaceDir: fact?.workspaceDir,
      },
      index,
    );
  });
}

function projectStrings(
  values: Array<string | null | undefined>,
  compact: boolean,
  preserveEmptyLists: boolean,
): string[] | undefined {
  const projected = compact
    ? values.filter((value): value is string => Boolean(value))
    : values.map((value) => value ?? "");
  if (projected.length === 0 || (!preserveEmptyLists && !projected.some(Boolean))) {
    return undefined;
  }
  return projected;
}

export function projectMediaFacts(
  media: readonly MediaFactInput[] | null | undefined,
  mode: "channel" | "compact" | "aligned" = "channel",
): MediaFactLegacyProjection {
  const entries = Array.isArray(media) ? media : [];
  const preserveEmptyLists = mode !== "channel";
  const mediaUrl = (entry: MediaFactInput) =>
    (mode === "channel" ? (entry.url ?? entry.path) : entry.path) ?? undefined;
  const mediaType = (entry: MediaFactInput) =>
    entry.contentType ?? (mode === "channel" ? entry.kind : undefined) ?? undefined;
  const transcribedIndexes = entries.flatMap((entry, index) => (entry.transcribed ? [index] : []));
  return {
    MediaPath: entries[0]?.path ?? undefined,
    MediaUrl: entries[0] ? mediaUrl(entries[0]) : undefined,
    MediaType: entries[0] ? mediaType(entries[0]) : undefined,
    MediaPaths: projectStrings(
      entries.map((entry) => entry.path),
      false,
      preserveEmptyLists,
    ),
    MediaUrls: projectStrings(entries.map(mediaUrl), false, preserveEmptyLists),
    MediaTypes: projectStrings(entries.map(mediaType), mode === "compact", preserveEmptyLists),
    ...(mode !== "channel"
      ? {}
      : {
          MediaTranscribedIndexes: transcribedIndexes.length > 0 ? transcribedIndexes : undefined,
        }),
  };
}

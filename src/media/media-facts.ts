import type { MediaKind } from "@openclaw/media-core/constants";
import { kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PromptImageOrderEntry } from "./prompt-image-order.js";

/** One ordered runtime attachment; array position is its alignment identity. */
export type MediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaKind;
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
  /** Internal proof that this exact fact was covered by a legacy staged projection. */
  staged?: boolean;
  // Declared field, not a symbol: suppression must survive every fact copy or
  // reprojection boundary; described images otherwise rehydrate or count failed.
  // Structured persistence may retain it; legacy Media* projections never emit it.
  hydrationSuppressed?: boolean;
};

export type MediaFactInput = {
  [Key in keyof MediaFact]?: MediaFact[Key] | null;
};

const RUNTIME_PROMPT_MEDIA_FACTS = Symbol.for("openclaw.runtimePromptMediaFacts");

/** Attaches facts to a runtime prompt message without changing serialized/model-visible bytes. */
export function attachRuntimePromptMediaFacts<T extends object>(
  message: T,
  media: readonly MediaFact[],
  imageOrder?: readonly PromptImageOrderEntry[],
): T {
  const normalized = normalizeMediaFacts(media);
  if (imageOrder?.length) {
    Object.defineProperty(normalized, "imageOrder", { value: [...imageOrder] });
  }
  Object.defineProperty(message, RUNTIME_PROMPT_MEDIA_FACTS, {
    configurable: true,
    value: normalized,
  });
  return message;
}

export function readRuntimePromptMediaFacts(message: object): MediaFact[] | undefined {
  const media = (message as Record<PropertyKey, unknown>)[RUNTIME_PROMPT_MEDIA_FACTS];
  return Array.isArray(media) ? (media as MediaFact[]) : undefined;
}

/** Reads the canonical persisted media envelope without consulting legacy top-level fields. */
export function readPersistedMediaFacts(message: object): MediaFact[] | undefined {
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  const media =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).media
      : undefined;
  return Array.isArray(media) ? normalizeMediaFacts(media as MediaFactInput[]) : undefined;
}

export function readRuntimePromptImageOrder(message: object): PromptImageOrderEntry[] | undefined {
  const imageOrder = (
    readRuntimePromptMediaFacts(message) as
      | (MediaFact[] & { imageOrder?: PromptImageOrderEntry[] })
      | undefined
  )?.imageOrder;
  return Array.isArray(imageOrder) ? (imageOrder as PromptImageOrderEntry[]) : undefined;
}

/** Returns whether a fact can produce native image input. */
export function isImageMediaFact(fact: MediaFactInput): boolean {
  if (fact.kind && fact.kind !== "unknown") {
    return fact.kind === "image" || fact.kind === "sticker";
  }
  const contentType = normalizeOptionalString(fact.contentType);
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (
    normalizedContentType &&
    normalizedContentType !== "application/octet-stream" &&
    normalizedContentType !== "binary/octet-stream"
  ) {
    const mimeKind = kindFromMime(normalizedContentType);
    if (mimeKind) {
      return mimeKind === "image";
    }
    // Legacy channel-mode projections persist bare kinds as MediaType; honor
    // them, and fall through to filename inference for other unknown strings.
    if (normalizedContentType === "image" || normalizedContentType === "sticker") {
      return true;
    }
    if (
      normalizedContentType === "audio" ||
      normalizedContentType === "video" ||
      normalizedContentType === "document"
    ) {
      return false;
    }
  }
  const pathValue = normalizeOptionalString(fact.path) ?? normalizeOptionalString(fact.url);
  return kindFromMime(mimeTypeFromFilePath(pathValue)) === "image";
}

type MediaFactDefaults<TInput extends MediaFactInput = MediaFactInput> = {
  kind?: MediaKind;
  messageId?: string;
  workspaceDir?: string;
  transcribed?: (media: TInput, index: number) => boolean;
};

export type MediaFactLegacyProjection = {
  /** @deprecated Use `media[0]?.path`. */
  MediaPath?: string;
  /** @deprecated Use `media[0]?.url`. */
  MediaUrl?: string;
  /** @deprecated Use `media[0]?.contentType` or `.kind`. */
  MediaType?: string;
  /** @deprecated Use `media.map((entry) => entry.path)`. */
  MediaPaths?: string[];
  /** @deprecated Use `media.map((entry) => entry.url)`. */
  MediaUrls?: string[];
  /** @deprecated Use `media.map((entry) => entry.contentType ?? entry.kind)`. */
  MediaTypes?: string[];
  /** @deprecated Use each media fact's `transcribed` field. */
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
  const normalized: MediaFact = {
    path: normalizeOptionalString(media.path),
    url: normalizeOptionalString(media.url),
    contentType,
    kind: media.kind ?? defaults.kind ?? kindFromMime(contentType),
    transcribed: media.transcribed === true || defaults.transcribed?.(media, index) === true,
    messageId: normalizeOptionalString(media.messageId) ?? defaults.messageId,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(media.staged === true ? { staged: true } : {}),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
  return normalized;
}

/** True when media already carries staged workspace paths. */
export function hasStagedMediaProjection(source: MediaFactSource): boolean {
  // MediaWorkspaceDir is a whole-context SDK contract and applies to every
  // fact through the workspace fallback in the positional resolver.
  if (normalizeOptionalString(source.MediaWorkspaceDir)) {
    return true;
  }
  if (source.MediaStaged === true) {
    const legacy = resolveMediaFacts({ ...source, media: undefined });
    if (!legacy.some((fact) => fact.path)) {
      return true;
    }
    const merged = resolveStagedMediaFacts(source);
    if (
      merged.every(
        (fact, index) => !normalizeOptionalString(fact.path) || Boolean(legacy[index]?.path),
      )
    ) {
      return true;
    }
  }
  const stageable = resolveMediaFacts(source).filter((fact) =>
    Boolean(normalizeOptionalString(fact.path)),
  );
  return (
    stageable.length > 0 &&
    stageable.every(
      (fact) => Boolean(normalizeOptionalString(fact.workspaceDir)) || fact.staged === true,
    )
  );
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

function resolveMediaFactsWithPrecedence(
  source: MediaFactSource,
  legacyProjectionWins: boolean,
): MediaFact[] {
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
  const legacyHasPath =
    Boolean(normalizeOptionalString(source.MediaPath)) ||
    paths.some((value) => Boolean(normalizeOptionalString(value)));
  return Array.from({ length: count }, (_, index) => {
    const fact = canonical[index];
    const legacyPath = paths[index] ?? (index === 0 ? source.MediaPath : undefined);
    const legacyUrl =
      urls[index] ?? (paths.length > 0 || index === 0 ? source.MediaUrl : undefined);
    const legacyContentType =
      normalizeOptionalString(types[index]) ?? (index === 0 ? source.MediaType : undefined);
    return normalizeMediaFact(
      {
        path: legacyProjectionWins
          ? (normalizeOptionalString(legacyPath) ?? fact?.path)
          : (fact?.path ?? legacyPath),
        url: legacyProjectionWins
          ? (normalizeOptionalString(legacyUrl) ?? fact?.url)
          : (fact?.url ?? legacyUrl),
        contentType: legacyProjectionWins
          ? (legacyContentType ?? fact?.contentType)
          : (fact?.contentType ?? legacyContentType),
        kind: fact?.kind,
        transcribed: legacyProjectionWins
          ? fact
            ? fact.transcribed === true
            : transcribed.has(index)
          : fact?.transcribed === true || transcribed.has(index),
        messageId: fact?.messageId,
        workspaceDir:
          normalizeOptionalString(fact?.workspaceDir) ??
          normalizeOptionalString(source.MediaWorkspaceDir),
        staged:
          fact?.staged === true ||
          (legacyProjectionWins &&
            source.MediaStaged === true &&
            (!legacyHasPath || Boolean(normalizeOptionalString(legacyPath)))),
        hydrationSuppressed: fact?.hydrationSuppressed,
      },
      index,
    );
  });
}

/** Normalizes canonical facts or, for compatibility callers, legacy parallel fields. */
export function resolveMediaFacts(source: MediaFactSource): MediaFact[] {
  return resolveMediaFactsWithPrecedence(source, false);
}

/** Adopts staged legacy paths positionally while retaining canonical fact metadata and count. */
export function resolveStagedMediaFacts(source: MediaFactSource): MediaFact[] {
  return resolveMediaFactsWithPrecedence(source, true);
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

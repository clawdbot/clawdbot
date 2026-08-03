import type { MediaKind } from "@openclaw/media-core/constants";
import {
  getFileExtension,
  kindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PromptImageOrderEntry } from "./prompt-image-order.js";

/** One ordered runtime attachment; array position is its alignment identity. */
export type MediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaKind;
  fileName?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
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

function normalizeNonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

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
  const media = readPersistedMediaFactInputs(message);
  return media ? normalizeMediaFacts(media) : undefined;
}

function readPersistedMediaFactInputs(message: object): MediaFactInput[] | undefined {
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  const media =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).media
      : undefined;
  return Array.isArray(media) ? (media as MediaFactInput[]) : undefined;
}

const LEGACY_MEDIA_CONTEXT_KEYS = [
  "MediaPath",
  "MediaPaths",
  "MediaUrl",
  "MediaUrls",
  "MediaType",
  "MediaTypes",
  "MediaDir",
  "MediaTranscribedIndexes",
  "MediaStaged",
  "MediaWorkspaceDir",
] as const;
export type LegacyMediaContextKey = (typeof LEGACY_MEDIA_CONTEXT_KEYS)[number];

export const PERSISTED_LEGACY_MEDIA_KEYS = [
  "MediaPath",
  "MediaPaths",
  "MediaUrl",
  "MediaUrls",
  "MediaType",
  "MediaTypes",
  "MediaTranscribedIndexes",
  "MediaStaged",
  "MediaWorkspaceDir",
] as const;

/** Returns whether a top-level retired carrier contains an attachment fact worth migrating. */
export function hasMeaningfulRetiredMediaCarrier(message: object): boolean {
  const record = message as Record<string, unknown>;
  const retired: Record<string, unknown> = {};
  if (Array.isArray(record.media)) {
    retired.media = record.media;
  }
  for (const key of PERSISTED_LEGACY_MEDIA_KEYS) {
    if (Object.hasOwn(record, key)) {
      retired[key] = record[key];
    }
  }
  if (resolveMediaFacts(retired as MediaFactSource).some(isMeaningfulMediaFact)) {
    return true;
  }
  const canonical = normalizeMediaFacts(readPersistedMediaFactInputs(message));
  if (canonical.length === 0) {
    return false;
  }
  const transcribedIndexes = Array.isArray(record.MediaTranscribedIndexes)
    ? record.MediaTranscribedIndexes
    : [];
  return (
    transcribedIndexes.some(
      (index) => Number.isInteger(index) && index >= 0 && index < canonical.length,
    ) ||
    Boolean(normalizeOptionalString(record.MediaWorkspaceDir)) ||
    record.MediaStaged === true
  );
}

const LEGACY_MEDIA_KINDS = new Set<MediaKind>([
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "unknown",
]);

function hasAmbiguousSparseLegacyMediaAlignment(source: MediaFactSource): boolean {
  const paths = Array.isArray(source.MediaPaths) ? source.MediaPaths : [];
  const urls = Array.isArray(source.MediaUrls) ? source.MediaUrls : [];
  const types = Array.isArray(source.MediaTypes) ? source.MediaTypes : [];
  const canonical = normalizeMediaFacts(source.media);
  const slotCount = Math.max(paths.length, urls.length);
  if (types.length === 0 || types.length >= slotCount) {
    return false;
  }
  return Array.from({ length: slotCount }, (_, index) =>
    Boolean(normalizeOptionalString(paths[index]) ?? normalizeOptionalString(urls[index])),
  ).some((meaningful, index) => {
    if (!meaningful) {
      return false;
    }
    const fact = canonical[index];
    const canonicalIdentity =
      normalizeOptionalString(fact?.path) ?? normalizeOptionalString(fact?.url);
    const canonicalClassification = normalizeOptionalString(fact?.contentType) ?? fact?.kind;
    return !canonicalIdentity || !canonicalClassification;
  });
}

function hasUnderCardinalLegacyTypes(source: MediaFactSource): boolean {
  const paths = Array.isArray(source.MediaPaths) ? source.MediaPaths : [];
  const urls = Array.isArray(source.MediaUrls) ? source.MediaUrls : [];
  const types = Array.isArray(source.MediaTypes) ? source.MediaTypes : [];
  const slotCount = Math.max(paths.length, urls.length);
  return types.length > 0 && types.length < slotCount;
}

type CanonicalizedPersistedMediaMessage<T extends object> = {
  changed: boolean;
  hadLegacy: boolean;
  message: T;
};

/** Canonicalizes persisted user-message media; ambiguous sparse legacy arrays are rejected. */
export function canonicalizePersistedUserMessageMedia<T extends object>(
  message: T,
): CanonicalizedPersistedMediaMessage<T> {
  const record = message as Record<string, unknown>;
  const hadLegacy = PERSISTED_LEGACY_MEDIA_KEYS.some((key) => Object.hasOwn(record, key));
  const hadTopLevelMedia = Object.hasOwn(record, "media");
  const canonical = readPersistedMediaFactInputs(message);
  if (!hadLegacy && !hadTopLevelMedia && canonical === undefined) {
    return { changed: false, hadLegacy: false, message };
  }

  const topLevelMedia = Array.isArray(record.media)
    ? (record.media as readonly MediaFactInput[])
    : undefined;
  const source: MediaFactSource = { ...record, media: canonical ?? topLevelMedia };
  const hasAmbiguousLegacyAlignment = hasAmbiguousSparseLegacyMediaAlignment(source);
  if (hadLegacy && hasAmbiguousLegacyAlignment) {
    throw new Error("legacy media arrays have ambiguous sparse positional alignment");
  }
  const resolvedSource =
    hasUnderCardinalLegacyTypes(source) && !hasAmbiguousLegacyAlignment
      ? { ...source, MediaType: undefined, MediaTypes: [] }
      : source;
  const resolvedMedia = resolveMediaFacts(resolvedSource);
  const stagedMedia =
    resolvedSource.MediaStaged === true ? resolveStagedMediaFacts(resolvedSource) : undefined;
  const legacyTypes = Array.isArray(resolvedSource.MediaTypes) ? resolvedSource.MediaTypes : [];
  const canonicalInputs = Array.isArray(resolvedSource.media) ? resolvedSource.media : [];
  const media: MediaFact[] = [];
  for (const [index, fact] of resolvedMedia.entries()) {
    const legacyType = normalizeOptionalString(
      legacyTypes[index] ?? (index === 0 ? resolvedSource.MediaType : undefined),
    );
    const existing = canonicalInputs[index];
    const bareLegacyKind =
      legacyType &&
      LEGACY_MEDIA_KINDS.has(legacyType as MediaKind) &&
      !normalizeOptionalString(existing?.contentType) &&
      existing?.kind === undefined;
    const explicitKind = existing?.kind ?? (bareLegacyKind ? (legacyType as MediaKind) : undefined);
    media.push({
      ...(fact.path ? { path: fact.path } : {}),
      ...(fact.url ? { url: fact.url } : {}),
      ...(fact.contentType && !bareLegacyKind ? { contentType: fact.contentType } : {}),
      ...(explicitKind ? { kind: explicitKind } : {}),
      ...(fact.fileName ? { fileName: fact.fileName } : {}),
      ...(fact.sizeBytes !== undefined ? { sizeBytes: fact.sizeBytes } : {}),
      ...(fact.durationMs ? { durationMs: fact.durationMs } : {}),
      ...(fact.width ? { width: fact.width } : {}),
      ...(fact.height ? { height: fact.height } : {}),
      ...(fact.transcribed ? { transcribed: true } : {}),
      ...(fact.messageId ? { messageId: fact.messageId } : {}),
      ...(fact.workspaceDir ? { workspaceDir: fact.workspaceDir } : {}),
      ...(fact.staged || stagedMedia?.[index]?.staged ? { staged: true } : {}),
      ...(fact.hydrationSuppressed ? { hydrationSuppressed: true } : {}),
    });
  }

  const next: Record<string, unknown> = { ...record };
  delete next.media;
  for (const key of PERSISTED_LEGACY_MEDIA_KEYS) {
    delete next[key];
  }
  const metadata = record["__openclaw"];
  const openclaw =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (media.length > 0 || canonical !== undefined || topLevelMedia !== undefined) {
    openclaw.media = media;
  }
  if (Object.keys(openclaw).length > 0) {
    next["__openclaw"] = openclaw;
  } else {
    delete next["__openclaw"];
  }
  return {
    changed: JSON.stringify(next) !== JSON.stringify(record),
    hadLegacy,
    message: next as T,
  };
}

export function stripLegacyMediaContextFields(ctx: Record<string, unknown>): void {
  for (const key of LEGACY_MEDIA_CONTEXT_KEYS) {
    delete ctx[key];
  }
}

export function readRuntimePromptImageOrder(message: object): PromptImageOrderEntry[] | undefined {
  const imageOrder = (
    readRuntimePromptMediaFacts(message) as
      | (MediaFact[] & { imageOrder?: PromptImageOrderEntry[] })
      | undefined
  )?.imageOrder;
  return Array.isArray(imageOrder) ? (imageOrder as PromptImageOrderEntry[]) : undefined;
}

/** Returns whether a declared MIME only describes otherwise unclassified binary bytes. */
export function isGenericBinaryMediaContentType(contentType?: string | null): boolean {
  const normalizedContentType = normalizeMimeType(contentType);
  return (
    normalizedContentType === "application/octet-stream" ||
    normalizedContentType === "binary/octet-stream"
  );
}

/** Returns whether a fact can produce native image input. */
export function isImageMediaFact(fact: MediaFactInput): boolean {
  if (fact.kind && fact.kind !== "unknown") {
    return fact.kind === "image" || fact.kind === "sticker";
  }
  const normalizedContentType = normalizeMimeType(fact.contentType);
  if (normalizedContentType && !isGenericBinaryMediaContentType(normalizedContentType)) {
    const mimeKind = kindFromMime(normalizedContentType);
    if (mimeKind) {
      return mimeKind === "image";
    }
    // Legacy channel-mode projections persist bare image or sticker kind as MediaType.
    return normalizedContentType === "image" || normalizedContentType === "sticker";
  }
  const pathValue = normalizeOptionalString(fact.path) ?? normalizeOptionalString(fact.url);
  const inferredMime = mimeTypeFromFilePath(pathValue);
  if (inferredMime === "image/svg+xml") {
    return false;
  }
  if (kindFromMime(inferredMime) === "image") {
    return true;
  }
  const extension = getFileExtension(pathValue);
  return extension === ".tif" || extension === ".tiff";
}

type MediaFactDefaults<TInput extends MediaFactInput = MediaFactInput> = {
  kind?: MediaKind;
  messageId?: string;
  workspaceDir?: string;
  transcribed?: (media: TInput, index: number) => boolean;
};

function normalizePositiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

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
  const durationMs = normalizePositiveInteger(media.durationMs);
  const width = normalizePositiveInteger(media.width);
  const height = normalizePositiveInteger(media.height);
  const normalized: MediaFact = {
    path: normalizeOptionalString(media.path),
    url: normalizeOptionalString(media.url),
    contentType,
    kind:
      media.kind ??
      defaults.kind ??
      (isGenericBinaryMediaContentType(contentType) ? undefined : kindFromMime(contentType)),
    fileName: normalizeOptionalString(media.fileName),
    sizeBytes: normalizeNonNegativeNumber(media.sizeBytes),
    ...(durationMs ? { durationMs } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    transcribed: media.transcribed === true || defaults.transcribed?.(media, index) === true,
    messageId: normalizeOptionalString(media.messageId) ?? defaults.messageId,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(media.staged === true ? { staged: true } : {}),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
  return normalized;
}

/** True when every path-bearing canonical fact has explicit staging proof. */
export function hasStagedMediaFacts(media: readonly MediaFactInput[] | null | undefined): boolean {
  const stageable = normalizeMediaFacts(media).filter((fact) =>
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
export function isMeaningfulMediaFact(fact: MediaFact): boolean {
  return Boolean(
    fact.path?.trim() ||
    fact.url?.trim() ||
    fact.contentType ||
    (fact.kind && fact.kind !== "unknown"),
  );
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
    source.MediaPath || source.MediaUrl || source.MediaType ? 1 : 0,
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
        fileName: fact?.fileName,
        sizeBytes: fact?.sizeBytes,
        durationMs: fact?.durationMs,
        width: fact?.width,
        height: fact?.height,
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
  mode: "channel" | "compact" = "channel",
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

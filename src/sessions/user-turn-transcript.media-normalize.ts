import path from "node:path";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import type { MediaFactInput } from "../media/media-facts.js";
import type { PersistedUserTurnMediaInput } from "./user-turn-transcript.types.js";

const URL_LIKE_MEDIA_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const STRUCTURED_MEDIA_KINDS = new Set<NonNullable<MediaFactInput["kind"]>>([
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "unknown",
]);
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu;

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeNonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeStructuredMediaKind(value: string | null | undefined): MediaFactInput["kind"] {
  const kind = normalizeOptionalText(value);
  return kind && STRUCTURED_MEDIA_KINDS.has(kind as NonNullable<MediaFactInput["kind"]>)
    ? (kind as NonNullable<MediaFactInput["kind"]>)
    : undefined;
}

function normalizePositiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function resolveTranscriptMediaPath(
  pathValue: string,
  workspaceDir: string | undefined,
): string {
  // Relative staged media paths are anchored to the media workspace; absolute
  // paths and URL-like refs are already stable transcript references.
  if (!workspaceDir || path.isAbsolute(pathValue) || URL_LIKE_MEDIA_PATH_PATTERN.test(pathValue)) {
    return pathValue;
  }
  return path.join(workspaceDir, pathValue);
}

export function normalizeStructuredMediaEntryForTranscript(
  media: PersistedUserTurnMediaInput,
): MediaFactInput {
  const mediaPath = normalizeOptionalText(media.path);
  const mediaUrl = normalizeOptionalText(media.url);
  const kind = normalizeStructuredMediaKind(media.kind);
  const legacyKind = normalizeOptionalText(media.kind);
  const messageId = normalizeOptionalText(media.messageId);
  const workspaceDir = normalizeOptionalText(media.workspaceDir);
  const contentType =
    normalizeOptionalText(media.contentType) ??
    (kind || !legacyKind || !MIME_TYPE_PATTERN.test(legacyKind) ? undefined : legacyKind) ??
    mimeTypeFromFilePath(mediaPath ?? mediaUrl);
  const durationMs = normalizePositiveInteger(media.durationMs);
  const width = normalizePositiveInteger(media.width);
  const height = normalizePositiveInteger(media.height);
  const fileName = normalizeOptionalText(media.fileName);
  const sizeBytes = normalizeNonNegativeNumber(media.sizeBytes);
  return {
    ...(mediaPath ? { path: mediaPath } : {}),
    ...(mediaUrl ? { url: mediaUrl } : {}),
    ...(contentType ? { contentType } : {}),
    ...(kind ? { kind } : {}),
    ...(fileName ? { fileName } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(media.transcribed === true ? { transcribed: true } : {}),
    ...(messageId ? { messageId } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
}

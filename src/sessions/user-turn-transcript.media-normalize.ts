import path from "node:path";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import {
  asFiniteNumberInRange,
  asPositiveSafeInteger,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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

function normalizeStructuredMediaKind(value: string | null | undefined): MediaFactInput["kind"] {
  const kind = normalizeOptionalString(value);
  return kind && STRUCTURED_MEDIA_KINDS.has(kind as NonNullable<MediaFactInput["kind"]>)
    ? (kind as NonNullable<MediaFactInput["kind"]>)
    : undefined;
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
  const workspaceDir = normalizeOptionalString(media.workspaceDir);
  const mediaPath = normalizeOptionalString(media.path);
  const mediaUrl = normalizeOptionalString(media.url);
  const kind = normalizeStructuredMediaKind(media.kind);
  const legacyKind = normalizeOptionalString(media.kind);
  const messageId = normalizeOptionalString(media.messageId);
  const contentType =
    normalizeOptionalString(media.contentType) ??
    (kind || !legacyKind || !MIME_TYPE_PATTERN.test(legacyKind) ? undefined : legacyKind) ??
    mimeTypeFromFilePath(mediaPath ?? mediaUrl);
  const durationMs = asPositiveSafeInteger(media.durationMs);
  const width = asPositiveSafeInteger(media.width);
  const height = asPositiveSafeInteger(media.height);
  const fileName = normalizeOptionalString(media.fileName);
  const sizeBytes = asFiniteNumberInRange(media.sizeBytes, { min: 0 });
  return {
    ...(mediaPath ? { path: resolveTranscriptMediaPath(mediaPath, workspaceDir) } : {}),
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

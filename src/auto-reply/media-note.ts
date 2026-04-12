import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { MsgContext } from "./templating.js";

function sanitizeInlineMediaNoteValue(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[\p{Cc}\]]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMediaAttachedLine(params: {
  path: string;
  url?: string;
  type?: string;
  index?: number;
  total?: number;
}): string {
  const prefix =
    typeof params.index === "number" && typeof params.total === "number"
      ? `[media attached ${params.index}/${params.total}: `
      : "[media attached: ";
  const path = sanitizeInlineMediaNoteValue(params.path);
  const typeRaw = sanitizeInlineMediaNoteValue(params.type);
  const typePart = typeRaw ? ` (${typeRaw})` : "";
  const urlRaw = sanitizeInlineMediaNoteValue(params.url);
  const urlPart = urlRaw ? ` | ${urlRaw}` : "";
  return `${prefix}${path}${typePart}${urlPart}]`;
}

// Common audio file extensions for transcription detection
const AUDIO_EXTENSIONS = new Set([
  ".ogg",
  ".opus",
  ".mp3",
  ".m4a",
  ".wav",
  ".webm",
  ".flac",
  ".aac",
  ".wma",
  ".aiff",
  ".alac",
  ".oga",
]);

function isAudioPath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(path);
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

function isValidAttachmentIndex(index: number, attachmentCount: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < attachmentCount;
}

function collectTranscribedAudioAttachmentIndices(
  ctx: MsgContext,
  attachmentCount: number,
): Set<number> {
  // Only audio transcription should suppress the raw attachment in prompt notes.
  // Image/video descriptions are lossy derived context, so the original attachment
  // must stay available to multimodal models and downstream tools.
  const transcribedAudioIndices = new Set<number>();
  if (Array.isArray(ctx.MediaUnderstanding)) {
    for (const output of ctx.MediaUnderstanding) {
      if (
        output.kind === "audio.transcription" &&
        isValidAttachmentIndex(output.attachmentIndex, attachmentCount)
      ) {
        transcribedAudioIndices.add(output.attachmentIndex);
      }
    }
  }
  if (Array.isArray(ctx.MediaUnderstandingDecisions)) {
    for (const decision of ctx.MediaUnderstandingDecisions) {
      if (decision.capability !== "audio" || decision.outcome !== "success") {
        continue;
      }
      for (const attachment of decision.attachments) {
        if (
          attachment.chosen?.outcome === "success" &&
          isValidAttachmentIndex(attachment.attachmentIndex, attachmentCount)
        ) {
          transcribedAudioIndices.add(attachment.attachmentIndex);
        }
      }
    }
  }
  return transcribedAudioIndices;
}

export function buildInboundMediaNote(ctx: MsgContext): string | undefined {
  // Attachment indices follow MediaPaths/MediaUrls ordering as supplied by the channel.
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) {
    return undefined;
  }

  const transcribedAudioIndices = collectTranscribedAudioAttachmentIndices(ctx, paths.length);

  const urls =
    Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length === paths.length
      ? ctx.MediaUrls
      : undefined;
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  const hasTranscript = Boolean(ctx.Transcript?.trim());
  // Transcript alone does not identify an attachment index; only use it as a fallback
  // when there is a single attachment to avoid stripping unrelated audio files.
  const canStripSingleAttachmentByTranscript = hasTranscript && paths.length === 1;

  const entries = paths
    .map((entry, index) => ({
      path: entry ?? "",
      type: types?.[index] ?? ctx.MediaType,
      url: urls?.[index] ?? ctx.MediaUrl,
      index,
    }))
    .filter((entry) => {
      // Strip audio attachments when transcription succeeded - the transcript is already
      // available in the context, raw audio binary would only waste tokens (issue #4197)
      // Note: Only trust MIME type from per-entry types array, not fallback ctx.MediaType
      // which could misclassify non-audio attachments (greptile review feedback)
      const hasPerEntryType = types !== undefined;
      const isAudioByMime =
        hasPerEntryType && normalizeLowercaseStringOrEmpty(entry.type).startsWith("audio/");
      const isAudioEntry = isAudioPath(entry.path) || isAudioByMime;
      if (!isAudioEntry) {
        return true;
      }
      if (
        transcribedAudioIndices.has(entry.index) ||
        (canStripSingleAttachmentByTranscript && entry.index === 0)
      ) {
        return false;
      }
      return true;
    });
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return formatMediaAttachedLine({
      path: entries[0]?.path ?? "",
      type: entries[0]?.type,
      url: entries[0]?.url,
    });
  }

  const count = entries.length;
  const lines: string[] = [`[media attached: ${count} files]`];
  for (const [idx, entry] of entries.entries()) {
    lines.push(
      formatMediaAttachedLine({
        path: entry.path,
        index: idx + 1,
        total: count,
        type: entry.type,
        url: entry.url,
      }),
    );
  }
  return lines.join("\n");
}

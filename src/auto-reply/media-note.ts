/** Builds compact prompt notes for inbound media attachments. */
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveMediaFacts, type MediaFact } from "../media/media-facts.js";
import { getMediaDir } from "../media/store.js";
import type { RuntimeMsgContext as MsgContext } from "./templating.js";

function stripDarwinPrivatePrefix(value: string): string {
  return value.startsWith("/private/var/") ? value.slice("/private".length) : value;
}

function normalizeManagedInboundMediaRef(value: string): string {
  if (!path.isAbsolute(value)) {
    return value;
  }
  const mediaDir = stripDarwinPrivatePrefix(path.resolve(getMediaDir()));
  const candidate = stripDarwinPrivatePrefix(path.resolve(value));
  const inboundDir = path.join(mediaDir, "inbound");
  const relativeToInbound = path.relative(inboundDir, candidate);
  // Managed inbound media gets a stable URI so prompts do not leak host-specific temp paths.
  if (
    !relativeToInbound ||
    relativeToInbound.startsWith("..") ||
    path.isAbsolute(relativeToInbound)
  ) {
    return value;
  }
  return `media://inbound/${path.basename(candidate)}`;
}

function sanitizeInlineMediaNoteValue(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return normalizeManagedInboundMediaRef(trimmed)
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
  const pathValue = sanitizeInlineMediaNoteValue(params.path);
  const typeRaw = sanitizeInlineMediaNoteValue(params.type);
  const typePart = typeRaw ? ` (${typeRaw})` : "";
  const urlRaw = sanitizeInlineMediaNoteValue(params.url);
  // When the channel mirrors the local path into the fact URL (Telegram album
  // media is the canonical case), rendering ` | ${url}` adds no information
  // and clutters the prompt with `path | path` duplication (issue #47587).
  const urlPart = urlRaw && urlRaw !== pathValue ? ` | ${urlRaw}` : "";
  return `${prefix}${pathValue}${typePart}${urlPart}]`;
}

// Common audio file extensions for transcription detection
const AUDIO_EXTENSIONS = new Set([
  ".ogg",
  ".opus",
  ".mp3",
  ".m4a",
  ".m2a",
  ".wav",
  ".webm",
  ".flac",
  ".aac",
  ".wma",
  ".aiff",
  ".alac",
  ".oga",
]);

function isAudioPath(pathLocal: string | undefined): boolean {
  if (!pathLocal) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(pathLocal);
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

function collectDescribedImageAttachmentIndices(ctx: MsgContext): Set<number> {
  return new Set(
    ctx.MediaUnderstanding?.flatMap((output) =>
      output.kind === "image.description" ? [output.attachmentIndex] : [],
    ) ?? [],
  );
}

type InboundMediaNoteProjection = {
  text?: string;
  media: MediaFact[];
};

/** Formats prompt-visible attachment text and retains facts that still need native hydration. */
export function buildInboundMediaNoteProjection(ctx: MsgContext): InboundMediaNoteProjection {
  const facts = resolveMediaFacts(ctx);
  const entries = facts.flatMap((fact, index) => {
    const mediaPath = fact.path?.trim() ?? "";
    return mediaPath || fact.url?.trim()
      ? [
          {
            fact,
            path: mediaPath,
            type: fact.contentType ?? fact.kind,
            url: fact.url,
            index,
          },
        ]
      : [];
  });
  if (entries.length === 0) {
    return { media: [] };
  }

  const transcribedAudioIndices = collectTranscribedAudioAttachmentIndices(ctx, facts.length);
  const hasTranscript = Boolean(ctx.Transcript?.trim());
  // Transcript alone does not identify an attachment index; only use it as a fallback
  // when there is a single attachment to avoid stripping unrelated audio files.
  const canStripSingleAttachmentByTranscript = hasTranscript && facts.length === 1;

  const visibleEntries = entries.filter((entry) => {
    // Strip audio attachments when transcription succeeded - the transcript is already
    // available in the context, raw audio binary would only waste tokens (issue #4197)
    const normalizedType = normalizeLowercaseStringOrEmpty(entry.type);
    const isAudioByMime = normalizedType === "audio" || normalizedType.startsWith("audio/");
    const isAudioEntry = entry.fact.kind === "audio" || isAudioPath(entry.path) || isAudioByMime;
    if (!isAudioEntry) {
      return true;
    }
    if (
      entry.fact.transcribed === true ||
      transcribedAudioIndices.has(entry.index) ||
      (canStripSingleAttachmentByTranscript && entry.index === 0)
    ) {
      return false;
    }
    return true;
  });
  if (visibleEntries.length === 0) {
    return { media: [] };
  }
  const describedImageIndices = collectDescribedImageAttachmentIndices(ctx);
  const media = visibleEntries.map((entry) => ({
    ...entry.fact,
    ...(describedImageIndices.has(entry.index) ? { hydrationSuppressed: true } : {}),
  }));
  if (visibleEntries.length === 1) {
    return {
      text: formatMediaAttachedLine({
        path: visibleEntries[0]?.path ?? "",
        type: visibleEntries[0]?.type,
        url: visibleEntries[0]?.url,
      }),
      media,
    };
  }

  const count = visibleEntries.length;
  const lines: string[] = [`[media attached: ${count} files]`];
  for (const [idx, entry] of visibleEntries.entries()) {
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
  return { text: lines.join("\n"), media };
}

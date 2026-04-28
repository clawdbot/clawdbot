/**
 * Single source of truth for rendering attachment summaries as
 * human-readable tags that the LLM sees.
 *
 * There is exactly ONE vocabulary shared by every consumer:
 *
 *   • Type labels: `image` / `voice` / `video` / `file` / `attachment`
 *   • Keyword for voice text: `transcript:` (never `content:`)
 *   • With source: `MEDIA:{source}` (no bracketed alias)
 *   • Without source: `[{type}]` or `[{type}: {filename}]`
 *
 * Both consumers (group history / current inbound turn, and the ref-index
 * quoted-message block) call the same function with the same vocabulary.
 * They differ only on two orthogonal dimensions:
 *
 *   1. `transcriptSource` — ref mode appends `[source: local STT]` (or
 *      similar) after a voice transcript so the model knows where the
 *      text came from. Inline mode omits this (the current turn knows
 *      its own STT provenance).
 *
 *   2. Separator — inline joins with `\n` (history replay is multi-line),
 *      ref joins with a space (quoted block is rendered inline).
 *
 * These are the ONLY permitted differences between modes. Any new
 * decoration must be added in both modes or behind an explicit option
 * documented here, otherwise the model ends up learning two dialects.
 *
 * Zero external dependencies — pure string formatting.
 */

import type { RefAttachmentSummary } from "../ref/types.js";

// ============ Types ============

/** Canonical attachment shape shared by history entries and ref entries. */
export type AttachmentSummary = RefAttachmentSummary;

/**
 * Rendering mode.
 *
 * - `"inline"`: current turn + history replay. No transcript-source tag.
 *   Tags are separated by newlines.
 * - `"ref"`: quoted-message block. Appends `[source: …]` to voice
 *   transcripts when `transcriptSource` is present. Tags are separated
 *   by spaces so the block fits on one line.
 */
export type RenderMode = "inline" | "ref";

/** Human-readable labels for transcript provenance (prompt contract). */
export const TRANSCRIPT_SOURCE_LABELS: Record<
  NonNullable<RefAttachmentSummary["transcriptSource"]>,
  string
> = {
  stt: "local STT",
  asr: "platform ASR",
  tts: "TTS source",
  fallback: "fallback text",
};

/** Options controlling how the tag list is rendered. */
export interface RenderOptions {
  mode: RenderMode;
  /** Separator between tags. Defaults per mode: inline=`\n`, ref=` `. */
  separator?: string;
  /** Returned when `attachments` is empty/undefined. Defaults to `""`. */
  emptyFallback?: string;
}

// ============ Public API ============

/**
 * Render a list of attachments into an LLM-facing tag string.
 *
 * Shared grammar (both modes):
 *
 * ```
 * attachment_with_source  := "MEDIA:" SOURCE [voice_suffix]
 * voice_suffix            := ' (transcript: "' TEXT '")' [source_suffix]
 * attachment_no_source    := "[" TYPE_LABEL [": " FILENAME] [voice_suffix_bare] "]" [source_suffix_bare]
 * voice_suffix_bare       := ' (transcript: "' TEXT '")'
 * source_suffix           := " [source: " LABEL "]"   ← ref mode only
 * source_suffix_bare      := " [source: " LABEL "]"   ← ref mode only
 * TYPE_LABEL              := "image" | "voice" | "video" | "file" | "attachment"
 * ```
 *
 * The **only** mode-dependent decoration is the `source_suffix` (present
 * in `ref`, absent in `inline`). Every other token is identical.
 */
export function renderAttachmentTags(
  attachments: readonly AttachmentSummary[] | undefined,
  options: RenderOptions,
): string {
  if (!attachments?.length) {
    return options.emptyFallback ?? "";
  }

  const parts: string[] = [];
  for (const att of attachments) {
    parts.push(renderOne(att, options.mode));
  }

  const separator = options.separator ?? (options.mode === "ref" ? " " : "\n");
  return parts.join(separator);
}

/**
 * Shorthand for `renderAttachmentTags(attachments, { mode: "inline" })`.
 *
 * Kept as the primary entry point for group history / current-turn
 * rendering where the terse inline form is always wanted.
 */
export function formatAttachmentTags(attachments?: readonly AttachmentSummary[]): string {
  return renderAttachmentTags(attachments, { mode: "inline" });
}

// ============ Internal ============

/**
 * Render a single attachment.
 *
 * The function is split into two orthogonal concerns:
 *   - `renderBody`: the shared "MEDIA:{source}…" or "[type…]" string.
 *   - `renderSourceSuffix`: ref-mode-only `" [source: …]"` tail.
 *
 * Both consumers produce the same body; only the suffix differs.
 */
function renderOne(att: AttachmentSummary, mode: RenderMode): string {
  const body = renderBody(att);
  const suffix = mode === "ref" ? renderSourceSuffix(att) : "";
  return body + suffix;
}

/** Shared, mode-agnostic body of the tag. */
function renderBody(att: AttachmentSummary): string {
  const source = att.localPath || att.url;
  const voiceSuffix =
    att.type === "voice" && att.transcript ? ` (transcript: "${att.transcript}")` : "";

  if (source) {
    return `MEDIA:${source}${voiceSuffix}`;
  }

  const label = labelForType(att.type);
  const namePart = att.filename ? `: ${att.filename}` : "";
  return `[${label}${namePart}${voiceSuffix}]`;
}

/**
 * Ref-mode-only tail that records where a voice transcript came from.
 * Empty string when the attachment isn't a transcribed voice message.
 */
function renderSourceSuffix(att: AttachmentSummary): string {
  if (att.type !== "voice" || !att.transcript || !att.transcriptSource) {
    return "";
  }
  const label = TRANSCRIPT_SOURCE_LABELS[att.transcriptSource] ?? att.transcriptSource;
  return ` [source: ${label}]`;
}

/** Canonical single-word label for each attachment type. */
function labelForType(type: AttachmentSummary["type"]): string {
  switch (type) {
    case "image":
      return "image";
    case "voice":
      return "voice";
    case "video":
      return "video";
    case "file":
      return "file";
    default:
      return "attachment";
  }
}

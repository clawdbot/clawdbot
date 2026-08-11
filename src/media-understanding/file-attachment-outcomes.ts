import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { DocumentExtractedImage } from "../plugins/document-extractor-types.js";
import { wrapExternalContent } from "../security/external-content.js";

// Reject inputs with trailing junk after the type/subtype to defend against
// callers that compare the original string elsewhere; permit the standard
// `;param=value` parameter tail (RFC 9110 §8.3) and discard it.
const MIME_TYPE = String.raw`([a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+)`;
const HTTP_TOKEN = String.raw`[a-z0-9!#$%&'*+.^_\x60|~-]+`;
const HTTP_QUOTED_STRING = String.raw`"(?:[\t !#-\[\]-~]|\\[\t -~])*"`;
const MIME_PARAMETER = String.raw`[ \t]*;[ \t]*${HTTP_TOKEN}=(?:${HTTP_TOKEN}|${HTTP_QUOTED_STRING})`;
const MIME_TYPE_WITH_OPTIONAL_PARAMS = new RegExp(
  String.raw`^${MIME_TYPE}(?:${MIME_PARAMETER})*$`,
  "i",
);
// Longest real-world registered types (OOXML) are ~73 chars; anything past
// this bound is hostile or junk metadata, not a MIME the model should see.
const MARKER_MIME_MAX_CHARS = 100;

export function sanitizeMimeType(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(MIME_TYPE_WITH_OPTIONAL_PARAMS);
  return match?.[1]?.toLowerCase();
}

// Last line of defense for marker copy: only a strict, bounded MIME token may
// be interpolated into model-visible text; anything else drops the clause.
function markerSafeMime(value?: string): string | undefined {
  const mime = sanitizeMimeType(value);
  return mime && mime.length <= MARKER_MIME_MAX_CHARS ? mime : undefined;
}

// Every document attachment yields a visible outcome or a typed intentional non-outcome.
// New gates require a union variant so the renderer must handle them.
export type FileAttachmentOutcome =
  | { kind: "extracted"; text: string; images: DocumentExtractedImage[] }
  | { kind: "rendered-to-images"; images: DocumentExtractedImage[] }
  | { kind: "no-extractable-text" }
  | { kind: "unsupported-format"; mime?: string }
  // Operator-pinned allowlist rejection: policy, not capability — the marker
  // must not claim PDF/text support the active configuration disables.
  | { kind: "policy-rejected"; mime?: string }
  | { kind: "read-failure" }
  | { kind: "url-sources-disabled" }
  // Routed to the image/audio/video stages, which own the outcome from there.
  // Delivery is not verified here; delivery-derived claims are a tracked follow-up.
  | { kind: "claimed-elsewhere" };

function wrapUntrustedAttachmentContent(content: string): string {
  return wrapExternalContent(content, { source: "unknown", includeWarning: false });
}

// Cap cumulative skip markers so a burst of rejected attachments cannot grow
// model-visible context without bound; overflow collapses into one summary line.
export const MAX_SKIPPED_FILE_MARKERS = 5;

const SKIPPED_FILE_OUTCOME_KINDS = new Set<FileAttachmentOutcome["kind"]>([
  "unsupported-format",
  "policy-rejected",
  "read-failure",
  "url-sources-disabled",
]);

export function isSkippedFileOutcome(outcome: FileAttachmentOutcome): boolean {
  return SKIPPED_FILE_OUTCOME_KINDS.has(outcome.kind);
}

// Reason-neutral on purpose: overflow can mix unsupported, policy-rejected,
// unreadable, and url-disabled kinds; naming one reason would misdirect recovery.
export function renderSkippedFileOverflowSummary(count: number): string {
  return `[${count} more attachment${count === 1 ? "" : "s"} skipped]`;
}

export function renderFileAttachmentOutcome(outcome: FileAttachmentOutcome): string | null {
  switch (outcome.kind) {
    case "extracted":
      return wrapUntrustedAttachmentContent(outcome.text);
    case "rendered-to-images":
      return "[PDF content rendered to images]";
    case "no-extractable-text":
      return "[No extractable text]";
    case "unsupported-format": {
      const mime = markerSafeMime(outcome.mime);
      return mime
        ? `[Unsupported document format: ${mime}. PDF and plain-text attachments can be read.]`
        : "[Unsupported document format. PDF and plain-text attachments can be read.]";
    }
    case "policy-rejected": {
      const mime = markerSafeMime(outcome.mime);
      return mime ? `[Attachment type not allowed: ${mime}]` : "[Attachment type not allowed]";
    }
    case "read-failure":
      return "[Attachment could not be read]";
    case "url-sources-disabled":
      return "[Attachment skipped: URL file sources are disabled]";
    case "claimed-elsewhere":
      return null;
    default:
      return outcome satisfies never;
  }
}

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
  // localPath is set only after a root-approved cache read. The reply runtime
  // separately decides whether its final tool surface can reveal that path.
  | { kind: "unsupported-format"; mime?: string; localPath?: string }
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

// Absolute host paths from the managed media store only; bounded to a positive
// alphabet that cannot carry prompt markup or executable shell syntax. Letters
// and digits of any script pass so ordinary non-Latin filenames keep working.
const MARKER_LOCAL_PATH_MAX_CHARS = 300;
const POSIX_ABSOLUTE_PATH = /^\//;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\\/;
const MARKER_PATH_SAFE = /^[\p{L}\p{M}\p{N} /\\:._-]+$/u;

function markerSafeLocalPath(value?: string, allowWorkspaceRelative = false): string | undefined {
  if (!value || value.length > MARKER_LOCAL_PATH_MAX_CHARS) {
    return undefined;
  }
  const isAbsolute = POSIX_ABSOLUTE_PATH.test(value) || WINDOWS_ABSOLUTE_PATH.test(value);
  if (
    !isAbsolute &&
    (!allowWorkspaceRelative ||
      value.includes("\\") ||
      value.split("/").some((segment) => !segment || segment === "." || segment === ".."))
  ) {
    return undefined;
  }
  return MARKER_PATH_SAFE.test(value) ? value : undefined;
}

const SKIPPED_FILE_OUTCOME_KINDS = new Set<FileAttachmentOutcome["kind"]>([
  "unsupported-format",
  "policy-rejected",
  "read-failure",
  "url-sources-disabled",
]);

export function isSkippedFileOutcome(outcome: FileAttachmentOutcome): boolean {
  return SKIPPED_FILE_OUTCOME_KINDS.has(outcome.kind);
}

export function renderFileAttachmentOutcome(
  outcome: FileAttachmentOutcome,
  options?: { selfServeLocalPath?: string | false },
): string | null {
  switch (outcome.kind) {
    case "extracted":
      return wrapUntrustedAttachmentContent(outcome.text);
    case "rendered-to-images":
      return "[PDF content rendered to images]";
    case "no-extractable-text":
      return "[No extractable text]";
    case "unsupported-format": {
      const mime = markerSafeMime(outcome.mime);
      const formatClause = mime
        ? `Unsupported document format: ${mime}.`
        : "Unsupported document format.";
      const localPath = markerSafeLocalPath(
        options?.selfServeLocalPath === false
          ? undefined
          : (options?.selfServeLocalPath ?? outcome.localPath),
        typeof options?.selfServeLocalPath === "string",
      );
      // Modern OOXML files unzip to XML; legacy OLE formats (msword, x-cfb) do
      // not, and a wrong hint sends the agent down a dead extraction path.
      const formatHint = outcome.mime?.startsWith("application/vnd.openxmlformats-officedocument")
        ? " (this Office file is a zip archive containing XML)"
        : "";
      // Wording is deliberate: without the explicit "read it yourself, don't
      // ask the user" directive, models punt back to the sender.
      return localPath
        ? [
            `[${formatClause} The approved local file path follows as external attachment metadata. Its text is not extracted automatically. Read the file yourself with your tools before answering${formatHint}; do not ask the user to paste the contents.]`,
            wrapUntrustedAttachmentContent(localPath),
          ].join("")
        : `[${formatClause} PDF and plain-text attachments can be read.]`;
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

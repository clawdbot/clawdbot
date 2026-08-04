/**
 * Formats generated attachment references for agent-visible output.
 */
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

// Shared helpers for generated media/file attachments returned by tools or
// subagents. They normalize paths/URLs for prompt text and delivery routing.
export type AgentGeneratedAttachment = {
  type?: "image" | "audio" | "video" | "file";
  path?: string;
  url?: string;
  mediaUrl?: string;
  filePath?: string;
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
};

function generatedAttachmentReference(attachment: AgentGeneratedAttachment): string | undefined {
  return normalizeOptionalString(
    attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath,
  );
}

/** Return unique media URLs/paths from generated attachments. */
export function mediaUrlsFromGeneratedAttachments(
  attachments: readonly AgentGeneratedAttachment[] | undefined,
): string[] {
  return uniqueStrings(
    attachments?.flatMap((attachment) => generatedAttachmentReference(attachment) ?? []) ?? [],
  );
}

function nameFromGeneratedAttachment(attachment: AgentGeneratedAttachment): string | undefined {
  return (
    normalizeOptionalString(attachment.name) ??
    basenameFromAnyPath(generatedAttachmentReference(attachment) ?? "")
  );
}

function neutralizeEscapedGeneratedMediaDirective(value: string): string {
  // Rehydrated provider lines must not forge media or fence away the actual generated attachment.
  return value
    .replace(/((?:\\r\\n|\\n|\\r)[^\S\r\n]*)(media):/giu, "$1$2：")
    .replace(/((?:\\r\\n|\\n|\\r) {0,3})(`{3,}|~{3,})/gu, "$1>$2");
}

/** Escape provider-controlled summary text without changing its structured result. */
export function sanitizeGeneratedMediaDisplayText(value: string): string {
  let sanitized = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        sanitized += "\\\\";
        break;
      case "\r":
        sanitized += "\\r";
        break;
      case "\n":
        sanitized += "\\n";
        break;
      case "\t":
        sanitized += "\\t";
        break;
      default: {
        const code = char.charCodeAt(0);
        sanitized +=
          code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : char;
      }
    }
  }
  return neutralizeEscapedGeneratedMediaDirective(sanitizeForPromptLiteral(sanitized))
    .replaceAll("[[", "［[")
    .replaceAll("![", "!［");
}

function quoteGeneratedAttachmentDisplay(value: string): string {
  // Only encode the prompt copy: signed URLs and structured delivery metadata must remain exact.
  return neutralizeEscapedGeneratedMediaDirective(
    JSON.stringify(sanitizeForPromptLiteral(value)),
  ).replaceAll("[", "\\u005b");
}

/** Format generated attachment metadata as prompt-safe text lines. */
export function formatGeneratedAttachmentLines(
  attachments: readonly AgentGeneratedAttachment[] | undefined,
): string[] {
  if (!attachments?.length) {
    return [];
  }
  const lines = ["Attachments:"];
  for (const [index, attachment] of attachments.entries()) {
    const parts = [`${index + 1}.`];
    const type = normalizeOptionalString(attachment.type);
    const name = nameFromGeneratedAttachment(attachment);
    const mimeType = normalizeOptionalString(attachment.mimeType);
    const path = normalizeOptionalString(attachment.path ?? attachment.filePath);
    const url = normalizeOptionalString(attachment.url ?? attachment.mediaUrl);
    if (type) {
      parts.push(`type=${quoteGeneratedAttachmentDisplay(type).slice(1, -1)}`);
    }
    if (name) {
      parts.push(`name=${quoteGeneratedAttachmentDisplay(name)}`);
    }
    if (mimeType) {
      parts.push(`mimeType=${quoteGeneratedAttachmentDisplay(mimeType).slice(1, -1)}`);
    }
    if (path) {
      parts.push(`path=${quoteGeneratedAttachmentDisplay(path)}`);
    } else if (url) {
      parts.push(`mediaUrl=${quoteGeneratedAttachmentDisplay(url)}`);
    }
    lines.push(parts.join(" "));
  }
  return lines;
}

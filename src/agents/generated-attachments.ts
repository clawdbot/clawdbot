/**
 * Formats generated attachment references for agent-visible output.
 */
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";

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
};

/** Resolve the first usable path or URL reference for a generated attachment. */
export function generatedAttachmentReference(
  attachment: AgentGeneratedAttachment,
): string | undefined {
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

/** Resolve a display name from attachment metadata or path basename. */
export function nameFromGeneratedAttachment(
  attachment: AgentGeneratedAttachment,
): string | undefined {
  return (
    normalizeOptionalString(attachment.name) ??
    basenameFromAnyPath(generatedAttachmentReference(attachment) ?? "")
  );
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
      parts.push(`type=${type}`);
    }
    if (name) {
      parts.push(`name=${JSON.stringify(name)}`);
    }
    if (mimeType) {
      parts.push(`mimeType=${mimeType}`);
    }
    if (path) {
      parts.push(`path=${JSON.stringify(path)}`);
    } else if (url) {
      parts.push(`mediaUrl=${JSON.stringify(url)}`);
    }
    lines.push(parts.join(" "));
  }
  return lines;
}

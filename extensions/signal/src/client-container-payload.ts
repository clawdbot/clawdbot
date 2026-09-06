import { detectMime, extractOriginalFilename } from "openclaw/plugin-sdk/media-runtime";
import { readRegularFile } from "openclaw/plugin-sdk/security-runtime";

// Outbound file paths are converted to base64 before posting to the container. Cap
// reads to the same default the native signal send path uses (8 MiB) so a path to a
// huge or symlinked file cannot OOM the gateway before encoding.
const DEFAULT_SIGNAL_CONTAINER_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const CONTAINER_TEXT_STYLE_MARKERS: Record<string, string> = {
  BOLD: "**",
  ITALIC: "*",
  STRIKETHROUGH: "~",
  MONOSPACE: "`",
  SPOILER: "||",
};

/**
 * Convert local file paths to base64 data URIs for the container REST API.
 * The bbernhard container /v2/send only accepts `base64_attachments` (not file paths).
 */
export async function filesToBase64DataUris(
  filePaths: string[],
  configuredMaxBytes?: number,
): Promise<string[]> {
  const maxAttachmentBytes =
    typeof configuredMaxBytes === "number" &&
    Number.isFinite(configuredMaxBytes) &&
    configuredMaxBytes >= 0
      ? Math.floor(configuredMaxBytes)
      : DEFAULT_SIGNAL_CONTAINER_MAX_ATTACHMENT_BYTES;
  const results: string[] = [];
  let remainingBytes = maxAttachmentBytes;
  for (const filePath of filePaths) {
    // One send owns one raw-byte budget. A per-file cap would let attachment
    // count multiply the memory consumed before the container request starts.
    const { buffer } = await readRegularFile({
      filePath,
      maxBytes: remainingBytes,
    });
    remainingBytes -= buffer.byteLength;
    const mime = (await detectMime({ buffer, filePath })) ?? "application/octet-stream";
    // Signal splits on semicolons; commas and fragments break RFC 2397 attachment data.
    const filename = extractOriginalFilename(filePath).replace(/[,;#]/g, "_");
    const b64 = buffer.toString("base64");
    results.push(`data:${mime};filename=${filename};base64,${b64}`);
  }
  return results;
}

function escapeContainerStyledText(text: string): string {
  return text.replace(/[*~`|]/g, (char) => `\\${char}`);
}

export function renderContainerStyledText(
  text: string,
  styles: Array<{ start: number; length: number; style: string }>,
): string {
  const spans = styles
    .map((style) => {
      const marker = CONTAINER_TEXT_STYLE_MARKERS[style.style];
      if (!marker) {
        return null;
      }
      const start = Math.max(0, Math.min(style.start, text.length));
      const end = Math.max(start, Math.min(style.start + style.length, text.length));
      if (end <= start) {
        return null;
      }
      return { start, end, marker };
    })
    .filter((span): span is { start: number; end: number; marker: string } => span !== null);

  if (spans.length === 0) {
    return text;
  }

  const positions = [
    ...new Set([0, text.length, ...spans.flatMap((span) => [span.start, span.end])]),
  ].toSorted((a, b) => a - b);
  let rendered = "";
  for (const [index, pos] of positions.entries()) {
    for (const span of spans
      .filter((candidate) => candidate.end === pos)
      .toSorted((a, b) => b.start - a.start)) {
      rendered += span.marker;
    }
    for (const span of spans
      .filter((candidate) => candidate.start === pos)
      .toSorted((a, b) => b.end - a.end)) {
      rendered += span.marker;
    }
    const next = positions[index + 1];
    if (next !== undefined && next > pos) {
      rendered += escapeContainerStyledText(text.slice(pos, next));
    }
  }
  return rendered;
}

/**
 * Strip the "uuid:" prefix that native signal-cli accepts but the container API rejects.
 */
export function stripUuidPrefix(id: string): string {
  return id.startsWith("uuid:") ? id.slice(5) : id;
}

/**
 * Convert a group internal_id to the container-expected format.
 * The bbernhard container expects groups as "group.{base64(internal_id)}".
 */
export function formatGroupIdForContainer(groupId: string): string {
  if (groupId.startsWith("group.")) {
    return groupId;
  }
  return `group.${Buffer.from(groupId).toString("base64")}`;
}

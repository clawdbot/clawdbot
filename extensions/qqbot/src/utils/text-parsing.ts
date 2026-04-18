import type { RefAttachmentSummary } from "../ref-index-store.js";

const MAX_FACE_EXT_BYTES = 64 * 1024;

function estimateBase64DecodedBytes(base64: string): number {
  let effectiveLen = 0;
  for (let i = 0; i < base64.length; i += 1) {
    if (base64.charCodeAt(i) > 0x20) {
      effectiveLen += 1;
    }
  }
  if (effectiveLen === 0) {
    return 0;
  }

  let padding = 0;
  let end = base64.length - 1;
  while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
    end -= 1;
  }
  if (end >= 0 && base64[end] === "=") {
    padding = 1;
    end -= 1;
    while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
      end -= 1;
    }
    if (end >= 0 && base64[end] === "=") {
      padding = 2;
    }
  }

  return Math.max(0, Math.floor((effectiveLen * 3) / 4) - padding);
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Replace QQ face tags with readable text labels. */
export function parseFaceTags(text: string | undefined | null): string {
  if (!text) {
    return "";
  }

  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      if (estimateBase64DecodedBytes(ext) > MAX_FACE_EXT_BYTES) {
        return "[Emoji: unknown emoji]";
      }
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "unknown emoji";
      return `[Emoji: ${faceName}]`;
    } catch {
      return _match;
    }
  });
}

/** Remove internal framework markers before sending text outward. */
export function filterInternalMarkers(text: string | undefined | null): string {
  if (!text) {
    return "";
  }

  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");
  result = result.replace(/@(?:image|voice|video|file):[a-zA-Z0-9_.-]+/g, "");
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}

/** Parse quote-related ref indices from `message_scene.ext`. */
export function parseRefIndices(ext?: string[]): { refMsgIdx?: string; msgIdx?: string } {
  if (!ext || ext.length === 0) {
    return {};
  }
  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;
  for (const item of ext) {
    if (item.startsWith("ref_msg_idx=")) {
      refMsgIdx = item.slice("ref_msg_idx=".length);
    } else if (item.startsWith("msg_idx=")) {
      msgIdx = item.slice("msg_idx=".length);
    }
  }
  return { refMsgIdx, msgIdx };
}

/** Build attachment summaries for ref-index caching. */
export function buildAttachmentSummaries(
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
    voice_wav_url?: string;
  }>,
  localPaths?: Array<string | null>,
): RefAttachmentSummary[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((att, idx) => {
    const ct = normalizeLowercaseStringOrEmpty(att.content_type);
    let type: RefAttachmentSummary["type"] = "unknown";
    if (ct.startsWith("image/")) {
      type = "image";
    } else if (
      ct === "voice" ||
      ct.startsWith("audio/") ||
      ct.includes("silk") ||
      ct.includes("amr")
    ) {
      type = "voice";
    } else if (ct.startsWith("video/")) {
      type = "video";
    } else if (ct.startsWith("application/") || ct.startsWith("text/")) {
      type = "file";
    }
    return {
      type,
      filename: att.filename,
      contentType: att.content_type,
      localPath: localPaths?.[idx] ?? undefined,
    };
  });
}

/**
 * Text parsing utilities — zero external dependency.
 *
 * Contains pure functions for message text processing.
 */

import type { RefAttachmentSummary } from "../ref/types.js";

// ============ Internal markers ============

const INTERNAL_MARKER_RE = /\[internal:?\s*[^\]]*\]|\[debug:?\s*[^\]]*\]|\[system:?\s*[^\]]*\]/gi;

/** Remove internal markers like `[internal:...]`, `[debug:...]`, `[system:...]`. */
export function filterInternalMarkers(text: string | undefined | null): string {
  if (!text) {
    return "";
  }
  return text.replace(INTERNAL_MARKER_RE, "").trim();
}

// ============ Ref indices ============

/** QQ 引用（回复）消息类型常量。 */
export const MSG_TYPE_QUOTE = 103;

/**
 * Parse message_scene.ext to extract refMsgIdx and msgIdx.
 *
 * Supports both ext prefix formats:
 * - `ref_msg_idx=` / `msg_idx=` (platform native format)
 * - `refMsgIdx:` / `msgIdx:` (legacy internal format)
 *
 * When `messageType` equals `MSG_TYPE_QUOTE` (103) and `msgElements` is
 * provided, `msgElements[0].msg_idx` takes precedence over the ext-parsed
 * `refMsgIdx` value — the element-level index is more authoritative for
 * quote messages.
 */
export function parseRefIndices(
  ext?: string[],
  messageType?: number,
  msgElements?: Array<{ msg_idx?: string }>,
): { refMsgIdx?: string; msgIdx?: string } {
  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;

  if (ext && ext.length > 0) {
    for (const item of ext) {
      if (typeof item !== "string") {
        continue;
      }
      // Platform native format: ref_msg_idx= / msg_idx=
      if (item.startsWith("ref_msg_idx=")) {
        refMsgIdx = item.slice("ref_msg_idx=".length).trim();
      } else if (item.startsWith("msg_idx=")) {
        msgIdx = item.slice("msg_idx=".length).trim();
      }
      // Legacy internal format: refMsgIdx: / msgIdx:
      else if (item.startsWith("refMsgIdx:")) {
        refMsgIdx = item.slice("refMsgIdx:".length).trim();
      } else if (item.startsWith("msgIdx:")) {
        msgIdx = item.slice("msgIdx:".length).trim();
      }
    }
  }

  // For quote messages, msg_elements[0].msg_idx is more authoritative.
  if (messageType === MSG_TYPE_QUOTE) {
    const refElement = msgElements?.[0];
    if (refElement?.msg_idx) {
      refMsgIdx = refElement.msg_idx;
    }
  }

  return { refMsgIdx, msgIdx };
}

// ============ Face tags ============

const MAX_FACE_EXT_BYTES = 64 * 1024;

/** Estimate Base64 decoded byte size (replaces plugin-sdk estimateBase64DecodedBytes). */
function estimateBase64Size(base64: string): number {
  const len = base64.length;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.ceil((len * 3) / 4) - padding;
}

/** Replace QQ face tags with readable text labels. */
export function parseFaceTags(text: string | undefined | null): string {
  if (!text) {
    return "";
  }

  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      if (estimateBase64Size(ext) > MAX_FACE_EXT_BYTES) {
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

// ============ Attachment summaries ============

/** Lowercase a string safely (replaces plugin-sdk normalizeLowercaseStringOrEmpty). */
function lc(s: string | undefined | null): string {
  return (s ?? "").toLowerCase();
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
    const ct = lc(att.content_type);
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

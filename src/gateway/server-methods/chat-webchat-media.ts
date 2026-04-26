import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../../infra/local-file-access.js";
import { assertLocalMediaAllowed, LocalMediaAccessError } from "../../media/local-media-access.js";
import { isAudioFileName } from "../../media/mime.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { sanitizeReplyDirectiveId } from "../../utils/directive-tags.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";

/** Cap embedded audio size to avoid multi‑MB payloads on the chat WebSocket. */
const MAX_WEBCHAT_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_WEBCHAT_IMAGE_DATA_URL_CHARS = 2_000_000;
const MAX_WEBCHAT_IMAGE_DATA_BYTES = 1_500_000;
const ALLOWED_WEBCHAT_DATA_IMAGE_MEDIA_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

type WebchatAudioEmbeddingOptions = {
  localRoots?: readonly string[];
  onLocalAudioAccessDenied?: (err: LocalMediaAccessError) => void;
};

type WebchatAssistantMediaOptions = WebchatAudioEmbeddingOptions;

/** Map `mediaUrl` strings to an absolute filesystem path for local embedding (plain paths or `file:` URLs). */
function resolveLocalMediaPathForEmbedding(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^data:/i.test(trimmed)) {
    return null;
  }
  if (/^https?:/i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("file:")) {
    try {
      const p = safeFileURLToPath(trimmed);
      if (!path.isAbsolute(p)) {
        return null;
      }
      return p;
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(trimmed)) {
    return null;
  }
  try {
    assertNoWindowsNetworkPath(trimmed, "Local media path");
  } catch {
    return null;
  }
  return trimmed;
}

/** Returns a readable local file path when it is a regular file and within the size cap (single stat before read). */
async function resolveLocalAudioFileForEmbedding(
  payload: ReplyPayload,
  raw: string,
  options: WebchatAudioEmbeddingOptions | undefined,
): Promise<string | null> {
  if (payload.trustedLocalMedia !== true) {
    return null;
  }
  const resolved = resolveLocalMediaPathForEmbedding(raw);
  if (!resolved) {
    return null;
  }
  if (!isAudioFileName(resolved)) {
    return null;
  }
  try {
    await assertLocalMediaAllowed(resolved, options?.localRoots);
    const st = fs.statSync(resolved);
    if (!st.isFile() || st.size > MAX_WEBCHAT_AUDIO_BYTES) {
      return null;
    }
    return resolved;
  } catch (err) {
    if (err instanceof LocalMediaAccessError) {
      options?.onLocalAudioAccessDenied?.(err);
    }
    return null;
  }
}

function mimeTypeForPath(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return MIME_BY_EXT[ext] ?? "audio/mpeg";
}

function estimateBase64DecodedBytes(base64: string): number {
  const sanitized = base64.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==") ? 2 : sanitized.endsWith("=") ? 1 : 0;
  return Math.floor((sanitized.length * 3) / 4) - padding;
}

function resolveEmbeddableImageUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_WEBCHAT_IMAGE_DATA_URL_CHARS) {
    return null;
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const mediaType = normalizeLowercaseStringOrEmpty(match[1]);
  const base64Data = match[2];
  if (!ALLOWED_WEBCHAT_DATA_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return null;
  }
  if (estimateBase64DecodedBytes(base64Data) > MAX_WEBCHAT_IMAGE_DATA_BYTES) {
    return null;
  }
  return trimmed;
}

function resolveReplyDirectivePrefix(payload: ReplyPayload): string {
  const replyToId = sanitizeReplyDirectiveId(payload.replyToId);
  if (replyToId) {
    return `[[reply_to:${replyToId}]]`;
  }
  if (payload.replyToCurrent) {
    return "[[reply_to_current]]";
  }
  return "";
}

/**
 * Build Control UI / transcript `content` blocks for local TTS (or other) audio files
 * referenced by slash-command / agent replies when the webchat path only had text aggregation.
 */
export async function buildWebchatAudioContentBlocksFromReplyPayloads(
  payloads: ReplyPayload[],
  options?: WebchatAudioEmbeddingOptions,
): Promise<Array<Record<string, unknown>>> {
  const seen = new Set<string>();
  const blocks: Array<Record<string, unknown>> = [];
  for (const payload of payloads) {
    if (payload.isReasoning === true) {
      continue;
    }
    const parts = resolveSendableOutboundReplyParts(payload);
    for (const raw of parts.mediaUrls) {
      const url = raw.trim();
      if (!url) {
        continue;
      }
      const resolved = await resolveLocalAudioFileForEmbedding(payload, url, options);
      if (!resolved || seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      const block = tryReadLocalAudioContentBlock(resolved);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

export async function buildWebchatAssistantMessageFromReplyPayloads(
  payloads: ReplyPayload[],
  options?: WebchatAssistantMediaOptions,
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  const content: Array<Record<string, unknown>> = [];
  const transcriptTextParts: string[] = [];
  const seenAudio = new Set<string>();
  const seenImages = new Set<string>();
  let hasAudio = false;
  let hasImage = false;

  for (const payload of payloads) {
    if (payload.isReasoning === true) {
      continue;
    }
    const visibleText = payload.text?.trim();
    const text =
      visibleText && !isSuppressedControlReplyText(visibleText) ? visibleText : undefined;
    const replyDirectivePrefix = resolveReplyDirectivePrefix(payload);
    let payloadHasAudio = false;
    let payloadHasImage = false;
    const payloadMediaBlocks: Array<Record<string, unknown>> = [];
    const parts = resolveSendableOutboundReplyParts(payload);
    for (const raw of parts.mediaUrls) {
      const url = raw.trim();
      if (!url) {
        continue;
      }
      const resolvedAudioPath = await resolveLocalAudioFileForEmbedding(payload, url, options);
      if (resolvedAudioPath) {
        if (seenAudio.has(resolvedAudioPath)) {
          continue;
        }
        seenAudio.add(resolvedAudioPath);
        const block = tryReadLocalAudioContentBlock(resolvedAudioPath);
        if (block) {
          payloadMediaBlocks.push(block);
          hasAudio = true;
          payloadHasAudio = true;
        }
        continue;
      }
      const imageUrl = resolveEmbeddableImageUrl(url);
      if (!imageUrl || seenImages.has(imageUrl)) {
        continue;
      }
      seenImages.add(imageUrl);
      payloadMediaBlocks.push({ type: "input_image", image_url: imageUrl });
      hasImage = true;
      payloadHasImage = true;
    }
    const needsSyntheticText =
      payloadMediaBlocks.length > 0 &&
      (!text || replyDirectivePrefix) &&
      transcriptTextParts.length === 0;
    const syntheticText = needsSyntheticText
      ? payloadHasAudio && payloadHasImage
        ? "Media reply"
        : payloadHasAudio
          ? "Audio reply"
          : "Image reply"
      : undefined;
    const blockText = text ?? syntheticText;
    if (blockText) {
      const fullText = replyDirectivePrefix ? `${replyDirectivePrefix}${blockText}` : blockText;
      transcriptTextParts.push(fullText);
      content.push({ type: "text", text: fullText });
    } else if (replyDirectivePrefix) {
      transcriptTextParts.push(replyDirectivePrefix);
      content.push({ type: "text", text: replyDirectivePrefix });
    }
    content.push(...payloadMediaBlocks);
  }

  if (!hasAudio && !hasImage) {
    return null;
  }
  const transcriptText =
    transcriptTextParts.join("\n\n").trim() ||
    (hasAudio && hasImage ? "Media reply" : hasAudio ? "Audio reply" : "Image reply");
  if (transcriptTextParts.length === 0) {
    content.unshift({ type: "text", text: transcriptText });
  }
  return { content, transcriptText };
}

function tryReadLocalAudioContentBlock(filePath: string): Record<string, unknown> | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > MAX_WEBCHAT_AUDIO_BYTES) {
      return null;
    }
    const mediaType = mimeTypeForPath(filePath);
    const base64Data = buf.toString("base64");
    return {
      type: "audio",
      source: { type: "base64", media_type: mediaType, data: base64Data },
    };
  } catch {
    return null;
  }
}

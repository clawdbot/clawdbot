import { expectDefined } from "@openclaw/normalization-core";
import {
  readPairingQrReplyChannelData,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { renderQrPngDataUrl } from "../../media/qr-image.js";
import { renderQrTerminal } from "../../media/qr-terminal.js";
import { stripInlineDirectiveTagsForDisplay } from "../../utils/directive-tags.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import {
  cleanupManagedOutgoingMediaRecords,
  createManagedOutgoingMediaBlocks,
} from "../managed-image-attachments.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext } from "./types.js";

const MANAGED_OUTGOING_MEDIA_PATH_PREFIX = "/api/chat/media/outgoing/";
const chatHistoryManagedMediaCleanupState = new Map<string, Promise<void>>();

export type AssistantDisplayContentBlock = Record<string, unknown>;

/** Recombine non-streamed text without destroying Markdown's meaningful indentation. */
export function combineNonStreamingReplyParts(parts: readonly string[]): string {
  let combined = "";
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    if (!combined) {
      combined = part;
      continue;
    }
    // Outbound media normalization trims a chunk's trailing newline, so an
    // indented following chunk still needs its original single-line boundary.
    const separator =
      /[\r\n]$/.test(combined) || /^[\r\n]/.test(part)
        ? ""
        : /^[\t ]+\S/.test(part)
          ? "\n"
          : "\n\n";
    combined += separator + part;
  }
  return combined.trim();
}

export function isMediaBearingPayload(payload: ReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return false;
  }
  if (payload.mediaUrl?.trim()) {
    return true;
  }
  return Boolean(payload.mediaUrls?.some((url) => url.trim()));
}

export function hasSensitiveMediaPayload(payloads: ReplyPayload[]): boolean {
  return payloads.some(
    (payload) =>
      payload.sensitiveMedia === true &&
      (isMediaBearingPayload(payload) || Boolean(readPairingQrReplyChannelData(payload))),
  );
}

async function buildPairingQrAssistantContentBlock(
  payload: ReplyPayload,
): Promise<AssistantDisplayContentBlock | undefined> {
  const qr = readPairingQrReplyChannelData(payload);
  if (!qr) {
    return undefined;
  }
  const [imageUrl, terminalText] = await Promise.all([
    renderQrPngDataUrl(qr.setupCode),
    renderQrTerminal(qr.setupCode, { small: true }),
  ]);
  return {
    type: "openclaw_pairing_qr",
    image_url: imageUrl,
    terminalText,
    alt: "OpenClaw pairing QR code",
    expiresAtMs: qr.expiresAtMs,
    sensitive: true,
  };
}

export function sanitizeAssistantDisplayText(
  value?: string | null,
  options?: { preserveBoundaries?: boolean },
): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutEnvelope = stripEnvelopeFromMessage(value);
  const normalized = typeof withoutEnvelope === "string" ? withoutEnvelope : value;
  const stripped = stripInlineDirectiveTagsForDisplay(normalized).text;
  const visible = stripped.trim();
  return visible ? (options?.preserveBoundaries ? stripped : visible) : undefined;
}

export function extractAssistantDisplayTextFromContent(
  content?: readonly AssistantDisplayContentBlock[] | null,
): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const parts = content
    .map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") {
        return "";
      }
      return block.text;
    })
    .filter(Boolean);
  const text = combineNonStreamingReplyParts(parts);
  return text || undefined;
}

export async function buildAssistantDisplayContentFromReplyPayloads(params: {
  sessionKey: string;
  agentId?: string;
  payloads: ReplyPayload[];
  managedMediaLocalRoots?: Parameters<typeof createManagedOutgoingMediaBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  includeSensitiveDisplay?: boolean;
  onManagedMediaPrepareError?: (message: string) => void;
  onSensitiveDisplayPrepareError?: (message: string) => void;
}): Promise<AssistantDisplayContentBlock[] | undefined> {
  const rawTextPayloadCount = params.payloads.filter(
    (payload) =>
      payload.isReasoning !== true &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0,
  ).length;
  const normalized = normalizeReplyPayloadsForDelivery(params.payloads);
  if (normalized.length === 0) {
    return rawTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
  }

  const preserveTextBoundaries =
    normalized.filter((payload) => typeof payload.text === "string" && payload.text.trim()).length >
    1;
  const content: AssistantDisplayContentBlock[] = [];
  let strippedTextPayloadCount = 0;
  for (const payload of normalized) {
    const text = sanitizeAssistantDisplayText(payload.text, {
      preserveBoundaries: preserveTextBoundaries,
    });
    if (text) {
      const previousBlock = content.at(-1);
      if (previousBlock?.type === "text" && typeof previousBlock.text === "string") {
        previousBlock.text = combineNonStreamingReplyParts([previousBlock.text, text]);
      } else {
        content.push({ type: "text", text });
      }
    } else if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      strippedTextPayloadCount += 1;
    }
    if (params.includeSensitiveDisplay === true) {
      try {
        const pairingQrBlock = await buildPairingQrAssistantContentBlock(payload);
        if (pairingQrBlock) {
          content.push(pairingQrBlock);
        }
      } catch (err) {
        params.onSensitiveDisplayPrepareError?.(formatForLog(err));
      }
    }
    if (params.includeSensitiveMedia === false && payload.sensitiveMedia === true) {
      continue;
    }
    const mediaUrls = Array.from(
      new Set([
        ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
        ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
      ]),
    );
    const mediaBlocks = await createManagedOutgoingMediaBlocks({
      sessionKey: params.sessionKey,
      ...(params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
      mediaUrls,
      attachments: payload.attachments,
      localRoots: params.managedMediaLocalRoots,
      allowLocalNonImage: payload.trustedLocalMedia === true,
      continueOnPrepareError: true,
      onPrepareError: (error) => {
        params.onManagedMediaPrepareError?.(error.message);
      },
    });
    if (mediaBlocks.length > 0) {
      content.push(
        ...mediaBlocks.map((block) =>
          payload.audioAsVoice === true && block.type === "audio"
            ? { ...block, isVoiceNote: true }
            : block,
        ),
      );
    }
  }

  if (content.length > 0) {
    return content;
  }
  return strippedTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
}

export function replaceAssistantContentTextBlocks(
  content: readonly AssistantDisplayContentBlock[] | undefined,
  transcriptMediaMessage: { content: Array<Record<string, unknown>> } | null,
): AssistantDisplayContentBlock[] | undefined {
  const transcriptTextBlocks = (transcriptMediaMessage?.content ?? []).filter(
    (block): block is AssistantDisplayContentBlock =>
      Boolean(block) &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string",
  );
  if (transcriptTextBlocks.length === 0) {
    return content ? [...content] : undefined;
  }
  if (!content || content.length === 0) {
    return [...transcriptTextBlocks];
  }
  const merged: AssistantDisplayContentBlock[] = [];
  let transcriptTextIndex = 0;
  for (const block of content) {
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      transcriptTextIndex < transcriptTextBlocks.length
    ) {
      merged.push(
        expectDefined(
          transcriptTextBlocks[transcriptTextIndex++],
          "transcript text blocks entry at transcript text index++",
        ),
      );
      continue;
    }
    merged.push(block);
  }
  if (transcriptTextIndex < transcriptTextBlocks.length) {
    merged.unshift(...transcriptTextBlocks.slice(transcriptTextIndex));
  }
  return merged;
}

function isManagedOutgoingMediaUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const parsed = new URL(value, "http://localhost");
    return parsed.pathname.startsWith(MANAGED_OUTGOING_MEDIA_PATH_PREFIX);
  } catch {
    return false;
  }
}

export function stripManagedOutgoingAssistantContentBlocks(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): AssistantDisplayContentBlock[] | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }
  const filtered = content.filter((block) => {
    if (block?.type !== "image" && block?.type !== "audio" && block?.type !== "video") {
      return true;
    }
    return !(isManagedOutgoingMediaUrl(block.url) || isManagedOutgoingMediaUrl(block.openUrl));
  });
  return filtered.length > 0 ? filtered : undefined;
}

export function extractAssistantDisplayText(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): string | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }
  const text = combineNonStreamingReplyParts(
    content.map((block) =>
      block?.type === "text" && typeof block.text === "string" ? block.text : "",
    ),
  );
  return text || undefined;
}

export function hasAssistantDisplayMediaContent(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): boolean {
  return Boolean(content?.some((block) => block?.type !== "text"));
}

export function hasVisibleAssistantFinalMessage(
  message: Record<string, unknown> | undefined,
): boolean {
  if (!message) {
    return false;
  }
  if (typeof message.text === "string" && message.text.trim()) {
    return true;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      return typeof record.text === "string" && record.text.trim().length > 0;
    }
    return true;
  });
}

export function hasManagedOutgoingAssistantContent(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): boolean {
  return Boolean(
    content?.some(
      (block) =>
        (block?.type === "image" || block?.type === "audio" || block?.type === "video") &&
        (isManagedOutgoingMediaUrl(block.url) || isManagedOutgoingMediaUrl(block.openUrl)),
    ),
  );
}

export function scheduleChatHistoryManagedMediaCleanup(params: {
  sessionKey: string;
  agentId?: string;
  context: Pick<GatewayRequestContext, "logGateway">;
}) {
  const cleanupKey =
    params.sessionKey === "global" && params.agentId
      ? `agent:${params.agentId}:global`
      : params.sessionKey;
  if (chatHistoryManagedMediaCleanupState.has(cleanupKey)) {
    return;
  }
  const pending = cleanupManagedOutgoingMediaRecords({
    sessionKey: params.sessionKey,
    ...(params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      params.context.logGateway.debug(
        `chat.history managed media cleanup skipped sessionKey=${JSON.stringify(params.sessionKey)} error=${formatForLog(error)}`,
      );
    })
    .finally(() => {
      if (chatHistoryManagedMediaCleanupState.get(cleanupKey) === pending) {
        chatHistoryManagedMediaCleanupState.delete(cleanupKey);
      }
    });
  chatHistoryManagedMediaCleanupState.set(cleanupKey, pending);
}

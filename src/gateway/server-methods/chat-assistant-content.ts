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
  cleanupManagedOutgoingImageRecords,
  createManagedOutgoingImageBlocks,
} from "../managed-image-attachments.js";
import { formatForLog } from "../ws-log.js";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "./chat-webchat-media.js";
import type { GatewayRequestContext } from "./types.js";

const MANAGED_OUTGOING_IMAGE_PATH_PREFIX = "/api/chat/media/outgoing/";
const chatHistoryManagedImageCleanupState = new Map<string, Promise<void>>();

export type AssistantDisplayContentBlock = Record<string, unknown>;

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

export function sanitizeAssistantDisplayText(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutEnvelope = stripEnvelopeFromMessage(value);
  const normalized = typeof withoutEnvelope === "string" ? withoutEnvelope : value;
  const stripped = stripInlineDirectiveTagsForDisplay(normalized).text.trim();
  return stripped || undefined;
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
      return block.text.trim();
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export async function buildAssistantDisplayContentFromReplyPayloads(params: {
  sessionKey: string;
  agentId?: string;
  payloads: ReplyPayload[];
  managedImageLocalRoots?: Parameters<typeof createManagedOutgoingImageBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  includeSensitiveDisplay?: boolean;
  onLocalAudioAccessDenied?: (message: string) => void;
  onManagedImagePrepareError?: (message: string) => void;
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

  const content: AssistantDisplayContentBlock[] = [];
  let strippedTextPayloadCount = 0;
  for (const payload of normalized) {
    const text = sanitizeAssistantDisplayText(payload.text);
    if (text) {
      content.push({ type: "text", text });
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
    const audioBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads([payload], {
      localRoots: Array.isArray(params.managedImageLocalRoots)
        ? params.managedImageLocalRoots
        : undefined,
      onLocalAudioAccessDenied: (err) => {
        params.onLocalAudioAccessDenied?.(formatForLog(err));
      },
    });
    content.push(...audioBlocks);

    const mediaUrls = Array.from(
      new Set([
        ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
        ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
      ]),
    );
    const imageBlocks = await createManagedOutgoingImageBlocks({
      sessionKey: params.sessionKey,
      ...(params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
      mediaUrls,
      localRoots: params.managedImageLocalRoots,
      continueOnPrepareError: true,
      onPrepareError: (error) => {
        params.onManagedImagePrepareError?.(error.message);
      },
    });
    if (imageBlocks.length > 0) {
      content.push(...imageBlocks);
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

function isManagedOutgoingImageUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const parsed = new URL(value, "http://localhost");
    return parsed.pathname.startsWith(MANAGED_OUTGOING_IMAGE_PATH_PREFIX);
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
    if (block?.type !== "image") {
      return true;
    }
    return !(isManagedOutgoingImageUrl(block.url) || isManagedOutgoingImageUrl(block.openUrl));
  });
  return filtered.length > 0 ? filtered : undefined;
}

export function extractAssistantDisplayText(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): string | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }
  const text = content
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
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
        block?.type === "image" &&
        (isManagedOutgoingImageUrl(block.url) || isManagedOutgoingImageUrl(block.openUrl)),
    ),
  );
}

export function scheduleChatHistoryManagedImageCleanup(params: {
  sessionKey: string;
  agentId?: string;
  context: Pick<GatewayRequestContext, "logGateway">;
}) {
  const cleanupKey =
    params.sessionKey === "global" && params.agentId
      ? `agent:${params.agentId}:global`
      : params.sessionKey;
  if (chatHistoryManagedImageCleanupState.has(cleanupKey)) {
    return;
  }
  const pending = cleanupManagedOutgoingImageRecords({
    sessionKey: params.sessionKey,
    ...(params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      params.context.logGateway.debug(
        `chat.history managed image cleanup skipped sessionKey=${JSON.stringify(params.sessionKey)} error=${formatForLog(error)}`,
      );
    })
    .finally(() => {
      if (chatHistoryManagedImageCleanupState.get(cleanupKey) === pending) {
        chatHistoryManagedImageCleanupState.delete(cleanupKey);
      }
    });
  chatHistoryManagedImageCleanupState.set(cleanupKey, pending);
}

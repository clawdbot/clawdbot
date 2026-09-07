import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getReplyPayloadMetadata,
  readPairingQrReplyChannelData,
  stripReplyMediaFailureFallback,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { renderQrPngDataUrl } from "../../media/qr-image.js";
import { renderQrTerminal } from "../../media/qr-terminal.js";
import { stripInlineDirectiveTagsForDelivery } from "../../utils/directive-tags.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  buildManagedMediaFailureBlock,
  createManagedOutgoingMediaBlocks,
  prepareOutgoingMediaFromReplyPayload,
} from "../managed-image-attachments.js";
import { formatForLog } from "../ws-log.js";
import type { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";

const MANAGED_OUTGOING_MEDIA_PATH_PREFIX = "/api/chat/media/outgoing/";

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

function hasSensitiveMediaPayload(payloads: ReplyPayload[]): boolean {
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
  const stripped = stripInlineDirectiveTagsForDelivery(normalized);
  const visible = stripped.text.trim();
  return visible
    ? options?.preserveBoundaries && !stripped.changed
      ? normalized
      : visible
    : undefined;
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

export async function buildAssistantReplyContent(params: {
  sessionKey: string;
  agentId?: string;
  payloads: ReplyPayload[];
  managedMediaLocalRoots?: Parameters<typeof createManagedOutgoingMediaBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  includeSensitiveDisplay?: boolean;
  onManagedMediaPrepareError?: (message: string) => void;
  onSensitiveDisplayPrepareError?: (message: string) => void;
  transcriptMediaMessage?: Awaited<
    ReturnType<typeof buildWebchatAssistantMessageFromReplyPayloads>
  >;
}): Promise<{
  assistantContent: AssistantDisplayContentBlock[] | undefined;
  persistedAssistantContent: AssistantDisplayContentBlock[] | undefined;
}> {
  const rawTextPayloadCount = params.payloads.filter(
    (payload) =>
      payload.isReasoning !== true &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0,
  ).length;
  const plan = createOutboundPayloadPlan(params.payloads);
  if (plan.length === 0) {
    const failureBlocks = params.payloads.flatMap((payload) =>
      (getReplyPayloadMetadata(payload)?.assistantMediaFailures ?? []).map(
        buildManagedMediaFailureBlock,
      ),
    );
    const assistantContent =
      failureBlocks.length > 0
        ? failureBlocks
        : rawTextPayloadCount > 0
          ? [{ type: "text", text: "" }]
          : undefined;
    return { assistantContent, persistedAssistantContent: assistantContent };
  }

  const preserveTextBoundaries =
    plan.filter(({ payload }) => typeof payload.text === "string" && payload.text.trim()).length >
    1;
  const content: AssistantDisplayContentBlock[] = [];
  const persistedContent: AssistantDisplayContentBlock[] = [];
  const persistSensitiveDisplay = !hasSensitiveMediaPayload(params.payloads);
  let strippedTextPayloadCount = 0;
  for (const entry of plan) {
    const payload = entry.payload;
    const metadataSource = params.payloads[entry.sourceIndex] ?? payload;
    const mediaFailures = getReplyPayloadMetadata(metadataSource)?.assistantMediaFailures ?? [];
    const text = sanitizeAssistantDisplayText(
      stripReplyMediaFailureFallback(payload.text, mediaFailures),
      {
        preserveBoundaries: preserveTextBoundaries,
      },
    );
    if (text && !isSuppressedControlReplyText(text)) {
      const previousBlock = content.at(-1);
      if (previousBlock?.type === "text" && typeof previousBlock.text === "string") {
        previousBlock.text = combineNonStreamingReplyParts([previousBlock.text, text]);
      } else {
        content.push({ type: "text", text });
      }
    } else if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      strippedTextPayloadCount += 1;
    }
    // Display text may merge across payloads. Transcript captions and directives
    // stay attached to their source payload instead of matching display slots.
    const transcriptText = params.transcriptMediaMessage?.payloadTexts[entry.sourceIndex] ?? text;
    if (transcriptText && !isSuppressedControlReplyText(transcriptText)) {
      persistedContent.push({ type: "text", text: transcriptText });
    }
    if (params.includeSensitiveDisplay === true) {
      try {
        const pairingQrBlock = await buildPairingQrAssistantContentBlock(payload);
        if (pairingQrBlock) {
          content.push(pairingQrBlock);
          if (persistSensitiveDisplay) {
            persistedContent.push(pairingQrBlock);
          }
        }
      } catch (err) {
        params.onSensitiveDisplayPrepareError?.(formatForLog(err));
      }
    }
    if (params.includeSensitiveMedia === false && payload.sensitiveMedia === true) {
      continue;
    }
    const mediaBlocks = await createManagedOutgoingMediaBlocks({
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      items: prepareOutgoingMediaFromReplyPayload(payload, metadataSource),
      localRoots: params.managedMediaLocalRoots,
      continueOnPrepareError: true,
      onPrepareError: (error) => {
        params.onManagedMediaPrepareError?.(error.message);
      },
    });
    if (payload.audioAsVoice === true) {
      for (const block of mediaBlocks) {
        if (block.type === "audio") {
          block.isVoiceNote = true;
        }
      }
    }
    const mediaContent = [...mediaBlocks, ...mediaFailures.map(buildManagedMediaFailureBlock)];
    content.push(...mediaContent);
    persistedContent.push(...mediaContent);
  }

  const assistantContent =
    content.length > 0
      ? content
      : strippedTextPayloadCount > 0
        ? [{ type: "text", text: "" }]
        : undefined;
  return {
    assistantContent,
    persistedAssistantContent:
      persistedContent.length > 0
        ? persistedContent
        : strippedTextPayloadCount > 0
          ? [{ type: "text", text: "" }]
          : undefined,
  };
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
    const attachment =
      block?.type === "attachment" ? asOptionalRecord(block.attachment) : undefined;
    if (
      block?.type !== "image" &&
      block?.type !== "audio" &&
      block?.type !== "video" &&
      !attachment
    ) {
      return true;
    }
    return !(
      isManagedOutgoingMediaUrl(block.url) ||
      isManagedOutgoingMediaUrl(block.openUrl) ||
      isManagedOutgoingMediaUrl(attachment?.url)
    );
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
        ((block?.type === "image" || block?.type === "audio" || block?.type === "video") &&
          (isManagedOutgoingMediaUrl(block.url) || isManagedOutgoingMediaUrl(block.openUrl))) ||
        (block?.type === "attachment" &&
          isManagedOutgoingMediaUrl(asOptionalRecord(block.attachment)?.url)),
    ),
  );
}

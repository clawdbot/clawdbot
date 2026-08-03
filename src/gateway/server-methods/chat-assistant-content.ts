import { expectDefined } from "@openclaw/normalization-core";
import {
  readPairingQrReplyChannelData,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
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

function collectReplyMediaEntries(payload: ReplyPayload) {
  const attachmentByReference = new Map<string, NonNullable<ReplyPayload["attachments"]>[number]>();
  for (const attachment of payload.attachments ?? []) {
    const reference = (
      attachment.path ??
      attachment.url ??
      attachment.mediaUrl ??
      attachment.filePath
    )?.trim();
    if (reference && !attachmentByReference.has(reference)) {
      attachmentByReference.set(reference, attachment);
    }
  }
  const mediaUrlCount = payload.mediaUrls?.length ?? 0;
  return [
    ...(payload.mediaUrls ?? []).map((url, index) => ({
      url,
      attachment: attachmentByReference.get(url.trim()) ?? payload.attachments?.[index],
    })),
    ...(typeof payload.mediaUrl === "string"
      ? [
          {
            url: payload.mediaUrl,
            attachment:
              attachmentByReference.get(payload.mediaUrl.trim()) ??
              payload.attachments?.[mediaUrlCount],
          },
        ]
      : []),
  ];
}

function resolveAlignedReplyMedia(
  payload: ReplyPayload,
  metadataSource: ReplyPayload = payload,
): {
  mediaUrls: string[];
  attachments?: NonNullable<ReplyPayload["attachments"]>;
} {
  const metadataByUrl = new Map<string, NonNullable<ReplyPayload["attachments"]>[number]>();
  for (const entry of collectReplyMediaEntries(metadataSource)) {
    const key = entry.url.trim();
    if (key && entry.attachment && !metadataByUrl.has(key)) {
      metadataByUrl.set(key, entry.attachment);
    }
  }
  const seen = new Set<string>();
  const mediaUrls: string[] = [];
  const attachments: NonNullable<ReplyPayload["attachments"]> = [];
  let hasMetadata = false;
  for (const entry of collectReplyMediaEntries(payload)) {
    const key = entry.url.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    mediaUrls.push(entry.url);
    const attachment = metadataByUrl.get(key) ?? entry.attachment ?? {};
    attachments.push(attachment);
    hasMetadata ||= Object.keys(attachment).length > 0;
  }
  return { mediaUrls, ...(hasMetadata ? { attachments } : {}) };
}

function splitReplyMediaByTrust(
  media: ReturnType<typeof resolveAlignedReplyMedia>,
  payloadTrusted: boolean,
) {
  // One payload per trust class is the authorization boundary. Class order follows
  // first occurrence; interleaved entries are intentionally coalesced within their class.
  const groups = new Map<
    boolean,
    {
      mediaUrls: string[];
      attachments: NonNullable<ReplyPayload["attachments"]>;
      sourceIndexes: number[];
    }
  >();
  for (const [index, url] of media.mediaUrls.entries()) {
    const attachment = media.attachments?.[index] ?? {};
    const trusted = attachment.trustedLocalMedia ?? payloadTrusted;
    const group = groups.get(trusted) ?? { mediaUrls: [], attachments: [], sourceIndexes: [] };
    group.mediaUrls.push(url);
    group.attachments.push(attachment);
    group.sourceIndexes.push(index);
    groups.set(trusted, group);
  }
  return [...groups].map(([trustedLocalMedia, group]) =>
    Object.assign(group, { trustedLocalMedia }),
  );
}

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
  const plan = createOutboundPayloadPlan(params.payloads);
  if (plan.length === 0) {
    return rawTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
  }

  const preserveTextBoundaries =
    plan.filter(({ payload }) => typeof payload.text === "string" && payload.text.trim()).length >
    1;
  const content: AssistantDisplayContentBlock[] = [];
  let strippedTextPayloadCount = 0;
  for (const entry of plan) {
    const payload = entry.payload;
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
    const media = resolveAlignedReplyMedia(payload, params.payloads[entry.sourceIndex] ?? payload);
    const preparedMedia: Array<{ sourceIndex: number; blocks: AssistantDisplayContentBlock[] }> =
      [];
    for (const mediaGroup of splitReplyMediaByTrust(media, payload.trustedLocalMedia === true)) {
      for (const [groupIndex, mediaUrl] of mediaGroup.mediaUrls.entries()) {
        const mediaBlocks = await createManagedOutgoingMediaBlocks({
          sessionKey: params.sessionKey,
          ...(params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
          mediaUrls: [mediaUrl],
          attachments: [mediaGroup.attachments[groupIndex] ?? {}],
          localRoots: params.managedMediaLocalRoots,
          allowLocalNonImage: mediaGroup.trustedLocalMedia,
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
        preparedMedia.push({
          sourceIndex: mediaGroup.sourceIndexes[groupIndex] ?? groupIndex,
          blocks: mediaBlocks,
        });
      }
    }
    preparedMedia.sort((left, right) => left.sourceIndex - right.sourceIndex);
    content.push(...preparedMedia.flatMap((preparedEntry) => preparedEntry.blocks));
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

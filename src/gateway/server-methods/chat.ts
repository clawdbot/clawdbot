import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { rewriteTranscriptEntriesInSessionFile } from "../../agents/pi-embedded-runner/transcript-rewrite.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { extractCanvasFromText } from "../../chat/canvas-render.js";
import { resolveSessionFilePath } from "../../config/sessions.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { logLargePayload } from "../../logging/diagnostic-payload.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { isAudioFileName } from "../../media/mime.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { type SavedMedia, saveMediaBuffer } from "../../media/store.js";
import { createChannelReplyPipeline } from "../../plugin-sdk/channel-reply-pipeline.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../../shared/chat-message-content.js";
import {
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
  sanitizeReplyDirectiveId,
} from "../../utils/directive-tags.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayCliClient,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import {
  type ChatImageContent,
  type OffloadedRef,
  parseMessageWithAttachments,
} from "../chat-attachments.js";
import { MediaOffloadError } from "../chat-attachments.js";
import { stripEnvelopeFromMessage, stripEnvelopeFromMessages } from "../chat-sanitize.js";
import { augmentChatHistoryWithCliSessionImports } from "../cli-session-history.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  attachManagedOutgoingImagesToMessage,
  cleanupManagedOutgoingImageRecords,
  createManagedOutgoingImageBlocks,
} from "../managed-image-attachments.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  hasGatewayClientCap,
} from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../protocol/schema/primitives.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  resolveGatewayModelSupportsImages,
  resolveDeletedAgentIdFromSessionKey,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import {
  buildWebchatAssistantMessageFromReplyPayloads,
  buildWebchatAudioContentBlocksFromReplyPayloads,
} from "./chat-webchat-media.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

type AbortOrigin = "rpc" | "stop-command";

type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  text: string;
  abortOrigin: AbortOrigin;
};

type ChatAbortRequester = {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
};

/** True when a reply payload carries at least one media reference (mediaUrl or mediaUrls). */
function isMediaBearingPayload(payload: ReplyPayload): boolean {
  if (payload.mediaUrl?.trim()) {
    return true;
  }
  if (payload.mediaUrls?.some((url) => url.trim())) {
    return true;
  }
  return false;
}

async function buildWebchatAssistantMediaMessage(
  payloads: ReplyPayload[],
  options?: {
    localRoots?: readonly string[];
    onLocalAudioAccessDenied?: (message: string) => void;
  },
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  return buildWebchatAssistantMessageFromReplyPayloads(payloads, {
    localRoots: options?.localRoots,
    onLocalAudioAccessDenied: (err) => {
      options?.onLocalAudioAccessDenied?.(formatForLog(err));
    },
  });
}

export const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8_000;
export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const MANAGED_OUTGOING_IMAGE_PATH_PREFIX = "/api/chat/media/outgoing/";
let chatHistoryPlaceholderEmitCount = 0;
const chatHistoryManagedImageCleanupState = new Map<string, Promise<void>>();
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main",
  "direct",
  "dm",
  "group",
  "channel",
  "cron",
  "run",
  "subagent",
  "acp",
  "thread",
  "topic",
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

export function resolveEffectiveChatHistoryMaxChars(
  cfg: { gateway?: { webchat?: { chatHistoryMaxChars?: number } } },
  maxChars?: number,
): number {
  if (typeof maxChars === "number") {
    return maxChars;
  }
  if (typeof cfg.gateway?.webchat?.chatHistoryMaxChars === "number") {
    return cfg.gateway.webchat.chatHistoryMaxChars;
  }
  return DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
}

type ChatSendDeliveryEntry = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

type ChatSendOriginatingRoute = {
  originatingChannel: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  explicitDeliverRoute: boolean;
};

type ChatSendExplicitOrigin = {
  originatingChannel?: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string;
};

type SideResultPayload = {
  kind: "btw";
  runId: string;
  sessionKey: string;
  question: string;
  text: string;
  isError?: boolean;
  ts: number;
};

function buildTranscriptReplyText(payloads: ReplyPayload[]): string {
  const chunks = payloads
    .map((payload) => {
      const parts = resolveSendableOutboundReplyParts(payload);
      const lines: string[] = [];
      const replyToId = sanitizeReplyDirectiveId(payload.replyToId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text = payload.text?.trim();
      if (text && !isSuppressedControlReplyText(text)) {
        lines.push(text);
      }
      for (const mediaUrl of parts.mediaUrls) {
        if (payload.sensitiveMedia === true) {
          continue;
        }
        const trimmed = mediaUrl.trim();
        if (trimmed) {
          lines.push(`MEDIA:${trimmed}`);
        }
      }
      if (payload.audioAsVoice && parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n").trim();
    })
    .filter(Boolean);
  return chunks.join("\n\n").trim();
}

function hasSensitiveMediaPayload(payloads: ReplyPayload[]): boolean {
  return payloads.some(
    (payload) => payload.sensitiveMedia === true && isMediaBearingPayload(payload),
  );
}

type AssistantDisplayContentBlock = Record<string, unknown>;

function sanitizeAssistantDisplayText(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutEnvelope = stripEnvelopeFromMessage(value);
  const normalized = typeof withoutEnvelope === "string" ? withoutEnvelope : value;
  const stripped = stripInlineDirectiveTagsForDisplay(normalized).text.trim();
  return stripped || undefined;
}

function extractAssistantDisplayTextFromContent(
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

async function buildAssistantDisplayContentFromReplyPayloads(params: {
  sessionKey: string;
  payloads: ReplyPayload[];
  managedImageLocalRoots?: Parameters<typeof createManagedOutgoingImageBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  onLocalAudioAccessDenied?: (message: string) => void;
  onManagedImagePrepareError?: (message: string) => void;
}): Promise<AssistantDisplayContentBlock[] | undefined> {
  const rawTextPayloadCount = params.payloads.filter(
    (payload) => typeof payload.text === "string" && payload.text.trim().length > 0,
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

function replaceAssistantContentTextBlocks(
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
      merged.push(transcriptTextBlocks[transcriptTextIndex++]);
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

function stripManagedOutgoingAssistantContentBlocks(
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

function extractAssistantDisplayText(
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

function hasAssistantDisplayMediaContent(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): boolean {
  return Boolean(content?.some((block) => block?.type !== "text"));
}

function scheduleChatHistoryManagedImageCleanup(params: {
  sessionKey: string;
  context: Pick<GatewayRequestContext, "logGateway">;
}) {
  if (chatHistoryManagedImageCleanupState.has(params.sessionKey)) {
    return;
  }
  const pending = cleanupManagedOutgoingImageRecords({ sessionKey: params.sessionKey })
    .then(() => undefined)
    .catch((error) => {
      params.context.logGateway.debug(
        `chat.history managed image cleanup skipped sessionKey=${JSON.stringify(params.sessionKey)} error=${formatForLog(error)}`,
      );
    })
    .finally(() => {
      if (chatHistoryManagedImageCleanupState.get(params.sessionKey) === pending) {
        chatHistoryManagedImageCleanupState.delete(params.sessionKey);
      }
    });
  chatHistoryManagedImageCleanupState.set(params.sessionKey, pending);
}

function resolveChatSendOriginatingRoute(params: {
  client?: { mode?: string | null; id?: string | null } | null;
  deliver?: boolean;
  entry?: ChatSendDeliveryEntry;
  explicitOrigin?: ChatSendExplicitOrigin;
  hasConnectedClient?: boolean;
  mainKey?: string;
  sessionKey: string;
}): ChatSendOriginatingRoute {
  if (params.explicitOrigin?.originatingChannel && params.explicitOrigin.originatingTo) {
    return {
      originatingChannel: params.explicitOrigin.originatingChannel,
      originatingTo: params.explicitOrigin.originatingTo,
      ...(params.explicitOrigin.accountId ? { accountId: params.explicitOrigin.accountId } : {}),
      ...(params.explicitOrigin.messageThreadId
        ? { messageThreadId: params.explicitOrigin.messageThreadId }
        : {}),
      explicitDeliverRoute: params.deliver === true,
    };
  }
  const shouldDeliverExternally = params.deliver === true;
  if (!shouldDeliverExternally) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const routeChannelCandidate = normalizeMessageChannel(
    params.entry?.deliveryContext?.channel ??
      params.entry?.lastChannel ??
      params.entry?.origin?.provider,
  );
  const routeToCandidate = params.entry?.deliveryContext?.to ?? params.entry?.lastTo;
  const routeAccountIdCandidate =
    params.entry?.deliveryContext?.accountId ??
    params.entry?.lastAccountId ??
    params.entry?.origin?.accountId ??
    undefined;
  const routeThreadIdCandidate =
    params.entry?.deliveryContext?.threadId ??
    params.entry?.lastThreadId ??
    params.entry?.origin?.threadId;
  if (params.sessionKey.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  const sessionScopeHead = sessionScopeParts[0];
  const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
  const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => (part ?? "").trim().toLowerCase())
    .filter(Boolean);
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === routeChannelCandidate;
  const isFromWebchatClient = isWebchatClient(params.client);
  const isFromGatewayCliClient = isGatewayCliClient(params.client);
  const hasClientMetadata =
    (typeof params.client?.mode === "string" && params.client.mode.trim().length > 0) ||
    (typeof params.client?.id === "string" && params.client.id.trim().length > 0);
  const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
  const isConfiguredMainSessionScope =
    normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey;
  const canInheritConfiguredMainRoute =
    isConfiguredMainSessionScope &&
    params.hasConnectedClient &&
    (isFromGatewayCliClient || !hasClientMetadata);

  // Webchat clients never inherit external delivery routes. Configured-main
  // sessions are stricter than channel-scoped sessions: only CLI callers, or
  // legacy callers with no client metadata, may inherit the last external route.
  const canInheritDeliverableRoute = Boolean(
    !isFromWebchatClient &&
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    ((!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape)) ||
      canInheritConfiguredMainRoute),
  );
  const hasDeliverableRoute =
    canInheritDeliverableRoute &&
    routeChannelCandidate &&
    routeChannelCandidate !== INTERNAL_MESSAGE_CHANNEL &&
    typeof routeToCandidate === "string" &&
    routeToCandidate.trim().length > 0;

  if (!hasDeliverableRoute) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  return {
    originatingChannel: routeChannelCandidate,
    originatingTo: routeToCandidate,
    accountId: routeAccountIdCandidate,
    messageThreadId: routeThreadIdCandidate,
    explicitDeliverRoute: true,
  };
}

function isAcpSessionKey(sessionKey: string | undefined): boolean {
  return Boolean(sessionKey?.split(":").includes("acp"));
}

function explicitOriginTargetsAcpSession(origin: ChatSendExplicitOrigin | undefined): boolean {
  if (!origin?.originatingChannel || !origin.originatingTo || !origin.accountId) {
    return false;
  }
  const channel = normalizeMessageChannel(origin.originatingChannel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel,
    accountId: origin.accountId,
    conversationId: origin.originatingTo,
  });
  return isAcpSessionKey(binding?.targetSessionKey);
}

function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}

export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}

function normalizeOptionalChatSystemReceipt(
  value: unknown,
): { ok: true; receipt?: string } | { ok: false; error: string } {
  if (value == null) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "systemProvenanceReceipt must be a string" };
  }
  const sanitized = sanitizeChatSendMessageInput(value);
  if (!sanitized.ok) {
    return sanitized;
  }
  const receipt = sanitized.message.trim();
  return { ok: true, receipt: receipt || undefined };
}

function isAcpBridgeClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const info = client?.connect?.client;
  return (
    info?.id === GATEWAY_CLIENT_NAMES.CLI &&
    info?.mode === GATEWAY_CLIENT_MODES.CLI &&
    info?.displayName === "ACP" &&
    info?.version === "acp"
  );
}

function canInjectSystemProvenance(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

async function persistChatSendImages(params: {
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<SavedMedia[]> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return [];
  }
  const inlineSaved: SavedMedia[] = [];
  for (const img of params.images) {
    try {
      inlineSaved.push(
        await saveMediaBuffer(Buffer.from(img.data, "base64"), img.mimeType, "inbound"),
      );
    } catch (err) {
      params.logGateway.warn(
        `chat.send: failed to persist inbound image (${img.mimeType}): ${formatForLog(err)}`,
      );
    }
  }
  const offloadedSaved = params.offloadedRefs.map((ref) => ({
    id: ref.id,
    path: ref.path,
    size: 0,
    contentType: ref.mimeType,
  }));
  if (params.imageOrder.length === 0) {
    return [...inlineSaved, ...offloadedSaved];
  }
  const saved: SavedMedia[] = [];
  let inlineIndex = 0;
  let offloadedIndex = 0;
  for (const entry of params.imageOrder) {
    if (entry === "inline") {
      const inline = inlineSaved[inlineIndex++];
      if (inline) {
        saved.push(inline);
      }
      continue;
    }
    const offloaded = offloadedSaved[offloadedIndex++];
    if (offloaded) {
      saved.push(offloaded);
    }
  }
  for (; inlineIndex < inlineSaved.length; inlineIndex++) {
    const inline = inlineSaved[inlineIndex];
    if (inline) {
      saved.push(inline);
    }
  }
  for (; offloadedIndex < offloadedSaved.length; offloadedIndex++) {
    const offloaded = offloadedSaved[offloadedIndex];
    if (offloaded) {
      saved.push(offloaded);
    }
  }
  return saved;
}

function buildChatSendTranscriptMessage(params: {
  message: string;
  savedImages: SavedMedia[];
  timestamp: number;
}) {
  const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
  return {
    role: "user" as const,
    content: params.message,
    timestamp: params.timestamp,
    ...mediaFields,
  };
}

function resolveChatSendTranscriptMediaFields(savedImages: SavedMedia[]) {
  const mediaPaths = savedImages.map((entry) => entry.path);
  if (mediaPaths.length === 0) {
    return {};
  }
  const mediaTypes = savedImages.map((entry) => entry.contentType ?? "application/octet-stream");
  return {
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes,
  };
}

function extractTranscriptUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block && typeof block === "object" && "text" in block ? block.text : undefined,
    )
    .filter((text): text is string => typeof text === "string");
  return textBlocks.length > 0 ? textBlocks.join("") : undefined;
}

async function rewriteChatSendUserTurnMediaPaths(params: {
  transcriptPath: string;
  sessionKey: string;
  message: string;
  savedImages: SavedMedia[];
}) {
  const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
  if (!("MediaPath" in mediaFields)) {
    return;
  }
  const sessionManager = SessionManager.open(params.transcriptPath);
  const branch = sessionManager.getBranch();
  const target = [...branch].toReversed().find((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") {
      return false;
    }
    const existingPaths = Array.isArray((entry.message as { MediaPaths?: unknown }).MediaPaths)
      ? (entry.message as { MediaPaths?: unknown[] }).MediaPaths
      : undefined;
    if (
      (typeof (entry.message as { MediaPath?: unknown }).MediaPath === "string" &&
        (entry.message as { MediaPath?: string }).MediaPath) ||
      (existingPaths && existingPaths.length > 0)
    ) {
      return false;
    }
    return (
      extractTranscriptUserText((entry.message as { content?: unknown }).content) === params.message
    );
  });
  if (!target || target.type !== "message") {
    return;
  }
  const rewrittenMessage = {
    ...target.message,
    ...mediaFields,
  };
  await rewriteTranscriptEntriesInSessionFile({
    sessionFile: params.transcriptPath,
    sessionKey: params.sessionKey,
    request: {
      replacements: [
        {
          entryId: target.id,
          message: rewrittenMessage,
        },
      ],
    },
  });
}

function truncateChatHistoryText(
  text: string,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n...(truncated)...`,
    truncated: true,
  };
}

function isToolHistoryBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "toolcall" ||
    normalized === "tool_call" ||
    normalized === "tooluse" ||
    normalized === "tool_use" ||
    normalized === "toolresult" ||
    normalized === "tool_result"
  );
}

function extractChatHistoryBlockText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const textParts = entry.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return undefined;
      }
      const typed = block as { text?: unknown; type?: unknown };
      return typeof typed.text === "string" ? typed.text : undefined;
    })
    .filter((value): value is string => typeof value === "string");
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function sanitizeChatHistoryContentBlock(
  block: unknown,
  opts?: { preserveExactToolPayload?: boolean; maxChars?: number },
): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  const preserveExactToolPayload =
    opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
  const maxChars = opts?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    if (preserveExactToolPayload) {
      entry.text = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    if (preserveExactToolPayload) {
      entry.content = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.partialJson === "string") {
    if (!preserveExactToolPayload) {
      const res = truncateChatHistoryText(entry.partialJson, maxChars);
      entry.partialJson = res.text;
      changed ||= res.truncated;
    }
  }
  if (typeof entry.arguments === "string") {
    if (!preserveExactToolPayload) {
      const res = truncateChatHistoryText(entry.arguments, maxChars);
      entry.arguments = res.text;
      changed ||= res.truncated;
    }
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking, maxChars);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  if (type === "audio" && entry.source && typeof entry.source === "object") {
    const source = { ...(entry.source as Record<string, unknown>) };
    if (source.type === "base64" && typeof source.data === "string") {
      const bytes = Buffer.byteLength(source.data, "utf8");
      delete source.data;
      source.omitted = true;
      source.bytes = bytes;
      entry.source = source;
      changed = true;
    }
  }
  return { block: changed ? entry : block, changed };
}

function sanitizeAssistantPhasedContentBlocks(content: unknown[]): {
  content: unknown[];
  changed: boolean;
} {
  const hasExplicitPhasedText = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    return (
      entry.type === "text" && Boolean(parseAssistantTextSignature(entry.textSignature)?.phase)
    );
  });
  if (!hasExplicitPhasedText) {
    return { content, changed: false };
  }
  const filtered = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    if (entry.type !== "text") {
      return true;
    }
    return parseAssistantTextSignature(entry.textSignature)?.phase === "final_answer";
  });
  return {
    content: filtered,
    changed: filtered.length !== content.length,
  };
}

/**
 * Validate that a value is a finite number, returning undefined otherwise.
 */
function toFiniteNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/**
 * Sanitize usage metadata to ensure only finite numeric fields are included.
 * Prevents UI crashes from malformed transcript JSON.
 */
function sanitizeUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const out: Record<string, number> = {};

  // Whitelist known usage fields and validate they're finite numbers
  const knownFields = [
    "input",
    "output",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ];

  for (const k of knownFields) {
    const n = toFiniteNumber(u[k]);
    if (n !== undefined) {
      out[k] = n;
    }
  }

  // Preserve nested usage.cost when present
  if ("cost" in u && u.cost != null && typeof u.cost === "object") {
    const sanitizedCost = sanitizeCost(u.cost);
    if (sanitizedCost) {
      (out as Record<string, unknown>).cost = sanitizedCost;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Sanitize cost metadata to ensure only finite numeric fields are included.
 * Prevents UI crashes from calling .toFixed() on non-numbers.
 */
function sanitizeCost(raw: unknown): { total?: number } | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const total = toFiniteNumber(c.total);
  return total !== undefined ? { total } : undefined;
}

function sanitizeChatHistoryMessage(
  message: unknown,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const preserveExactToolPayload =
    role === "toolresult" ||
    role === "tool_result" ||
    role === "tool" ||
    role === "function" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string" ||
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string";

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }

  // Keep usage/cost so the chat UI can render per-message token and cost badges.
  // Only retain usage/cost on assistant messages and validate numeric fields to prevent UI crashes.
  if (entry.role !== "assistant") {
    if ("usage" in entry) {
      delete entry.usage;
      changed = true;
    }
    if ("cost" in entry) {
      delete entry.cost;
      changed = true;
    }
  } else {
    // Validate and sanitize usage/cost for assistant messages
    if ("usage" in entry) {
      const sanitized = sanitizeUsage(entry.usage);
      if (sanitized) {
        entry.usage = sanitized;
      } else {
        delete entry.usage;
      }
      changed = true;
    }
    if ("cost" in entry) {
      const sanitized = sanitizeCost(entry.cost);
      if (sanitized) {
        entry.cost = sanitized;
      } else {
        delete entry.cost;
      }
      changed = true;
    }
  }

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    if (preserveExactToolPayload) {
      entry.content = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) =>
      sanitizeChatHistoryContentBlock(block, { preserveExactToolPayload, maxChars }),
    );
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
      if (sanitizedPhases.changed) {
        entry.content = sanitizedPhases.content;
        changed = true;
      }
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    if (preserveExactToolPayload) {
      entry.text = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }

  return { message: changed ? entry : message, changed };
}

/**
 * Extract the visible text from an assistant history message for silent-token checks.
 * Returns `undefined` for non-assistant messages or messages with no extractable text.
 * When `entry.text` is present it takes precedence over `entry.content` to avoid
 * dropping messages that carry real text alongside a stale `content: "NO_REPLY"`.
 */
function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function hasAssistantNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type !== "text",
  );
}

function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as { role?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return true;
  }
  const text = extractAssistantTextForSilentCheck(message);
  if (text === undefined || !isSuppressedControlReplyText(text)) {
    return false;
  }
  return !hasAssistantNonTextContent(message);
}

export function sanitizeChatHistoryMessages(
  messages: unknown[],
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars);
    changed ||= res.changed;
    if (shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

function appendCanvasBlockToAssistantHistoryMessage(params: {
  message: unknown;
  preview: ReturnType<typeof extractCanvasFromText>;
  rawText: string | null;
}): unknown {
  const preview = params.preview;
  if (!preview || !params.message || typeof params.message !== "object") {
    return params.message;
  }
  const entry = params.message as Record<string, unknown>;
  const baseContent = Array.isArray(entry.content)
    ? [...entry.content]
    : typeof entry.content === "string"
      ? [{ type: "text", text: entry.content }]
      : typeof entry.text === "string"
        ? [{ type: "text", text: entry.text }]
        : [];
  const alreadyPresent = baseContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as { type?: unknown; preview?: unknown };
    return (
      typed.type === "canvas" &&
      typed.preview &&
      typeof typed.preview === "object" &&
      (((typed.preview as { viewId?: unknown }).viewId &&
        (typed.preview as { viewId?: unknown }).viewId === preview.viewId) ||
        ((typed.preview as { url?: unknown }).url &&
          (typed.preview as { url?: unknown }).url === preview.url))
    );
  });
  if (!alreadyPresent) {
    baseContent.push({
      type: "canvas",
      preview,
      rawText: params.rawText,
    });
  }
  return {
    ...entry,
    content: baseContent,
  };
}

function messageContainsToolHistoryContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string"
  ) {
    return true;
  }
  if (!Array.isArray(entry.content)) {
    return false;
  }
  return entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
}

export function augmentChatHistoryWithCanvasBlocks(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  const next = [...messages];
  let changed = false;
  let lastAssistantIndex = -1;
  let lastRenderableAssistantIndex = -1;
  const pending: Array<{
    preview: NonNullable<ReturnType<typeof extractCanvasFromText>>;
    rawText: string | null;
  }> = [];
  for (let index = 0; index < next.length; index++) {
    const message = next[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    if (role === "assistant") {
      lastAssistantIndex = index;
      if (!messageContainsToolHistoryContent(entry)) {
        lastRenderableAssistantIndex = index;
        if (pending.length > 0) {
          let target = next[index];
          for (const item of pending) {
            target = appendCanvasBlockToAssistantHistoryMessage({
              message: target,
              preview: item.preview,
              rawText: item.rawText,
            });
          }
          next[index] = target;
          pending.length = 0;
          changed = true;
        }
      }
      continue;
    }
    if (!messageContainsToolHistoryContent(entry)) {
      continue;
    }
    const toolName =
      typeof entry.toolName === "string"
        ? entry.toolName
        : typeof entry.tool_name === "string"
          ? entry.tool_name
          : undefined;
    const text = extractChatHistoryBlockText(entry);
    const preview = extractCanvasFromText(text, toolName);
    if (!preview) {
      continue;
    }
    pending.push({
      preview,
      rawText: text ?? null,
    });
  }
  if (pending.length > 0) {
    const targetIndex =
      lastRenderableAssistantIndex >= 0 ? lastRenderableAssistantIndex : lastAssistantIndex;
    if (targetIndex >= 0) {
      let target = next[targetIndex];
      for (const item of pending) {
        target = appendCanvasBlockToAssistantHistoryMessage({
          message: target,
          preview: item.preview,
          rawText: item.rawText,
        });
      }
      next[targetIndex] = target;
      changed = true;
    }
  }
  return changed ? next : messages;
}

export function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: { truncated: true, reason: "oversized" },
  };
}

export function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

export function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  return { messages: [], placeholderCount: 0 };
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function transcriptHasIdempotencyKey(transcriptPath: string, idempotencyKey: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (parsed?.message?.idempotencyKey === idempotencyKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  return appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    message: params.message,
    label: params.label,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
  });
}

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  runIds: ReadonlySet<string>;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (!params.runIds.has(runId)) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}) {
  if (params.snapshots.length === 0) {
    return;
  }
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  for (const snapshot of params.snapshots) {
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = appendAssistantTranscriptMessage({
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatDeltaSentAt: context.chatDeltaSentAt,
    chatDeltaLastBroadcastLen: context.chatDeltaLastBroadcastLen,
    chatAbortedRuns: context.chatAbortedRuns,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

function normalizeOptionalText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeExplicitChatSendOrigin(
  params: ChatSendExplicitOrigin,
): { ok: true; value?: ChatSendExplicitOrigin } | { ok: false; error: string } {
  const originatingChannel = normalizeOptionalText(params.originatingChannel);
  const originatingTo = normalizeOptionalText(params.originatingTo);
  const accountId = normalizeOptionalText(params.accountId);
  const messageThreadId = normalizeOptionalText(params.messageThreadId);
  const hasAnyExplicitOriginField = Boolean(
    originatingChannel || originatingTo || accountId || messageThreadId,
  );
  if (!hasAnyExplicitOriginField) {
    return { ok: true };
  }
  const normalizedChannel = normalizeMessageChannel(originatingChannel);
  if (!normalizedChannel) {
    return {
      ok: false,
      error: "originatingChannel is required when using originating route fields",
    };
  }
  if (!originatingTo) {
    return {
      ok: false,
      error: "originatingTo is required when using originating route fields",
    };
  }
  return {
    ok: true,
    value: {
      originatingChannel: normalizedChannel,
      originatingTo,
      ...(accountId ? { accountId } : {}),
      ...(messageThreadId ? { messageThreadId } : {}),
    },
  };
}

function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
): ChatAbortRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return {
    connId: normalizeOptionalText(client?.connId),
    deviceId: normalizeOptionalText(client?.connect?.device?.id),
    isAdmin: scopes.includes(ADMIN_SCOPE),
  };
}

function canRequesterAbortChatRun(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  if (!ownerDeviceId && !ownerConnId) {
    return true;
  }
  if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) {
    return true;
  }
  if (ownerConnId && requester.connId && ownerConnId === requester.connId) {
    return true;
  }
  return false;
}

function resolveAuthorizedRunIdsForSession(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  sessionKey: string;
  requester: ChatAbortRequester;
}) {
  const authorizedRunIds: string[] = [];
  let matchedSessionRuns = 0;
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortChatRun(active, params.requester)) {
      authorizedRunIds.push(runId);
    }
  }
  return {
    matchedSessionRuns,
    authorizedRunIds,
  };
}

function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
}) {
  const { matchedSessionRuns, authorizedRunIds } = resolveAuthorizedRunIdsForSession({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKey: params.sessionKey,
    requester: params.requester,
  });
  if (authorizedRunIds.length === 0) {
    return {
      aborted: false,
      runIds: [],
      unauthorized: matchedSessionRuns > 0,
    };
  }
  const authorizedRunIdSet = new Set(authorizedRunIds);
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  const runIds: string[] = [];
  for (const runId of authorizedRunIds) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey: params.sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const res = { aborted: runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted) {
    persistAbortedPartials({
      context: params.context,
      sessionKey: params.sessionKey,
      snapshots,
    });
  }
  return res;
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message) as
    | Record<string, unknown>
    | undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

function isBtwReplyPayload(payload: ReplyPayload | undefined): payload is ReplyPayload & {
  btw: { question: string };
  text: string;
} {
  return (
    typeof payload?.btw?.question === "string" &&
    payload.btw.question.trim().length > 0 &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0
  );
}

function broadcastSideResult(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  payload: SideResultPayload;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.payload.runId);
  params.context.broadcast("chat.side_result", {
    ...params.payload,
    seq,
  });
  params.context.nodeSendToSession(params.payload.sessionKey, "chat.side_result", {
    ...params.payload,
    seq,
  });
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit, maxChars } = params as {
      sessionKey: string;
      limit?: number;
      maxChars?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const localMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const rawMessages = augmentChatHistoryWithCliSessionImports({
      entry,
      provider: resolvedSessionModel.provider,
      localMessages,
    });
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = stripEnvelopeFromMessages(sliced);
    const normalized = augmentChatHistoryWithCanvasBlocks(
      sanitizeChatHistoryMessages(sanitized, effectiveMaxChars),
    );
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = replaceOversizedChatHistoryMessages({
      messages: normalized,
      maxSingleMessageBytes: perMessageHardCap,
    });
    scheduleChatHistoryManagedImageCleanup({ sessionKey, context });
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
    if (placeholderCount > 0) {
      chatHistoryPlaceholderEmitCount += placeholderCount;
      logLargePayload({
        surface: "gateway.chat.history",
        action: "truncated",
        bytes: jsonUtf8Bytes(normalized),
        limitBytes: maxHistoryBytes,
        count: placeholderCount,
        reason: "chat_history_budget",
      });
      context.logGateway.debug(
        `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
      );
    }
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const catalog = await context.loadGatewayModelCatalog();
      thinkingLevel = resolveThinkingDefault({
        cfg,
        provider: resolvedSessionModel.provider,
        model: resolvedSessionModel.model,
        catalog,
      });
    }
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    respond(true, {
      sessionKey,
      sessionId,
      messages: bounded.messages,
      thinkingLevel,
      fastMode: entry?.fastMode,
      verboseLevel,
    });
  },
  "chat.abort": ({ params, respond, context, client }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = createChatAbortOps(context);
    const requester = resolveChatAbortRequester(client);

    if (!runId) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: rawSessionKey,
        abortOrigin: "rpc",
        stopReason: "rpc",
        requester,
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== rawSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }
    if (!canRequesterAbortChatRun(active, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: rawSessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && partialText && partialText.trim()) {
      persistAbortedPartials({
        context,
        sessionKey: rawSessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            text: partialText,
            abortOrigin: "rpc",
          },
        ],
      });
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      originatingChannel?: string;
      originatingTo?: string;
      originatingAccountId?: string;
      originatingThreadId?: string;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      systemInputProvenance?: InputProvenance;
      systemProvenanceReceipt?: string;
      idempotencyKey: string;
    };
    const explicitOriginResult = normalizeExplicitChatSendOrigin({
      originatingChannel: p.originatingChannel,
      originatingTo: p.originatingTo,
      accountId: p.originatingAccountId,
      messageThreadId: p.originatingThreadId,
    });
    if (!explicitOriginResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, explicitOriginResult.error));
      return;
    }
    if (
      (p.systemInputProvenance || p.systemProvenanceReceipt || explicitOriginResult.value) &&
      !canInjectSystemProvenance(client)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          p.systemInputProvenance || p.systemProvenanceReceipt
            ? "system provenance fields require admin scope"
            : "originating route fields require admin scope",
        ),
      );
      return;
    }
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
    if (!systemReceiptResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, systemReceiptResult.error));
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
    const systemProvenanceReceipt = systemReceiptResult.receipt;
    const stopCommand = isChatStopCommandText(inboundMessage);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    const rawSessionKey = p.sessionKey;
    const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, sessionKey);
    if (deletedAgentId !== null) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${deletedAgentId}" no longer exists in configuration`,
        ),
      );
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
    });
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    let imageOrder: PromptImageOrderEntry[] = [];
    let offloadedRefs: OffloadedRef[] = [];
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        abortOrigin: "stop-command",
        stopReason: "stop",
        requester: resolveChatAbortRequester(client),
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    if (normalizedAttachments.length > 0) {
      const modelRef = resolveSessionModelRef(cfg, entry, agentId);
      const supportsSessionModelImages = await resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        provider: modelRef.provider,
        model: modelRef.model,
      });
      const supportsImages =
        supportsSessionModelImages || explicitOriginTargetsAcpSession(explicitOriginResult.value);
      try {
        const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
          supportsImages,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
        imageOrder = parsed.imageOrder;
        offloadedRefs = parsed.offloadedRefs;
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(err),
          ),
        );
        return;
      }
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: rawSessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
        ownerConnId: normalizeOptionalText(client?.connId),
        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });
      const persistedImagesPromise = persistChatSendImages({
        images: parsedImages,
        imageOrder,
        offloadedRefs,
        client,
        logGateway: context.logGateway,
      });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const clientInfo = client?.connect?.client;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = resolveChatSendOriginatingRoute({
        client: clientInfo,
        deliver: p.deliver,
        entry,
        explicitOrigin: explicitOriginResult.value,
        hasConnectedClient: client?.connect !== undefined,
        mainKey: cfg.session?.mainKey,
        sessionKey,
      });
      // Inject timestamp so agents know the current date/time.
      // Only BodyForAgent gets the timestamp — Body stays raw for UI display.
      // See: https://github.com/moltbot/moltbot/issues/3658
      const stampedMessage = injectTimestamp(messageForAgent, timestampOptsFromConfig(cfg));

      const ctx: MsgContext = {
        Body: messageForAgent,
        BodyForAgent: stampedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        InputProvenance: systemInputProvenance,
        SessionKey: sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
        GatewayClientScopes: client?.connect?.scopes ?? [],
      };

      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const deliveredReplies: Array<{ payload: ReplyPayload; kind: "block" | "final" }> = [];
      let appendedWebchatAgentMedia = false;
      let userTranscriptUpdatePromise: Promise<void> | null = null;
      const emitUserTranscriptUpdate = async () => {
        if (userTranscriptUpdatePromise) {
          await userTranscriptUpdatePromise;
          return;
        }
        userTranscriptUpdatePromise = (async () => {
          const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
          const resolvedSessionId = latestEntry?.sessionId ?? entry?.sessionId;
          if (!resolvedSessionId) {
            return;
          }
          const transcriptPath = resolveTranscriptPath({
            sessionId: resolvedSessionId,
            storePath: latestStorePath,
            sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
            agentId,
          });
          if (!transcriptPath) {
            return;
          }
          const persistedImages = await persistedImagesPromise;
          emitSessionTranscriptUpdate({
            sessionFile: transcriptPath,
            sessionKey,
            message: buildChatSendTranscriptMessage({
              message: parsedMessage,
              savedImages: persistedImages,
              timestamp: now,
            }),
          });
        })();
        await userTranscriptUpdatePromise;
      };
      let transcriptMediaRewriteDone = false;
      const rewriteUserTranscriptMedia = async () => {
        if (transcriptMediaRewriteDone) {
          return;
        }
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
        const resolvedSessionId = latestEntry?.sessionId ?? entry?.sessionId;
        if (!resolvedSessionId) {
          return;
        }
        const transcriptPath = resolveTranscriptPath({
          sessionId: resolvedSessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
          agentId,
        });
        if (!transcriptPath) {
          return;
        }
        transcriptMediaRewriteDone = true;
        await rewriteChatSendUserTurnMediaPaths({
          transcriptPath,
          sessionKey,
          message: parsedMessage,
          savedImages: await persistedImagesPromise,
        });
      };
      const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
        if (!agentRunStarted || appendedWebchatAgentMedia || !isMediaBearingPayload(payload)) {
          return;
        }
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
        const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
        const resolvedTranscriptPath = resolveTranscriptPath({
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
          agentId,
        });
        const mediaLocalRoots = appendLocalMediaParentRoots(
          getAgentScopedMediaLocalRoots(cfg, agentId),
          resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
        );
        const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
          sessionKey,
          payloads: [payload],
          managedImageLocalRoots: mediaLocalRoots,
          includeSensitiveMedia: payload.sensitiveMedia !== true,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
          onManagedImagePrepareError: (message) => {
            context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
          },
        });
        const mediaMessage = await buildWebchatAssistantMediaMessage([payload], {
          localRoots: mediaLocalRoots,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
        });
        const persistedAssistantContent = replaceAssistantContentTextBlocks(
          assistantContent,
          mediaMessage,
        );
        const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent)
          ? persistedAssistantContent
          : undefined;
        const transcriptReply =
          mediaMessage?.transcriptText ??
          extractAssistantDisplayTextFromContent(assistantContent) ??
          buildTranscriptReplyText([payload]);
        if (!transcriptReply && !persistedAssistantContent?.length && !assistantContent?.length) {
          return;
        }
        const appended = appendAssistantTranscriptMessage({
          message: transcriptReply,
          ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile,
          agentId,
          createIfMissing: true,
          idempotencyKey: `${clientRunId}:assistant-media`,
        });
        if (appended.ok) {
          if (appended.messageId && assistantContent?.length) {
            await attachManagedOutgoingImagesToMessage({
              messageId: appended.messageId,
              blocks: assistantContent,
            });
          }
          appendedWebchatAgentMedia = true;
          return;
        }
        context.logGateway.warn(
          `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
        );
      };
      const dispatcher = createReplyDispatcher({
        ...replyPipeline,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          switch (info.kind) {
            case "block":
            case "final":
              deliveredReplies.push({ payload, kind: info.kind });
              await appendWebchatAgentMediaTranscriptIfNeeded(payload);
              break;
            case "tool":
              // Tool results that carry audio (e.g. the TTS tool) must be promoted
              // to "final" so the downstream audio extraction path can pick them up.
              // Strip text to avoid leaking tool summary into the combined reply.
              if (isMediaBearingPayload(payload)) {
                deliveredReplies.push({
                  payload: { ...payload, text: undefined },
                  kind: "final",
                });
              }
              break;
          }
        },
      });

      // Surface accepted inbound turns immediately so transcript subscribers
      // (gateway watchers, MCP bridges, external channel backends) do not wait
      // on model startup, completion, or failure paths before seeing the user turn.
      void emitUserTranscriptUpdate().catch((transcriptErr) => {
        context.logGateway.warn(
          `webchat eager user transcript update failed: ${formatForLog(transcriptErr)}`,
        );
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
          onAgentRunStart: (runId) => {
            agentRunStarted = true;
            void emitUserTranscriptUpdate();
            const connId = typeof client?.connId === "string" ? client.connId : undefined;
            const wantsToolEvents = hasGatewayClientCap(
              client?.connect?.caps,
              GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
            );
            if (connId && wantsToolEvents) {
              context.registerToolEventRecipient(runId, connId);
              // Register for any other active runs *in the same session* so
              // late-joining clients (e.g. page refresh mid-response) receive
              // in-progress tool events without leaking cross-session data.
              for (const [activeRunId, active] of context.chatAbortControllers) {
                if (activeRunId !== runId && active.sessionKey === p.sessionKey) {
                  context.registerToolEventRecipient(activeRunId, connId);
                }
              }
            }
          },
          onModelSelected,
        },
      })
        .then(async () => {
          await rewriteUserTranscriptMedia();
          if (!agentRunStarted) {
            await emitUserTranscriptUpdate();
            const btwReplies = deliveredReplies
              .map((entry) => entry.payload)
              .filter(isBtwReplyPayload);
            const btwText = btwReplies
              .map((payload) => payload.text.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            if (btwReplies.length > 0 && btwText) {
              broadcastSideResult({
                context,
                payload: {
                  kind: "btw",
                  runId: clientRunId,
                  sessionKey,
                  question: btwReplies[0].btw.question.trim(),
                  text: btwText,
                  isError: btwReplies.some((payload) => payload.isError),
                  ts: Date.now(),
                },
              });
              broadcastChatFinal({
                context,
                runId: clientRunId,
                sessionKey,
              });
            } else {
              const finalPayloads = deliveredReplies
                .filter((entry) => entry.kind === "final")
                .map((entry) => entry.payload);
              const { storePath: latestStorePath, entry: latestEntry } =
                loadSessionEntry(sessionKey);
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const resolvedTranscriptPath = resolveTranscriptPath({
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
                agentId,
              });
              const mediaLocalRoots = appendLocalMediaParentRoots(
                getAgentScopedMediaLocalRoots(cfg, agentId),
                resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
              );
              const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
                sessionKey,
                payloads: finalPayloads,
                managedImageLocalRoots: mediaLocalRoots,
                includeSensitiveMedia: false,
                onLocalAudioAccessDenied: (message) => {
                  context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
                },
                onManagedImagePrepareError: (message) => {
                  context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
                },
              });
              const mediaMessage = await buildWebchatAssistantMediaMessage(finalPayloads, {
                localRoots: mediaLocalRoots,
                onLocalAudioAccessDenied: (message) => {
                  context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
                },
              });
              const hasSensitiveMedia = hasSensitiveMediaPayload(finalPayloads);
              const persistedAssistantContent = replaceAssistantContentTextBlocks(
                hasSensitiveMedia
                  ? await buildAssistantDisplayContentFromReplyPayloads({
                      sessionKey,
                      payloads: finalPayloads,
                      managedImageLocalRoots: mediaLocalRoots,
                      includeSensitiveMedia: false,
                      onLocalAudioAccessDenied: (message) => {
                        context.logGateway.warn(
                          `webchat audio embedding denied local path: ${message}`,
                        );
                      },
                      onManagedImagePrepareError: (message) => {
                        context.logGateway.warn(
                          `webchat image embedding skipped attachment: ${message}`,
                        );
                      },
                    })
                  : assistantContent,
                mediaMessage,
              );
              const persistedContentForAppend = hasAssistantDisplayMediaContent(
                persistedAssistantContent,
              )
                ? persistedAssistantContent
                : undefined;
              const broadcastAssistantContent = hasAssistantDisplayMediaContent(assistantContent)
                ? assistantContent
                : hasAssistantDisplayMediaContent(mediaMessage?.content)
                  ? mediaMessage?.content
                  : assistantContent;
              const displayReply =
                extractAssistantDisplayTextFromContent(assistantContent) ??
                buildTranscriptReplyText(finalPayloads);
              const transcriptReply =
                mediaMessage?.transcriptText ||
                buildTranscriptReplyText(finalPayloads) ||
                displayReply;
              let message: Record<string, unknown> | undefined;
              if (
                transcriptReply ||
                persistedContentForAppend?.length ||
                assistantContent?.length
              ) {
                const appended = appendAssistantTranscriptMessage({
                  message: transcriptReply,
                  ...(persistedContentForAppend?.length
                    ? { content: persistedContentForAppend }
                    : {}),
                  sessionId,
                  storePath: latestStorePath,
                  sessionFile: latestEntry?.sessionFile,
                  agentId,
                  createIfMissing: true,
                });
                if (appended.ok) {
                  if (appended.messageId && assistantContent?.length) {
                    await attachManagedOutgoingImagesToMessage({
                      messageId: appended.messageId,
                      blocks: assistantContent,
                    });
                  }
                  message = broadcastAssistantContent?.length
                    ? { ...appended.message, content: broadcastAssistantContent }
                    : appended.message;
                } else {
                  context.logGateway.warn(
                    `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                  );
                  const fallbackAssistantContent =
                    stripManagedOutgoingAssistantContentBlocks(persistedAssistantContent) ??
                    stripManagedOutgoingAssistantContentBlocks(assistantContent);
                  const fallbackText =
                    extractAssistantDisplayText(fallbackAssistantContent) ?? displayReply;
                  const now = Date.now();
                  message = {
                    role: "assistant",
                    ...(fallbackAssistantContent?.length
                      ? { content: fallbackAssistantContent }
                      : fallbackText
                        ? { content: [{ type: "text", text: fallbackText }] }
                        : {}),
                    ...(fallbackText ? { text: fallbackText } : {}),
                    timestamp: now,
                    // Keep this compatible with Pi stopReason enums even though this message isn't
                    // persisted to the transcript due to the append failure.
                    stopReason: "stop",
                    usage: { input: 0, output: 0, totalTokens: 0 },
                  };
                }
              }
              broadcastChatFinal({
                context,
                runId: clientRunId,
                sessionKey,
                message,
              });
            }
          } else {
            void emitUserTranscriptUpdate();
          }
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            },
          });
        })
        .catch((err) => {
          void rewriteUserTranscriptMedia().catch((rewriteErr) => {
            context.logGateway.warn(
              `webchat transcript media rewrite failed after error: ${formatForLog(rewriteErr)}`,
            );
          });
          void emitUserTranscriptUpdate().catch((transcriptErr) => {
            context.logGateway.warn(
              `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
            );
          });
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(err),
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    const appended = appendAssistantTranscriptMessage({
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: resolveSessionAgentId({ sessionKey, config: cfg }),
      createIfMissing: true,
    });
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      seq: 0,
      state: "final" as const,
      message: stripInlineDirectiveTagsFromMessageForDisplay(
        stripEnvelopeFromMessage(appended.message) as Record<string, unknown>,
      ),
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(sessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId: appended.messageId });
  },
};

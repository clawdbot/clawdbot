import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatMessageGetParams,
  validateChatSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../../packages/gateway-protocol/src/schema.js";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { rewriteTranscriptEntriesInSessionFile } from "../../agents/embedded-agent-runner/transcript-rewrite.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { stageSandboxMedia } from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import { extractCanvasFromText } from "../../chat/canvas-render.js";
import { resolveSessionFilePath } from "../../config/sessions.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  emitDiagnosticsTimelineEvent,
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage, formatUncaughtError } from "../../infra/errors.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { logLargePayload } from "../../logging/diagnostic-payload.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import {
  deleteMediaBuffer,
  MEDIA_MAX_BYTES,
  type SavedMedia,
  saveMediaBuffer,
} from "../../media/store.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import {
  INTER_SESSION_PROMPT_PREFIX_BASE,
  normalizeInputProvenance,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import {
  stripInlineDirectiveTagsForDisplay,
  sanitizeReplyDirectiveId,
} from "../../utils/directive-tags.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayCliClient,
  isOperatorUiClient,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  abortChatRunById,
  boundInFlightRunSnapshotForChatHistory,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  registerChatAbortController,
  resolveInFlightRunSnapshot,
  updateChatRunProvider,
} from "../chat-abort.js";
import {
  type ChatImageContent,
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
  resolveChatAttachmentMaxBytes,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import {
  isToolHistoryBlockType,
  projectChatDisplayMessage,
  projectRecentChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import { augmentChatHistoryWithCliSessionImports } from "../cli-session-history.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  attachManagedOutgoingImagesToMessage,
  cleanupManagedOutgoingImageRecords,
  createManagedOutgoingImageBlocks,
} from "../managed-image-attachments.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { getMaxChatHistoryMessagesBytes, MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { resolveSessionHistoryTailReadOptions } from "../session-history-state.js";
import { readSessionTranscriptIndex } from "../session-transcript-index.fs.js";
import {
  capArrayByJsonBytes,
  buildGatewaySessionInfo,
  getSessionDefaults,
  loadSessionEntry,
  listAgentsForGateway,
  readSessionMessageByIdAsync,
  readSessionMessagesAsync,
  resolveGatewayModelSupportsImages,
  resolveDeletedAgentIdFromSessionKey,
  readRecentSessionMessagesAsync,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import {
  appendInjectedAssistantMessageToTranscript,
  type GatewayInjectedTtsSupplementMarker,
} from "./chat-transcript-inject.js";
import {
  buildWebchatAssistantMessageFromReplyPayloads,
  buildWebchatAudioContentBlocksFromReplyPayloads,
} from "./chat-webchat-media.js";
import { loadOptionalServerMethodModelCatalog } from "./optional-model-catalog.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
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
  agentId?: string;
  text: string;
  abortOrigin: AbortOrigin;
};

type ChatAbortRequester = {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
};

type PreRegisteredAgentDedupePayload = {
  agentId?: unknown;
  controlUiVisible?: unknown;
  dedupeKeys?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status?: unknown;
};

type PreRegisteredAgentRun = {
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
};

type ChatHistoryMethod = "chat.history" | "chat.startup";

function normalizeUnknownText(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalText(value) : undefined;
}

/** True when a reply payload carries at least one media reference (mediaUrl or mediaUrls). */
function isMediaBearingPayload(payload: ReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return false;
  }
  if (payload.mediaUrl?.trim()) {
    return true;
  }
  if (payload.mediaUrls?.some((url) => url.trim())) {
    return true;
  }
  return false;
}

function stripVisibleTextFromTtsSupplement(payload: ReplyPayload): ReplyPayload {
  return isReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : payload;
}

function resolveTtsSupplementMarkerText(text: string): string {
  const trimmed = text.trim();
  const projected = projectChatDisplayMessage(
    {
      role: "assistant",
      content: [{ type: "text", text: trimmed }],
    },
    { maxChars: Number.MAX_SAFE_INTEGER },
  );
  const projectedContent = Array.isArray(projected?.content)
    ? (projected.content as AssistantDisplayContentBlock[])
    : undefined;
  return (
    extractAssistantDisplayTextFromContent(projectedContent) ??
    (typeof projected?.text === "string" ? projected.text.trim() : undefined) ??
    trimmed
  );
}

function buildTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): GatewayInjectedTtsSupplementMarker | undefined {
  const supplement = getReplyPayloadTtsSupplement(payload);
  if (!supplement) {
    return undefined;
  }
  const visibleText = resolveTtsSupplementMarkerText(
    payload.text?.trim() || supplement.spokenText.trim(),
  );
  return {
    textSha256: createHash("sha256").update(visibleText).digest("hex"),
  };
}

function buildMediaOnlyTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): GatewayInjectedTtsSupplementMarker | undefined {
  if (payload.text?.trim()) {
    return undefined;
  }
  return buildTtsSupplementTranscriptMarker(payload);
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

export {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../chat-display-projection.js";

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

type ChatSendDeliveryEntry = {
  route?: ChannelRouteRef;
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

const ACTIVE_CHAT_SEND_DEDUPE_PREFIX = "chat:active-send";

function resolveActiveChatSendRunId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim() ? runId : null;
}

function buildActiveChatSendDedupeKey(params: {
  attachmentCount: number;
  explicitDeliverRoute: boolean;
  message: string;
  originatingChannel: string;
  sessionKey: string;
}): string | null {
  const message = params.message.trim();
  if (
    !message ||
    message.startsWith("/") ||
    params.attachmentCount > 0 ||
    params.explicitDeliverRoute ||
    normalizeMessageChannel(params.originatingChannel) !== INTERNAL_MESSAGE_CHANNEL
  ) {
    return null;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([params.sessionKey, message]))
    .digest("hex")
    .slice(0, 32);
  return `${ACTIVE_CHAT_SEND_DEDUPE_PREFIX}:${digest}`;
}

function validateChatSelectedAgent(params: {
  cfg: OpenClawConfig;
  requestedSessionKey: string;
  agentId?: string;
}): { ok: true; agentId?: string } | { ok: false; error: string } {
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  if (!agentId) {
    return { ok: true };
  }
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return { ok: false, error: `Unknown agent id "${params.agentId}"` };
  }
  const requestedSessionKey = params.requestedSessionKey.trim();
  const parsed = parseAgentSessionKey(requestedSessionKey);
  if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
    return {
      ok: false,
      error: `agentId "${params.agentId}" does not match session key "${params.requestedSessionKey}"`,
    };
  }
  if (requestedSessionKey.toLowerCase() === "global") {
    return { ok: true, agentId };
  }
  if (resolveSessionStoreKey({ cfg: params.cfg, sessionKey: requestedSessionKey }) === "global") {
    return { ok: true, agentId };
  }
  if (!parsed || normalizeAgentId(parsed.agentId) !== agentId) {
    return {
      ok: false,
      error: `agentId "${params.agentId}" does not match session key "${params.requestedSessionKey}"`,
    };
  }
  return { ok: true, agentId };
}

function resolveRequestedChatAgentId(params: {
  cfg?: OpenClawConfig;
  requestedSessionKey: string;
  agentId?: string;
}): string | undefined {
  const explicitAgentId = normalizeOptionalText(params.agentId);
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  if (!params.cfg) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(params.requestedSessionKey.trim());
  if (
    !parsed?.agentId ||
    resolveSessionStoreKey({ cfg: params.cfg, sessionKey: params.requestedSessionKey }) !== "global"
  ) {
    return undefined;
  }
  return normalizeAgentId(parsed.agentId);
}

function resolveChatSendActiveScopeKey(params: {
  sessionKey: string;
  agentId?: string;
  mainKey?: string;
}): string {
  if (params.sessionKey !== "global" || !params.agentId) {
    return params.sessionKey;
  }
  return (
    scopeLegacySessionKeyToAgent({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      mainKey: params.mainKey,
    }) ?? params.sessionKey
  );
}

type ChatSendExplicitOrigin = {
  originatingChannel?: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string;
};

function formatAttachmentFailureForLog(err: unknown): string {
  const primary = formatUncaughtError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) {
    return primary;
  }
  const causeText = formatUncaughtError(cause);
  if (!causeText || causeText === primary) {
    return primary;
  }
  return `${primary}\nCaused by: ${causeText}`;
}

function logAttachmentFailure(
  logGateway: Pick<GatewayRequestContext["logGateway"], "error">,
  label: string,
  err: unknown,
): void {
  logGateway.error(label, {
    error: formatAttachmentFailureForLog(err),
    consoleMessage: `${label}: ${formatForLog(err)}`,
  });
}

type SideResultPayload = {
  kind: "btw";
  runId: string;
  sessionKey: string;
  agentId?: string;
  question: string;
  text: string;
  isError?: boolean;
  ts: number;
};

function buildTranscriptReplyText(payloads: ReplyPayload[]): string {
  const chunks = payloads
    .map((payload) => {
      if (payload.isReasoning === true) {
        return "";
      }
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
          lines.push(`Attachment: ${trimmed}`);
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
  agentId?: string;
  payloads: ReplyPayload[];
  managedImageLocalRoots?: Parameters<typeof createManagedOutgoingImageBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  onLocalAudioAccessDenied?: (message: string) => void;
  onManagedImagePrepareError?: (message: string) => void;
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

function hasManagedOutgoingAssistantContent(
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

function scheduleChatHistoryManagedImageCleanup(params: {
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

  const sessionDeliveryContext = deliveryContextFromSession(params.entry);
  const routeChannelCandidate = normalizeMessageChannel(
    sessionDeliveryContext?.channel ?? params.entry?.lastChannel ?? params.entry?.origin?.provider,
  );
  const routeToCandidate = sessionDeliveryContext?.to ?? params.entry?.lastTo;
  const routeAccountIdCandidate =
    sessionDeliveryContext?.accountId ??
    params.entry?.lastAccountId ??
    params.entry?.origin?.accountId ??
    undefined;
  const routeThreadIdCandidate =
    sessionDeliveryContext?.threadId ??
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

function explicitOriginTargetsPluginBinding(origin: ChatSendExplicitOrigin | undefined): boolean {
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
  return isPluginOwnedSessionBindingRecord(binding);
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
  // imageOrder now only tracks image slots (see chat-attachments.ts), so split
  // offloaded refs by mime: image offloads interleave with inline images via
  // imageOrder, and non-image offloads append to the transcript tail. Without
  // this split a non-image file would consume the next image slot whenever
  // both kinds appear in the same request.
  const imageOffloadedSaved: SavedMedia[] = [];
  const nonImageOffloadedSaved: SavedMedia[] = [];
  for (const ref of params.offloadedRefs) {
    const entry: SavedMedia = {
      id: ref.id,
      path: ref.path,
      size: 0,
      contentType: ref.mimeType,
    };
    if (ref.mimeType.startsWith("image/")) {
      imageOffloadedSaved.push(entry);
    } else {
      nonImageOffloadedSaved.push(entry);
    }
  }
  if (params.imageOrder.length === 0) {
    return [...inlineSaved, ...imageOffloadedSaved, ...nonImageOffloadedSaved];
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
    const offloaded = imageOffloadedSaved[offloadedIndex++];
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
  for (; offloadedIndex < imageOffloadedSaved.length; offloadedIndex++) {
    const offloaded = imageOffloadedSaved[offloadedIndex];
    if (offloaded) {
      saved.push(offloaded);
    }
  }
  for (const offloaded of nonImageOffloadedSaved) {
    saved.push(offloaded);
  }
  return saved;
}

function stripTrailingOffloadedMediaMarkers(message: string, refs: OffloadedRef[]): string {
  if (refs.length === 0) {
    return message;
  }
  const removableRefs = new Set(refs.map((ref) => ref.mediaRef));
  const lines = message.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? "";
    const match = /^\[media attached:\s*(media:\/\/inbound\/[^\]\s]+)\]$/.exec(last);
    if (!match?.[1] || !removableRefs.delete(match[1])) {
      break;
    }
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

// Stages media-path offloads into the agent sandbox synchronously so chat.send
// can surface 5xx before respond(). Throws MediaOffloadError on any staging
// failure (ENOSPC / EPERM / partial-stage) so the outer chat.send handler can
// map it to UNAVAILABLE (5xx); plain Error would be misclassified as 4xx. All
// offloaded refs are cleaned up from the media store before rethrow.
// Callers MUST set ctx.MediaStaged=true when this runs so the dispatch
// pipeline skips its own stageSandboxMedia pass.
//
// Returned paths are absolute media-store paths when no sandbox is active, or
// sandbox-relative paths plus `workspaceDir` when sandboxing is active. Host-side
// media-understanding uses MediaWorkspaceDir to resolve those relative paths.
async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  includeImageRefs?: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): Promise<{ paths: string[]; types: string[]; workspaceDir?: string }> {
  const mediaPathRefs = params.offloadedRefs.filter(
    (ref) => params.includeImageRefs || !ref.mimeType.startsWith("image/"),
  );
  if (mediaPathRefs.length === 0) {
    return { paths: [], types: [] };
  }

  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return {
        paths: mediaPathRefs.map((ref) => ref.path),
        types: mediaPathRefs.map((ref) => ref.mimeType),
      };
    }

    // stageSandboxMedia caps each file at STAGED_MEDIA_MAX_BYTES (=
    // MEDIA_MAX_BYTES, 5MB) and silently skips oversized files. The parse cap
    // (resolveChatAttachmentMaxBytes, default 20MB) is higher, so a sandboxed
    // session receiving a file between the two caps would otherwise
    // pass parse, fail staging, and surface as a retryable 5xx even though
    // retry cannot succeed. Reject here as a client-side 4xx instead.
    const oversizedForSandbox = mediaPathRefs.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      MediaPath: mediaPathRefs[0].path,
      MediaPaths: mediaPathRefs.map((ref) => ref.path),
      MediaType: mediaPathRefs[0].mimeType,
      MediaTypes: mediaPathRefs.map((ref) => ref.mimeType),
    };
    const stageResult = await stageSandboxMedia({
      ctx: stagingCtx,
      sessionCtx: stagingCtx as TemplateContext,
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });

    // stageSandboxMedia silently keeps unstaged entries as their original
    // absolute path, so length parity with `nonImage` does not prove every
    // file landed in the sandbox. The RPC max (20MB via
    // resolveChatAttachmentMaxBytes) admits files above the staging cap
    // (STAGED_MEDIA_MAX_BYTES = 5MB); check the returned `staged` map so any
    // missing source becomes a 5xx MediaOffloadError the client can retry.
    const stagedSources = stageResult.staged;
    const missing = mediaPathRefs.filter((ref) => !stagedSources.has(ref.path));
    if (missing.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${mediaPathRefs.length} paths staged into sandbox workspace (missing: ${missing.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedPaths = stagingCtx.MediaPaths ?? [];
    const stagedTypes = stagingCtx.MediaTypes ?? mediaPathRefs.map((ref) => ref.mimeType);

    // Keep stagedPaths sandbox-relative (e.g. `media/inbound/foo.pdf`) so the
    // agent inside the container can read them. Host-side media-understanding
    // resolves them via ctx.MediaWorkspaceDir, which we carry separately.
    return { paths: stagedPaths, types: stagedTypes, workspaceDir: sandbox.workspaceDir };
  } catch (err) {
    await Promise.allSettled(
      params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")),
    );
    if (err instanceof MediaOffloadError) {
      throw err;
    }
    // Sandbox-oversize rejections are client-side 4xx (see check above). Wrapping
    // them as MediaOffloadError would misclassify them as retryable 5xx.
    if (err instanceof UnsupportedAttachmentError) {
      throw err;
    }
    throw new MediaOffloadError(
      `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

type ChatSendManagedMediaFields = Partial<
  Pick<MsgContext, "MediaPath" | "MediaPaths" | "MediaType" | "MediaTypes">
>;

function resolveChatSendManagedMediaFields(savedImages: SavedMedia[]): ChatSendManagedMediaFields {
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

function applyChatSendManagedMediaFields(ctx: MsgContext, fields: ChatSendManagedMediaFields) {
  if (!ctx.MediaStaged) {
    Object.assign(ctx, fields);
    return;
  }

  if (ctx.MediaPath === undefined && fields.MediaPath !== undefined) {
    ctx.MediaPath = fields.MediaPath;
  }
  if (ctx.MediaPaths === undefined && fields.MediaPaths !== undefined) {
    ctx.MediaPaths = fields.MediaPaths;
  }
  if (ctx.MediaType === undefined && fields.MediaType !== undefined) {
    ctx.MediaType = fields.MediaType;
  }
  if (ctx.MediaTypes === undefined && fields.MediaTypes !== undefined) {
    ctx.MediaTypes = fields.MediaTypes;
  }
}

function buildChatSendUserTurnMedia(savedMedia: SavedMedia[]): NonNullable<UserTurnInput["media"]> {
  return savedMedia.map((entry) => ({
    path: entry.path,
    contentType: entry.contentType,
  }));
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
  const rawMetadata =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)["__openclaw"]
      : undefined;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const metadataId = typeof metadata.id === "string" ? metadata.id : undefined;
  const metadataSeq = typeof metadata.seq === "number" ? metadata.seq : undefined;
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: {
      ...(metadataId ? { id: metadataId } : {}),
      ...(metadataSeq !== undefined ? { seq: metadataSeq } : {}),
      truncated: true,
      reason: "oversized",
    },
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

async function findAssistantTranscriptMessageByIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const trimmedIdempotencyKey = idempotencyKey.trim();
  if (!trimmedIdempotencyKey) {
    return null;
  }
  const index = await readSessionTranscriptIndex(transcriptPath);
  const target = index?.entries.toReversed().find((entry) => {
    const message = entry.record.message as Record<string, unknown> | undefined;
    return message?.role === "assistant" && message.idempotencyKey === trimmedIdempotencyKey;
  });
  const message = target?.record.message as Record<string, unknown> | undefined;
  if (!target || !message) {
    return null;
  }
  return { messageId: target.id ?? trimmedIdempotencyKey, message };
}

async function findSourceReplyTranscriptMirrorByIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const found = await findAssistantTranscriptMessageByIdempotencyKey(
    transcriptPath,
    idempotencyKey,
  );
  if (found?.message.provider !== "openclaw" || found.message.model !== "delivery-mirror") {
    return null;
  }
  return found;
}

function extractAssistantTranscriptText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? ((block as { text: string }).text.trim() ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

async function findSourceReplyTranscriptMirrorByMetadata(params: {
  transcriptPath: string;
  idempotencyKey: string;
  metadata: NonNullable<ReturnType<typeof getReplyPayloadMetadata>>["sourceReplyTranscriptMirror"];
}): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const byIdempotencyKey = await findSourceReplyTranscriptMirrorByIdempotencyKey(
    params.transcriptPath,
    params.idempotencyKey,
  );
  if (byIdempotencyKey) {
    return byIdempotencyKey;
  }
  const expectedText = resolveMirroredTranscriptText({
    text: params.metadata?.text,
    mediaUrls: params.metadata?.mediaUrls,
  });
  if (!expectedText) {
    return null;
  }
  const index = await readSessionTranscriptIndex(params.transcriptPath);
  const target = index?.entries.toReversed().find((entry) => {
    const message = entry.record.message as Record<string, unknown> | undefined;
    return (
      typeof entry.id === "string" &&
      entry.id.trim().length > 0 &&
      message?.role === "assistant" &&
      message.provider === "openclaw" &&
      message.model === "delivery-mirror" &&
      extractAssistantTranscriptText(message) === expectedText
    );
  });
  const message = target?.record.message as Record<string, unknown> | undefined;
  if (!target?.id || !message) {
    return null;
  }
  return { messageId: target.id, message };
}

async function appendAssistantTranscriptMessage(params: {
  sessionKey: string;
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
  ttsSupplement?: GatewayInjectedTtsSupplementMarker;
  cfg?: OpenClawConfig;
}): Promise<TranscriptAppendResult> {
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

  if (params.idempotencyKey) {
    const existing = await findAssistantTranscriptMessageByIdempotencyKey(
      transcriptPath,
      params.idempotencyKey,
    );
    if (existing) {
      return { ok: true, messageId: existing.messageId, message: existing.message };
    }
  }

  return await appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    label: params.label,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
    ttsSupplement: params.ttsSupplement,
    config: params.cfg,
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
      agentId: active.agentId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

async function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}): Promise<void> {
  if (params.snapshots.length === 0) {
    return;
  }
  for (const snapshot of params.snapshots) {
    const sessionLoadOptions =
      params.sessionKey === "global" && snapshot.agentId
        ? { agentId: snapshot.agentId }
        : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(params.sessionKey, sessionLoadOptions);
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = await appendAssistantTranscriptMessage({
      sessionKey: params.sessionKey,
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      cfg,
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
    chatAbortedRuns: context.chatAbortedRuns,
    clearChatRunState: context.clearChatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    getRuntimeConfig: context.getRuntimeConfig,
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

function canRequesterAbortChatRunWithoutSessionMatch(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  return Boolean(
    (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) ||
    (ownerConnId && requester.connId && ownerConnId === requester.connId),
  );
}

function readPreRegisteredAgentDedupePayloadForSession(params: {
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
  runId: string;
  sessionKey: string;
  agentId?: string;
  defaultAgentId: string;
  includeHidden?: boolean;
}): PreRegisteredAgentDedupePayload | undefined {
  if (!params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (!params.includeHidden && payload.controlUiVisible === false) {
    return undefined;
  }
  const payloadRunId = normalizeUnknownText(payload.runId);
  if (payloadRunId && payloadRunId !== params.runId) {
    return undefined;
  }
  if (normalizeUnknownText(payload.sessionKey) !== params.sessionKey) {
    return undefined;
  }
  const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
  if (agentId) {
    const parsed = parseAgentSessionKey(params.sessionKey);
    const sessionAgentId =
      params.sessionKey === "global"
        ? resolveStoredGlobalRunAgentId(
            normalizeUnknownText(payload.agentId),
            params.defaultAgentId,
          )
        : parsed?.agentId
          ? normalizeAgentId(parsed.agentId)
          : undefined;
    if (sessionAgentId && sessionAgentId !== agentId) {
      return undefined;
    }
  }
  return payload;
}

function readPreRegisteredAgentRun(params: {
  key: string;
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
}): PreRegisteredAgentRun | undefined {
  if (!params.key.startsWith("agent:") || !params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (payload.controlUiVisible === false) {
    return undefined;
  }
  const runId = normalizeUnknownText(payload.runId) ?? normalizeOptionalText(params.key.slice(6));
  const sessionKey = normalizeUnknownText(payload.sessionKey);
  if (!runId || !sessionKey) {
    return undefined;
  }
  return { runId, sessionKey, payload };
}

function canRequesterAbortPreRegisteredAgentRun(
  payload: PreRegisteredAgentDedupePayload,
  requester: ChatAbortRequester,
): boolean {
  return canRequesterAbortChatRun(
    {
      controller: new AbortController(),
      sessionId: "",
      sessionKey: normalizeUnknownText(payload.sessionKey) ?? "",
      startedAtMs: 0,
      expiresAtMs: 0,
      ownerConnId: normalizeUnknownText(payload.ownerConnId),
      ownerDeviceId: normalizeUnknownText(payload.ownerDeviceId),
      controlUiVisible: payload.controlUiVisible === false ? false : undefined,
      kind: "agent",
    },
    requester,
  );
}

function resolvePreRegisteredAgentDedupeKeys(
  payload: PreRegisteredAgentDedupePayload,
  runId: string,
): string[] {
  const keys = [`agent:${runId}`];
  const payloadKeys = Array.isArray(payload.dedupeKeys) ? payload.dedupeKeys : [];
  for (const key of payloadKeys) {
    const normalized = normalizeUnknownText(key);
    if (normalized?.startsWith("agent:")) {
      keys.push(normalized);
    }
  }
  return uniqueStrings(keys);
}

function resolveStoredGlobalRunAgentId(
  agentId: string | undefined,
  defaultAgentId: string,
): string {
  return normalizeOptionalText(agentId)?.toLowerCase() ?? defaultAgentId.toLowerCase();
}

function writePreRegisteredAgentAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
  stopReason: string;
  endedAt?: number;
}) {
  const endedAt = params.endedAt ?? Date.now();
  const payloadAgentId = normalizeUnknownText(params.payload.agentId);
  for (const key of resolvePreRegisteredAgentDedupeKeys(params.payload, params.runId)) {
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key,
      entry: {
        ts: endedAt,
        ok: true,
        payload: {
          runId: params.runId,
          sessionKey: params.sessionKey,
          ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
          ...(params.payload.controlUiVisible === false ? { controlUiVisible: false } : {}),
          status: "timeout" as const,
          summary: "aborted",
          stopReason: params.stopReason,
          endedAt,
        },
      },
    });
  }
}

function resolveAuthorizedPreRegisteredAgentRunsForSessionKeys(params: {
  context: GatewayRequestContext;
  sessionKeys: Iterable<string>;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const authorizedByRunId = new Map<string, PreRegisteredAgentRun>();
  let matchedSessionRuns = 0;
  for (const [key, entry] of params.context.dedupe) {
    const run = readPreRegisteredAgentRun({ key, entry });
    if (!run || !sessionKeys.has(run.sessionKey)) {
      continue;
    }
    if (params.context.chatAbortControllers.has(run.runId)) {
      continue;
    }
    const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
    if (
      agentId &&
      run.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(
        normalizeUnknownText(run.payload.agentId),
        params.defaultAgentId,
      ) !== agentId
    ) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortPreRegisteredAgentRun(run.payload, params.requester)) {
      authorizedByRunId.set(run.runId, run);
    }
  }
  return {
    matchedSessionRuns,
    authorizedRuns: [...authorizedByRunId.values()],
  };
}

function resolveAuthorizedRunsForSessionKeys(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const sessionIds = new Set(
    Array.from(params.sessionIds ?? [], (sessionId) => normalizeOptionalText(sessionId)).filter(
      (sessionId): sessionId is string => Boolean(sessionId),
    ),
  );
  const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
  const authorizedRuns: Array<{ runId: string; sessionKey: string }> = [];
  let matchedSessionRuns = 0;
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.controlUiVisible === false) {
      continue;
    }
    if (!sessionKeys.has(active.sessionKey) && !sessionIds.has(active.sessionId)) {
      continue;
    }
    if (
      agentId &&
      active.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(active.agentId, params.defaultAgentId) !== agentId
    ) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortChatRun(active, params.requester)) {
      authorizedRuns.push({ runId, sessionKey: active.sessionKey });
    }
  }
  return {
    matchedSessionRuns,
    authorizedRuns,
  };
}

async function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  persistSessionKey?: string;
  defaultAgentId: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
}): Promise<{ aborted: boolean; runIds: string[]; unauthorized: boolean }> {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const { matchedSessionRuns, authorizedRuns } = resolveAuthorizedRunsForSessionKeys({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
  });
  const {
    matchedSessionRuns: matchedPendingAgentRuns,
    authorizedRuns: authorizedPendingAgentRuns,
  } = resolveAuthorizedPreRegisteredAgentRunsForSessionKeys({
    context: params.context,
    sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
  });
  if (authorizedRuns.length === 0 && authorizedPendingAgentRuns.length === 0) {
    return {
      aborted: false,
      runIds: [],
      unauthorized: matchedSessionRuns > 0 || matchedPendingAgentRuns > 0,
    };
  }
  const authorizedRunIdSet = new Set(authorizedRuns.map((run) => run.runId));
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  const runIds: string[] = [];
  for (const { runId, sessionKey } of authorizedRuns) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const endedAt = Date.now();
  const stopReason = params.stopReason ?? "rpc";
  for (const { runId, sessionKey, payload } of authorizedPendingAgentRuns) {
    writePreRegisteredAgentAbort({
      context: params.context,
      runId,
      sessionKey,
      payload,
      stopReason,
      endedAt,
    });
    runIds.push(runId);
  }
  const res = { aborted: runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted) {
    await persistAbortedPartials({
      context: params.context,
      sessionKey: params.persistSessionKey ?? params.sessionKey,
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
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  runId: string;
  sessionKey: string;
  agentId?: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
    state: "final" as const,
    message: projectChatDisplayMessage(params.message),
  };
  params.context.broadcast("chat", payload);
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.sessionKey,
    agentId: payloadAgentId,
    event: "chat",
    payload,
  });
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
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  payload: SideResultPayload;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.payload.runId);
  const payloadAgentId =
    params.payload.sessionKey === "global" ? params.payload.agentId : undefined;
  const payload = {
    ...params.payload,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
  };
  params.context.broadcast("chat.side_result", payload);
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.payload.sessionKey,
    agentId: payloadAgentId,
    event: "chat.side_result",
    payload,
  });
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  runId: string;
  sessionKey: string;
  agentId?: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;
  const errorText = params.errorMessage?.trim();
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
    ...(errorText
      ? {
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text:
                  errorText.startsWith("⚠️") || errorText.startsWith("Error:")
                    ? errorText
                    : `Error: ${errorText}`,
              },
            ],
            timestamp: Date.now(),
          },
        }
      : {}),
  };
  params.context.broadcast("chat", payload);
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.sessionKey,
    agentId: payloadAgentId,
    event: "chat",
    payload,
  });
  params.context.agentRunSeq.delete(params.runId);
}

function sendGlobalAwareNodeChatPayload(params: {
  context: Pick<GatewayRequestContext, "nodeSendToSession"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  sessionKey: string;
  agentId?: string;
  event: string;
  payload: unknown;
}) {
  const deliveryKeys = resolveGlobalAwareNodeChatDeliveryKeys({
    cfg: params.context.getRuntimeConfig?.() ?? ({} as OpenClawConfig),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  for (const deliveryKey of deliveryKeys) {
    params.context.nodeSendToSession(deliveryKey, params.event, params.payload);
  }
}

function resolveGlobalAwareNodeChatDeliveryKeys(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): string[] {
  if (params.sessionKey !== "global") {
    return [params.sessionKey];
  }
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const scopedAgentId = params.agentId ?? defaultAgentId;
  const keys = [`agent:${scopedAgentId}:global`];
  if (scopedAgentId === defaultAgentId) {
    keys.push("global");
  }
  return keys;
}

function isSourceReplyTranscriptMirrorPayload(payload: ReplyPayload | undefined) {
  return Boolean(payload && getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror);
}

function readChatHistoryRecordTimestampMs(message: unknown): number | undefined {
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const value = meta?.recordTimestampMs;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const timestamp = asOptionalRecord(message)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function isSubagentAnnounceInterSessionUserChatHistoryMessage(message: unknown): boolean {
  const record = asOptionalRecord(message);
  if (!record || record.role !== "user") {
    return false;
  }
  const provenance = normalizeInputProvenance(record.provenance);
  if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") {
    return true;
  }
  const text = extractChatHistoryBlockText(record);
  return (
    typeof text === "string" &&
    text.includes(INTER_SESSION_PROMPT_PREFIX_BASE) &&
    text.includes("sourceTool=subagent_announce")
  );
}

function isChatHistoryAssistantMessage(message: unknown): boolean {
  return asOptionalRecord(message)?.role === "assistant";
}

export function dropPreSessionStartAnnouncePairs(
  messages: unknown[],
  sessionStartedAt: number | undefined,
): unknown[] {
  if (sessionStartedAt === undefined || messages.length === 0) {
    return messages;
  }
  let changed = false;
  const kept: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (isSubagentAnnounceInterSessionUserChatHistoryMessage(current)) {
      const ts = readChatHistoryRecordTimestampMs(current);
      if (typeof ts === "number" && ts < sessionStartedAt) {
        const next = messages[i + 1];
        const nextTs = readChatHistoryRecordTimestampMs(next);
        if (
          isChatHistoryAssistantMessage(next) &&
          typeof nextTs === "number" &&
          nextTs < sessionStartedAt
        ) {
          // Skip only an assistant reply that is also pre-session-start; recent
          // or timestampless assistants may be real fresh-session context.
          i++;
        }
        changed = true;
        continue;
      }
    }
    kept.push(current);
  }
  return changed ? kept : messages;
}

function readChatHistoryMessageId(message: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return typeof metadata?.id === "string" ? metadata.id : undefined;
}

async function isChatMessageIdVisibleAfterHistoryFilters(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile: string | undefined;
  messageId: string;
  sessionStartedAt?: number;
}): Promise<boolean> {
  if (params.sessionStartedAt === undefined) {
    return true;
  }
  const messages = await readSessionMessagesAsync(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    {
      mode: "full",
      reason: "chat.message.get visibility",
    },
  );
  return dropPreSessionStartAnnouncePairs(messages, params.sessionStartedAt).some(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
}

function dropLocalHistoryOverreadContextMessage(
  messages: unknown[],
  contextMessage: unknown,
): unknown[] {
  if (contextMessage === undefined) {
    return messages;
  }
  const index = messages.indexOf(contextMessage);
  if (index < 0) {
    return messages;
  }
  return [...messages.slice(0, index), ...messages.slice(index + 1)];
}

async function handleChatHistoryRequest({
  params,
  respond,
  context,
  method,
  includeAgentsList,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
  includeAgentsList?: boolean;
}) {
  if (!validateChatHistoryParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${method} params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
      ),
    );
    return;
  }
  const { sessionKey, limit, maxChars } = params as {
    sessionKey: string;
    agentId?: string;
    limit?: number;
    maxChars?: number;
  };
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const requestedAgentId = resolveRequestedChatAgentId({
    cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
    requestedSessionKey: sessionKey,
    agentId: agentIdOverride,
  });
  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntry(
    sessionKey,
    sessionLoadOptions,
  );
  const selectedAgent = validateChatSelectedAgent({
    cfg,
    requestedSessionKey: sessionKey,
    agentId: requestedAgentId,
  });
  if (!selectedAgent.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
    return;
  }
  const sessionId = entry?.sessionId;
  const sessionAgentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: selectedAgent.agentId,
  });
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const rawHistoryWindow = resolveSessionHistoryTailReadOptions(max);
  const localHistoryReadOptions = {
    maxMessages: rawHistoryWindow.maxMessages + 1,
    maxLines: rawHistoryWindow.maxLines + 1,
  };
  const localMessages =
    sessionId && storePath
      ? await readRecentSessionMessagesAsync(sessionId, storePath, entry?.sessionFile, {
          ...localHistoryReadOptions,
          maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
        })
      : [];
  const overreadContextMessage =
    localMessages.length > rawHistoryWindow.maxMessages ? localMessages[0] : undefined;
  const localMessagesWithBoundaryFilter = dropLocalHistoryOverreadContextMessage(
    dropPreSessionStartAnnouncePairs(
      localMessages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    ),
    overreadContextMessage,
  );
  const rawMessages = augmentChatHistoryWithCliSessionImports({
    entry,
    provider: resolvedSessionModel.provider,
    localMessages: localMessagesWithBoundaryFilter,
  });
  // Drop subagent_announce pairs (user inter-session announce + adjacent
  // assistant) whose record timestamp predates the current session's
  // sessionStartedAt. Run after CLI history imports too, because those
  // timestamped messages share the same chat.history response surface.
  const recencyFilteredMessages = dropPreSessionStartAnnouncePairs(
    rawMessages,
    typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
  );
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
  const normalized = augmentChatHistoryWithCanvasBlocks(
    projectRecentChatDisplayMessages(recencyFilteredMessages, {
      maxChars: effectiveMaxChars,
      maxMessages: max,
    }),
  );
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  scheduleChatHistoryManagedImageCleanup({
    sessionKey,
    ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
    context,
  });
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
  const modelCatalog = await measureDiagnosticsTimelineSpan(
    `gateway.${method}.model_catalog`,
    () => loadOptionalServerMethodModelCatalog(context, method),
    {
      config: cfg,
      phase: method,
    },
  );
  const sessionInfo = buildGatewaySessionInfo({
    cfg,
    storePath,
    store,
    key: canonicalKey,
    entry,
    agentId: selectedAgent.agentId,
    modelCatalog,
  });
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const activeRunAgentId =
    canonicalKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : selectedAgent.agentId;
  sessionInfo.hasActiveRun = hasTrackedActiveSessionRun({
    context,
    requestedKey: sessionKey,
    canonicalKey,
    ...(activeRunAgentId ? { agentId: activeRunAgentId } : {}),
    defaultAgentId,
  });
  const defaults = getSessionDefaults(cfg, modelCatalog, { allowPluginNormalization: false });
  const thinkingLevel = sessionInfo.thinkingLevel ?? sessionInfo.thinkingDefault;
  const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
  sessionInfo.verboseLevel = verboseLevel;
  // Surface any run still streaming for this session+agent so a client that
  // switched away (and stopped receiving the run's per-agent-delivered events)
  // can restore the in-flight assistant text on switch-back.
  const inFlightRun = resolveInFlightRunSnapshot({
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    requestedSessionKey: sessionKey,
    canonicalSessionKey: resolveSessionStoreKey({ cfg, sessionKey }),
    agentId: activeRunAgentId,
    defaultAgentId,
  });
  const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
    snapshot: inFlightRun,
    messages: bounded.messages,
    maxBytes: maxHistoryBytes,
  });
  const payload = {
    sessionKey,
    sessionId,
    messages: bounded.messages,
    defaults,
    sessionInfo,
    thinkingLevel,
    fastMode: entry?.fastMode,
    verboseLevel,
    ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
    ...(includeAgentsList ? { agentsList: listAgentsForGateway(cfg, modelCatalog) } : {}),
  };
  respond(true, payload);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async (opts) => {
    await handleChatHistoryRequest({ ...opts, method: "chat.history" });
  },
  "chat.startup": async (opts) => {
    await handleChatHistoryRequest({ ...opts, method: "chat.startup", includeAgentsList: true });
  },
  "chat.message.get": async ({ params, respond, context }) => {
    if (!validateChatMessageGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.message.get params: ${formatValidationErrors(validateChatMessageGetParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, messageId, maxChars } = params as {
      sessionKey: string;
      agentId?: string;
      messageId: string;
      maxChars?: number;
    };
    const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: sessionKey,
      agentId: agentIdOverride,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: sessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }

    const resolved = await readSessionMessageByIdAsync(
      sessionId,
      storePath,
      entry?.sessionFile,
      messageId,
    );
    if (!resolved.found) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    const visible = await isChatMessageIdVisibleAfterHistoryFilters({
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      messageId,
      sessionStartedAt:
        typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    });
    if (!visible) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    if (resolved.oversized) {
      respond(true, { ok: false, unavailableReason: "oversized" });
      return;
    }

    const effectiveMaxChars =
      typeof maxChars === "number" ? maxChars : Math.min(MAX_PAYLOAD_BYTES, 1_000_000);
    const projectedMessage = resolved.message
      ? projectChatDisplayMessage(resolved.message, {
          maxChars: effectiveMaxChars,
        })
      : undefined;
    const projected = projectedMessage
      ? augmentChatHistoryWithCanvasBlocks([projectedMessage])[0]
      : undefined;
    if (!projected) {
      respond(true, { ok: false, unavailableReason: "not_visible" });
      return;
    }

    respond(true, {
      ok: true,
      message: projected,
    });
  },
  "chat.abort": async ({ params, respond, context, client }) => {
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
      agentId?: string;
      runId?: string;
    };
    const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
    const abortCfg = context.getRuntimeConfig();
    const defaultAgentId = resolveDefaultAgentId(abortCfg);
    const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
    const abortSessionResolvesGlobal =
      resolveSessionStoreKey({ cfg: abortCfg, sessionKey: rawSessionKey }) === "global";
    const inferredGlobalAgentId =
      !agentIdOverride && parsedAbortSessionKey && abortSessionResolvesGlobal
        ? normalizeAgentId(parsedAbortSessionKey.agentId)
        : undefined;
    const abortAgentId =
      agentIdOverride ??
      inferredGlobalAgentId ??
      (abortSessionResolvesGlobal ? defaultAgentId : undefined);
    if (
      agentIdOverride &&
      parsedAbortSessionKey &&
      normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
        ),
      );
      return;
    }
    const canonicalAbortSessionKey =
      abortAgentId && abortSessionResolvesGlobal ? "global" : rawSessionKey;

    const ops = createChatAbortOps(context);
    const requester = resolveChatAbortRequester(client);

    if (!runId) {
      const res = await abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: canonicalAbortSessionKey,
        sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
        agentId: abortAgentId,
        defaultAgentId,
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
    const normalizedAgentIdOverride = abortAgentId?.toLowerCase();

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
      const pendingAgentMatch = (() => {
        const canonicalMatch = readPreRegisteredAgentDedupePayloadForSession({
          entry: pendingAgentEntry,
          runId,
          sessionKey: canonicalAbortSessionKey,
          agentId: abortAgentId,
          defaultAgentId,
          includeHidden: true,
        });
        if (canonicalMatch) {
          return { sessionKey: canonicalAbortSessionKey, payload: canonicalMatch };
        }
        if (rawSessionKey === canonicalAbortSessionKey) {
          return undefined;
        }
        const aliasMatch = readPreRegisteredAgentDedupePayloadForSession({
          entry: pendingAgentEntry,
          runId,
          sessionKey: rawSessionKey,
          agentId: abortAgentId,
          defaultAgentId,
          includeHidden: true,
        });
        return aliasMatch ? { sessionKey: rawSessionKey, payload: aliasMatch } : undefined;
      })();
      if (pendingAgentMatch) {
        const pendingAgentPayload = pendingAgentMatch.payload;
        if (!canRequesterAbortPreRegisteredAgentRun(pendingAgentPayload, requester)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
          return;
        }
        writePreRegisteredAgentAbort({
          context,
          runId,
          sessionKey: pendingAgentMatch.sessionKey,
          payload: pendingAgentPayload,
          stopReason: "rpc",
        });
        respond(true, { ok: true, aborted: true, runIds: [runId] });
        return;
      }
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    const abortSessionKeysForRun = new Set([rawSessionKey, canonicalAbortSessionKey]);
    if (
      !abortSessionKeysForRun.has(active.sessionKey) &&
      !canRequesterAbortChatRunWithoutSessionMatch(active, requester)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }
    if (
      normalizedAgentIdOverride &&
      active.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(active.agentId, defaultAgentId) !== normalizedAgentIdOverride
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
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
      sessionKey: active.sessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && active.controlUiVisible !== false && partialText && partialText.trim()) {
      await persistAbortedPartials({
        context,
        sessionKey: active.sessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            agentId: active.agentId,
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
      agentId?: string;
      sessionId?: string;
      message: string;
      thinking?: string;
      fastMode?: boolean;
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
    const agentIdOverride = normalizeOptionalText(p.agentId);
    const clientRunId = p.idempotencyKey;
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: agentIdOverride,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const {
      cfg,
      entry,
      canonicalKey: sessionKey,
    } = measureDiagnosticsTimelineSpanSync(
      "gateway.chat_send.load_session",
      () => loadSessionEntry(rawSessionKey, sessionLoadOptions),
      {
        phase: "agent-turn",
        attributes: {
          runId: clientRunId,
          hasAttachments: normalizedAttachments.length > 0,
          hasExplicitOrigin: explicitOriginResult.value !== undefined,
        },
      },
    );
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const requestedSessionId = normalizeOptionalText(p.sessionId);
    const backingSessionId = entry?.sessionId ?? requestedSessionId;
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
      agentId: selectedAgent.agentId,
    });
    const activeRunScopeKey = resolveChatSendActiveScopeKey({
      sessionKey,
      agentId: selectedAgent.agentId,
      mainKey: cfg.session?.mainKey,
    });
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, agentId);
    const resolvedSessionAuthProvider = resolveProviderIdForAuth(resolvedSessionModel.provider, {
      config: cfg,
    });
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    let imageOrder: PromptImageOrderEntry[] = [];
    let offloadedRefs: OffloadedRef[] = [];
    let mediaPathOffloadPaths: string[] = [];
    let mediaPathOffloadTypes: string[] = [];
    let mediaPathOffloadWorkspaceDir: string | undefined;
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();

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
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const stopAgentId =
        sessionKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : selectedAgent.agentId;
      const res = await abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        sessionKeyAliases: sessionKey === rawSessionKey ? undefined : [sessionKey],
        agentId: stopAgentId,
        sessionId: entry?.sessionId,
        persistSessionKey: sessionKey,
        defaultAgentId,
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
    const clientInfo = client?.connect?.client;
    const chatSendTraceAttributes = {
      runId: clientRunId,
      sessionKey,
      agentId: selectedAgent.agentId ?? agentId,
      provider: resolvedSessionModel.provider,
      model: resolvedSessionModel.model,
      hasAttachments: normalizedAttachments.length > 0,
      hasExplicitOrigin: explicitOriginResult.value !== undefined,
      hasConnectedClient: client?.connect !== undefined,
    };
    const originatingRoute = resolveChatSendOriginatingRoute({
      client: clientInfo,
      deliver: p.deliver,
      entry,
      explicitOrigin: explicitOriginResult.value,
      hasConnectedClient: client?.connect !== undefined,
      mainKey: cfg.session?.mainKey,
      sessionKey,
    });
    const activeChatSendDedupeKey = buildActiveChatSendDedupeKey({
      attachmentCount: normalizedAttachments.length,
      explicitDeliverRoute: originatingRoute.explicitDeliverRoute,
      message: rawMessage,
      originatingChannel: originatingRoute.originatingChannel,
      sessionKey: activeRunScopeKey,
    });
    if (activeChatSendDedupeKey) {
      const activeRunId = resolveActiveChatSendRunId(
        context.dedupe.get(activeChatSendDedupeKey)?.payload,
      );
      if (activeRunId && context.chatAbortControllers.has(activeRunId)) {
        respond(true, { runId: activeRunId, status: "in_flight" as const }, undefined, {
          cached: true,
          runId: activeRunId,
        });
        return;
      }
    }
    const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(
      explicitOriginResult.value,
    );
    if (normalizedAttachments.length > 0) {
      try {
        await measureDiagnosticsTimelineSpan(
          "gateway.chat_send.prepare_attachments",
          async () => {
            const supportsSessionModelImages = await resolveGatewayModelSupportsImages({
              loadGatewayModelCatalog: context.loadGatewayModelCatalog,
              provider: resolvedSessionModel.provider,
              model: resolvedSessionModel.model,
            });
            const explicitOriginSupportsInlineImages =
              explicitOriginTargetsAcpSession(explicitOriginResult.value) ||
              explicitOriginTargetsPlugin;
            // Bound plugin sessions own the real recipient model, so keep image
            // attachments even when the parent OpenClaw session model is text-only.
            const supportsImages = supportsSessionModelImages || explicitOriginSupportsInlineImages;
            const routeImageOffloadsAsMediaPaths = !supportsImages;
            const parsed = await parseMessageWithAttachments(
              inboundMessage,
              normalizedAttachments,
              {
                maxBytes: resolveChatAttachmentMaxBytes(cfg),
                log: context.logGateway,
                supportsImages,
                // chat.send routes selected offloadedRefs into ctx.MediaPaths below
                // so the auto-reply stage pipeline can surface them to the agent.
                acceptNonImage: true,
              },
            );
            parsedMessage = stripTrailingOffloadedMediaMarkers(
              parsed.message,
              routeImageOffloadsAsMediaPaths
                ? parsed.offloadedRefs.filter((ref) => ref.mimeType.startsWith("image/"))
                : [],
            );
            parsedImages = parsed.images;
            imageOrder = routeImageOffloadsAsMediaPaths ? [] : parsed.imageOrder;
            offloadedRefs = parsed.offloadedRefs;
            ({
              paths: mediaPathOffloadPaths,
              types: mediaPathOffloadTypes,
              workspaceDir: mediaPathOffloadWorkspaceDir,
            } = await prestageMediaPathOffloads({
              offloadedRefs,
              // Text-only image offloads need ctx.MediaPaths so media-understanding
              // can describe them via agents.defaults.imageModel. Vision-capable
              // image offloads stay as prompt refs for native image loading.
              includeImageRefs: routeImageOffloadsAsMediaPaths,
              cfg,
              sessionKey,
              agentId,
            }));
          },
          {
            phase: "agent-turn",
            config: cfg,
            attributes: {
              ...chatSendTraceAttributes,
              attachmentCount: normalizedAttachments.length,
            },
          },
        );
      } catch (err) {
        logAttachmentFailure(context.logGateway, "chat.send attachment parse/stage failed", err);
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
      const activeRunAbort = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: clientRunId,
        sessionId: backingSessionId ?? clientRunId,
        sessionKey,
        agentId: selectedAgent.agentId,
        timeoutMs,
        now,
        ownerConnId: normalizeOptionalText(client?.connId),
        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
        providerId: resolvedSessionModel.provider,
        authProviderId: resolvedSessionAuthProvider,
        kind: "chat-send",
      });
      if (!activeRunAbort.registered) {
        respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      if (activeChatSendDedupeKey) {
        context.dedupe.set(activeChatSendDedupeKey, {
          ts: now,
          ok: true,
          payload: { runId: clientRunId },
        });
      }
      context.addChatRun(clientRunId, {
        sessionKey,
        agentId: selectedAgent.agentId,
        clientRunId,
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: "gateway.chat_send.ack_ready",
          phase: "agent-turn",
          attributes: {
            ...chatSendTraceAttributes,
            ackStatus: ackPayload.status,
          },
        },
        { config: cfg },
      );
      respond(true, ackPayload, undefined, { runId: clientRunId });
      const persistedImagesPromise = persistChatSendImages({
        images: parsedImages,
        imageOrder,
        offloadedRefs,
        client,
        logGateway: context.logGateway,
      });
      let persistedMediaForTranscript: SavedMedia[] | undefined;
      const getPersistedMediaForTranscript = async () => {
        if (!persistedMediaForTranscript) {
          persistedMediaForTranscript = await persistedImagesPromise;
        }
        return persistedMediaForTranscript;
      };
      const preparedUserTurnMediaPromise =
        normalizedAttachments.length > 0 ? getPersistedMediaForTranscript() : Promise.resolve([]);
      const userTurnMediaPromise = preparedUserTurnMediaPromise.then(buildChatSendUserTurnMedia);
      const baseUserTurnInput: UserTurnInput = {
        text: rawMessage,
        timestamp: now,
        idempotencyKey: `${clientRunId}:user`,
        ...(systemInputProvenance ? { provenance: systemInputProvenance } : {}),
      };
      const userTurnInputPromise: Promise<UserTurnInput> = userTurnMediaPromise.then((media) => ({
        ...baseUserTurnInput,
        ...(media.length > 0
          ? {
              media,
              mediaOnlyText: "[User sent media without caption]",
            }
          : {}),
      }));
      const pluginBoundMediaFieldsPromise =
        explicitOriginTargetsPlugin && parsedImages.length > 0
          ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields)
          : Promise.resolve({});

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const commandSource = trimmedMessage.startsWith("/") ? "text" : undefined;
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = originatingRoute;
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
        AgentId: agentId,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        ...(commandSource ? { CommandSource: commandSource } : {}),
        CommandAuthorized: true,
        CommandTurn: commandSource
          ? {
              kind: "text-slash",
              source: commandSource,
              authorized: true,
              body: commandBody,
            }
          : {
              kind: "normal",
              source: "message",
              authorized: false,
              body: commandBody,
            },
        MessageSid: clientRunId,
        ...(!isOperatorUiClient(clientInfo)
          ? {
              SenderId: clientInfo?.id,
              SenderName: clientInfo?.displayName,
              SenderUsername: clientInfo?.displayName,
            }
          : {}),
        GatewayClientScopes: client?.connect?.scopes ?? [],
      };
      if (mediaPathOffloadPaths.length > 0) {
        // Inject offloads via the same MsgContext fields the channel
        // path uses so buildInboundMediaNote renders a real `[media attached:
        // <workspace-relative-path>]` line into the agent prompt. Marker
        // blocks the dispatch pipeline from re-running stageSandboxMedia; see
        // prestageMediaPathOffloads.
        ctx.MediaPath = mediaPathOffloadPaths[0];
        ctx.MediaPaths = mediaPathOffloadPaths;
        ctx.MediaType = mediaPathOffloadTypes[0];
        ctx.MediaTypes = mediaPathOffloadTypes;
        ctx.MediaWorkspaceDir = mediaPathOffloadWorkspaceDir;
        ctx.MediaStaged = true;
      }
      const mediaPathOffloadsIncludeImages = mediaPathOffloadTypes.some((type) =>
        type.startsWith("image/"),
      );
      const replyOptionImages = mediaPathOffloadsIncludeImages
        ? undefined
        : parsedImages.length > 0
          ? parsedImages
          : undefined;

      const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const deliveredReplies: Array<{ payload: ReplyPayload; kind: "block" | "final" }> = [];
      let appendedWebchatAgentMedia = false;
      let agentRunStarted = false;
      const userTurnRecorder: UserTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: baseUserTurnInput,
        resolveInput: () => userTurnInputPromise,
        target: () => {
          const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
            sessionKey,
            sessionLoadOptions,
          );
          const resolvedSessionId = latestEntry?.sessionId ?? backingSessionId;
          if (!resolvedSessionId) {
            return undefined;
          }
          return {
            sessionId: resolvedSessionId,
            sessionKey,
            sessionEntry: latestEntry ?? entry,
            storePath: latestStorePath,
            agentId,
            config: cfg,
          };
        },
        errorContext: "gateway chat user turn transcript",
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        onPersistenceError: (error) => {
          context.logGateway.warn(
            `gateway user transcript persistence failed: ${formatForLog(error)}`,
          );
        },
      });
      const persistGatewayUserTurnTranscript = async () => {
        await measureDiagnosticsTimelineSpan(
          "gateway.chat_send.persist_user_transcript",
          async () => {
            await userTurnRecorder.persistFallback();
          },
          {
            phase: "agent-turn",
            config: cfg,
            attributes: chatSendTraceAttributes,
          },
        );
      };
      const persistGatewayUserTurnTranscriptBestEffort = async () => {
        await persistGatewayUserTurnTranscript().catch(() => undefined);
      };
      const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
        if (!agentRunStarted || appendedWebchatAgentMedia || !isMediaBearingPayload(payload)) {
          return;
        }
        if (isSourceReplyTranscriptMirrorPayload(payload)) {
          return;
        }
        const ttsSupplementMarker = buildTtsSupplementTranscriptMarker(payload);
        const [transcriptPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
          cfg,
          sessionKey,
          agentId,
          accountId,
          payloads: [stripVisibleTextFromTtsSupplement(payload)],
        });
        if (!transcriptPayload) {
          return;
        }
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
          sessionKey,
          sessionLoadOptions,
        );
        const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
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
          agentId,
          payloads: [transcriptPayload],
          managedImageLocalRoots: mediaLocalRoots,
          includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
          onManagedImagePrepareError: (message) => {
            context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
          },
        });
        const mediaMessage = await buildWebchatAssistantMediaMessage([transcriptPayload], {
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
        if (!persistedContentForAppend?.length) {
          return;
        }
        const transcriptReply =
          mediaMessage?.transcriptText ??
          extractAssistantDisplayTextFromContent(assistantContent) ??
          buildTranscriptReplyText([transcriptPayload]);
        if (!transcriptReply && !persistedAssistantContent?.length && !assistantContent?.length) {
          return;
        }
        const appended = await appendAssistantTranscriptMessage({
          sessionKey,
          message: transcriptReply,
          ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile,
          agentId,
          createIfMissing: true,
          idempotencyKey: `${clientRunId}:assistant-media`,
          ttsSupplement: ttsSupplementMarker,
          cfg,
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
          if (getReplyPayloadMetadata(payload)?.beforeAgentRunBlocked === true) {
            userTurnRecorder.markBlocked();
          }
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

      void measureDiagnosticsTimelineSpan(
        "gateway.chat_send.dispatch_inbound",
        async () => {
          applyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);
          const dispatchResult = await dispatchInboundMessage({
            ctx,
            cfg,
            dispatcher,
            replyOptions: {
              runId: clientRunId,
              abortSignal: activeRunAbort.controller.signal,
              images: replyOptionImages,
              imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
              thinkingLevelOverride: p.thinking,
              fastModeOverride: p.fastMode,
              userTurnTranscriptRecorder: userTurnRecorder,
              onAgentRunStart: (runId) => {
                agentRunStarted = true;
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
                  const defaultAgentId = resolveDefaultAgentId(cfg);
                  const selectedGlobalAgentId =
                    sessionKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : undefined;
                  for (const [activeRunId, active] of context.chatAbortControllers) {
                    const activeGlobalAgentId =
                      active.sessionKey === "global"
                        ? (active.agentId ?? defaultAgentId)
                        : undefined;
                    const sameSelectedGlobalAgent =
                      sessionKey === "global" &&
                      selectedGlobalAgentId !== undefined &&
                      activeGlobalAgentId === selectedGlobalAgentId;
                    const sameSession =
                      active.sessionKey === sessionKey &&
                      (sessionKey !== "global" || sameSelectedGlobalAgent);
                    if (activeRunId !== runId && sameSession) {
                      context.registerToolEventRecipient(activeRunId, connId);
                    }
                  }
                }
              },
              onModelSelected: (modelSelection) => {
                updateChatRunProvider(context.chatAbortControllers, {
                  runId: clientRunId,
                  providerId: modelSelection.provider,
                  authProviderId: resolveProviderIdForAuth(modelSelection.provider, {
                    config: cfg,
                  }),
                });
                onModelSelected(modelSelection);
              },
            },
          });
          if (dispatchResult.beforeAgentRunBlocked === true) {
            userTurnRecorder.markBlocked();
          }
          return dispatchResult;
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: chatSendTraceAttributes,
        },
      )
        .then(async () => {
          await measureDiagnosticsTimelineSpan(
            "gateway.chat_send.post_dispatch",
            async () => {
              const returnedAgentErrorPayloads = agentRunStarted
                ? deliveredReplies
                    .map((entryInner) => entryInner.payload)
                    .filter((payload) => payload.isError)
                : [];
              const returnedAgentErrorMessage =
                returnedAgentErrorPayloads
                  .map((payload) => payload.text?.trim())
                  .filter((text): text is string => Boolean(text))
                  .join(" | ") || undefined;
              if (
                agentRunStarted &&
                returnedAgentErrorPayloads.length > 0 &&
                !userTurnRecorder.hasPersisted() &&
                !userTurnRecorder.isBlocked()
              ) {
                await persistGatewayUserTurnTranscriptBestEffort();
              }
              if (
                agentRunStarted &&
                returnedAgentErrorPayloads.length === 0 &&
                !userTurnRecorder.hasPersisted() &&
                !userTurnRecorder.isBlocked() &&
                userTurnRecorder.hasRuntimePersistencePending()
              ) {
                await persistGatewayUserTurnTranscriptBestEffort();
              }
              let broadcastedSourceReplyFinal = false;
              // WebChat persistence has two owners. Agent runs persist model-visible turns
              // through OpenClaw runtime's SessionManager; this dispatcher only owns live delivery payloads.
              // Do not blindly mirror agent-run final payloads into JSONL or chat.history can
              // duplicate normal embedded-agent assistant turns. The non-agent branch below has no
              // runtime-owned assistant turn, so it appends a gateway-injected assistant entry before
              // broadcasting the final UI event.
              if (!agentRunStarted) {
                const btwReplies = deliveredReplies
                  .map((entryScoped) => entryScoped.payload)
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
                      ...(sessionKey === "global" && agentId ? { agentId } : {}),
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
                    agentId,
                  });
                } else {
                  await persistGatewayUserTurnTranscriptBestEffort();
                  const rawFinalPayloads = appendedWebchatAgentMedia
                    ? []
                    : deliveredReplies
                        .filter((entryItem) => entryItem.kind === "final")
                        .map((entryCandidate) => entryCandidate.payload);
                  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
                    cfg,
                    sessionKey,
                    agentId,
                    accountId,
                    payloads: rawFinalPayloads,
                  });
                  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                    sessionKey,
                    sessionLoadOptions,
                  );
                  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
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
                    agentId,
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
                  });
                  const mediaMessage = await buildWebchatAssistantMediaMessage(finalPayloads, {
                    localRoots: mediaLocalRoots,
                    onLocalAudioAccessDenied: (message) => {
                      context.logGateway.warn(
                        `webchat audio embedding denied local path: ${message}`,
                      );
                    },
                  });
                  const hasSensitiveMedia = hasSensitiveMediaPayload(finalPayloads);
                  const ttsSupplementMarker = finalPayloads
                    .map((payload) => buildMediaOnlyTtsSupplementTranscriptMarker(payload))
                    .find((marker): marker is GatewayInjectedTtsSupplementMarker =>
                      Boolean(marker),
                    );
                  const persistedAssistantContent = replaceAssistantContentTextBlocks(
                    hasSensitiveMedia
                      ? await buildAssistantDisplayContentFromReplyPayloads({
                          sessionKey,
                          agentId,
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
                  const broadcastAssistantContent = hasAssistantDisplayMediaContent(
                    assistantContent,
                  )
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
                    const appended = await appendAssistantTranscriptMessage({
                      sessionKey,
                      message: transcriptReply,
                      ...(persistedContentForAppend?.length
                        ? { content: persistedContentForAppend }
                        : {}),
                      sessionId,
                      storePath: latestStorePath,
                      sessionFile: latestEntry?.sessionFile,
                      agentId,
                      createIfMissing: true,
                      idempotencyKey: clientRunId,
                      ttsSupplement: ttsSupplementMarker,
                      cfg,
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
                      const nowValue = Date.now();
                      message = {
                        role: "assistant",
                        ...(fallbackAssistantContent?.length
                          ? { content: fallbackAssistantContent }
                          : fallbackText
                            ? { content: [{ type: "text", text: fallbackText }] }
                            : {}),
                        ...(fallbackText ? { text: fallbackText } : {}),
                        timestamp: nowValue,
                        ...(ttsSupplementMarker
                          ? { openclawTtsSupplement: ttsSupplementMarker }
                          : {}),
                        // Keep this compatible with runner stopReason enums even though this message isn't
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
                    agentId,
                    message,
                  });
                }
              } else {
                const sourceReplyPayloads = deliveredReplies
                  .filter((entryEntry) => entryEntry.kind === "final")
                  .map((entryResult) => entryResult.payload)
                  .filter(isSourceReplyTranscriptMirrorPayload);
                if (sourceReplyPayloads.length > 0) {
                  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
                    cfg,
                    sessionKey,
                    agentId,
                    accountId,
                    payloads: sourceReplyPayloads,
                  });
                  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                    sessionKey,
                    sessionLoadOptions,
                  );
                  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
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
                  const buildReplyAssistantContent = async (
                    payloads: typeof finalPayloads,
                  ): Promise<AssistantDisplayContentBlock[] | undefined> =>
                    await buildAssistantDisplayContentFromReplyPayloads({
                      sessionKey,
                      agentId,
                      payloads,
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
                    });
                  const buildReplyMediaMessage = async (payloads: typeof finalPayloads) =>
                    await buildWebchatAssistantMediaMessage(payloads, {
                      localRoots: mediaLocalRoots,
                      onLocalAudioAccessDenied: (message) => {
                        context.logGateway.warn(
                          `webchat audio embedding denied local path: ${message}`,
                        );
                      },
                    });
                  const combinedAssistantContent =
                    sourceReplyPayloads.length === 1
                      ? await buildReplyAssistantContent(finalPayloads)
                      : undefined;
                  const combinedMediaMessage =
                    sourceReplyPayloads.length === 1
                      ? await buildReplyMediaMessage(finalPayloads)
                      : undefined;
                  type SourceReplyContentState = {
                    broadcastContent: AssistantDisplayContentBlock[];
                    persistedContent: AssistantDisplayContentBlock[];
                    hasManagedOutgoingContent: boolean;
                    backedManagedOutgoingContent: boolean;
                  };
                  const sourceReplyContentStates: SourceReplyContentState[] = [];
                  const sourceReplyBroadcastContent: AssistantDisplayContentBlock[] = [];
                  for (const [replyIndex] of sourceReplyPayloads.entries()) {
                    const finalPayload = finalPayloads[replyIndex];
                    if (!finalPayload) {
                      continue;
                    }
                    const replyAssistantContent =
                      sourceReplyPayloads.length === 1
                        ? combinedAssistantContent
                        : await buildReplyAssistantContent([finalPayload]);
                    const replyMediaMessage =
                      sourceReplyPayloads.length === 1
                        ? combinedMediaMessage
                        : await buildReplyMediaMessage([finalPayload]);
                    const replyBroadcastContent = hasAssistantDisplayMediaContent(
                      replyAssistantContent,
                    )
                      ? replyAssistantContent
                      : hasAssistantDisplayMediaContent(replyMediaMessage?.content)
                        ? replyMediaMessage?.content
                        : replyAssistantContent;
                    const persistedContent = replaceAssistantContentTextBlocks(
                      replyAssistantContent,
                      replyMediaMessage ?? null,
                    );
                    const state: SourceReplyContentState = {
                      broadcastContent: replyBroadcastContent ? [...replyBroadcastContent] : [],
                      persistedContent: persistedContent ? [...persistedContent] : [],
                      hasManagedOutgoingContent:
                        hasManagedOutgoingAssistantContent(persistedContent),
                      backedManagedOutgoingContent: false,
                    };
                    sourceReplyContentStates[replyIndex] = state;
                    if (state.broadcastContent.length > 0) {
                      sourceReplyBroadcastContent.push(...state.broadcastContent);
                    }
                  }

                  const displayReply =
                    extractAssistantDisplayTextFromContent(sourceReplyBroadcastContent) ??
                    buildTranscriptReplyText(finalPayloads);
                  if (sourceReplyBroadcastContent.length || displayReply) {
                    const sourceReplyPersistenceRequests: Array<{
                      idempotencyKey: string;
                      metadata: NonNullable<
                        ReturnType<typeof getReplyPayloadMetadata>
                      >["sourceReplyTranscriptMirror"];
                      state: SourceReplyContentState;
                    }> = [];
                    for (const [replyIndex, sourceReplyPayload] of sourceReplyPayloads.entries()) {
                      const state = sourceReplyContentStates[replyIndex];
                      if (!state || !hasAssistantDisplayMediaContent(state.persistedContent)) {
                        continue;
                      }
                      const mirrorMetadata =
                        getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
                      const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
                      if (
                        typeof mirrorIdempotencyKey !== "string" ||
                        mirrorIdempotencyKey.trim().length === 0
                      ) {
                        continue;
                      }
                      if (!state.hasManagedOutgoingContent) {
                        state.backedManagedOutgoingContent = true;
                      }
                      sourceReplyPersistenceRequests.push({
                        idempotencyKey: mirrorIdempotencyKey,
                        metadata: mirrorMetadata,
                        state,
                      });
                    }

                    const attachSourceReplyManagedImages = async (paramsLocal: {
                      messageId?: string;
                      request: (typeof sourceReplyPersistenceRequests)[number];
                    }) => {
                      if (!paramsLocal.request.state.hasManagedOutgoingContent) {
                        paramsLocal.request.state.backedManagedOutgoingContent = true;
                        return;
                      }
                      if (!paramsLocal.messageId) {
                        return;
                      }
                      await attachManagedOutgoingImagesToMessage({
                        messageId: paramsLocal.messageId,
                        blocks: paramsLocal.request.state.persistedContent,
                      });
                      paramsLocal.request.state.backedManagedOutgoingContent = true;
                    };

                    if (resolvedTranscriptPath && sourceReplyPersistenceRequests.length > 0) {
                      const allowedSourceReplyMirrorIds = new Set<string>();
                      for (const [
                        replyIndex,
                        sourceReplyPayload,
                      ] of sourceReplyPayloads.entries()) {
                        if (!sourceReplyContentStates[replyIndex]) {
                          continue;
                        }
                        const mirrorIdempotencyKey =
                          getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror
                            ?.idempotencyKey;
                        const mirrorMetadata =
                          getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
                        if (
                          typeof mirrorIdempotencyKey !== "string" ||
                          mirrorIdempotencyKey.trim().length === 0 ||
                          !mirrorMetadata
                        ) {
                          continue;
                        }
                        const target = await findSourceReplyTranscriptMirrorByMetadata({
                          transcriptPath: resolvedTranscriptPath,
                          idempotencyKey: mirrorIdempotencyKey,
                          metadata: mirrorMetadata,
                        });
                        if (target) {
                          allowedSourceReplyMirrorIds.add(target.messageId);
                        }
                      }
                      const rewriteTargets: Array<{
                        request: (typeof sourceReplyPersistenceRequests)[number];
                        messageId: string;
                        message: Record<string, unknown>;
                      }> = [];
                      for (const request of sourceReplyPersistenceRequests) {
                        const target = await findSourceReplyTranscriptMirrorByMetadata({
                          transcriptPath: resolvedTranscriptPath,
                          idempotencyKey: request.idempotencyKey,
                          metadata: request.metadata,
                        });
                        if (target) {
                          rewriteTargets.push({ request, ...target });
                        }
                      }

                      if (rewriteTargets.length > 0) {
                        const rewriteTargetIds = new Set(
                          rewriteTargets.map((target) => target.messageId),
                        );
                        const rewriteIndex =
                          await readSessionTranscriptIndex(resolvedTranscriptPath);
                        const firstRewriteEntryIndex =
                          rewriteIndex?.entries.findIndex(
                            (entryValue) =>
                              typeof entryValue.id === "string" &&
                              rewriteTargetIds.has(entryValue.id),
                          ) ?? -1;
                        const canRewriteSourceReplyMirrors =
                          firstRewriteEntryIndex >= 0 &&
                          rewriteIndex?.entries
                            .slice(firstRewriteEntryIndex)
                            .every(
                              (entryLocal) =>
                                typeof entryLocal.id !== "string" ||
                                allowedSourceReplyMirrorIds.has(entryLocal.id),
                            ) === true;
                        if (canRewriteSourceReplyMirrors) {
                          const result = await rewriteTranscriptEntriesInSessionFile({
                            sessionFile: resolvedTranscriptPath,
                            sessionKey,
                            agentId,
                            config: cfg,
                            request: {
                              allowedRewriteSuffixEntryIds: [...allowedSourceReplyMirrorIds],
                              replacements: rewriteTargets.map((target) => ({
                                entryId: target.messageId,
                                message: {
                                  ...(target.message as unknown as AgentMessage),
                                  idempotencyKey: target.request.idempotencyKey,
                                  content: target.request.state.persistedContent,
                                } as unknown as AgentMessage,
                              })),
                            },
                          });
                          if (result.changed) {
                            for (const target of rewriteTargets) {
                              const rewritten =
                                await findSourceReplyTranscriptMirrorByIdempotencyKey(
                                  resolvedTranscriptPath,
                                  target.request.idempotencyKey,
                                );
                              await attachSourceReplyManagedImages({
                                messageId: rewritten?.messageId,
                                request: target.request,
                              });
                            }
                          }
                        }
                      }
                    }
                    const sourceReplyContent = sourceReplyContentStates
                      .flatMap((state) => {
                        if (
                          state.hasManagedOutgoingContent &&
                          !state.backedManagedOutgoingContent
                        ) {
                          const stripped = stripManagedOutgoingAssistantContentBlocks(
                            state.broadcastContent,
                          );
                          return stripped?.length
                            ? stripped
                            : [{ type: "text", text: "Media reply could not be displayed." }];
                        }
                        return state.broadcastContent;
                      })
                      .filter((block): block is AssistantDisplayContentBlock => Boolean(block));
                    const sourceReplyTextFromContent =
                      extractAssistantDisplayTextFromContent(sourceReplyContent);
                    const sourceReplyText =
                      sourceReplyTextFromContent ??
                      (sourceReplyContent.length === 0 ? displayReply : undefined);
                    const nowLocal = Date.now();
                    const message = {
                      role: "assistant",
                      ...(sourceReplyContent?.length
                        ? { content: sourceReplyContent }
                        : sourceReplyText
                          ? { content: [{ type: "text", text: sourceReplyText }] }
                          : {}),
                      ...(sourceReplyText ? { text: sourceReplyText } : {}),
                      timestamp: nowLocal,
                      stopReason: "stop",
                      usage: { input: 0, output: 0, totalTokens: 0 },
                    };
                    broadcastChatFinal({
                      context,
                      runId: clientRunId,
                      sessionKey,
                      agentId,
                      message,
                    });
                    broadcastedSourceReplyFinal = true;
                  }
                }
              }
              const shouldBroadcastAgentError =
                returnedAgentErrorPayloads.length > 0 && !broadcastedSourceReplyFinal;
              if (shouldBroadcastAgentError) {
                broadcastChatError({
                  context,
                  runId: clientRunId,
                  sessionKey,
                  agentId,
                  errorMessage: returnedAgentErrorMessage,
                });
              }
              if (!context.chatAbortedRuns.has(clientRunId)) {
                const returnedAgentError = shouldBroadcastAgentError
                  ? errorShape(
                      ErrorCodes.UNAVAILABLE,
                      returnedAgentErrorMessage ?? "agent returned an error payload",
                    )
                  : undefined;
                setGatewayDedupeEntry({
                  dedupe: context.dedupe,
                  key: `chat:${clientRunId}`,
                  entry: {
                    ts: Date.now(),
                    ok: !shouldBroadcastAgentError,
                    payload: shouldBroadcastAgentError
                      ? {
                          runId: clientRunId,
                          status: "error" as const,
                          summary: returnedAgentErrorMessage ?? "agent returned an error payload",
                        }
                      : { runId: clientRunId, status: "ok" as const },
                    ...(returnedAgentError ? { error: returnedAgentError } : {}),
                  },
                });
              }
            },
            {
              phase: "agent-turn",
              config: cfg,
              attributes: chatSendTraceAttributes,
            },
          );
        })
        .catch(async (err: unknown) => {
          const emitAfterError =
            userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()
              ? Promise.resolve()
              : persistGatewayUserTurnTranscript();
          await emitAfterError.catch((transcriptErr: unknown) => {
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
            agentId,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          activeRunAbort.cleanup();
          context.removeChatRun(clientRunId, clientRunId, sessionKey);
        });
    } catch (err) {
      context.chatAbortControllers.delete(clientRunId);
      context.removeChatRun(clientRunId, clientRunId, sessionKey);
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
      broadcastChatError({
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        errorMessage: String(err),
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
      agentId?: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: p.agentId,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const {
      cfg,
      storePath,
      entry,
      canonicalKey: sessionKey,
    } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });

    const appended = await appendAssistantTranscriptMessage({
      sessionKey,
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId,
      createIfMissing: true,
      cfg,
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
    const message = projectChatDisplayMessage(appended.message, {
      maxChars: resolveEffectiveChatHistoryMaxChars(cfg),
    });
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      ...(sessionKey === "global" && agentId ? { agentId } : {}),
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload);
    sendGlobalAwareNodeChatPayload({
      context,
      sessionKey,
      agentId,
      event: "chat",
      payload: chatPayload,
    });

    respond(true, { ok: true, messageId: appended.messageId });
  },
};

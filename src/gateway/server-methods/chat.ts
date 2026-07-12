// Chat gateway methods implement chat.send/history/abort/inject/metadata and
// bridge UI RPCs to agent dispatch, transcripts, media, and streaming state.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { expectDefined } from "@openclaw/normalization-core";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
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
  validateChatMetadataParams,
  validateChatMessageGetParams,
  validateChatToolTitlesParams,
  validateChatSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../../packages/gateway-protocol/src/schema.js";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { modelCatalogBrowseRequiresFullDiscovery } from "../../agents/model-catalog-browse.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  readPairingQrReplyChannelData,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { isBtwRequestText } from "../../auto-reply/reply/btw-command.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { isReplyRunAbortableForSignal } from "../../auto-reply/reply/reply-run-registry.js";
import {
  stageSandboxMedia,
  type StageSandboxMediaResult,
} from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import {
  resolveSessionRoutingContract,
  SESSION_ROUTING_CHANGED_ERROR_REASON,
} from "../../config/sessions/main-session.js";
import {
  findTranscriptEvent,
  patchSessionEntry,
  publishTranscriptUpdate,
  withTranscriptWriteLock,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
} from "../../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
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
import { parseInboundMediaUri } from "../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { renderQrPngDataUrl } from "../../media/qr-image.js";
import { renderQrTerminal } from "../../media/qr-terminal.js";
import { deleteMediaBuffer, MEDIA_MAX_BYTES, type SavedMedia } from "../../media/store.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding.js";
import {
  retainGatewayRootWorkAdmissionContinuation,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
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
import { listGatewayAgentsBasic } from "../agent-list.js";
import {
  abortChatRunById,
  boundInFlightRunSnapshotForChatHistory,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  registerChatAbortController,
  resolveChatRunExpiresAtMs,
  resolveInFlightRunSnapshot,
  updateChatRunProvider,
} from "../chat-abort.js";
import {
  type ChatImageContent,
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
  resolveChatAttachmentMaxBytes,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  dropPreSessionStartAnnouncePairs,
  projectChatDisplayMessages,
  projectChatDisplayMessage,
  projectRecentChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
import {
  abortQueuedChatTurnById,
  abortQueuedChatTurns,
  completeQueuedChatTurn,
  listQueuedChatTurnsForSession,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnEntry,
  type QueuedChatTurnMap,
} from "../chat-queued-turns.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import { augmentChatHistoryWithCliSessionImports } from "../cli-session-history.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import {
  attachManagedOutgoingImagesToMessage,
  cleanupManagedOutgoingImageRecords,
  createManagedOutgoingImageBlocks,
} from "../managed-image-attachments.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  chatAbortMarkerTimestampMs,
  createChatAbortMarker,
  type ChatRunTiming,
} from "../server-chat-state.js";
import { getMaxChatHistoryMessagesBytes, MAX_PAYLOAD_BYTES } from "../server-constants.js";
import {
  PENDING_CHAT_SEND_DEDUPE_PREFIX,
  pendingChatSendDedupeKey,
  type DedupeEntry,
} from "../server-shared.js";
import { resolveSessionHistoryTailReadOptions } from "../session-history-state.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import {
  capArrayByJsonBytes,
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessageByIdAsync,
  readRecentSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
  readSessionMessagesAsync,
} from "../session-transcript-readers.js";
import {
  buildGatewaySessionInfo,
  getSessionDefaults,
  loadSessionEntry,
  listAgentsForGateway,
  resolveGatewayModelSupportsImages,
  resolveDeletedAgentIdFromSessionKey,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
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
import {
  loadOptionalServerMethodModelCatalog,
  loadOptionalServerMethodModelCatalogSnapshot,
  startOptionalServerMethodModelCatalogSnapshotLoad,
} from "./optional-model-catalog.js";
import {
  hasTrackedActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type {
  GatewayClient,
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
  attemptId?: unknown;
  controlUiVisible?: unknown;
  dedupeKeys?: unknown;
  expiresAtMs?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sessionKeyAliases?: unknown;
  status?: unknown;
  turnKind?: unknown;
};

type PreRegisteredAgentRun = {
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
};

type ChatHistoryMethod = "chat.history" | "chat.startup";
type ChatHistoryPage = {
  messages: unknown[];
  offset?: number;
  totalMessages?: number;
  rawPageMessages?: number;
};

type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
};

type ChatSendAckServerTiming = {
  receivedToAckMs: number;
  loadSessionMs: number;
  prepareAttachmentsMs?: number;
};

type ChatSendServerTimingPhase =
  | "dispatch-started"
  | "model-selected"
  | "agent-run-started"
  | "first-assistant-event"
  | "dispatch-completed"
  | "post-dispatch-completed";

function roundedChatSendTimingMs(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function chatSendAckServerTimingAttributes(
  timing: ChatSendAckServerTiming | undefined,
): Record<string, number> {
  if (!timing) {
    return {};
  }
  return {
    serverReceivedToAckMs: timing.receivedToAckMs,
    serverLoadSessionMs: timing.loadSessionMs,
    ...(timing.prepareAttachmentsMs !== undefined
      ? { serverPrepareAttachmentsMs: timing.prepareAttachmentsMs }
      : {}),
  };
}

function shouldIncludeChatSendAckServerTiming(client?: {
  id?: string | null;
  mode?: string | null;
}): boolean {
  return isOperatorUiClient(client);
}

const CONTROL_UI_RECONNECT_RESUME_PARAM = "__controlUiReconnectResume";

function resolveControlUiReconnectResumeParams(
  params: unknown,
  clientInfo?: { id?: string | null; mode?: string | null },
): { params: unknown; resumeRequested: boolean } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { params, resumeRequested: false };
  }
  const record = params as Record<string, unknown>;
  const resumeRequested =
    record[CONTROL_UI_RECONNECT_RESUME_PARAM] === true && isOperatorUiClient(clientInfo);
  if (!resumeRequested) {
    return { params, resumeRequested: false };
  }
  const validatedParams = { ...record };
  delete validatedParams[CONTROL_UI_RECONNECT_RESUME_PARAM];
  return { params: validatedParams, resumeRequested: true };
}

function emitOperatorChatSendServerTiming(params: {
  context: Pick<GatewayRequestContext, "broadcastToConnIds">;
  client?: GatewayClient | null;
  phase: ChatSendServerTimingPhase;
  runId: string;
  sessionKey: string;
  agentId?: string;
  receivedAtMs: number;
  ackedAtMs: number;
  dispatchStartedAtMs?: number;
  extra?: Record<string, string | number>;
}) {
  const connId =
    typeof params.client?.connId === "string" && params.client.connId.trim()
      ? params.client.connId.trim()
      : undefined;
  if (!connId || !isOperatorUiClient(params.client?.connect?.client)) {
    return;
  }
  const nowMs = performance.now();
  params.context.broadcastToConnIds(
    "chat.send_timing",
    {
      phase: params.phase,
      runId: params.runId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ackToPhaseMs: roundedChatSendTimingMs(nowMs - params.ackedAtMs),
      receivedToPhaseMs: roundedChatSendTimingMs(nowMs - params.receivedAtMs),
      ...(params.dispatchStartedAtMs !== undefined
        ? {
            dispatchStartedToPhaseMs: roundedChatSendTimingMs(nowMs - params.dispatchStartedAtMs),
          }
        : {}),
      ...params.extra,
    },
    new Set([connId]),
    { dropIfSlow: true },
  );
}

async function handleChatMetadataRequest({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!validateChatMetadataParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid chat.metadata params: ${formatValidationErrors(validateChatMetadataParams.errors)}`,
      ),
    );
    return;
  }
  const metadataParams = params;
  const cfg = context.getRuntimeConfig();
  const requestedAgentId =
    typeof metadataParams.agentId === "string" && metadataParams.agentId.trim()
      ? normalizeAgentId(metadataParams.agentId)
      : resolveDefaultAgentId(cfg);
  if (!listAgentIds(cfg).includes(requestedAgentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${metadataParams.agentId}"`),
    );
    return;
  }
  try {
    respond(
      true,
      await buildChatMetadataResult({
        cfg,
        context,
        agentId: requestedAgentId,
      }),
    );
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}

async function buildChatMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
}): Promise<ChatMetadataResult> {
  const [{ buildModelsListResult }, { buildCommandsListResult }] = await Promise.all([
    import("./models-list-result.js"),
    import("./commands-list-result.js"),
  ]);
  const [models, commands] = await Promise.all([
    buildModelsListResult({
      context: params.context,
      agentId: params.agentId,
      params: { view: "configured" },
    }),
    Promise.resolve(
      buildCommandsListResult({
        cfg: params.cfg,
        agentId: params.agentId,
        includeArgs: true,
        scope: "text",
      }),
    ),
  ]);
  return { ...models, ...commands };
}

async function buildChatStartupMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
  modelCatalog: ModelCatalogSnapshot | undefined;
  catalogProjector?: ReturnType<
    (typeof import("./models-list-result.js"))["createGatewayAgentModelCatalogProjector"]
  >;
}): Promise<ChatMetadataResult | undefined> {
  if (!params.modelCatalog) {
    return undefined;
  }
  if (modelCatalogBrowseRequiresFullDiscovery({ cfg: params.cfg, view: "configured" })) {
    return undefined;
  }
  try {
    const { buildModelsListResult } = await import("./models-list-result.js");
    return await buildModelsListResult({
      context: params.context,
      agentId: params.agentId,
      params: { view: "configured" },
      preloadedCatalog: params.modelCatalog,
      ...(params.catalogProjector ? { catalogProjector: params.catalogProjector } : {}),
    });
  } catch (err) {
    params.context.logGateway.debug(
      `chat.startup continuing without metadata: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

async function buildChatStartupModelCatalogProjection(params: {
  cfg: OpenClawConfig;
  snapshot: ModelCatalogSnapshot;
  sessionAgentId: string;
  sessionEntry: ReturnType<typeof loadSessionEntry>["entry"];
  defaultAgentId: string;
  includeAgentsList: boolean;
}) {
  const { createGatewayAgentModelCatalogProjector } = await import("./models-list-result.js");
  const projectorByKey = new Map<
    string,
    ReturnType<typeof createGatewayAgentModelCatalogProjector>
  >();
  const modelCatalogByAgentId = new Map<string, ModelCatalogEntry[]>();
  const getProjector = (
    agentId: string,
    profiles: { preferredProfileId?: string; lockedProfileId?: string } = {},
  ) => {
    const id = normalizeAgentId(agentId);
    const key = `${id}\0${profiles.preferredProfileId ?? ""}\0${profiles.lockedProfileId ?? ""}`;
    let projector = projectorByKey.get(key);
    if (!projector) {
      projector = createGatewayAgentModelCatalogProjector({
        cfg: params.cfg,
        agentId: id,
        snapshot: params.snapshot,
        ...(profiles.preferredProfileId ? { preferredProfileId: profiles.preferredProfileId } : {}),
        ...(profiles.lockedProfileId ? { lockedProfileId: profiles.lockedProfileId } : {}),
      });
      projectorByKey.set(key, projector);
    }
    return projector;
  };
  const agentIds = new Set([params.sessionAgentId, params.defaultAgentId].map(normalizeAgentId));
  if (params.includeAgentsList) {
    for (const agent of listGatewayAgentsBasic(params.cfg).agents) {
      agentIds.add(agent.id);
    }
  }
  await Promise.all(
    [...agentIds].map(async (agentId) => {
      modelCatalogByAgentId.set(agentId, await getProjector(agentId).projectCatalog());
    }),
  );
  const sessionProfileId = params.sessionEntry?.authProfileOverride?.trim();
  const sessionProfileSource = params.sessionEntry?.authProfileOverrideSource;
  // Legacy rows omitted the source; a compaction count is the durable marker
  // that the profile was adopted automatically and may fall through.
  const legacyUserProfile =
    sessionProfileSource === undefined &&
    params.sessionEntry?.authProfileOverrideCompactionCount === undefined;
  const sessionProfiles = sessionProfileId
    ? {
        preferredProfileId: sessionProfileId,
        ...(sessionProfileSource === "user" || legacyUserProfile
          ? { lockedProfileId: sessionProfileId }
          : {}),
      }
    : undefined;
  const sessionCatalogProjector = getProjector(params.sessionAgentId, sessionProfiles);
  const sessionModelCatalog = await sessionCatalogProjector.projectCatalog();
  return { getProjector, modelCatalogByAgentId, sessionCatalogProjector, sessionModelCatalog };
}

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

function resolveWebchatPromptCacheKey(params: {
  agentId: string;
  model: string;
  provider: string;
  sessionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "v1",
        params.provider.trim().toLowerCase(),
        params.model.trim(),
        normalizeAgentId(params.agentId),
        params.sessionKey,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `openclaw-webchat-${digest}`;
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
  augmentChatHistoryWithCanvasBlocks,
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  dropPreSessionStartAnnouncePairs,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../chat-display-projection.js";
export { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";

export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const CHAT_HISTORY_UNAVAILABLE_SENTINEL =
  "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";

/**
 * A minimal, metadata-free notice returned when even a single oversized
 * placeholder cannot fit the chat-history byte budget. Returning this instead
 * of an empty array guarantees the dashboard never renders a blank transcript,
 * which otherwise reads to the operator as total history loss.
 */
function buildChatHistoryUnavailableSentinel(): Record<string, unknown> {
  return {
    role: "assistant",
    timestamp: Date.now(),
    content: [{ type: "text", text: CHAT_HISTORY_UNAVAILABLE_SENTINEL }],
  };
}
const CHAT_STARTUP_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 25;
const MANAGED_OUTGOING_IMAGE_PATH_PREFIX = "/api/chat/media/outgoing/";
let chatHistoryOmittedEmitCount = 0;
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

function buildAbortedChatSendPayload(params: {
  runId: string;
  endedAt: number;
  stopReason?: string;
}) {
  return {
    runId: params.runId,
    status: "timeout" as const,
    summary: "aborted",
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    endedAt: params.endedAt,
  };
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
      const parsedText = payload.text?.includes("[[")
        ? parseInlineDirectives(payload.text)
        : undefined;
      const replyToId =
        sanitizeReplyDirectiveId(payload.replyToId) ??
        sanitizeReplyDirectiveId(parsedText?.replyToExplicitId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent || parsedText?.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text = payload.text
        ? stripInlineDirectiveTagsForDelivery(payload.text).text.trim()
        : "";
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
      if (
        (payload.audioAsVoice || parsedText?.audioAsVoice) &&
        parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))
      ) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n").trim();
    })
    .filter(Boolean);
  return chunks.join("\n\n").trim();
}

function hasSensitiveMediaPayload(payloads: ReplyPayload[]): boolean {
  return payloads.some(
    (payload) =>
      payload.sensitiveMedia === true &&
      (isMediaBearingPayload(payload) || Boolean(readPairingQrReplyChannelData(payload))),
  );
}

type AssistantDisplayContentBlock = Record<string, unknown>;

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

function hasVisibleAssistantFinalMessage(message: Record<string, unknown> | undefined): boolean {
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

function hasGatewayAdminScope(client: GatewayRequestHandlerOptions["client"]): boolean {
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
  return await persistInboundImagesForTranscript({
    images: params.images,
    imageOrder: params.imageOrder,
    offloadedRefs: params.offloadedRefs,
    log: params.logGateway,
    logContext: "chat.send",
  });
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

function isPdfOffloadedRef(ref: OffloadedRef): boolean {
  const mime = ref.mimeType.trim().toLowerCase();
  if (mime === "application/pdf" || mime.endsWith("+pdf")) {
    return true;
  }
  return path.extname(ref.path.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf";
}

// A managed inbound PDF saved to the media store is safe to hand the agent as its
// media path without sandbox staging: host-side media-understanding extracts its
// text (see resolveFileExtractionLimits) by reading the media-store root, so even
// locked-down agents receive the document. This gates both the up-front bypass for
// oversized PDFs and the fallback to the managed path when sandbox staging fails
// for an already-managed PDF. #90097
function isManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  if (!isPdfOffloadedRef(ref)) {
    return false;
  }
  try {
    return parseInboundMediaUri(ref.mediaRef) !== null;
  } catch {
    return false;
  }
}

// Oversized managed PDFs skip sandbox staging up front: copying a large PDF into
// every sandbox is wasteful, and files above the 5MB staging cap would otherwise
// be rejected as a 4xx (see prestageMediaPathOffloads).
function shouldPassThroughManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  return ref.sizeBytes > MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref);
}

// Stages media-path offloads into the agent sandbox synchronously so chat.send
// can surface 5xx before respond(). Throws MediaOffloadError when staging fails
// for a ref that cannot fall back (ENOSPC / EPERM / partial-stage of a non-PDF or
// unmanaged ref) so the outer chat.send handler maps it to UNAVAILABLE (5xx);
// plain Error would be misclassified as 4xx. Already-managed inbound PDFs instead
// fall back to their managed media path on staging failure (#90097), since
// host-side media-understanding reads them from the media-store root. Offloaded
// refs are cleaned up from the media store before rethrow.
// Callers MUST set ctx.MediaStaged=true when this runs so the dispatch
// pipeline skips its own stageSandboxMedia pass.
//
// Returned paths are absolute media-store paths when no sandbox is active, for
// oversized managed PDFs that bypass staging, or for already-managed PDFs that
// fall back when staging fails (#90097); files staged into the sandbox use
// sandbox-relative paths plus `workspaceDir`. Host-side media-understanding
// resolves both via MediaWorkspaceDir and the media-store root.
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
  const refsByManagedPath = (refs: OffloadedRef[]) => ({
    paths: refs.map((ref) => ref.path),
    types: refs.map((ref) => ref.mimeType),
  });

  // Oversized managed PDFs bypass sandbox staging and are read host-side, so they
  // do not need a workspace copy or the staging-cap check below.
  const passThroughRefs: OffloadedRef[] = [];
  const refsToStage: OffloadedRef[] = [];
  for (const ref of mediaPathRefs) {
    (shouldPassThroughManagedInboundPdfOffloadRef(ref) ? passThroughRefs : refsToStage).push(ref);
  }
  if (refsToStage.length === 0) {
    return refsByManagedPath(mediaPathRefs);
  }

  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia caps each file at STAGED_MEDIA_MAX_BYTES (=
    // MEDIA_MAX_BYTES, 5MB) and silently skips oversized files. The parse cap
    // (resolveChatAttachmentMaxBytes, default 20MB) is higher, so a sandboxed
    // session receiving a non-PDF file between the two caps would otherwise
    // pass parse, fail staging, and surface as a retryable 5xx even though
    // retry cannot succeed. Reject here as a client-side 4xx instead. Managed
    // PDFs in that range pass through above instead of being rejected.
    const oversizedForSandbox = refsToStage.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
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
      MediaPath: expectDefined(refsToStage[0], "refs to stage entry at 0").path,
      MediaPaths: refsToStage.map((ref) => ref.path),
      MediaType: expectDefined(refsToStage[0], "refs to stage entry at 0").mimeType,
      MediaTypes: refsToStage.map((ref) => ref.mimeType),
    };
    let stageResult: StageSandboxMediaResult;
    try {
      stageResult = await stageSandboxMedia({
        ctx: stagingCtx,
        sessionCtx: stagingCtx as TemplateContext,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir,
      });
    } catch (stageErr) {
      // stageSandboxMedia threw before copying anything (e.g. workspace mkdir
      // ENOSPC/EPERM), so nothing reached the sandbox. Already-managed inbound
      // PDFs still reach the agent via their managed media path (host-side
      // media-understanding reads the media-store root); fail the send only when a
      // ref cannot fall back. #90097
      if (refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))) {
        throw stageErr;
      }
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia silently keeps unstaged entries as their original
    // absolute path, so length parity does not prove every file landed in the
    // sandbox. The RPC max (20MB via resolveChatAttachmentMaxBytes) admits files
    // above the staging cap (STAGED_MEDIA_MAX_BYTES = 5MB); check the returned
    // `staged` map for missing sources. Already-managed inbound PDFs fall back to
    // their absolute managed path (host-side media-understanding reads the
    // media-store root); any other missing source is a 5xx MediaOffloadError the
    // client can retry. #90097
    const stagedSources = stageResult.staged;
    const missing = refsToStage.filter((ref) => !stagedSources.has(ref.path));
    const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
    if (unstageable.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedPaths = stagingCtx.MediaPaths ?? [];
    const stagedTypes = stagingCtx.MediaTypes ?? refsToStage.map((ref) => ref.mimeType);

    // Map each ref to its post-staging path. Staged files become sandbox-relative
    // (e.g. `media/inbound/foo.pdf`) so the agent inside the container can read
    // them; pass-through PDFs and managed PDFs that fell back from staging keep
    // their absolute managed path (stagedPaths preserves the absolute path for any
    // unstaged entry). Host-side media-understanding resolves both via
    // ctx.MediaWorkspaceDir plus the media-store root. Preserve attachment order.
    const resolvedByRef = new Map<OffloadedRef, { path: string; mimeType: string }>();
    refsToStage.forEach((ref, index) => {
      resolvedByRef.set(ref, {
        path: stagedPaths[index] ?? ref.path,
        mimeType: stagedTypes[index] ?? ref.mimeType,
      });
    });
    for (const ref of passThroughRefs) {
      resolvedByRef.set(ref, { path: ref.path, mimeType: ref.mimeType });
    }
    const ordered = mediaPathRefs.map(
      (ref) => resolvedByRef.get(ref) ?? { path: ref.path, mimeType: ref.mimeType },
    );
    return {
      paths: ordered.map((entry) => entry.path),
      types: ordered.map((entry) => entry.mimeType),
      workspaceDir: sandbox.workspaceDir,
    };
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

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
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
  const metadataIdempotencyKey =
    typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : undefined;
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: {
      ...(metadataId ? { id: metadataId } : {}),
      ...(metadataSeq !== undefined ? { seq: metadataSeq } : {}),
      ...(metadataIdempotencyKey ? { idempotencyKey: metadataIdempotencyKey } : {}),
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

// Enforces the final byte budget for chat.history. Returns only the surviving
// messages; how many original messages were omitted is measured end-to-end by
// reportOmittedChatHistory, which alone sees the full replace/cap/final pipeline
// and so can count unique omitted originals without double-counting.
export function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last] };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder] };
  }
  // The oversized placeholder still does not fit (e.g. the source message
  // carried very large metadata). Never return an empty history — that renders
  // as a blank transcript and reads as data loss even though the on-disk
  // transcript is intact. Fall back to a small metadata-free sentinel.
  return { messages: [buildChatHistoryUnavailableSentinel()] };
}

// Counts how many of the original chat.history messages lost their verbatim
// representation by the time the budget pipeline finished — whether they were
// replaced with a placeholder, dropped by the front byte cap, or collapsed by
// the final budget. Identity membership counts each omitted original exactly
// once (a message that is first replaced and then trimmed is not counted twice),
// and emits the truncation diagnostic so operators see when history is omitted.
// Returns the omitted count (0 when nothing was omitted, so no diagnostic fires).
export function reportOmittedChatHistory(params: {
  originalMessages: unknown[];
  finalMessages: unknown[];
  normalizedBytes: number;
  maxHistoryBytes: number;
  logDebug: (message: string) => void;
}): number {
  const { originalMessages, finalMessages, normalizedBytes, maxHistoryBytes, logDebug } = params;
  const survivors = new Set(finalMessages);
  let omittedCount = 0;
  for (const message of originalMessages) {
    if (!survivors.has(message)) {
      omittedCount += 1;
    }
  }
  if (omittedCount === 0) {
    return 0;
  }
  chatHistoryOmittedEmitCount += omittedCount;
  logLargePayload({
    surface: "gateway.chat.history",
    action: "truncated",
    bytes: normalizedBytes,
    limitBytes: maxHistoryBytes,
    count: omittedCount,
    reason: "chat_history_budget",
  });
  logDebug(
    `chat.history omitted oversized payloads count=${omittedCount} total=${chatHistoryOmittedEmitCount}`,
  );
  return omittedCount;
}

type AssistantTranscriptScopeParams = {
  sessionId: string;
  storePath: string | undefined;
  sessionKey: string;
  agentId?: string;
};

type SourceReplyTranscriptMirrorMetadata = NonNullable<
  ReturnType<typeof getReplyPayloadMetadata>
>["sourceReplyTranscriptMirror"];

type SourceReplyContentState = {
  broadcastContent: AssistantDisplayContentBlock[];
  persistedContent: AssistantDisplayContentBlock[];
  hasManagedOutgoingContent: boolean;
  backedManagedOutgoingContent: boolean;
};

function assistantTranscriptScope(
  params: AssistantTranscriptScopeParams,
): SessionTranscriptWriteScope | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || !params.sessionId.trim()) {
    return null;
  }
  return {
    sessionKey,
    sessionId: params.sessionId,
    ...(params.storePath ? { storePath: params.storePath } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };
}

function transcriptEventRecord(event: TranscriptEvent): Record<string, unknown> | undefined {
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : undefined;
}

function transcriptEventId(event: TranscriptEvent): string | undefined {
  const id = transcriptEventRecord(event)?.id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function transcriptEventMessage(event: TranscriptEvent): Record<string, unknown> | undefined {
  const message = transcriptEventRecord(event)?.message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

function findAssistantTranscriptMessageByIdempotencyKeyInEvents(
  events: readonly TranscriptEvent[],
  idempotencyKey: string,
): { messageId: string; message: Record<string, unknown> } | null {
  const trimmedIdempotencyKey = idempotencyKey.trim();
  if (!trimmedIdempotencyKey) {
    return null;
  }
  const target = events.toReversed().find((event) => {
    const message = transcriptEventMessage(event);
    return message?.role === "assistant" && message.idempotencyKey === trimmedIdempotencyKey;
  });
  const message = target ? transcriptEventMessage(target) : undefined;
  const messageId = target ? transcriptEventId(target) : undefined;
  if (!messageId || !message) {
    return null;
  }
  return { messageId, message };
}

function findSourceReplyTranscriptMirrorByIdempotencyKeyInEvents(
  events: readonly TranscriptEvent[],
  idempotencyKey: string,
): { messageId: string; message: Record<string, unknown> } | null {
  const found = findAssistantTranscriptMessageByIdempotencyKeyInEvents(events, idempotencyKey);
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

function findSourceReplyTranscriptMirrorByMetadataInEvents(params: {
  events: readonly TranscriptEvent[];
  idempotencyKey: string;
  metadata: SourceReplyTranscriptMirrorMetadata;
}): { messageId: string; message: Record<string, unknown> } | null {
  const byIdempotencyKey = findSourceReplyTranscriptMirrorByIdempotencyKeyInEvents(
    params.events,
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
  const target = params.events.toReversed().find((event) => {
    const message = transcriptEventMessage(event);
    return (
      typeof transcriptEventId(event) === "string" &&
      message?.role === "assistant" &&
      message.provider === "openclaw" &&
      message.model === "delivery-mirror" &&
      extractAssistantTranscriptText(message) === expectedText
    );
  });
  const message = target ? transcriptEventMessage(target) : undefined;
  const messageId = target ? transcriptEventId(target) : undefined;
  if (!messageId || !message) {
    return null;
  }
  return { messageId, message };
}

async function transcriptExists(scope: SessionTranscriptWriteScope): Promise<boolean> {
  const sessionId = scope.sessionId;
  if (!sessionId) {
    return false;
  }
  // Existence probe: the newest-first matcher returns on the first record, so
  // this reads one transcript line instead of materializing the whole file.
  const found = await findTranscriptEvent({ ...scope, sessionId }, () => true).catch(
    () => undefined,
  );
  return found !== undefined;
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
  const scope = assistantTranscriptScope(params);
  if (!scope) {
    return { ok: false, error: "transcript identity not resolved" };
  }
  if (!params.createIfMissing && !(await transcriptExists(scope))) {
    return { ok: false, error: "transcript not found" };
  }

  const appended = await appendInjectedAssistantMessageToTranscript({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storePath: params.storePath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    label: params.label,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
    ttsSupplement: params.ttsSupplement,
    config: params.cfg,
  });
  return appended;
}

async function touchAssistantTranscriptSessionEntry(
  scope: SessionTranscriptWriteScope,
): Promise<void> {
  if (!scope.storePath || !scope.sessionKey || !scope.sessionId) {
    return;
  }
  const transcriptMarkerUpdatedAt = Date.now();
  await patchSessionEntry(
    {
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
    },
    (current) =>
      current.sessionId === scope.sessionId ? { updatedAt: transcriptMarkerUpdatedAt } : null,
    {
      skipMaintenance: true,
    },
  );
}

async function rewriteSourceReplyTranscriptMirrors(params: {
  candidates: readonly {
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
  }[];
  requests: readonly {
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
    state: SourceReplyContentState;
  }[];
  scope: SessionTranscriptWriteScope;
}): Promise<
  Array<{
    messageId: string;
    request: {
      idempotencyKey: string;
      metadata: SourceReplyTranscriptMirrorMetadata;
      state: SourceReplyContentState;
    };
  }>
> {
  if (params.requests.length === 0 || params.candidates.length === 0) {
    return [];
  }

  return await withTranscriptWriteLock(params.scope, async (transcript) => {
    const events = await transcript.readEvents();
    const allowedSourceReplyMirrorIds = new Set<string>();
    for (const candidate of params.candidates) {
      const target = findSourceReplyTranscriptMirrorByMetadataInEvents({
        events,
        idempotencyKey: candidate.idempotencyKey,
        metadata: candidate.metadata,
      });
      if (target) {
        allowedSourceReplyMirrorIds.add(target.messageId);
      }
    }

    const rewriteTargets: Array<{
      request: (typeof params.requests)[number];
      messageId: string;
      message: Record<string, unknown>;
    }> = [];
    for (const request of params.requests) {
      const target = findSourceReplyTranscriptMirrorByMetadataInEvents({
        events,
        idempotencyKey: request.idempotencyKey,
        metadata: request.metadata,
      });
      if (target) {
        rewriteTargets.push({ request, ...target });
      }
    }
    if (rewriteTargets.length === 0) {
      return [];
    }

    const rewriteTargetIds = new Set(rewriteTargets.map((target) => target.messageId));
    const firstRewriteEntryIndex = events.findIndex((event) => {
      const id = transcriptEventId(event);
      return id ? rewriteTargetIds.has(id) : false;
    });
    const canRewriteSourceReplyMirrors =
      firstRewriteEntryIndex >= 0 &&
      events.slice(firstRewriteEntryIndex).every((event) => {
        const id = transcriptEventId(event);
        return !id || allowedSourceReplyMirrorIds.has(id);
      });
    if (!canRewriteSourceReplyMirrors) {
      return [];
    }

    const replacementsById = new Map(rewriteTargets.map((target) => [target.messageId, target]));
    const rewrittenEvents = events.map((event) => {
      const id = transcriptEventId(event);
      const replacement = id ? replacementsById.get(id) : undefined;
      if (!replacement) {
        return event;
      }
      return Object.assign({}, event as Record<string, unknown>, {
        message: {
          ...replacement.message,
          idempotencyKey: replacement.request.idempotencyKey,
          content: replacement.request.state.persistedContent,
        },
      });
    });
    await transcript.replaceEvents(rewrittenEvents);
    return rewriteTargets.map((target) => ({
      messageId: target.messageId,
      request: target.request,
    }));
  });
}

async function publishAssistantTranscriptRewrite(params: {
  scope: SessionTranscriptWriteScope;
  rewritten: readonly { messageId: string }[];
}): Promise<void> {
  if (params.rewritten.length === 0) {
    return;
  }
  await touchAssistantTranscriptSessionEntry(params.scope);
  await publishTranscriptUpdate(params.scope, {
    messageId: params.rewritten.at(-1)?.messageId,
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
  const payloadSessionKeys = new Set([
    normalizeUnknownText(payload.sessionKey),
    ...(Array.isArray(payload.sessionKeyAliases)
      ? payload.sessionKeyAliases.map(normalizeUnknownText)
      : []),
  ]);
  const hasPayloadSessionKey = [...payloadSessionKeys].some(Boolean);
  if (
    (hasPayloadSessionKey && !payloadSessionKeys.has(params.sessionKey)) ||
    (!hasPayloadSessionKey && payloadRunId !== params.runId)
  ) {
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

function readPreRegisteredRun(params: {
  key: string;
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
  keyPrefix: string;
}): PreRegisteredAgentRun | undefined {
  if (!params.key.startsWith(params.keyPrefix) || !params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (payload.controlUiVisible === false) {
    return undefined;
  }
  const runId =
    normalizeUnknownText(payload.runId) ??
    normalizeOptionalText(params.key.slice(params.keyPrefix.length));
  const sessionKey = normalizeUnknownText(payload.sessionKey);
  if (!runId || !sessionKey) {
    return undefined;
  }
  return { runId, sessionKey, payload };
}

function canRequesterAbortPreRegisteredRun(
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
  sessionKey?: string;
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
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
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

function writePreRegisteredChatAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  stopReason: string;
  endedAt?: number;
  attemptId?: string;
}) {
  const endedAt = params.endedAt ?? Date.now();
  const payload = buildAbortedChatSendPayload({
    runId: params.runId,
    stopReason: params.stopReason,
    endedAt,
  });
  params.context.chatAbortedRuns.set(params.runId, createChatAbortMarker(endedAt));
  const pendingKey = pendingChatSendDedupeKey(params.runId);
  const pendingAttemptId = normalizeUnknownText(
    (params.context.dedupe.get(pendingKey)?.payload as PreRegisteredAgentDedupePayload | undefined)
      ?.attemptId,
  );
  if (!params.attemptId || pendingAttemptId === params.attemptId) {
    params.context.dedupe.delete(pendingKey);
  }
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    entry: { ts: endedAt, ok: true, payload },
  });
}

function resolveAuthorizedPreRegisteredRunsForSessionKeys(params: {
  context: GatewayRequestContext;
  sessionKeys: Iterable<string>;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
  keyPrefix: string;
  preserveSideRuns?: boolean;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const authorizedByRunId = new Map<string, PreRegisteredAgentRun>();
  let matchedSessionRuns = 0;
  for (const [key, entry] of params.context.dedupe) {
    const run = readPreRegisteredRun({ key, entry, keyPrefix: params.keyPrefix });
    if (!run) {
      continue;
    }
    if (params.preserveSideRuns && normalizeUnknownText(run.payload.turnKind) === "btw") {
      continue;
    }
    const runSessionKeys = [
      run.sessionKey,
      ...(Array.isArray(run.payload.sessionKeyAliases)
        ? run.payload.sessionKeyAliases.map(normalizeUnknownText)
        : []),
    ];
    if (!runSessionKeys.some((sessionKey) => Boolean(sessionKey && sessionKeys.has(sessionKey)))) {
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
    if (canRequesterAbortPreRegisteredRun(run.payload, params.requester)) {
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
  preserveSideRuns?: boolean;
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
    if (params.preserveSideRuns && active.turnKind === "btw") {
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

function ensureChatQueuedTurns(context: GatewayRequestContext): QueuedChatTurnMap {
  return context.chatQueuedTurns;
}

function canRequesterAbortQueuedChatTurn(
  entry: QueuedChatTurnEntry,
  requester: ChatAbortRequester,
): boolean {
  // Same ownership rules as active chat runs.
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

function canRequesterAbortQueuedChatTurnWithoutSessionMatch(
  entry: QueuedChatTurnEntry,
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

/**
 * Cancel authorized queued turns for a session BEFORE active-run abort so
 * drain cannot promote work into a half-aborted session.
 */
function abortAuthorizedQueuedTurnsForSession(params: {
  context: GatewayRequestContext;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
  stopReason?: string;
}): { runIds: string[]; matched: number; unauthorizedOnly: boolean } {
  const chatQueuedTurns = ensureChatQueuedTurns(params.context);
  const matches = listQueuedChatTurnsForSession({
    chatQueuedTurns,
    sessionKeys: params.sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
  });
  if (matches.length === 0) {
    return { runIds: [], matched: 0, unauthorizedOnly: false };
  }
  const authorized = matches.filter((m) =>
    canRequesterAbortQueuedChatTurn(m.entry, params.requester),
  );
  if (authorized.length === 0) {
    return { runIds: [], matched: matches.length, unauthorizedOnly: true };
  }
  const runIds = abortQueuedChatTurns(chatQueuedTurns, authorized, params.stopReason);
  return { runIds, matched: matches.length, unauthorizedOnly: false };
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
  preserveSideRuns?: boolean;
}): Promise<{ aborted: boolean; runIds: string[]; unauthorized: boolean }> {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  // Queued-turn cancel MUST run before active abort so followup drain cannot
  // promote cancelled work into the gap between active stop and queue clear.
  const queuedAbort = abortAuthorizedQueuedTurnsForSession({
    context: params.context,
    sessionKeys,
    sessionId: params.sessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    stopReason: params.stopReason,
  });
  const { matchedSessionRuns, authorizedRuns } = resolveAuthorizedRunsForSessionKeys({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    preserveSideRuns: params.preserveSideRuns,
  });
  const {
    matchedSessionRuns: matchedPendingAgentRuns,
    authorizedRuns: authorizedPendingAgentRuns,
  } = resolveAuthorizedPreRegisteredRunsForSessionKeys({
    context: params.context,
    sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    keyPrefix: "agent:",
    preserveSideRuns: params.preserveSideRuns,
  });
  const { matchedSessionRuns: matchedPendingChatRuns, authorizedRuns: authorizedPendingChatRuns } =
    resolveAuthorizedPreRegisteredRunsForSessionKeys({
      context: params.context,
      sessionKeys,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      requester: params.requester,
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
      preserveSideRuns: params.preserveSideRuns,
    });
  if (
    authorizedRuns.length === 0 &&
    authorizedPendingAgentRuns.length === 0 &&
    authorizedPendingChatRuns.length === 0 &&
    queuedAbort.runIds.length === 0
  ) {
    return {
      aborted: false,
      runIds: [],
      unauthorized:
        matchedSessionRuns > 0 ||
        matchedPendingAgentRuns > 0 ||
        matchedPendingChatRuns > 0 ||
        queuedAbort.unauthorizedOnly,
    };
  }
  const authorizedRunIdSet = new Set(authorizedRuns.map((run) => run.runId));
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  // Queued cancellations already applied above; keep them first in the response.
  const runIds: string[] = [...queuedAbort.runIds];
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
  for (const { runId, payload } of authorizedPendingChatRuns) {
    writePreRegisteredChatAbort({
      context: params.context,
      runId,
      stopReason,
      endedAt,
      attemptId: normalizeUnknownText(payload.attemptId),
    });
    runIds.push(runId);
  }
  const res = { aborted: runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted && snapshots.length > 0) {
    const abortedRunIds = new Set(runIds);
    await persistAbortedPartials({
      context: params.context,
      sessionKey: params.persistSessionKey ?? params.sessionKey,
      snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
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

function readChatHistoryMessageId(message: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return typeof metadata?.id === "string" ? metadata.id : undefined;
}

function readChatHistoryMessageSeq(message: unknown): number | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const seq = metadata?.seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
}): number {
  const oldestSeq = params.messages
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  if (oldestSeq !== undefined) {
    return Math.max(params.offset, params.totalMessages - oldestSeq + 1);
  }
  return params.offset + params.rawPageMessages;
}

function capOffsetChatHistoryProjectedMessages(messages: unknown[], max: number): unknown[] {
  if (messages.length <= max) {
    return messages;
  }
  const start = Math.max(0, messages.length - max);
  const boundarySeq = readChatHistoryMessageSeq(messages[start]);
  if (boundarySeq === undefined) {
    return messages.slice(start);
  }
  // Offset cursors can only resume at transcript-record boundaries.
  // Keep boundary rows with the same seq together so projection mirrors are not stranded.
  let safeStart = start;
  while (safeStart > 0 && readChatHistoryMessageSeq(messages[safeStart - 1]) === boundarySeq) {
    safeStart--;
  }
  return messages.slice(safeStart);
}

async function isChatMessageIdVisibleAfterHistoryFilters(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionEntry?: { sessionFile?: string; sessionId?: string };
  sessionKey: string;
  agentId?: string;
  messageId: string;
  sessionStartedAt?: number;
  allowResetArchiveFallback?: boolean;
}): Promise<boolean> {
  if (params.sessionStartedAt === undefined) {
    return true;
  }
  const messages = await readSessionMessagesAsync(
    {
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      mode: "full",
      reason: "chat.message.get visibility",
      ...(params.allowResetArchiveFallback === true ? { allowResetArchiveFallback: true } : {}),
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

async function readChatHistoryPage(params: {
  entry: ReturnType<typeof loadSessionEntry>["entry"];
  provider: string | undefined;
  sessionId: string | undefined;
  storePath: string | undefined;
  sessionAgentId: string;
  canonicalKey: string;
  max: number;
  maxHistoryBytes: number;
  effectiveMaxChars: number;
  offset: number | undefined;
}): Promise<ChatHistoryPage> {
  const {
    entry,
    provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset,
  } = params;
  if (!sessionId || !storePath) {
    return { messages: [] };
  }

  const readScope = {
    agentId: sessionAgentId,
    sessionEntry: entry,
    sessionId,
    sessionKey: canonicalKey,
    storePath,
  };
  if (offset !== undefined) {
    const rawHistoryWindow = resolveSessionHistoryTailReadOptions(max);
    const readPage =
      offset === 0
        ? await readRecentSessionMessagesWithStatsAsync(readScope, {
            maxMessages: rawHistoryWindow.maxMessages + 1,
            maxLines: rawHistoryWindow.maxLines + 1,
            maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
            allowResetArchiveFallback: true,
          })
        : await readSessionMessagesPageWithStatsAsync(readScope, {
            offset,
            maxMessages: max + 1,
            allowResetArchiveFallback: true,
          });
    const overreadContextMessage =
      offset === 0
        ? readPage.messages.length > rawHistoryWindow.maxMessages
          ? readPage.messages[0]
          : undefined
        : readPage.messages.length > max
          ? readPage.messages[0]
          : undefined;
    const localMessages =
      offset === 0
        ? dropLocalHistoryOverreadContextMessage(
            dropPreSessionStartAnnouncePairs(
              readPage.messages,
              typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
            ),
            overreadContextMessage,
          )
        : dropLocalHistoryOverreadContextMessage(
            dropPreSessionStartAnnouncePairs(
              readPage.messages,
              typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
            ),
            overreadContextMessage,
          );
    const rawPageMessages =
      offset === 0
        ? readPage.messages.length
        : Math.min(max, Math.max(0, readPage.totalMessages - offset));
    const rawMessages = localMessages;
    const recencyFilteredMessages = dropPreSessionStartAnnouncePairs(
      rawMessages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    );
    const projected =
      offset === 0
        ? projectRecentChatDisplayMessages(recencyFilteredMessages, {
            maxChars: effectiveMaxChars,
            maxMessages: max,
          })
        : projectChatDisplayMessages(recencyFilteredMessages, {
            maxChars: effectiveMaxChars,
          });
    const windowed =
      offset === 0 ? projected : capOffsetChatHistoryProjectedMessages(projected, max);
    const normalized = augmentChatHistoryWithCanvasBlocks(windowed);
    return {
      messages: normalized,
      offset,
      totalMessages: readPage.totalMessages,
      rawPageMessages,
    };
  }

  const rawHistoryWindow = resolveSessionHistoryTailReadOptions(max);
  const localHistoryReadOptions = {
    maxMessages: rawHistoryWindow.maxMessages + 1,
    maxLines: rawHistoryWindow.maxLines + 1,
  };
  const localMessages = await readRecentSessionMessagesAsync(readScope, {
    ...localHistoryReadOptions,
    maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
    allowResetArchiveFallback: true,
  });
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
    provider,
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
  return {
    messages: augmentChatHistoryWithCanvasBlocks(
      projectRecentChatDisplayMessages(recencyFilteredMessages, {
        maxChars: effectiveMaxChars,
        maxMessages: max,
      }),
    ),
  };
}

async function handleChatHistoryRequest({
  params,
  respond,
  context,
  method,
  includeAgentsList,
  includeMetadata,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
  includeAgentsList?: boolean;
  includeMetadata?: boolean;
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
  const { sessionKey, limit, offset, maxChars } = params as {
    sessionKey: string;
    agentId?: string;
    limit?: number;
    offset?: number;
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
  const startupModelCatalogLoad =
    method === "chat.startup"
      ? startOptionalServerMethodModelCatalogSnapshotLoad(context)
      : undefined;
  const modelCatalogPromise = measureDiagnosticsTimelineSpan(
    `gateway.${method}.model_catalog`,
    () =>
      startupModelCatalogLoad
        ? loadOptionalServerMethodModelCatalogSnapshot(context, method, {
            logOnceKey: "chat.startup",
            startedLoad: startupModelCatalogLoad,
            timeoutMs: CHAT_STARTUP_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS,
          })
        : loadOptionalServerMethodModelCatalog(context, method).then((entries) =>
            entries ? { entries, routeVariants: entries } : undefined,
          ),
    {
      config: cfg,
      phase: method,
    },
  );
  if (startupModelCatalogLoad) {
    void modelCatalogPromise.catch(() => undefined);
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
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
  const historyPage = await readChatHistoryPage({
    entry,
    provider: resolvedSessionModel.provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset,
  });
  const normalized = historyPage.messages;
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
  const nextOffset =
    historyPage.offset !== undefined && historyPage.totalMessages !== undefined
      ? resolveChatHistoryNextOffset({
          messages: bounded.messages,
          totalMessages: historyPage.totalMessages,
          offset: historyPage.offset,
          rawPageMessages: historyPage.rawPageMessages ?? bounded.messages.length,
        })
      : undefined;
  const hasMore =
    nextOffset !== undefined && historyPage.totalMessages !== undefined
      ? nextOffset < historyPage.totalMessages
      : undefined;
  reportOmittedChatHistory({
    originalMessages: normalized,
    finalMessages: bounded.messages,
    normalizedBytes: jsonUtf8Bytes(normalized),
    maxHistoryBytes,
    logDebug: (message) => context.logGateway.debug(message),
  });
  const modelCatalogSnapshot = await modelCatalogPromise;
  const modelCatalog = modelCatalogSnapshot?.entries;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const startupCatalogProjection =
    method === "chat.startup" && modelCatalogSnapshot
      ? await buildChatStartupModelCatalogProjection({
          cfg,
          snapshot: modelCatalogSnapshot,
          sessionAgentId,
          sessionEntry: entry,
          defaultAgentId,
          includeAgentsList: includeAgentsList === true,
        })
      : undefined;
  const sessionModelCatalog = startupCatalogProjection?.sessionModelCatalog ?? modelCatalog;
  const defaultModelCatalog =
    startupCatalogProjection?.modelCatalogByAgentId.get(normalizeAgentId(defaultAgentId)) ??
    modelCatalog;
  const startupMetadata = includeMetadata
    ? await buildChatStartupMetadataResult({
        cfg,
        context,
        agentId: sessionAgentId,
        modelCatalog: modelCatalogSnapshot,
        ...(startupCatalogProjection
          ? { catalogProjector: startupCatalogProjection.sessionCatalogProjector }
          : {}),
      })
    : undefined;
  const sessionInfo = buildGatewaySessionInfo({
    cfg,
    storePath,
    store,
    key: canonicalKey,
    entry,
    agentId: selectedAgent.agentId,
    modelCatalog: sessionModelCatalog,
  });
  const activeRunAgentId =
    canonicalKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : selectedAgent.agentId;
  const activeRunState = resolveVisibleActiveSessionRunState({
    context,
    requestedKey: sessionKey,
    canonicalKey,
    sessionId: entry?.sessionId,
    ...(activeRunAgentId ? { agentId: activeRunAgentId } : {}),
    defaultAgentId,
  });
  sessionInfo.hasActiveRun = activeRunState.active;
  sessionInfo.activeRunIds = activeRunState.runIds;
  const defaults = getSessionDefaults(cfg, defaultModelCatalog, {
    allowPluginNormalization: false,
  });
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
    ...(historyPage.offset !== undefined ? { offset: historyPage.offset } : {}),
    ...(hasMore ? { nextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(historyPage.totalMessages !== undefined
      ? { totalMessages: historyPage.totalMessages }
      : {}),
    defaults,
    sessionInfo,
    thinkingLevel,
    fastMode: entry?.fastMode,
    verboseLevel,
    ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
    ...(includeAgentsList
      ? {
          agentsList: listAgentsForGateway(
            cfg,
            modelCatalog,
            startupCatalogProjection
              ? { modelCatalogByAgentId: startupCatalogProjection.modelCatalogByAgentId }
              : undefined,
          ),
        }
      : {}),
    ...(startupMetadata ? { metadata: startupMetadata } : {}),
  };
  respond(true, payload);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async (opts) => {
    await handleChatHistoryRequest({ ...opts, method: "chat.history" });
  },
  "chat.startup": async (opts) => {
    await handleChatHistoryRequest({
      ...opts,
      method: "chat.startup",
      includeAgentsList: true,
      includeMetadata: true,
    });
  },
  "chat.metadata": handleChatMetadataRequest,
  "chat.toolTitles": async ({ params, respond, context }) => {
    if (!validateChatToolTitlesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.toolTitles params: ${formatValidationErrors(validateChatToolTitlesParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    // Opt-in gate: tool titles spend utility-model tokens, so the gateway
    // stays fully deterministic unless the operator enables them explicitly.
    // `disabled: true` lets clients stop asking for the rest of the session.
    if (cfg.gateway?.controlUi?.toolTitles !== true) {
      respond(true, { titles: {}, disabled: true });
      return;
    }
    const agentIdOverride = normalizeOptionalText(params.agentId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg,
      requestedSessionKey: params.sessionKey,
      agentId: agentIdOverride,
    });
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: params.sessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    try {
      const sessionAgentId = resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: cfg,
        agentId: selectedAgent.agentId,
      });
      // Session entry carries per-session model overrides; utility routing must
      // derive its small-model default from the provider this session actually
      // uses, not the agent's configured default.
      const { cfg: sessionCfg, entry } = loadSessionEntry(
        params.sessionKey,
        selectedAgent.agentId ? { agentId: selectedAgent.agentId } : undefined,
      );
      const sessionModel = resolveSessionModelRef(sessionCfg, entry, sessionAgentId);
      // Title generation pulls in the simple-completion runtime; load it lazily
      // so gateways that never enable the opt-in skip that cost.
      const { generateToolCallTitles } = await import("../chat-tool-titles.js");
      const titles = await generateToolCallTitles({
        cfg: sessionCfg,
        agentId: sessionAgentId,
        sessionPrimaryProvider: sessionModel.provider,
        sessionAuthProfile: entry?.authProfileOverride?.trim() || undefined,
        items: params.items,
      });
      respond(true, { titles });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
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

    const sessionAgentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });
    const resolved = await readSessionMessageByIdAsync(
      {
        agentId: sessionAgentId,
        sessionEntry: entry,
        sessionId,
        sessionKey,
        storePath,
      },
      messageId,
      { allowResetArchiveFallback: true },
    );
    if (!resolved.found) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    const visible = await isChatMessageIdVisibleAfterHistoryFilters({
      sessionId,
      storePath,
      sessionEntry: entry,
      sessionKey,
      agentId: sessionAgentId,
      messageId,
      sessionStartedAt:
        typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
      allowResetArchiveFallback: true,
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
    const {
      sessionKey: rawSessionKey,
      runId,
      preserveSideRuns,
    } = params as {
      sessionKey: string;
      agentId?: string;
      runId?: string;
      preserveSideRuns?: boolean;
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
      const sessionLoadOptions = abortAgentId ? { agentId: abortAgentId } : undefined;
      const { entry } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
      const res = await abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: canonicalAbortSessionKey,
        sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
        agentId: abortAgentId,
        sessionId: entry?.sessionId,
        defaultAgentId,
        abortOrigin: "rpc",
        stopReason: "rpc",
        requester,
        preserveSideRuns,
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
      const readPendingRunForAbort = (
        entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never,
      ) => {
        const canonicalMatch = readPreRegisteredAgentDedupePayloadForSession({
          entry,
          runId,
          sessionKey: canonicalAbortSessionKey,
          agentId: abortAgentId,
          defaultAgentId,
          includeHidden: true,
        });
        if (canonicalMatch) {
          return {
            sessionKey: normalizeUnknownText(canonicalMatch.sessionKey)
              ? canonicalAbortSessionKey
              : undefined,
            payload: canonicalMatch,
          };
        }
        if (rawSessionKey === canonicalAbortSessionKey) {
          return undefined;
        }
        const aliasMatch = readPreRegisteredAgentDedupePayloadForSession({
          entry,
          runId,
          sessionKey: rawSessionKey,
          agentId: abortAgentId,
          defaultAgentId,
          includeHidden: true,
        });
        return aliasMatch
          ? {
              sessionKey: normalizeUnknownText(aliasMatch.sessionKey) ? rawSessionKey : undefined,
              payload: aliasMatch,
            }
          : undefined;
      };
      const pendingChatMatch = readPendingRunForAbort(
        context.dedupe.get(pendingChatSendDedupeKey(runId)),
      );
      if (pendingChatMatch) {
        if (!canRequesterAbortPreRegisteredRun(pendingChatMatch.payload, requester)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
          return;
        }
        writePreRegisteredChatAbort({
          context,
          runId,
          stopReason: "rpc",
          attemptId: normalizeUnknownText(pendingChatMatch.payload.attemptId),
        });
        respond(true, { ok: true, aborted: true, runIds: [runId] });
        return;
      }
      const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
      const pendingAgentMatch = readPendingRunForAbort(pendingAgentEntry);
      if (pendingAgentMatch) {
        const pendingAgentPayload = pendingAgentMatch.payload;
        if (!canRequesterAbortPreRegisteredRun(pendingAgentPayload, requester)) {
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
      // Queued followup/collect turns keep a cancel identity after chat.send
      // terminalizes; abort them here so Esc cannot report done while they run.
      const chatQueuedTurns = ensureChatQueuedTurns(context);
      const queued = chatQueuedTurns.get(runId);
      if (queued) {
        const abortSessionKeysForQueued = new Set([rawSessionKey, canonicalAbortSessionKey]);
        if (
          !abortSessionKeysForQueued.has(queued.sessionKey) &&
          !canRequesterAbortQueuedChatTurnWithoutSessionMatch(queued, requester)
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
          queued.sessionKey === "global" &&
          resolveStoredGlobalRunAgentId(queued.agentId, defaultAgentId) !==
            normalizedAgentIdOverride
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
          );
          return;
        }
        if (!canRequesterAbortQueuedChatTurn(queued, requester)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
          return;
        }
        const queuedRes = abortQueuedChatTurnById(chatQueuedTurns, {
          runId,
          sessionKey: queued.sessionKey,
          stopReason: "rpc",
          allowSessionMismatch: true,
        });
        respond(true, {
          ok: true,
          aborted: queuedRes.aborted,
          runIds: queuedRes.aborted ? [runId] : [],
        });
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
    const chatSendReceivedAtMs = performance.now();
    const clientInfo = client?.connect?.client;
    const supportsTaskSuggestions =
      isOperatorUiClient(clientInfo) &&
      client?.connect?.scopes?.includes("operator.admin") === true &&
      hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS);
    const controlUiReconnectResume = resolveControlUiReconnectResumeParams(params, clientInfo);
    if (!validateChatSendParams(controlUiReconnectResume.params)) {
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
    const p = controlUiReconnectResume.params as {
      sessionKey: string;
      agentId?: string;
      sessionId?: string;
      message: string;
      thinking?: string;
      fastMode?: FastMode;
      fastAutoOnSeconds?: number;
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
      suppressCommandInterpretation?: boolean;
      expectedSessionRoutingContract?: string;
      idempotencyKey: string;
    };
    const suppressCommandInterpretation = p.suppressCommandInterpretation === true;
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
      (p.systemInputProvenance ||
        p.systemProvenanceReceipt ||
        suppressCommandInterpretation ||
        explicitOriginResult.value) &&
      !hasGatewayAdminScope(client)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          p.systemInputProvenance || p.systemProvenanceReceipt || suppressCommandInterpretation
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
    const stopCommand = !suppressCommandInterpretation && isChatStopCommandText(inboundMessage);
    const turnKind =
      !suppressCommandInterpretation && isBtwRequestText(inboundMessage) ? "btw" : "main";
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
    const pendingChatSendKey = pendingChatSendDedupeKey(clientRunId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: agentIdOverride,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const sessionLoadStartedAtMs = performance.now();
    const sessionLoadResult = measureDiagnosticsTimelineSpanSync(
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
    const sessionLoadMs = roundedChatSendTimingMs(performance.now() - sessionLoadStartedAtMs);
    const { cfg, storePath, entry, canonicalKey: sessionKey, legacyKey } = sessionLoadResult;
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(sessionKey, entry);
    if (missingHarnessSessionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError));
      return;
    }
    const expectedSessionRoutingContract = normalizeOptionalText(p.expectedSessionRoutingContract);
    const sessionRoutingChanged = (candidateConfig: OpenClawConfig) =>
      expectedSessionRoutingContract !== undefined &&
      expectedSessionRoutingContract.toLowerCase() !==
        resolveSessionRoutingContract(candidateConfig);
    const respondSessionRoutingChanged = () => {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session routing changed; review and retry", {
          details: { reason: SESSION_ROUTING_CHANGED_ERROR_REASON },
        }),
      );
    };
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
    const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, sessionKey, entry, {
      acpMetadataSessionKey: legacyKey ?? sessionKey,
    });
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
      if (sessionRoutingChanged(cfg)) {
        respondSessionRoutingChanged();
        return;
      }
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

    const abortMarker = context.chatAbortedRuns.get(clientRunId);
    if (abortMarker !== undefined) {
      const abortedAt = chatAbortMarkerTimestampMs(abortMarker);
      const payload = buildAbortedChatSendPayload({
        runId: clientRunId,
        endedAt: abortedAt,
      });
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: abortedAt,
          ok: true,
          payload,
        },
      });
      respond(true, payload, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    const pendingChatSend = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    if (pendingChatSend) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
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
    if (context.chatQueuedTurns?.has(clientRunId)) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    // Cached/in-flight retries are already bound to their original target and
    // must remain queryable after config changes. Gate only a new dispatch.
    if (sessionRoutingChanged(cfg)) {
      respondSessionRoutingChanged();
      return;
    }
    const archivedSessionError = resolveSessionWorkStartError(sessionKey, entry);
    if (archivedSessionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
      return;
    }
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
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const pendingAttemptId = randomUUID();
    const pendingExpiresAtMs = resolveChatRunExpiresAtMs({ now, timeoutMs });
    // Keep the run abortable while lifecycle mutation owns the session. Admission
    // must reject an expired/missing reservation instead of reviving evicted work.
    context.dedupe.set(pendingChatSendKey, {
      ts: now,
      ok: true,
      payload: {
        runId: clientRunId,
        attemptId: pendingAttemptId,
        status: "accepted" as const,
        sessionKey,
        ...(rawSessionKey === sessionKey ? {} : { sessionKeyAliases: [rawSessionKey] }),
        ...(sessionKey === "global" && selectedAgent.agentId
          ? { agentId: selectedAgent.agentId }
          : {}),
        ownerConnId: normalizeOptionalText(client?.connId),
        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
        expiresAtMs: pendingExpiresAtMs,
        turnKind,
      },
    });
    const clearPendingChatSendReservation = () => {
      const pending = readPreRegisteredRun({
        key: pendingChatSendKey,
        entry: context.dedupe.get(pendingChatSendKey),
        keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
      });
      if (
        pending?.runId === clientRunId &&
        normalizeUnknownText(pending.payload.attemptId) === pendingAttemptId
      ) {
        context.dedupe.delete(pendingChatSendKey);
      }
    };
    let admittedSessionId = backingSessionId ?? clientRunId;
    let gatewayWorkAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    let admittedRunAbort: ReturnType<typeof registerChatAbortController> | undefined;
    let reservationSuperseded = false;
    let supersedingResult: DedupeEntry | undefined;
    const assertChatWorkAdmissionAllowed = (commitOutcome: boolean) => {
      if (context.chatAbortedRuns.has(clientRunId)) {
        return;
      }
      const pendingReservation = readPreRegisteredRun({
        key: pendingChatSendKey,
        entry: context.dedupe.get(pendingChatSendKey),
        keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
      });
      if (
        pendingReservation &&
        normalizeUnknownText(pendingReservation.payload.attemptId) !== pendingAttemptId
      ) {
        if (commitOutcome) {
          reservationSuperseded = true;
        }
        return;
      }
      if (!pendingReservation) {
        const terminalResult = context.dedupe.get(`chat:${clientRunId}`);
        if (terminalResult || context.chatAbortControllers.has(clientRunId)) {
          if (commitOutcome) {
            reservationSuperseded = true;
            supersedingResult = terminalResult;
          }
          return;
        }
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (commitOutcome) {
          writePreRegisteredChatAbort({
            context,
            runId: clientRunId,
            stopReason: "restart",
            attemptId: pendingAttemptId,
          });
        }
        return;
      }
      if (
        !pendingReservation ||
        !isFutureDateTimestampMs(pendingReservation.payload.expiresAtMs, {
          nowMs: Date.now(),
        })
      ) {
        if (commitOutcome) {
          writePreRegisteredChatAbort({
            context,
            runId: clientRunId,
            stopReason: "timeout",
            attemptId: pendingAttemptId,
          });
        }
        return;
      }
      const latestSession = loadSessionEntry(rawSessionKey, sessionLoadOptions);
      if (sessionRoutingChanged(latestSession.cfg)) {
        throw new Error(SESSION_ROUTING_CHANGED_ERROR_REASON);
      }
      const latestEntry = latestSession.entry;
      if (entry && !latestEntry) {
        throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
      }
      // Admission can queue behind reset. Never route a request captured
      // against the old session into the replacement transcript.
      if (
        backingSessionId &&
        latestEntry?.sessionId &&
        latestEntry.sessionId !== backingSessionId
      ) {
        throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
      }
      const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
      if (archivedError) {
        throw new Error(archivedError);
      }
      if (!commitOutcome) {
        return;
      }
      admittedSessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
      admittedRunAbort = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: clientRunId,
        sessionId: admittedSessionId,
        sessionKey,
        agentId: selectedAgent.agentId,
        timeoutMs,
        now,
        ownerConnId: normalizeOptionalText(client?.connId),
        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
        providerId: resolvedSessionModel.provider,
        authProviderId: resolvedSessionAuthProvider,
        isAbortable: (active) => isReplyRunAbortableForSignal(active.controller.signal),
        kind: "chat-send",
        turnKind,
        lifecycleGeneration,
      });
    };
    try {
      gatewayWorkAdmission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, backingSessionId],
        assertAllowed: () => assertChatWorkAdmissionAllowed(false),
        revalidateAllowed: () => assertChatWorkAdmissionAllowed(true),
        onInterrupt: () => {
          if (admittedRunAbort?.entry) {
            admittedRunAbort.entry.abortStopReason = "restart";
          }
          admittedRunAbort?.controller.abort(createAgentRunRestartAbortError());
        },
      });
    } catch (err) {
      clearPendingChatSendReservation();
      if (err instanceof Error && err.message === SESSION_ROUTING_CHANGED_ERROR_REASON) {
        respondSessionRoutingChanged();
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }
    clearPendingChatSendReservation();
    const activeRunAbort = admittedRunAbort;
    if (reservationSuperseded) {
      gatewayWorkAdmission.release();
      const supersedingCached = supersedingResult ?? context.dedupe.get(`chat:${clientRunId}`);
      if (supersedingCached) {
        respond(supersedingCached.ok, supersedingCached.payload, supersedingCached.error, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
      if (activeRunAbort) {
        if (activeRunAbort.entry) {
          activeRunAbort.entry.abortStopReason = "restart";
        }
        activeRunAbort.controller.abort();
        activeRunAbort.cleanup({ force: true });
      }
      gatewayWorkAdmission.release();
      if (!context.dedupe.has(`chat:${clientRunId}`)) {
        writePreRegisteredChatAbort({
          context,
          runId: clientRunId,
          stopReason: activeRunAbort?.entry?.abortStopReason ?? "restart",
          attemptId: pendingAttemptId,
        });
      }
      const aborted = context.dedupe.get(`chat:${clientRunId}`);
      respond(aborted?.ok ?? true, aborted?.payload, aborted?.error, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    if (!activeRunAbort) {
      gatewayWorkAdmission.release();
      const aborted = context.dedupe.get(`chat:${clientRunId}`);
      if (aborted) {
        respond(aborted.ok, aborted.payload, aborted.error, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "chat run admission failed"));
      return;
    }
    if (!activeRunAbort.registered) {
      gatewayWorkAdmission.release();
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    let releaseGatewayRootContinuation: (() => void) | undefined;
    const cleanupAdmittedRun: typeof activeRunAbort.cleanup = (options) => {
      activeRunAbort.cleanup(options);
      gatewayWorkAdmission?.release();
      releaseGatewayRootContinuation?.();
      releaseGatewayRootContinuation = undefined;
    };
    claimAgentRunContext(clientRunId, {
      sessionKey,
      sessionId: admittedSessionId,
      lifecycleGeneration,
    });
    const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(
      explicitOriginResult.value,
    );
    let prepareAttachmentsMs: number | undefined;
    if (normalizedAttachments.length > 0) {
      const prepareAttachmentsStartedAtMs = performance.now();
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
        prepareAttachmentsMs = roundedChatSendTimingMs(
          performance.now() - prepareAttachmentsStartedAtMs,
        );
      } catch (err) {
        cleanupAdmittedRun({ force: true });
        clearAgentRunContext(clientRunId, lifecycleGeneration);
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
    if (activeRunAbort.controller.signal.aborted) {
      const stopReason = activeRunAbort.entry?.abortStopReason ?? "rpc";
      const endedAt = Date.now();
      const payload = buildAbortedChatSendPayload({
        runId: clientRunId,
        stopReason,
        endedAt,
      });
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: endedAt,
          ok: true,
          payload,
        },
      });
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      respond(true, payload, undefined, { runId: clientRunId });
      return;
    }

    // Attachment preparation and admission can suspend. Recheck immediately
    // before ACK/dispatch so hot config reload cannot cross the send boundary.
    if (sessionRoutingChanged(context.getRuntimeConfig())) {
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      respondSessionRoutingChanged();
      return;
    }

    try {
      const serverTiming = shouldIncludeChatSendAckServerTiming(clientInfo)
        ? {
            receivedToAckMs: roundedChatSendTimingMs(performance.now() - chatSendReceivedAtMs),
            loadSessionMs: sessionLoadMs,
            ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
          }
        : undefined;
      const chatSendTiming: ChatRunTiming | undefined =
        serverTiming && typeof client?.connId === "string" && client.connId.trim()
          ? {
              ackedAtMs: performance.now(),
              connId: client.connId.trim(),
              receivedAtMs: chatSendReceivedAtMs,
            }
          : undefined;
      context.addChatRun(clientRunId, {
        sessionKey,
        agentId: selectedAgent.agentId,
        clientRunId,
        ...(chatSendTiming ? { chatSendTiming } : {}),
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
        ...(serverTiming ? { serverTiming } : {}),
      };
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: "gateway.chat_send.ack_ready",
          phase: "agent-turn",
          attributes: {
            ...chatSendTraceAttributes,
            ackStatus: ackPayload.status,
            ...chatSendAckServerTimingAttributes(serverTiming),
          },
        },
        { config: cfg },
      );
      respond(true, ackPayload, undefined, { runId: clientRunId });
      const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
      const titleSource = stripInlineDirectiveTagsForDisplay(rawMessage).text;
      if (isDashboardSessionTitleCandidate({ sessionKey, userMessage: titleSource })) {
        void runWithGatewayIndependentRootWorkContinuation(async () => {
          const titleEntry =
            entry?.sessionId === admittedSessionId
              ? entry
              : loadSessionEntry(sessionKey, sessionLoadOptions).entry;
          const titleSessionId = titleEntry?.sessionId;
          if (!titleSessionId) {
            return;
          }
          const updated = await maybeGenerateDashboardSessionTitle({
            cfg,
            agentId,
            entry: titleEntry,
            sessionId: titleSessionId,
            sessionKey,
            storePath,
            userMessage: titleSource,
          });
          if (updated) {
            emitSessionsChanged(context, {
              sessionKey,
              agentId,
              reason: "chat.title",
            });
          }
        }).catch((err: unknown) => {
          context.logGateway.warn(
            `dashboard session title generation failed: ${formatForLog(err)}`,
          );
        });
      }
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
        ...(hasGatewayAdminScope(client) ? { senderIsOwner: true } : {}),
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
      const commandBody = parsedMessage;
      const commandSource =
        !suppressCommandInterpretation && trimmedMessage.startsWith("/") ? "text" : undefined;
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const queuedFollowupOwnerDeviceId = normalizeOptionalText(client?.connect?.device?.id);
      const queuedFollowupOwnerConnId = normalizeOptionalText(client?.connId);
      const queuedFollowupOwnerKey = queuedFollowupOwnerDeviceId
        ? `device:${queuedFollowupOwnerDeviceId}`
        : queuedFollowupOwnerConnId
          ? `connection:${queuedFollowupOwnerConnId}`
          : undefined;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = originatingRoute;
      // The per-message timestamp prefix is now applied at the single LLM
      // boundary (normalizeMessagesForLlmBoundary), derived from each message's
      // own timestamp, so the current turn and all historical turns carry
      // identical bytes on the wire. BodyForAgent uses the same bare text as
      // Body; the transient gateway stamp is removed (stamping the live turn
      // here would diverge from bare stored history and bust the prompt cache).
      // See: https://github.com/openclaw/openclaw/issues/3658
      const ctx: MsgContext = {
        Body: messageForAgent,
        BodyForAgent: messageForAgent,
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
        CommandAuthorized: !suppressCommandInterpretation,
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
        ApprovalReviewerDeviceId: queuedFollowupOwnerDeviceId,
        ...(!isOperatorUiClient(clientInfo)
          ? {
              SenderId: clientInfo?.id,
              SenderName: clientInfo?.displayName,
              SenderUsername: clientInfo?.displayName,
            }
          : {}),
        GatewayClientScopes: client?.connect?.scopes ?? [],
        GatewayClientCaps: client?.connect?.caps ?? [],
      };
      const isInternalTextSlashCommandTurn =
        ctx.Provider === INTERNAL_MESSAGE_CHANNEL && ctx.CommandSource === "text";
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
      let queuedFollowupEnqueued = false;
      let pendingDispatchLifecycleError:
        | {
            endedAt: number;
            error: string;
            sessionId: string;
            startedAt: number;
          }
        | undefined;
      let persistDispatchErrorUserTurn: (() => Promise<void>) | undefined;
      let acceptedUserTurnSessionId = entry?.sessionId;
      const userTurnRecorder: UserTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: baseUserTurnInput,
        resolveInput: () => userTurnInputPromise,
        target: () => {
          const {
            storePath: latestStorePath,
            store: latestStore,
            entry: latestEntry,
          } = loadSessionEntry(sessionKey, sessionLoadOptions);
          if (!latestEntry?.sessionId || latestEntry.sessionId !== acceptedUserTurnSessionId) {
            return undefined;
          }
          return {
            sessionId: latestEntry.sessionId,
            expectedSessionId: latestEntry.sessionId,
            sessionKey,
            sessionEntry: latestEntry,
            sessionStore: latestStore,
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
        const mediaLocalRoots = appendLocalMediaParentRoots(
          getAgentScopedMediaLocalRoots(cfg, agentId),
          latestStorePath ? [latestStorePath] : undefined,
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

      const emitServerTiming = (
        phase: ChatSendServerTimingPhase,
        extra?: Record<string, string | number>,
        dispatchStartedAtMs?: number,
      ) => {
        emitOperatorChatSendServerTiming({
          context,
          client,
          phase,
          runId: clientRunId,
          sessionKey,
          agentId,
          receivedAtMs: chatSendReceivedAtMs,
          ackedAtMs: chatSendAckedAtMs,
          dispatchStartedAtMs,
          extra,
        });
      };
      const dispatchStartedAtMs = performance.now();
      if (chatSendTiming) {
        chatSendTiming.dispatchStartedAtMs = dispatchStartedAtMs;
      }
      emitServerTiming("dispatch-started");
      let firstAssistantServerTimingEmitted = false;
      const emitFirstAssistantServerTiming = () => {
        if (firstAssistantServerTimingEmitted || chatSendTiming?.firstAssistantEventSent) {
          return;
        }
        firstAssistantServerTimingEmitted = true;
        if (chatSendTiming) {
          chatSendTiming.firstAssistantEventSent = true;
        }
        emitServerTiming("first-assistant-event", undefined, dispatchStartedAtMs);
      };
      // Reserve the detached dispatch before this request releases its root. Otherwise
      // its inherited ALS context becomes retired and rejects queued/session work.
      releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? undefined;
      void gatewayWorkAdmission
        .run(() =>
          measureDiagnosticsTimelineSpan(
            "gateway.chat_send.dispatch_inbound",
            async () => {
              applyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);
              const dispatchResult = await dispatchInboundMessage({
                ctx,
                cfg,
                dispatcher,
                onSessionMetadataChanges: (changes) => {
                  for (const change of changes) {
                    emitSessionsChanged(context, change);
                  }
                },
                replyOptions: {
                  runId: clientRunId,
                  ...(isOperatorUiClient(clientInfo)
                    ? {
                        promptCacheKey: resolveWebchatPromptCacheKey({
                          agentId,
                          provider: resolvedSessionModel.provider,
                          model: resolvedSessionModel.model,
                          sessionKey: activeRunScopeKey,
                        }),
                      }
                    : {}),
                  ...(supportsTaskSuggestions
                    ? { taskSuggestionDeliveryMode: "gateway" as const }
                    : {}),
                  requestedSessionId,
                  ...(entry?.sessionId
                    ? {
                        expectedExistingSessionId: entry.sessionId,
                      }
                    : {}),
                  resumeRequestedSession: controlUiReconnectResume.resumeRequested,
                  onSessionPrepared: (binding) => {
                    if (binding.sessionKey === sessionKey) {
                      acceptedUserTurnSessionId = binding.sessionId;
                    }
                  },
                  abortSignal: activeRunAbort.controller.signal,
                  // Keep a Gateway-owned cancel identity after this chat.send
                  // terminalizes while the prompt waits in followup/collect queue.
                  queuedFollowupLifecycle: {
                    ownerKey: queuedFollowupOwnerKey,
                    onEnqueued: () => {
                      queuedFollowupEnqueued = registerQueuedChatTurn({
                        chatQueuedTurns: ensureChatQueuedTurns(context),
                        runId: clientRunId,
                        controller: activeRunAbort.controller,
                        sessionId: backingSessionId ?? clientRunId,
                        sessionKey,
                        agentId: selectedAgent.agentId,
                        ownerConnId: normalizeOptionalText(client?.connId),
                        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
                      });
                      return queuedFollowupEnqueued;
                    },
                    onCancellationRetired: () => {
                      retireQueuedChatTurnCancellation(
                        ensureChatQueuedTurns(context),
                        clientRunId,
                        activeRunAbort.controller,
                      );
                    },
                    onComplete: () => {
                      completeQueuedChatTurn(
                        ensureChatQueuedTurns(context),
                        clientRunId,
                        activeRunAbort.controller,
                      );
                    },
                  },
                  images: replyOptionImages,
                  imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
                  thinkingLevelOverride: p.thinking,
                  fastModeOverride: p.fastMode,
                  userTurnTranscriptRecorder: userTurnRecorder,
                  fastModeAutoOnSecondsOverride: p.fastAutoOnSeconds,
                  onAgentRunStart: (runId) => {
                    agentRunStarted = true;
                    emitServerTiming(
                      "agent-run-started",
                      runId !== clientRunId ? { agentRunId: runId } : undefined,
                      dispatchStartedAtMs,
                    );
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
                        sessionKey === "global"
                          ? (selectedAgent.agentId ?? defaultAgentId)
                          : undefined;
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
                    emitServerTiming(
                      "model-selected",
                      {
                        provider: modelSelection.provider,
                        model: modelSelection.model,
                      },
                      dispatchStartedAtMs,
                    );
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
          ),
        )
        .then(async () => {
          emitServerTiming("dispatch-completed", undefined, dispatchStartedAtMs);
          const postDispatchStartedAtMs = performance.now();
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
              if (!agentRunStarted && !queuedFollowupEnqueued) {
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
                      question: expectDefined(
                        btwReplies[0],
                        "btw replies entry at 0",
                      ).btw.question.trim(),
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
                  const finalPayloadEntries = deliveredReplies.filter(
                    (entryItem) => entryItem.kind === "final",
                  );
                  const parseReplyInlineDirectives = (payload: ReplyPayload) =>
                    typeof payload.text === "string" && payload.text.includes("[[")
                      ? parseInlineDirectives(payload.text)
                      : undefined;
                  const shouldFoldCommandBlocks = isInternalTextSlashCommandTurn;
                  const commandBlockPayloadEntries = shouldFoldCommandBlocks
                    ? deliveredReplies.filter((entryItem) => entryItem.kind === "block")
                    : [];
                  const replyMediaUrls = (payload: ReplyPayload) =>
                    resolveSendableOutboundReplyParts(payload).mediaUrls;
                  const normalizeCommandMediaDedupeKey = (value: string): string => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                      return "";
                    }
                    if (!trimmed.toLowerCase().startsWith("file://")) {
                      return path.isAbsolute(trimmed) ? path.normalize(trimmed) : trimmed;
                    }
                    try {
                      const parsed = new URL(trimmed);
                      if (parsed.protocol === "file:") {
                        return path.normalize(fileURLToPath(parsed));
                      }
                    } catch {
                      // Keep malformed file URL-like values comparable with the fallback below.
                    }
                    return trimmed.replace(/^file:\/\//iu, "");
                  };
                  const replyMediaDedupeKeys = (payload: ReplyPayload) =>
                    replyMediaUrls(payload).map((mediaUrl) =>
                      normalizeCommandMediaDedupeKey(mediaUrl),
                    );
                  const canonicalizeReplyMedia = (payload: ReplyPayload): ReplyPayload => {
                    const mediaUrls = replyMediaUrls(payload);
                    return {
                      ...payload,
                      mediaUrl: undefined,
                      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
                    };
                  };
                  const mergeDefinedReplySemantics = (
                    target: ReplyPayload,
                    source: ReplyPayload,
                  ): ReplyPayload => {
                    const sourceInlineDirectives = parseReplyInlineDirectives(source);
                    const sourceReplyToId =
                      sanitizeReplyDirectiveId(source.replyToId) ??
                      sanitizeReplyDirectiveId(sourceInlineDirectives?.replyToExplicitId);
                    return {
                      ...target,
                      ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
                        ? { trustedLocalMedia: true }
                        : {}),
                      ...(source.sensitiveMedia === true || target.sensitiveMedia === true
                        ? { sensitiveMedia: true }
                        : {}),
                      ...(source.presentation !== undefined
                        ? { presentation: source.presentation }
                        : {}),
                      ...(source.delivery !== undefined ? { delivery: source.delivery } : {}),
                      ...(source.interactive !== undefined
                        ? { interactive: source.interactive }
                        : {}),
                      ...(sourceReplyToId !== undefined ? { replyToId: sourceReplyToId } : {}),
                      ...(source.replyToTag === true || target.replyToTag === true
                        ? { replyToTag: true }
                        : {}),
                      ...(source.replyToCurrent === true ||
                      sourceInlineDirectives?.replyToCurrent === true ||
                      target.replyToCurrent === true
                        ? { replyToCurrent: true }
                        : {}),
                      ...(source.audioAsVoice === true ||
                      sourceInlineDirectives?.audioAsVoice === true ||
                      target.audioAsVoice === true
                        ? { audioAsVoice: true }
                        : {}),
                      ...(source.spokenText !== undefined ? { spokenText: source.spokenText } : {}),
                      ...(source.ttsSupplement !== undefined
                        ? { ttsSupplement: source.ttsSupplement }
                        : {}),
                      ...(source.isError === true || target.isError === true
                        ? { isError: true }
                        : {}),
                      ...(source.channelData !== undefined
                        ? { channelData: source.channelData }
                        : {}),
                    };
                  };
                  const mergeMediaReplySemantics = (
                    target: ReplyPayload,
                    source: ReplyPayload,
                  ): ReplyPayload => {
                    const sourceInlineDirectives = parseReplyInlineDirectives(source);
                    return {
                      ...target,
                      ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
                        ? { trustedLocalMedia: true }
                        : {}),
                      ...(source.sensitiveMedia === true || target.sensitiveMedia === true
                        ? { sensitiveMedia: true }
                        : {}),
                      ...(source.audioAsVoice === true ||
                      sourceInlineDirectives?.audioAsVoice === true ||
                      target.audioAsVoice === true
                        ? { audioAsVoice: true }
                        : {}),
                    };
                  };
                  const hasMergeableReplySemantics = (payload: ReplyPayload): boolean => {
                    const inlineDirectives = parseReplyInlineDirectives(payload);
                    return Boolean(
                      payload.trustedLocalMedia !== undefined ||
                      payload.sensitiveMedia !== undefined ||
                      payload.presentation ||
                      payload.delivery ||
                      payload.interactive ||
                      payload.replyToId ||
                      payload.replyToTag !== undefined ||
                      payload.replyToCurrent !== undefined ||
                      payload.audioAsVoice !== undefined ||
                      inlineDirectives?.hasReplyTag ||
                      inlineDirectives?.hasAudioTag ||
                      payload.spokenText ||
                      payload.ttsSupplement ||
                      payload.isError !== undefined ||
                      payload.channelData,
                    );
                  };
                  const hasUnmergedReplySemantics = (payload: ReplyPayload): boolean =>
                    Boolean(
                      payload.isReasoning ||
                      payload.isReasoningSnapshot ||
                      payload.isCompactionNotice ||
                      payload.isFallbackNotice ||
                      payload.isStatusNotice ||
                      payload.btw,
                    );
                  const hasReplySemantics = (payload: ReplyPayload): boolean =>
                    hasMergeableReplySemantics(payload) || hasUnmergedReplySemantics(payload);
                  const mediaSetsMatch = (
                    leftMediaUrls: readonly string[],
                    rightMediaUrls: readonly string[],
                  ): boolean => {
                    if (leftMediaUrls.length !== rightMediaUrls.length) {
                      return false;
                    }
                    return leftMediaUrls.every(
                      (mediaUrl, index) => mediaUrl === rightMediaUrls[index],
                    );
                  };
                  const replyDisplayText = (payload: ReplyPayload): string =>
                    sanitizeAssistantDisplayText(payload.text) ?? "";
                  const commandBlockPayloadEntriesForDelivery = commandBlockPayloadEntries.map(
                    (entryItem) => ({
                      kind: entryItem.kind,
                      payload: canonicalizeReplyMedia(entryItem.payload),
                    }),
                  );
                  const sensitiveMediaDedupeKeys = new Set(
                    finalPayloadEntries.flatMap((entryItem) =>
                      entryItem.payload.sensitiveMedia === true
                        ? replyMediaDedupeKeys(entryItem.payload).filter(Boolean)
                        : [],
                    ),
                  );
                  if (sensitiveMediaDedupeKeys.size > 0) {
                    for (const entryItem of commandBlockPayloadEntriesForDelivery) {
                      if (
                        replyMediaDedupeKeys(entryItem.payload).some((key) =>
                          sensitiveMediaDedupeKeys.has(key),
                        )
                      ) {
                        entryItem.payload = { ...entryItem.payload, sensitiveMedia: true };
                      }
                    }
                  }
                  const finalPayloadEntriesForDelivery = shouldFoldCommandBlocks
                    ? finalPayloadEntries.flatMap((entryItem) => {
                        const finalMediaUrls = replyMediaUrls(entryItem.payload);
                        const finalMediaKeys = replyMediaDedupeKeys(entryItem.payload);
                        const finalDisplayText = replyDisplayText(entryItem.payload);
                        const matchingMediaBlockEntry =
                          finalMediaUrls.length > 0
                            ? commandBlockPayloadEntriesForDelivery.find((candidate) =>
                                mediaSetsMatch(
                                  replyMediaDedupeKeys(candidate.payload),
                                  finalMediaKeys,
                                ),
                              )
                            : undefined;
                        const matchingTextBlockEntry = finalDisplayText
                          ? commandBlockPayloadEntriesForDelivery.find(
                              (candidate) =>
                                replyDisplayText(candidate.payload) === finalDisplayText,
                            )
                          : undefined;
                        const matchingMediaAndTextBlockEntry =
                          finalMediaUrls.length > 0 && finalDisplayText
                            ? commandBlockPayloadEntriesForDelivery.find(
                                (candidate) =>
                                  replyDisplayText(candidate.payload) === finalDisplayText &&
                                  mediaSetsMatch(
                                    replyMediaDedupeKeys(candidate.payload),
                                    finalMediaKeys,
                                  ),
                              )
                            : undefined;
                        const duplicateBlockEntry =
                          finalMediaUrls.length > 0
                            ? finalDisplayText
                              ? matchingMediaAndTextBlockEntry
                              : matchingMediaBlockEntry
                            : finalMediaUrls.length === 0
                              ? matchingTextBlockEntry
                              : undefined;
                        if (duplicateBlockEntry) {
                          duplicateBlockEntry.payload = mergeDefinedReplySemantics(
                            duplicateBlockEntry.payload,
                            entryItem.payload,
                          );
                        } else if (matchingMediaBlockEntry) {
                          matchingMediaBlockEntry.payload = mergeMediaReplySemantics(
                            matchingMediaBlockEntry.payload,
                            entryItem.payload,
                          );
                        }
                        const remainingFinalMediaUrls = matchingMediaBlockEntry
                          ? []
                          : finalMediaUrls;
                        if (
                          remainingFinalMediaUrls.length === 0 &&
                          ((duplicateBlockEntry && !hasUnmergedReplySemantics(entryItem.payload)) ||
                            (!duplicateBlockEntry &&
                              !finalDisplayText &&
                              !hasReplySemantics(entryItem.payload)))
                        ) {
                          return [];
                        }
                        return [
                          {
                            ...entryItem,
                            payload: {
                              ...entryItem.payload,
                              mediaUrl: undefined,
                              mediaUrls:
                                remainingFinalMediaUrls.length > 0
                                  ? remainingFinalMediaUrls
                                  : undefined,
                            },
                          },
                        ];
                      })
                    : finalPayloadEntries;
                  // Non-agent command paths can enqueue only block replies. If no visible final
                  // supersedes them, fold those blocks into the final WebChat message.
                  const rawFinalPayloads = appendedWebchatAgentMedia
                    ? []
                    : [
                        ...commandBlockPayloadEntriesForDelivery,
                        ...finalPayloadEntriesForDelivery,
                      ].map((entryCandidate) => entryCandidate.payload);
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
                  const mediaLocalRoots = appendLocalMediaParentRoots(
                    getAgentScopedMediaLocalRoots(cfg, agentId),
                    latestStorePath ? [latestStorePath] : undefined,
                  );
                  const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
                    sessionKey,
                    agentId,
                    payloads: finalPayloads,
                    managedImageLocalRoots: mediaLocalRoots,
                    includeSensitiveMedia: false,
                    includeSensitiveDisplay: true,
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
                    onSensitiveDisplayPrepareError: (message) => {
                      context.logGateway.warn(
                        `webchat sensitive display skipped attachment: ${message}`,
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
                  const transcriptDisplayReply = displayReply
                    ? stripInlineDirectiveTagsForDisplay(displayReply).text.trim()
                    : "";
                  const transcriptReply =
                    mediaMessage?.transcriptText ||
                    buildTranscriptReplyText(finalPayloads) ||
                    transcriptDisplayReply;
                  let message: Record<string, unknown> | undefined;
                  const shouldAppendAssistantTranscript = Boolean(
                    transcriptReply || persistedContentForAppend?.length,
                  );
                  if (shouldAppendAssistantTranscript) {
                    await persistGatewayUserTurnTranscriptBestEffort();
                  } else {
                    await persistGatewayUserTurnTranscriptBestEffort();
                  }
                  if (shouldAppendAssistantTranscript) {
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
                  } else if (broadcastAssistantContent?.length) {
                    message = {
                      role: "assistant",
                      content: broadcastAssistantContent,
                      text: extractAssistantDisplayText(broadcastAssistantContent) ?? "",
                      timestamp: Date.now(),
                      stopReason: "stop",
                      usage: { input: 0, output: 0, totalTokens: 0 },
                    };
                  }
                  if (hasVisibleAssistantFinalMessage(message)) {
                    emitFirstAssistantServerTiming();
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
                const hasReturnedAgentErrorPayloads = returnedAgentErrorPayloads.length > 0;
                const agentRunReplyPayloads = deliveredReplies
                  .filter((entryEntry) => entryEntry.kind === "final")
                  .map((entryResult) => entryResult.payload)
                  .filter(
                    (payload) =>
                      isSourceReplyTranscriptMirrorPayload(payload) ||
                      (!hasReturnedAgentErrorPayloads && isReplyPayloadStatusNotice(payload)),
                  );
                if (agentRunReplyPayloads.length > 0) {
                  const hasSourceReplyTranscriptMirror = agentRunReplyPayloads.some(
                    isSourceReplyTranscriptMirrorPayload,
                  );
                  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
                    cfg,
                    sessionKey,
                    agentId,
                    accountId,
                    payloads: agentRunReplyPayloads,
                  });
                  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                    sessionKey,
                    sessionLoadOptions,
                  );
                  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
                  const mediaLocalRoots = appendLocalMediaParentRoots(
                    getAgentScopedMediaLocalRoots(cfg, agentId),
                    latestStorePath ? [latestStorePath] : undefined,
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
                    agentRunReplyPayloads.length === 1
                      ? await buildReplyAssistantContent(finalPayloads)
                      : undefined;
                  const combinedMediaMessage =
                    agentRunReplyPayloads.length === 1
                      ? await buildReplyMediaMessage(finalPayloads)
                      : undefined;
                  const sourceReplyContentStates: SourceReplyContentState[] = [];
                  const sourceReplyBroadcastContent: AssistantDisplayContentBlock[] = [];
                  for (const [replyIndex] of agentRunReplyPayloads.entries()) {
                    const finalPayload = finalPayloads[replyIndex];
                    if (!finalPayload) {
                      continue;
                    }
                    const replyAssistantContent =
                      agentRunReplyPayloads.length === 1
                        ? combinedAssistantContent
                        : await buildReplyAssistantContent([finalPayload]);
                    const replyMediaMessage =
                      agentRunReplyPayloads.length === 1
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
                      metadata: SourceReplyTranscriptMirrorMetadata;
                      state: SourceReplyContentState;
                    }> = [];
                    for (const [
                      replyIndex,
                      sourceReplyPayload,
                    ] of agentRunReplyPayloads.entries()) {
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
                    const sourceReplyMirrorCandidates: Array<{
                      idempotencyKey: string;
                      metadata: SourceReplyTranscriptMirrorMetadata;
                    }> = [];
                    for (const [
                      replyIndex,
                      sourceReplyPayload,
                    ] of agentRunReplyPayloads.entries()) {
                      if (!sourceReplyContentStates[replyIndex]) {
                        continue;
                      }
                      const mirrorMetadata =
                        getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
                      const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
                      if (
                        typeof mirrorIdempotencyKey !== "string" ||
                        mirrorIdempotencyKey.trim().length === 0 ||
                        !mirrorMetadata
                      ) {
                        continue;
                      }
                      sourceReplyMirrorCandidates.push({
                        idempotencyKey: mirrorIdempotencyKey,
                        metadata: mirrorMetadata,
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

                    const sourceReplyScope = assistantTranscriptScope({
                      sessionId,
                      sessionKey,
                      storePath: latestStorePath,
                      agentId,
                    });
                    if (sourceReplyScope && sourceReplyPersistenceRequests.length > 0) {
                      const rewritten = await rewriteSourceReplyTranscriptMirrors({
                        candidates: sourceReplyMirrorCandidates,
                        requests: sourceReplyPersistenceRequests,
                        scope: sourceReplyScope,
                      });
                      if (rewritten.length > 0) {
                        await publishAssistantTranscriptRewrite({
                          scope: sourceReplyScope,
                          rewritten,
                        });
                        for (const target of rewritten) {
                          await attachSourceReplyManagedImages({
                            messageId: target.messageId,
                            request: target.request,
                          });
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
                    if (hasVisibleAssistantFinalMessage(message)) {
                      emitFirstAssistantServerTiming();
                    }
                    broadcastChatFinal({
                      context,
                      runId: clientRunId,
                      sessionKey,
                      agentId,
                      message,
                    });
                    broadcastedSourceReplyFinal = hasSourceReplyTranscriptMirror;
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
          emitServerTiming(
            "post-dispatch-completed",
            {
              postDispatchMs: roundedChatSendTimingMs(performance.now() - postDispatchStartedAtMs),
            },
            dispatchStartedAtMs,
          );
          if (queuedFollowupEnqueued && !context.chatAbortedRuns.has(clientRunId)) {
            // Successful queue admission ends this client run. The later
            // aggregate/followup owns its own run id.
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey,
              agentId,
            });
          }
        })
        .catch(async (err: unknown) => {
          const errorMessage = String(err);
          if (queuedFollowupEnqueued) {
            context.logGateway.warn(
              `webchat dispatch failed after followup queue admission: ${formatForLog(err)}`,
            );
            if (!context.chatAbortedRuns.has(clientRunId)) {
              setGatewayDedupeEntry({
                dedupe: context.dedupe,
                key: `chat:${clientRunId}`,
                entry: {
                  ts: Date.now(),
                  ok: true,
                  payload: { runId: clientRunId, status: "ok" as const },
                },
              });
              broadcastChatFinal({
                context,
                runId: clientRunId,
                sessionKey,
                agentId,
              });
            }
            return;
          }
          persistDispatchErrorUserTurn =
            userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()
              ? undefined
              : persistGatewayUserTurnTranscript;
          if (
            !activeRunAbort.controller.signal.aborted &&
            !context.chatAbortedRuns.has(clientRunId)
          ) {
            pendingDispatchLifecycleError = {
              endedAt: Date.now(),
              error: errorMessage,
              sessionId: activeRunAbort.entry?.sessionId ?? backingSessionId ?? clientRunId,
              startedAt: activeRunAbort.entry?.startedAtMs ?? now,
            };
          }
          const error = errorShape(ErrorCodes.UNAVAILABLE, errorMessage);
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: errorMessage,
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey,
            agentId,
            errorMessage,
          });
        })
        .finally(() => {
          const dispatchError = pendingDispatchLifecycleError;
          // Reserve error projection before cleanup retires the dispatch root. Restart
          // drain may already reject fresh roots, but this accepted request must finish.
          const releaseDispatchErrorRoot = dispatchError
            ? retainGatewayRootWorkAdmissionContinuation()
            : null;
          cleanupAdmittedRun();
          clearAgentRunContext(clientRunId, lifecycleGeneration);
          context.removeChatRun(clientRunId, clientRunId, sessionKey);
          if (!dispatchError) {
            return;
          }
          const persistDispatchLifecycleError = async () => {
            const hasActiveRun = hasTrackedActiveSessionRun({
              context,
              requestedKey: rawSessionKey,
              canonicalKey: sessionKey,
              ...(sessionKey === "global" && agentId ? { agentId } : {}),
              defaultAgentId: resolveDefaultAgentId(cfg),
            });
            if (hasActiveRun) {
              return;
            }
            try {
              await persistGatewaySessionLifecycleEvent({
                sessionKey,
                ...(sessionKey === "global" && agentId ? { agentId } : {}),
                event: {
                  runId: clientRunId,
                  sessionId: dispatchError.sessionId,
                  lifecycleGeneration,
                  ts: dispatchError.endedAt,
                  data: {
                    phase: "error",
                    startedAt: dispatchError.startedAt,
                    endedAt: dispatchError.endedAt,
                    error: dispatchError.error,
                  },
                },
              });
              emitSessionsChanged(context, {
                sessionKey,
                ...(agentId ? { agentId } : {}),
                reason: "chat.dispatch-error",
              });
            } catch (persistErr: unknown) {
              context.logGateway.warn(
                `webchat session lifecycle persist failed after error: ${formatForLog(persistErr)}`,
              );
            }
          };
          void (async () => {
            await persistDispatchLifecycleError();
            await persistDispatchErrorUserTurn?.().catch((transcriptErr: unknown) => {
              context.logGateway.warn(
                `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
              );
            });
          })()
            .catch((continuationErr: unknown) => {
              context.logGateway.warn(
                `webchat session lifecycle continuation failed: ${formatForLog(continuationErr)}`,
              );
            })
            .finally(() => releaseDispatchErrorRoot?.());
        });
    } catch (err) {
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
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

    let appended: Awaited<ReturnType<typeof appendAssistantTranscriptMessage>>;
    try {
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {
          const latestEntry = loadSessionEntry(rawSessionKey, sessionLoadOptions).entry;
          if (!latestEntry) {
            throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
          }
          if (latestEntry.sessionId !== sessionId) {
            throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
          }
          const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
          if (archivedError) {
            throw new Error(archivedError);
          }
        },
      });
      try {
        appended = await admission.run(
          async () =>
            await appendAssistantTranscriptMessage({
              sessionKey,
              message: p.message,
              label: p.label,
              sessionId,
              storePath,
              sessionFile: entry.sessionFile,
              agentId,
              createIfMissing: true,
              cfg,
            }),
        );
      } finally {
        admission.release();
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }
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

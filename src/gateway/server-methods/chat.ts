// Chat gateway methods implement chat.send/history/abort/inject/metadata and
// bridge UI RPCs to agent dispatch, transcripts, media, and streaming state.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatMetadataParams,
  validateChatMessageGetParams,
  validateChatToolTitlesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { modelCatalogBrowseRequiresFullDiscovery } from "../../agents/model-catalog-browse.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { resolveTranscriptSessionKeyBySessionId } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearAgentRunContext,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  emitDiagnosticsTimelineEvent,
  measureDiagnosticsTimelineSpan,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import {
  retainGatewayRootWorkAdmissionContinuation,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { stripInlineDirectiveTagsForDisplay } from "../../utils/directive-tags.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import {
  boundInFlightRunSnapshotForChatHistory,
  resolveInFlightRunSnapshot,
  updateChatRunProvider,
} from "../chat-abort.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  dropPreSessionStartAnnouncePairs,
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
import {
  isDashboardSessionTitleCandidate,
  maybeGenerateDashboardSessionTitle,
} from "../dashboard-session-title.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import { getMaxChatHistoryMessagesBytes, MAX_PAYLOAD_BYTES } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  readSessionMessageByIdAsync,
  readSessionMessagesAsync,
} from "../session-transcript-readers.js";
import {
  buildGatewaySessionInfo,
  getSessionDefaults,
  loadSessionEntry,
  listAgentsForGateway,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { ensureChatQueuedTurns } from "./chat-abort-runtime.js";
import { scheduleChatHistoryManagedImageCleanup } from "./chat-assistant-content.js";
import {
  broadcastChatError,
  broadcastChatFinal,
  sendGlobalAwareNodeChatPayload,
} from "./chat-broadcast.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";
import {
  capChatHistoryAroundMessage,
  enrichChatHistoryCompactionMarkers,
  readChatHistoryPage,
  readChatHistoryMessageId,
  readChatHistoryMessageSeq,
} from "./chat-history-pages.js";
import {
  hasGatewayAdminScope,
  resolveRequestedChatAgentId,
  validateChatSelectedAgent,
} from "./chat-origin-routing.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import { admitChatSend } from "./chat-send-admission.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";
import { finalizeChatSendNonAgentReplies } from "./chat-send-nonagent-finalization.js";
import {
  respondChatSessionRoutingChanged,
  runChatSendPreAdmission,
} from "./chat-send-pre-admission.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";
import { applyChatSendManagedMediaFields, prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  chatSendAckServerTimingAttributes,
  emitOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
  shouldIncludeChatSendAckServerTiming,
  type ChatSendServerTimingPhase,
} from "./chat-server-timing.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import {
  loadOptionalServerMethodModelCatalog,
  loadOptionalServerMethodModelCatalogSnapshot,
  startOptionalServerMethodModelCatalogSnapshotLoad,
} from "./optional-model-catalog.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type ChatHistoryMethod = "chat.history" | "chat.startup";

type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
};

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

export {
  augmentChatHistoryWithCanvasBlocks,
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  dropPreSessionStartAnnouncePairs,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../chat-display-projection.js";
export { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
export {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";

const CHAT_STARTUP_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 25;
function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
  replayOldestRecord?: boolean;
}): number {
  const oldestSeq = params.messages
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  if (oldestSeq !== undefined) {
    const recordOffset = params.totalMessages - oldestSeq + 1;
    const replayOffset = recordOffset - 1;
    if (params.replayOldestRecord && replayOffset > params.offset) {
      return replayOffset;
    }
    // A replay cursor that does not advance strands every older record. Skip
    // the pathological projected siblings and continue with the next record.
    return Math.max(params.offset + 1, recordOffset);
  }
  return params.offset + params.rawPageMessages;
}

function shouldReplayOldestChatHistoryRecord(params: {
  projected: unknown[];
  bounded: unknown[];
}): boolean {
  const oldestSeq = params.bounded
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  if (oldestSeq === undefined) {
    return false;
  }
  const projectedCount = params.projected.filter(
    (message) => readChatHistoryMessageSeq(message) === oldestSeq,
  ).length;
  const boundedCount = params.bounded.filter(
    (message) => readChatHistoryMessageSeq(message) === oldestSeq,
  ).length;
  return boundedCount < projectedCount;
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
  const {
    sessionKey,
    limit,
    offset,
    messageId,
    sessionId: requestedSessionId,
    maxChars,
  } = params as {
    sessionKey: string;
    agentId?: string;
    limit?: number;
    offset?: number;
    messageId?: string;
    sessionId?: string;
    maxChars?: number;
  };
  if (offset !== undefined && messageId !== undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "offset and messageId cannot be used together"),
    );
    return;
  }
  if (requestedSessionId !== undefined && messageId === undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "sessionId requires messageId"),
    );
    return;
  }
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
  const sessionAgentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: selectedAgent.agentId,
  });
  if (requestedSessionId) {
    const transcriptSessionKey = resolveTranscriptSessionKeyBySessionId({
      agentId: sessionAgentId,
      sessionId: requestedSessionId,
      storePath,
    });
    if (
      !transcriptSessionKey ||
      scopeLegacySessionKeyToAgent({
        sessionKey: transcriptSessionKey,
        agentId: sessionAgentId,
      }) !== scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId: sessionAgentId })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionId does not belong to sessionKey"),
      );
      return;
    }
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
  const sessionId = requestedSessionId ?? entry?.sessionId;
  const historyEntry =
    requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
  const requested = typeof limit === "number" ? limit : 200;
  const max = Math.min(1000, requested);
  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
  const historyPage = await readChatHistoryPage({
    entry: historyEntry,
    provider: resolvedSessionModel.provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset,
    messageId,
  });
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, historyEntry);
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
  const capped = messageId
    ? (capChatHistoryAroundMessage({
        messages: replaced.messages,
        messageId,
        fits: (messages) => jsonUtf8Bytes(messages) <= maxHistoryBytes,
      }) ?? capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items)
    : capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
  const historyBudgetPreserved =
    replaced.replacedCount === 0 &&
    capped.length === normalized.length &&
    bounded.messages.length === capped.length &&
    bounded.messages.every((message, index) => message === capped[index]);
  const pagination = historyPage.pagination;
  const candidateNextOffset =
    pagination === undefined
      ? undefined
      : resolveChatHistoryNextOffset({
          messages: bounded.messages,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          replayOldestRecord: shouldReplayOldestChatHistoryRecord({
            projected: normalized,
            bounded: bounded.messages,
          }),
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? pagination.exhausted !== true && candidateNextOffset < pagination.totalMessages
      : undefined;
  const nextOffset = hasMore ? candidateNextOffset : undefined;
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
    ...(historyPage.responseOffset !== undefined ? { offset: historyPage.responseOffset } : {}),
    ...(hasMore ? { nextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(pagination !== undefined ? { totalMessages: pagination.totalMessages } : {}),
    ...(historyPage.completeCliImport && !hasMore && historyBudgetPreserved
      ? { completeSnapshot: true }
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
  "chat.abort": handleChatAbortRequest,
  "chat.send": async ({ params, respond, context, client }) => {
    const normalizedRequest = normalizeChatSendRequest({ params, client });
    if (!normalizedRequest.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, normalizedRequest.error));
      return;
    }
    const {
      chatSendReceivedAtMs,
      clientInfo,
      supportsTaskSuggestions,
      p,
      systemInputProvenance,
      rawMessage,
      reconnectResumeRequested,
    } = normalizedRequest.value;
    const preparedSession = prepareChatSendSession({
      request: normalizedRequest.value,
      context,
      client,
    });
    if (!preparedSession.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, preparedSession.error));
      return;
    }
    const {
      clientRunId,
      sessionLoadOptions,
      sessionLoadMs,
      cfg,
      storePath,
      entry,
      sessionKey,
      sessionRoutingChanged,
      selectedAgent,
      requestedSessionId,
      backingSessionId,
      agentId,
      activeRunScopeKey,
      resolvedSessionModel,
      now,
    } = preparedSession.value;
    const shouldAdmit = await runChatSendPreAdmission({
      request: normalizedRequest.value,
      session: preparedSession.value,
      respond,
      context,
      client,
    });
    if (!shouldAdmit) {
      return;
    }
    const admitted = await admitChatSend({
      request: normalizedRequest.value,
      session: preparedSession.value,
      respond,
      context,
      client,
    });
    if (!admitted.ok) {
      return;
    }
    const {
      activeRunAbort,
      admittedSessionId,
      chatSendTraceAttributes,
      cleanupAdmittedRun,
      finishAbortedChatSend,
      gatewayWorkAdmission,
      lifecycleGeneration,
      restartSafeAdmission,
      setReleaseGatewayRootContinuation,
    } = admitted.value;
    const preparedAttachments = await prepareChatSendAttachments({
      request: normalizedRequest.value,
      session: preparedSession.value,
      admission: admitted.value,
      respond,
      context,
    });
    if (!preparedAttachments.ok) {
      return;
    }
    if (activeRunAbort.controller.signal.aborted) {
      finishAbortedChatSend();
      return;
    }

    // Attachment preparation can suspend. Recheck immediately before the
    // synchronous ACK path so aborts and hot routing reloads cannot cross it.
    if (sessionRoutingChanged(context.getRuntimeConfig())) {
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      respondChatSessionRoutingChanged(respond);
      return;
    }
    const { imageOrder, prepareAttachmentsMs } = preparedAttachments.value;

    const admissionStartedAt = Date.now();
    const terminalizeRestartSafeAdmission = async (terminalState: {
      retryable: boolean;
      status: "failed" | "killed";
    }): Promise<boolean> =>
      await terminalizeRestartSafeChatAdmission({
        admittedSessionId,
        clientRunId,
        sessionKey,
        startedAt: admissionStartedAt,
        storePath,
        ...terminalState,
      });

    try {
      const userTurn = createGatewayChatUserTurnController({
        agentId,
        cfg,
        clientRunId,
        initialSessionId: admittedSessionId,
        now,
        ...(systemInputProvenance ? { provenance: systemInputProvenance } : {}),
        rawMessage,
        ...(restartSafeAdmission ? { restartAdmission: restartSafeAdmission } : {}),
        senderIsOwner: hasGatewayAdminScope(client),
        sessionKey,
        ...(sessionLoadOptions ? { sessionLoadOptions } : {}),
        startedAt: admissionStartedAt,
        traceAttributes: chatSendTraceAttributes,
        warn: (message) => context.logGateway.warn(message),
      });
      const {
        persist: persistGatewayUserTurnTranscript,
        persistBestEffort: persistGatewayUserTurnTranscriptBestEffort,
        recorder: userTurnRecorder,
      } = userTurn;
      if (restartSafeAdmission) {
        const persistedUserTurn = await persistGatewayUserTurnTranscript();
        const admittedEntry = persistedUserTurn?.sessionEntry;
        // A matching idempotency row and lifecycle claim commit atomically, so
        // retries adopt the durable turn without submitting it twice.
        if (
          !persistedUserTurn ||
          admittedEntry?.status !== "running" ||
          admittedEntry.restartRecoveryDeliveryRunId !== clientRunId
        ) {
          throw new Error("chat turn was not durably admitted");
        }
        if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
          if (activeRunAbort.entry) {
            activeRunAbort.entry.abortStopReason = "restart";
          }
          activeRunAbort.controller.abort(createAgentRunRestartAbortError());
        }
        if (activeRunAbort.controller.signal.aborted) {
          if (
            !(await terminalizeRestartSafeAdmission({
              retryable: activeRunAbort.entry?.abortStopReason === "restart",
              status: "killed",
            }))
          ) {
            throw new Error("chat admission ownership changed before terminalization");
          }
          finishAbortedChatSend();
          return;
        }
        if (sessionRoutingChanged(context.getRuntimeConfig())) {
          if (!(await terminalizeRestartSafeAdmission({ retryable: true, status: "failed" }))) {
            throw new Error("chat admission ownership changed before terminalization");
          }
          cleanupAdmittedRun({ force: true });
          clearAgentRunContext(clientRunId, lifecycleGeneration);
          respondChatSessionRoutingChanged(respond);
          return;
        }
      }

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
      const {
        accountId,
        ctx,
        isInternalTextSlashCommandTurn,
        pluginBoundMediaFieldsPromise,
        queuedFollowupOwnerKey,
        replyOptionImages,
      } = prepareChatSendUserTurn({
        request: normalizedRequest.value,
        session: preparedSession.value,
        admission: admitted.value,
        attachments: preparedAttachments.value,
        client,
        logGateway: context.logGateway,
        userTurn,
      });

      let agentRunStarted = false;
      const { deliveredReplies, dispatcher, hasAppendedWebchatAgentMedia, onModelSelected } =
        createChatSendReplyDispatch({
          accountId,
          isAgentRunStarted: () => agentRunStarted,
          logGateway: context.logGateway,
          session: preparedSession.value,
          userTurnRecorder,
        });
      let queuedFollowupEnqueued = false;
      const dispatchErrorLifecycle = createChatSendDispatchErrorLifecycle({
        admission: admitted.value,
        context,
        isQueuedFollowupEnqueued: () => queuedFollowupEnqueued,
        persistUserTurnTranscript: persistGatewayUserTurnTranscript,
        session: preparedSession.value,
        terminalizeRestartSafeAdmission,
        userTurnRecorder,
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
      setReleaseGatewayRootContinuation(retainGatewayRootWorkAdmissionContinuation() ?? undefined);
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
                  ...(restartSafeAdmission
                    ? {
                        expectedExistingSessionId: admittedSessionId,
                        pinExpectedExistingSession: true,
                      }
                    : entry?.sessionId
                      ? { expectedExistingSessionId: entry.sessionId }
                      : {}),
                  resumeRequestedSession: reconnectResumeRequested,
                  onSessionPrepared: (binding) => {
                    if (binding.sessionKey === sessionKey) {
                      userTurn.setAcceptedSessionId(binding.sessionId);
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
                  queueModeOverride: p.queueMode,
                  userTurnTranscriptRecorder: userTurnRecorder,
                  ...(restartSafeAdmission ? { suppressNextUserMessagePersistence: true } : {}),
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
                await finalizeChatSendNonAgentReplies({
                  accountId,
                  context,
                  deliveredReplies,
                  emitFirstAssistantServerTiming,
                  foldCommandBlocks: isInternalTextSlashCommandTurn,
                  persistUserTurnTranscript: persistGatewayUserTurnTranscriptBestEffort,
                  session: preparedSession.value,
                  suppressReplies: hasAppendedWebchatAgentMedia(),
                });
              } else {
                broadcastedSourceReplyFinal = await finalizeChatSendSourceReplies({
                  accountId,
                  context,
                  deliveredReplies,
                  emitFirstAssistantServerTiming,
                  hasReturnedAgentErrorPayloads: returnedAgentErrorPayloads.length > 0,
                  session: preparedSession.value,
                });
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
        .catch(dispatchErrorLifecycle.handleError)
        .finally(dispatchErrorLifecycle.finalize);
    } catch (err) {
      if (restartSafeAdmission) {
        const terminalized = await terminalizeRestartSafeAdmission({
          retryable: true,
          status: "failed",
        }).catch((terminalizeError: unknown) => {
          context.logGateway.warn(
            `failed to release restart-safe chat admission after setup error: ${formatForLog(
              terminalizeError,
            )}`,
          );
          return false;
        });
        if (terminalized) {
          emitSessionsChanged(context, {
            sessionKey,
            ...(agentId ? { agentId } : {}),
            reason: "chat.dispatch-error",
          });
        }
      }
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

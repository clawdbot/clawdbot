// Read-side chat handlers own history projection, startup metadata, and message lookup.
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateChatHistoryParams,
  validateChatMetadataParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_HISTORY_MAX_ENTRIES } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  resolveTranscriptSessionKeyBySessionId,
} from "../../config/sessions/session-accessor.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import {
  boundInFlightRunSnapshotForChatHistory,
  resolveInFlightRunSnapshot,
} from "../chat-abort.js";
import { resolveEffectiveChatHistoryMaxChars } from "../chat-display-projection.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import { capArrayByJsonBytes } from "../session-transcript-readers.js";
import {
  buildGatewaySessionInfo,
  getSessionDefaults,
  loadSessionEntryReadOnly,
  listAgentsForGateway,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../session-utils.js";
import { scheduleChatHistoryManagedMediaCleanup } from "./chat-assistant-content.js";
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
  readChatHistoryMessageSeq,
} from "./chat-history-pages.js";
import type { ChatMetadataResult } from "./chat-metadata-runtime.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";
import type { ChatStartupProjectionResult } from "./chat-startup-projection-contract.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import {
  loadOptionalServerMethodModelCatalogSnapshot,
  startOptionalServerMethodModelCatalogSnapshotLoad,
} from "./optional-model-catalog.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatHistoryMethod = "chat.history" | "chat.startup";

async function handleChatMetadataRequest({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!assertValidParams(params, validateChatMetadataParams, "chat.metadata", respond)) {
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
  respond(
    true,
    await context.readChatMetadata({
      agentId: requestedAgentId,
    }),
  );
}

// The UI fills metadata gaps as soon as chat.startup returns, so history never waits
// beyond this budget for a catalog snapshot that requires slower discovery.
const CHAT_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 25;
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

async function handleChatHistoryRequest({
  params,
  respond,
  context,
  client,
  method,
  includeAgentsList,
  includeMetadata,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
  includeAgentsList?: boolean;
  includeMetadata?: boolean;
}) {
  if (!assertValidParams(params, validateChatHistoryParams, method, respond)) {
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
  const requestConfig = context.getRuntimeConfig();
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const requestedAgentId = resolveRequestedChatAgentId({
    cfg: requestConfig,
    requestedSessionKey: sessionKey,
    agentId: agentIdOverride,
  });
  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, store, entry, canonicalKey } = measureDiagnosticsTimelineSpanSync(
    `gateway.${method}.session_entry`,
    () =>
      loadSessionEntryReadOnly(sessionKey, {
        ...sessionLoadOptions,
        includeStoreChildEntries: true,
      }),
    {
      config: requestConfig,
      phase: method,
    },
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
  const modelCatalogPromise =
    method === "chat.history"
      ? (() => {
          const optionalModelCatalogLoad = startOptionalServerMethodModelCatalogSnapshotLoad(
            context,
            {
              agentId: sessionAgentId,
            },
          );
          const load = measureDiagnosticsTimelineSpan(
            `gateway.${method}.model_catalog`,
            () =>
              loadOptionalServerMethodModelCatalogSnapshot(context, method, {
                logOnceKey: method,
                startedLoad: optionalModelCatalogLoad,
                timeoutMs: CHAT_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS,
              }),
            {
              config: cfg,
              phase: method,
            },
          );
          void load.catch(() => undefined);
          return load;
        })()
      : Promise.resolve(undefined);
  const sessionId = requestedSessionId ?? entry?.sessionId;
  const historyEntry =
    requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
  const requested = typeof limit === "number" ? limit : 200;
  const max = Math.min(CHAT_HISTORY_MAX_ENTRIES, requested);
  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
  let historyPage: Awaited<ReturnType<typeof readChatHistoryPage>>;
  try {
    historyPage = await measureDiagnosticsTimelineSpan(
      `gateway.${method}.history_page`,
      () =>
        readChatHistoryPage({
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
        }),
      {
        config: cfg,
        phase: method,
        attributes: {
          limit: max,
          hasMessageId: Boolean(messageId),
          hasOffset: offset !== undefined,
        },
      },
    );
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "session history is rebuilding; retry shortly", {
        details: { method },
        retryable: true,
        retryAfterMs: 250,
      }),
    );
    return;
  }
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, historyEntry);
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  scheduleChatHistoryManagedMediaCleanup({
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
    getNormalizedBytes: () => jsonUtf8Bytes(normalized),
    maxHistoryBytes,
    logDebug: (message) => context.logGateway.debug(message),
  });
  const modelCatalogSnapshot = await modelCatalogPromise;
  const catalogOwnedBySessionAgent = modelCatalogSnapshot?.agentId === sessionAgentId;
  const catalogConfig = catalogOwnedBySessionAgent ? modelCatalogSnapshot.config : cfg;
  const modelCatalog = catalogOwnedBySessionAgent ? modelCatalogSnapshot.entries : undefined;
  const defaultAgentId = resolveDefaultAgentId(catalogConfig);
  let startupProjection: ChatStartupProjectionResult | undefined;
  let startupMetadata: ChatMetadataResult | undefined;
  let startupAgentsList: ReturnType<typeof listAgentsForGateway> | undefined;
  if (method === "chat.startup") {
    const includeSystem = hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.AGENT_KIND);
    const startupProjections = await measureDiagnosticsTimelineSpan(
      `gateway.${method}.startup_projections`,
      async () => {
        const projection = context.readChatStartupProjection
          ? await context
              .readChatStartupProjection({
                agentId: sessionAgentId,
                sessionEntry: entry,
                includeSystem,
              })
              .catch((error: unknown) => {
                context.logGateway.debug(
                  `chat.startup continuing without prepared startup projection: ${formatErrorMessage(error)}`,
                );
                return undefined;
              })
          : undefined;
        const metadata = includeMetadata
          ? (projection?.metadata ??
            (await context
              .readChatMetadata({
                agentId: sessionAgentId,
                sessionEntry: entry,
              })
              .catch((error: unknown) => {
                context.logGateway.debug(
                  `chat.startup continuing without metadata: ${formatErrorMessage(error)}`,
                );
                return undefined;
              })))
          : undefined;
        const agentsList = includeAgentsList
          ? (projection?.agentsList ?? listAgentsForGateway(cfg, modelCatalog, { includeSystem }))
          : undefined;
        return { agentsList, projection, metadata };
      },
      {
        config: cfg,
        phase: method,
        attributes: {
          agentId: sessionAgentId,
          includeSystem,
        },
      },
    );
    startupProjection = startupProjections.projection;
    startupMetadata = startupProjections.metadata;
    startupAgentsList = startupProjections.agentsList;
  }
  const sessionModelCatalog = startupProjection?.sessionModelCatalog ?? modelCatalog;
  const defaultModelCatalog = startupProjection?.defaultModelCatalog ?? modelCatalog;
  const sessionInfo = measureDiagnosticsTimelineSpanSync(
    `gateway.${method}.session_info`,
    () =>
      buildGatewaySessionInfo({
        cfg,
        storePath,
        store,
        key: canonicalKey,
        entry,
        agentId: selectedAgent.agentId,
        modelCatalog: sessionModelCatalog,
      }),
    {
      config: cfg,
      phase: method,
      attributes: {
        storeEntries: Object.keys(store).length,
      },
    },
  );
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
  if (Object.hasOwn(historyPage, "activeLeafEntryId")) {
    sessionInfo.activeLeafEntryId = historyPage.activeLeafEntryId ?? null;
  }
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
    chatRunState: context.chatRunState,
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
    toolOverrides: entry?.toolOverrides,
    verboseLevel,
    ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
    ...(includeAgentsList && startupAgentsList ? { agentsList: startupAgentsList } : {}),
    ...(startupMetadata ? { metadata: startupMetadata } : {}),
  };
  respond(true, payload);
}

export const chatHistoryHandlers: GatewayRequestHandlers = {
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
};

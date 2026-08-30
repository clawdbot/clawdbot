// Read-side chat handlers own history projection, startup metadata, and message lookup.
import {
  ErrorCodes,
  errorShape,
  validateChatHistoryParams,
  validateChatMetadataParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_HISTORY_MAX_ENTRIES } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { resolveAgentConfig, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../../agents/embedded-agent-runner/runs.js";
import { findModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  resolveTranscriptSessionKeyBySessionId,
} from "../../config/sessions/session-accessor.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import {
  boundInFlightRunSnapshotForChatHistory,
  projectInFlightRunSnapshot,
  resolveInFlightRunSnapshot,
} from "../chat-abort.js";
import { resolveEffectiveChatHistoryMaxChars } from "../chat-display-projection.js";
import { resolveClaudeCliBindingSessionId } from "../cli-session-history.js";
import type { ChatRunState } from "../server-chat-state.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { capArrayByJsonBytes } from "../session-transcript-readers.js";
import {
  buildGatewaySessionInfo,
  getSessionDefaults,
  loadGatewaySessionEntryReadOnly,
  resolveSessionModelRef,
} from "../session-utils.js";
import { prepareSessionWorkspaceIcon } from "../workspace-icon-http.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import {
  capChatHistoryAroundMessage,
  enrichChatHistoryCompactionMarkers,
  readChatHistoryPage,
  resolveChatHistoryNextOffset,
  shouldReplayOldestChatHistoryRecord,
} from "./chat-history-pages.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { readSessionPlacementFields } from "./session-placement-read-projection.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatHistoryMethod = "chat.history" | "chat.startup";

function respondChatHistoryUnavailable(
  method: ChatHistoryMethod,
  respond: GatewayRequestHandlerOptions["respond"],
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "session history is rebuilding; retry shortly", {
      details: { method },
      retryable: true,
      retryAfterMs: 250,
    }),
  );
}

function resolveEmbeddedAgentRunRecoverySnapshot(params: {
  chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs">;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  sessionId?: string;
}) {
  const sessionId =
    params.sessionId ??
    resolveActiveEmbeddedRunHandleSessionId(params.canonicalSessionKey) ??
    resolveActiveEmbeddedRunHandleSessionId(params.requestedSessionKey);
  if (!sessionId) {
    return undefined;
  }
  const owner = resolveActiveEmbeddedRunOwner(sessionId);
  if (!owner) {
    return undefined;
  }
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId: owner.runId,
    startedAtMs: owner.startedAtMs,
    sessionAbortable: true,
  });
}

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
  if (metadataParams.sessionKey) {
    const requested = resolveRequestedChatAgentId({
      cfg,
      requestedSessionKey: metadataParams.sessionKey,
      agentId: metadataParams.agentId,
    });
    if (!requested.ok) {
      respond(false, undefined, requested.error);
      return;
    }
    // The router authorizes the session selector; only the persisted entry supplies auth profiles.
    const session = loadGatewaySessionEntryReadOnly(metadataParams.sessionKey, {
      agentId: requested.agentId,
    });
    respond(
      true,
      await context.readChatMetadata({
        agentId: resolveSessionAgentId({
          sessionKey: metadataParams.sessionKey,
          config: session.cfg,
          agentId: requested.agentId,
        }),
        sessionEntry: session.entry,
      }),
    );
    return;
  }
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: metadataParams.agentId,
    respond,
    cfg,
    normalize: (rawAgentId) =>
      typeof rawAgentId === "string" && rawAgentId.trim()
        ? normalizeAgentId(rawAgentId)
        : undefined,
  });
  if (!resolvedAgent) {
    return;
  }
  respond(
    true,
    await context.readChatMetadata({
      agentId: resolvedAgent.agentId,
    }),
  );
}

async function handleChatHistoryRequest({
  params,
  respond,
  context,
  method,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
}) {
  if (!assertValidParams(params, validateChatHistoryParams, method, respond)) {
    return;
  }
  const {
    sessionKey,
    limit,
    offset,
    cursor,
    messageId,
    sessionId: requestedSessionId,
    maxChars,
    pendingBefore,
  } = params as {
    sessionKey: string;
    agentId?: string;
    limit?: number;
    offset?: number;
    cursor?: string;
    messageId?: string;
    sessionId?: string;
    maxChars?: number;
    pendingBefore?: number;
  };
  if (offset !== undefined && messageId !== undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "offset and messageId cannot be used together"),
    );
    return;
  }
  if (cursor !== undefined && (offset !== undefined || messageId !== undefined)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "cursor cannot be used with offset or messageId"),
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
  const requestedAgent = resolveRequestedChatAgentId({
    cfg: requestConfig,
    requestedSessionKey: sessionKey,
    agentId: agentIdOverride,
  });
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const requestedAgentId = requestedAgent.agentId;
  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, store, entry, canonicalKey } = measureDiagnosticsTimelineSpanSync(
    `gateway.${method}.session_entry`,
    () =>
      loadGatewaySessionEntryReadOnly(sessionKey, {
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
    explicitAgentId: agentIdOverride,
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
  if (method === "chat.startup") {
    void prepareSessionWorkspaceIcon({ sessionKey, agentId: sessionAgentId }).catch(
      (error: unknown) => {
        context.logGateway.debug(
          `chat.startup continuing without a workspace icon: ${formatErrorMessage(error)}`,
        );
      },
    );
  }
  const readStartupProjection = () =>
    measureDiagnosticsTimelineSpan(
      `gateway.${method}.startup_projection`,
      async () => {
        try {
          return await context.readChatStartupProjection?.({
            agentId: sessionAgentId,
            sessionEntry: entry,
            readPolicy: method === "chat.history" ? "ready" : "current",
          });
        } catch (error) {
          context.logGateway.debug(
            `${method} continuing without prepared startup projection: ${formatErrorMessage(error)}`,
          );
          return undefined;
        }
      },
      { config: cfg, phase: method, attributes: { agentId: sessionAgentId } },
    );
  const startupProjectionPromise = entry?.authProfileOverride?.trim()
    ? readStartupProjection()
    : undefined;
  const sessionId = requestedSessionId ?? entry?.sessionId;
  const historyEntry =
    requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
  // Transcript projection needs a provider id, not executable model preparation.
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId, {
    allowPluginNormalization: false,
  });
  const requested = typeof limit === "number" ? limit : 200;
  const max = Math.min(CHAT_HISTORY_MAX_ENTRIES, requested);
  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
  const pendingInputs =
    sessionId && sessionId === entry?.sessionId
      ? readChatPendingInputs(
          {
            agentId: sessionAgentId,
            sessionKey: canonicalKey,
            sessionId,
            storePath,
          },
          { before: pendingBefore, limit: max, maxChars: effectiveMaxChars },
        )
      : { items: [], total: 0 };
  let historyPage: Awaited<ReturnType<typeof readChatHistoryPage>>;
  try {
    historyPage = cursor
      ? { messages: [] }
      : await measureDiagnosticsTimelineSpan(
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
    respondChatHistoryUnavailable(method, respond);
    return;
  }
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, historyEntry);
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const byteCounter = createChatHistoryByteCounter();
  const replaced = replaceOversizedChatHistoryMessages({
    byteCounter,
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const capped = messageId
    ? (capChatHistoryAroundMessage({
        messages: replaced.messages,
        messageId,
        // A nonempty JSON array costs one framing byte plus each message and its separator.
        maxCost: maxHistoryBytes - 1,
        messageCost: (message) => byteCounter.messageBytes(message) + 1,
      }) ?? capArrayByJsonBytes(replaced.messages, maxHistoryBytes, byteCounter.messageBytes).items)
    : capArrayByJsonBytes(replaced.messages, maxHistoryBytes, byteCounter.messageBytes).items;
  const historyBudgetPreserved =
    replaced.replacedCount === 0 &&
    capped.length === normalized.length &&
    capped.every((message, index) => message === normalized[index]);
  const pagination = historyPage.pagination;
  const candidateNextOffset =
    pagination === undefined
      ? undefined
      : resolveChatHistoryNextOffset({
          messages: capped,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          replayOldestRecord: shouldReplayOldestChatHistoryRecord({
            projected: normalized,
            bounded: capped,
          }),
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? pagination.exhausted !== true && candidateNextOffset < pagination.totalMessages
      : undefined;
  const nextOffset = hasMore ? candidateNextOffset : undefined;
  reportOmittedChatHistory({
    originalMessages: normalized,
    finalMessages: capped,
    getNormalizedBytes: () => byteCounter.messagesBytes(normalized),
    maxHistoryBytes,
    logDebug: (message) => context.logGateway.debug(message),
  });
  const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  const startupProjection = await (startupProjectionPromise ?? readStartupProjection());
  const startupMetadata = method === "chat.startup" ? startupProjection?.metadata : undefined;
  const sessionModelCatalog = startupProjection?.sessionModelCatalog;
  const defaultModelCatalog = startupProjection?.defaultModelCatalog;
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
  const activeRunAgentId = selectedAgent.agentId;
  const activeRunState = resolveVisibleActiveSessionRunState({
    context,
    requestedKey: sessionKey,
    canonicalKey,
    sessionId,
    ...(activeRunAgentId ? { agentId: activeRunAgentId } : {}),
    defaultAgentId: compatibilityOwnerAgentId,
    // History stays active until the terminal row is queryable or its write fails.
    includeTerminalPersistence: true,
  });
  sessionInfo.hasActiveRun = activeRunState.active;
  if (activeRunState.runIds !== undefined) {
    sessionInfo.activeRunIds = activeRunState.runIds;
  }
  if (activeRunState.active) {
    sessionInfo.status = activeRunState.status ?? "running";
  }
  // Clients merge this row into the same store sessions.list fills, so it must
  // carry the placement facts that projection adds; without them the merge
  // erases a live worker placement and its move intent.
  Object.assign(sessionInfo, readSessionPlacementFields(context, entry?.sessionId));
  // An active embedded run can be owned by the embedded registry while absent
  // from the visible chat-abort controllers. The activeRunIds field stays
  // omitted to preserve the exact-chat-send identity contract (coordination
  // gates such as suggestion send-now rely on it being a complete set); the
  // scoped inFlightRun snapshot below drives UI adoption instead.
  const embeddedRecovery = resolveEmbeddedAgentRunRecoverySnapshot({
    chatRunState: context.chatRunState,
    requestedSessionKey: sessionKey,
    canonicalSessionKey: canonicalKey,
    sessionId,
  });
  if (Object.hasOwn(historyPage, "activeLeafEntryId")) {
    sessionInfo.activeLeafEntryId = historyPage.activeLeafEntryId ?? null;
  }
  const defaults = getSessionDefaults(cfg, defaultModelCatalog, {
    agentId: sessionAgentId,
    providerPolicySource: "active",
  });
  // Unprepared catalog facts are unknown, not an Off default or a smaller profile.
  // Omission lets clients retain richer same-identity metadata; authored defaults still apply.
  for (const [projection, catalog] of [
    [sessionInfo, sessionModelCatalog],
    [defaults, defaultModelCatalog],
  ] as const) {
    const provider = projection.modelProvider;
    const model = projection.model;
    const catalogEntry =
      catalog && provider && model
        ? findModelCatalogEntry(catalog, { provider, modelId: model })
        : undefined;
    if (typeof catalogEntry?.reasoning === "boolean") {
      continue;
    }
    delete projection.thinkingLevels;
    delete projection.thinkingOptions;
    projection.thinkingDefault =
      resolveAgentConfig(cfg, sessionAgentId)?.thinkingDefault ??
      (provider && model
        ? resolveConfiguredThinkingDefault({ cfg, provider, model })
        : cfg.agents?.defaults?.thinkingDefault);
  }
  const thinkingLevel = sessionInfo.thinkingLevel ?? sessionInfo.thinkingDefault;
  const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
  sessionInfo.verboseLevel = verboseLevel;
  // Surface any run still streaming for this session+agent so a client that
  // switched away (and stopped receiving the run's per-agent-delivered events)
  // can restore the in-flight assistant text on switch-back.
  const inFlightRun =
    resolveInFlightRunSnapshot({
      chatAbortControllers: context.chatAbortControllers,
      chatRunState: context.chatRunState,
      requestedSessionKey: sessionKey,
      // The agent-scoped canonical key from session load: an unscoped re-resolve
      // falls back to the default agent for alias keys, misses the abort entry's
      // stored key, and drops the in-flight snapshot for non-default agents.
      canonicalSessionKey: canonicalKey,
      agentId: activeRunAgentId,
      defaultAgentId: compatibilityOwnerAgentId,
    }) ?? embeddedRecovery;
  if (cursor !== undefined) {
    if (!sessionId || !storePath || resolveClaudeCliBindingSessionId(entry)) {
      respond(true, { kind: "reset" });
      return;
    }
    const sessionSnapshot = buildGatewaySessionSnapshot({
      sessionRow: sessionInfo,
      agentId: sessionAgentId,
      includeSession: true,
      activeRunState,
    });
    let delta: ReturnType<typeof readChatHistoryDelta>;
    try {
      delta = readChatHistoryDelta({
        agentId: sessionAgentId,
        cursor,
        scope: {
          agentId: sessionAgentId,
          sessionEntry: entry,
          sessionId,
          sessionKey: canonicalKey,
          storePath,
        },
        sessionKey: canonicalKey,
        sessionSnapshot,
      });
    } catch (error) {
      if (!isSessionTranscriptProjectionUnavailableError(error)) {
        throw error;
      }
      respondChatHistoryUnavailable(method, respond);
      return;
    }
    if (delta.kind === "reset") {
      respond(true, delta);
      return;
    }
    sessionInfo.activeLeafEntryId = delta.activeLeafEntryId;
    const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
      snapshot: inFlightRun,
      messages: delta.messages,
      maxBytes: maxHistoryBytes,
    });
    respond(true, {
      kind: "delta",
      messages: delta.messages,
      deltaCursor: delta.deltaCursor,
      pendingInputs,
      sessionInfo,
      ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
      ...(startupMetadata ? { metadata: startupMetadata } : {}),
    });
    return;
  }
  const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
    snapshot: inFlightRun,
    messages: capped,
    maxBytes: maxHistoryBytes,
  });
  const payload = {
    sessionKey,
    sessionId,
    messages: composeTranscriptDisplay(capped),
    pendingInputs,
    ...(historyPage.deltaCursor ? { deltaCursor: historyPage.deltaCursor } : {}),
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
    ...(startupMetadata ? { metadata: startupMetadata } : {}),
  };
  respond(true, payload);
}

export const chatHistoryHandlers: GatewayRequestHandlers = {
  "chat.history": async (opts) => {
    await handleChatHistoryRequest({ ...opts, method: "chat.history" });
  },
  "chat.startup": async (opts) => {
    await handleChatHistoryRequest({ ...opts, method: "chat.startup" });
  },
  "chat.metadata": handleChatMetadataRequest,
};

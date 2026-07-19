// Read-side chat handlers own history projection, startup metadata, and message lookup.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatHistoryParams,
  validateChatMetadataParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { modelCatalogBrowseRequiresFullDiscovery } from "../../agents/model-catalog-browse.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  resolveTranscriptSessionKeyBySessionId,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { normalizeAgentId, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
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
  loadSessionEntry,
  listAgentsForGateway,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../session-utils.js";
import { scheduleChatHistoryManagedImageCleanup } from "./chat-assistant-content.js";
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
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import {
  loadOptionalServerMethodModelCatalog,
  loadOptionalServerMethodModelCatalogSnapshot,
  startOptionalServerMethodModelCatalogSnapshotLoad,
} from "./optional-model-catalog.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
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
  let historyPage: Awaited<ReturnType<typeof readChatHistoryPage>>;
  try {
    historyPage = await readChatHistoryPage({
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
    chatRunPlanSnapshots: context.chatRunPlanSnapshots,
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

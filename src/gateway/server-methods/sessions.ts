import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { resolveModelAgentRuntimeMetadata } from "../../agents/agent-runtime-metadata.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded-runner/runs.js";
import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import {
  loadSessionStore,
  runSessionsCleanup,
  serializeSessionCleanupResult,
  resolveMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "../../hooks/internal-hooks.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  type SessionOperationEvent,
  validateSessionsAbortParams,
  validateSessionsCleanupParams,
  validateSessionsCompactParams,
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionGetParams,
  validateSessionsCompactionListParams,
  validateSessionsCompactionRestoreParams,
  validateSessionsCreateParams,
  validateSessionsDeleteParams,
  validateSessionsDescribeParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsPatchParams,
  validateSessionsPluginPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsSendParams,
} from "../protocol/index.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import {
  forkCompactionCheckpointTranscriptAsync,
  getSessionCompactionCheckpoint,
  listSessionCompactionCheckpoints,
} from "../session-compaction-checkpoints.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../session-store-key.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  archiveFileOnDisk,
  buildGatewaySessionRow,
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGateway,
  loadGatewaySessionRow,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readRecentSessionMessagesWithStatsAsync,
  readRecentSessionTranscriptLines,
  readSessionMessageCountAsync,
  readSessionPreviewItemsFromTranscript,
  resolveDeletedAgentIdFromSessionKey,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionDisplayModelIdentityRef,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { chatHandlers } from "./chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

function filterSessionStoreToConfiguredAgents(
  cfg: OpenClawConfig,
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  const configuredAgentIds = new Set(listAgentIds(cfg).map((agentId) => normalizeAgentId(agentId)));
  return Object.fromEntries(
    Object.entries(store).filter(([key]) => {
      if (key === "global" || key === "unknown") {
        return true;
      }
      const parsed = parseAgentSessionKey(key);
      return parsed ? configuredAgentIds.has(normalizeAgentId(parsed.agentId)) : false;
    }),
  );
}

type SessionsRuntimeModule = typeof import("./sessions.runtime.js");

let sessionsRuntimeModulePromise: Promise<SessionsRuntimeModule> | undefined;
let loggedSlowSessionsListCatalog = false;

const SESSIONS_LIST_MODEL_CATALOG_TIMEOUT_MS = 750;

function loadSessionsRuntimeModule(): Promise<SessionsRuntimeModule> {
  sessionsRuntimeModulePromise ??= import("./sessions.runtime.js");
  return sessionsRuntimeModulePromise;
}

async function loadOptionalSessionsListModelCatalog(
  context: GatewayRequestContext,
): Promise<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>> | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("sessions-list-model-catalog-timeout");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), SESSIONS_LIST_MODEL_CATALOG_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    const result = await Promise.race([
      context.loadGatewayModelCatalog().catch(() => undefined),
      timeoutPromise,
    ]);
    if (result === timedOut) {
      if (!loggedSlowSessionsListCatalog) {
        loggedSlowSessionsListCatalog = true;
        context.logGateway.debug(
          `sessions.list continuing without model catalog after ${SESSIONS_LIST_MODEL_CATALOG_TIMEOUT_MS}ms`,
        );
      }
      return undefined;
    }
    return Array.isArray(result) ? result : undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = normalizeOptionalString(raw) ?? "";
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function rejectPluginRuntimeDeleteMismatch(params: {
  client: GatewayClient | null;
  key: string;
  entry: SessionEntry | undefined;
  respond: RespondFn;
}): boolean {
  const pluginOwnerId = normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId);
  if (!pluginOwnerId || !params.entry) {
    return false;
  }
  if (normalizeOptionalString(params.entry.pluginOwnerId) === pluginOwnerId) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Plugin "${pluginOwnerId}" cannot delete session "${params.key}" because it did not create it.`,
    ),
  );
  return true;
}

function resolveGatewaySessionTargetFromKey(key: string, cfg: OpenClawConfig) {
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function resolveOptionalInitialSessionMessage(params: {
  task?: unknown;
  message?: unknown;
}): string | undefined {
  if (typeof params.task === "string" && params.task.trim()) {
    return params.task;
  }
  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }
  return undefined;
}

function shouldAttachPendingMessageSeq(params: { payload: unknown; cached?: boolean }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

function emitSessionsChanged(
  context: Pick<
    GatewayRequestContext,
    "broadcastToConnIds" | "chatAbortControllers" | "getSessionEventSubscriberConnIds"
  >,
  payload: { sessionKey?: string; reason: string; compacted?: boolean },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            updatedAt: sessionRow.updatedAt ?? undefined,
            sessionId: sessionRow.sessionId,
            kind: sessionRow.kind,
            channel: sessionRow.channel,
            subject: sessionRow.subject,
            groupChannel: sessionRow.groupChannel,
            space: sessionRow.space,
            chatType: sessionRow.chatType,
            origin: sessionRow.origin,
            spawnedBy: sessionRow.spawnedBy,
            spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
            forkedFromParent: sessionRow.forkedFromParent,
            spawnDepth: sessionRow.spawnDepth,
            subagentRole: sessionRow.subagentRole,
            subagentControlScope: sessionRow.subagentControlScope,
            label: sessionRow.label,
            displayName: sessionRow.displayName,
            deliveryContext: sessionRow.deliveryContext,
            parentSessionKey: sessionRow.parentSessionKey,
            childSessions: sessionRow.childSessions,
            thinkingLevel: sessionRow.thinkingLevel,
            fastMode: sessionRow.fastMode,
            verboseLevel: sessionRow.verboseLevel,
            traceLevel: sessionRow.traceLevel,
            reasoningLevel: sessionRow.reasoningLevel,
            elevatedLevel: sessionRow.elevatedLevel,
            sendPolicy: sessionRow.sendPolicy,
            systemSent: sessionRow.systemSent,
            abortedLastRun: sessionRow.abortedLastRun,
            inputTokens: sessionRow.inputTokens,
            outputTokens: sessionRow.outputTokens,
            lastChannel: sessionRow.lastChannel,
            lastTo: sessionRow.lastTo,
            lastAccountId: sessionRow.lastAccountId,
            lastThreadId: sessionRow.lastThreadId,
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            contextTokens: sessionRow.contextTokens,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            responseUsage: sessionRow.responseUsage,
            modelProvider: sessionRow.modelProvider,
            model: sessionRow.model,
            status: sessionRow.status,
            hasActiveRun: hasTrackedActiveSessionRun({
              context,
              requestedKey: payload.sessionKey ?? sessionRow.key,
              canonicalKey: sessionRow.key,
            }),
            startedAt: sessionRow.startedAt,
            endedAt: sessionRow.endedAt,
            runtimeMs: sessionRow.runtimeMs,
            compactionCheckpointCount: sessionRow.compactionCheckpointCount,
            latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
            pluginExtensions: sessionRow.pluginExtensions,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

function emitSessionOperation(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: Omit<SessionOperationEvent, "ts">,
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  context.broadcastToConnIds(
    "session.operation",
    {
      ...payload,
      ts: Date.now(),
    } satisfies SessionOperationEvent,
    connIds,
    { dropIfSlow: true },
  );
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete" | "compact" | "restore";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function buildDashboardSessionKey(agentId: string): string {
  return `agent:${agentId}:dashboard:${randomUUID()}`;
}

function cloneCheckpointSessionEntry(params: {
  currentEntry: SessionEntry;
  nextSessionId: string;
  nextSessionFile: string;
  label?: string;
  parentSessionKey?: string;
  totalTokens?: number;
  preserveCompactionCheckpoints?: boolean;
}): SessionEntry {
  return {
    ...params.currentEntry,
    sessionId: params.nextSessionId,
    sessionFile: params.nextSessionFile,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? params.totalTokens
        : undefined,
    totalTokensFresh:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? true
        : undefined,
    label: params.label ?? params.currentEntry.label,
    parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
    compactionCheckpoints: params.preserveCompactionCheckpoints
      ? params.currentEntry.compactionCheckpoints
      : undefined,
  };
}

function isAgentMainSessionKey(cfg: OpenClawConfig, sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return sessionKey === resolveAgentMainSessionKey({ cfg, agentId: parsed.agentId });
}

async function createAgentMainSessionForSend(params: {
  req: GatewayRequestHandlerOptions["req"];
  canonicalKey: string;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
}): Promise<
  | {
      ok: true;
      entry: SessionEntry;
      canonicalKey: string;
      storePath: string;
    }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const agentId = parseAgentSessionKey(params.canonicalKey)?.agentId;
  if (!agentId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${params.canonicalKey}`),
    };
  }

  let createResult:
    | { ok: boolean; payload?: { key?: string }; error?: ReturnType<typeof errorShape> }
    | undefined;
  await sessionsHandlers["sessions.create"]({
    req: params.req,
    params: {
      key: params.canonicalKey,
      agentId,
    },
    respond: (ok, payload, error) => {
      createResult = {
        ok,
        payload: payload && typeof payload === "object" ? (payload as { key?: string }) : undefined,
        error,
      };
    },
    context: params.context,
    client: params.client,
    isWebchatConnect: params.isWebchatConnect,
  });

  if (!createResult) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "sessions.create did not respond"),
    };
  }
  if (!createResult.ok) {
    return {
      ok: false,
      error: createResult.error ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to create session"),
    };
  }

  const createdKey = normalizeOptionalString(createResult.payload?.key) ?? params.canonicalKey;
  const loaded = loadSessionEntry(createdKey);
  if (!loaded.entry?.sessionId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, `session not created: ${createdKey}`),
    };
  }
  return {
    ok: true,
    entry: loaded.entry,
    canonicalKey: loaded.canonicalKey,
    storePath: loaded.storePath,
  };
}

function ensureSessionTranscriptFile(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
}): { ok: true; transcriptPath: string } | { ok: false; error: string } {
  try {
    const transcriptPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        storePath: params.storePath,
        agentId: params.agentId,
      }),
    );
    if (!fs.existsSync(transcriptPath)) {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    return { ok: true, transcriptPath };
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
  activeRunSessionKey?: string;
  aliasKeys?: string[];
}): string {
  if (params.activeRunSessionKey) {
    return params.activeRunSessionKey;
  }
  const candidates = [params.canonicalKey, params.requestedKey, ...(params.aliasKeys ?? [])];
  for (const active of params.context.chatAbortControllers.values()) {
    for (const candidate of candidates) {
      if (active.sessionKey === candidate) {
        return candidate;
      }
    }
  }
  return params.requestedKey;
}

function resolveSessionKeyAgentId(
  sessionKey: string | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  if (!parseAgentSessionKey(key) && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });
  return resolveSessionStoreAgentId(cfg, canonicalKey);
}

function sessionKeyBelongsToAgent(
  sessionKey: string | undefined,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  const key = normalizeOptionalString(sessionKey);
  if (cfg.session?.scope === "global" && key?.toLowerCase() === "global") {
    return true;
  }
  const sessionAgentId = resolveSessionKeyAgentId(sessionKey, cfg);
  return Boolean(sessionAgentId && sessionAgentId === normalizeAgentId(agentId));
}

function resolveScopedAbortKey(params: {
  cfg: OpenClawConfig;
  key: string | undefined;
  agentId: string | undefined;
}): string | undefined {
  const key = normalizeOptionalString(params.key);
  if (!key) {
    return undefined;
  }
  const requestedAgentId = normalizeOptionalString(params.agentId);
  if (!requestedAgentId) {
    return key;
  }
  const scopedAgentId = normalizeAgentId(requestedAgentId);
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
  if (ownerAgentId && ownerAgentId !== scopedAgentId) {
    return undefined;
  }
  return resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
}

function collectTrackedActiveSessionRunKeys(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
): Set<string> {
  const keys = new Set<string>();
  if (!(context.chatAbortControllers instanceof Map)) {
    return keys;
  }
  for (const active of context.chatAbortControllers.values()) {
    if (typeof active.sessionKey === "string" && active.sessionKey.trim()) {
      keys.add(active.sessionKey);
    }
  }
  return keys;
}

function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
}): boolean {
  const activeSessionKeys = collectTrackedActiveSessionRunKeys(params.context);
  return activeSessionKeys.has(params.canonicalKey) || activeSessionKeys.has(params.requestedKey);
}

async function interruptSessionRunIfActive(params: {
  req: GatewayRequestHandlerOptions["req"];
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const hasTrackedRun = hasTrackedActiveSessionRun({
    context: params.context,
    requestedKey: params.requestedKey,
    canonicalKey: params.canonicalKey,
  });
  const hasEmbeddedRun =
    typeof params.sessionId === "string" && params.sessionId
      ? isEmbeddedPiRunActive(params.sessionId)
      : false;

  if (!hasTrackedRun && !hasEmbeddedRun) {
    return { interrupted: false };
  }

  if (hasTrackedRun) {
    let abortOk = true;
    let abortError: ReturnType<typeof errorShape> | undefined;
    const abortSessionKey = resolveAbortSessionKey({
      context: params.context,
      requestedKey: params.requestedKey,
      canonicalKey: params.canonicalKey,
    });

    await chatHandlers["chat.abort"]({
      req: params.req,
      params: {
        sessionKey: abortSessionKey,
      },
      respond: (ok, _payload, error) => {
        abortOk = ok;
        abortError = error;
      },
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });

    if (!abortOk) {
      return {
        interrupted: true,
        error:
          abortError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session"),
      };
    }
  }

  if (hasEmbeddedRun && params.sessionId) {
    abortEmbeddedPiRun(params.sessionId);
  }

  clearSessionQueues([params.requestedKey, params.canonicalKey, params.sessionId]);

  if (hasEmbeddedRun && params.sessionId) {
    const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
    if (!ended) {
      return {
        interrupted: true,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${params.requestedKey} is still active; try again in a moment.`,
        ),
      };
    }
  }

  return { interrupted: true };
}

async function handleSessionSend(params: {
  method: "sessions.send" | "sessions.steer";
  req: GatewayRequestHandlerOptions["req"];
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  interruptIfActive: boolean;
}) {
  if (
    !assertValidParams(params.params, validateSessionsSendParams, params.method, params.respond)
  ) {
    return;
  }
  const p = params.params;
  const key = requireSessionKey((p as { key?: unknown }).key, params.respond);
  if (!key) {
    return;
  }
  const loaded = loadSessionEntry(key);
  const { cfg } = loaded;
  let { entry, canonicalKey, storePath } = loaded;
  // Reject sends/steers targeting sessions whose owning agent was deleted (#65524).
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, canonicalKey);
  if (deletedAgentId !== null) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Agent "${deletedAgentId}" no longer exists in configuration`,
      ),
    );
    return;
  }
  if (!entry?.sessionId && !params.interruptIfActive && isAgentMainSessionKey(cfg, canonicalKey)) {
    const created = await createAgentMainSessionForSend({
      req: params.req,
      canonicalKey,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });
    if (!created.ok) {
      params.respond(false, undefined, created.error);
      return;
    }
    entry = created.entry;
    canonicalKey = created.canonicalKey;
    storePath = created.storePath;
  }
  if (!entry?.sessionId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
    );
    return;
  }

  let interruptedActiveRun = false;
  if (params.interruptIfActive) {
    const interruptResult = await interruptSessionRunIfActive({
      req: params.req,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
      requestedKey: key,
      canonicalKey,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      params.respond(false, undefined, interruptResult.error);
      return;
    }
    interruptedActiveRun = interruptResult.interrupted;
  }

  const messageSeq =
    (await readSessionMessageCountAsync(entry.sessionId, storePath, entry.sessionFile)) + 1;
  let sendAcked = false;
  let sendPayload: unknown;
  let sendCached = false;
  let startedRunId: string | undefined;
  const rawIdempotencyKey = (p as { idempotencyKey?: string }).idempotencyKey;
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : randomUUID();
  await chatHandlers["chat.send"]({
    req: params.req,
    params: {
      sessionKey: canonicalKey,
      message: (p as { message: string }).message,
      thinking: (p as { thinking?: string }).thinking,
      attachments: (p as { attachments?: unknown[] }).attachments,
      timeoutMs: (p as { timeoutMs?: number }).timeoutMs,
      idempotencyKey,
    },
    respond: (ok, payload, error, meta) => {
      sendAcked = ok;
      sendPayload = payload;
      sendCached = meta?.cached === true;
      startedRunId =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId
          : undefined;
      if (ok && shouldAttachPendingMessageSeq({ payload, cached: meta?.cached === true })) {
        params.respond(
          true,
          {
            ...(payload && typeof payload === "object" ? payload : {}),
            messageSeq,
            ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
          },
          undefined,
          meta,
        );
        return;
      }
      params.respond(
        ok,
        ok && payload && typeof payload === "object"
          ? {
              ...payload,
              ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
            }
          : payload,
        error,
        meta,
      );
    },
    context: params.context,
    client: params.client,
    isWebchatConnect: params.isWebchatConnect,
  });
  if (sendAcked) {
    if (shouldAttachPendingMessageSeq({ payload: sendPayload, cached: sendCached })) {
      await reactivateCompletedSubagentSession({
        sessionKey: canonicalKey,
        runId: startedRunId,
      });
    }
    emitSessionsChanged(params.context, {
      sessionKey: canonicalKey,
      reason: interruptedActiveRun ? "steer" : "send",
    });
  }
}
export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const configuredAgentsOnly = p.configuredAgentsOnly === true;
    const payload = await measureDiagnosticsTimelineSpan(
      "gateway.sessions.list",
      async () => {
        const { storePath, store } = measureDiagnosticsTimelineSpanSync(
          "gateway.sessions.list.store_load",
          () =>
            loadCombinedSessionStoreForGateway(cfg, {
              agentId: p.agentId,
              configuredAgentsOnly,
            }),
          {
            config: cfg,
            phase: "sessions.list",
            attributes: {
              agentId: p.agentId ?? null,
              configuredAgentsOnly,
            },
          },
        );
        const listStore = configuredAgentsOnly
          ? filterSessionStoreToConfiguredAgents(cfg, store)
          : store;
        const modelCatalog = await measureDiagnosticsTimelineSpan(
          "gateway.sessions.list.model_catalog",
          () => loadOptionalSessionsListModelCatalog(context),
          {
            config: cfg,
            phase: "sessions.list",
          },
        );
        const result = await measureDiagnosticsTimelineSpan(
          "gateway.sessions.list.rows",
          () =>
            listSessionsFromStoreAsync({
              cfg,
              storePath,
              store: listStore,
              modelCatalog,
              opts: p,
            }),
          {
            config: cfg,
            phase: "sessions.list",
            attributes: {
              storeEntries: Object.keys(listStore).length,
            },
          },
        );
        const sessions = measureDiagnosticsTimelineSpanSync(
          "gateway.sessions.list.active_run_flags",
          () => {
            const activeSessionKeys = collectTrackedActiveSessionRunKeys(context);
            return result.sessions.map((session) =>
              Object.assign({}, session, {
                hasActiveRun: activeSessionKeys.has(session.key),
              }),
            );
          },
          {
            config: cfg,
            phase: "sessions.list",
            attributes: {
              sessions: result.sessions.length,
            },
          },
        );
        return {
          ...result,
          sessions,
        };
      },
      {
        config: cfg,
        phase: "sessions.list",
        attributes: {
          agentId: p.agentId ?? null,
          configuredAgentsOnly,
        },
      },
    );
    respond(true, payload, undefined);
  },
  "sessions.cleanup": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)) {
      return;
    }
    try {
      const { mode, appliedSummaries } = await runSessionsCleanup({
        cfg: context.getRuntimeConfig(),
        opts: {
          agent: params.agent,
          allAgents: params.allAgents,
          enforce: params.enforce,
          activeKey: params.activeKey,
          fixMissing: params.fixMissing,
          fixDmScope: params.fixDmScope,
        },
      });
      const result = serializeSessionCleanupResult({
        mode,
        dryRun: false,
        summaries: appliedSummaries,
      });
      respond(true, result, undefined);
      for (const summary of appliedSummaries) {
        emitSessionsChanged(context, {
          reason: "cleanup",
          sessionKey: undefined,
        });
        if (summary.wouldMutate) {
          context.logGateway.debug(
            `sessions.cleanup applied ${summary.storePath}: ${summary.beforeCount} -> ${summary.afterCount}`,
          );
        }
      }
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
  "sessions.subscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.subscribeSessionEvents(connId);
    }
    respond(true, { subscribed: Boolean(connId) }, undefined);
  },
  "sessions.unsubscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.unsubscribeSessionEvents(connId);
    }
    respond(true, { subscribed: false }, undefined);
  },
  "sessions.messages.subscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSubscribeParams,
        "sessions.messages.subscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.subscribeSessionMessageEvents(connId, canonicalKey);
      respond(true, { subscribed: true, key: canonicalKey }, undefined);
      return;
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.messages.unsubscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesUnsubscribeParams,
        "sessions.messages.unsubscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.unsubscribeSessionMessageEvents(connId, canonicalKey);
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.preview": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => normalizeOptionalString(key ?? ""))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.describe": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg);
    const store = loadSessionStore(storePath);
    const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
    if (!entry) {
      respond(true, { session: null }, undefined);
      return;
    }
    const row = buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key: target.canonicalKey,
      entry,
      includeDerivedTitles: params.includeDerivedTitles,
      includeLastMessage: params.includeLastMessage,
      transcriptUsageMaxBytes: 64 * 1024,
    });
    respond(true, { session: row }, undefined);
  },
  "sessions.resolve": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.compaction.list": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionListParams,
        "sessions.compaction.list",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { entry, canonicalKey } = loadSessionEntry(key);
    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        checkpoints: listSessionCompactionCheckpoints(entry),
      },
      undefined,
    );
  },
  "sessions.compaction.get": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionGetParams,
        "sessions.compaction.get",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const checkpointId = normalizeOptionalString(p.checkpointId) ?? "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const { entry, canonicalKey } = loadSessionEntry(key);
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        checkpoint,
      },
      undefined,
    );
  },
  "sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const requestedKey = normalizeOptionalString(p.key);
    const agentId = normalizeAgentId(
      normalizeOptionalString(p.agentId) ?? resolveDefaultAgentId(cfg),
    );
    if (requestedKey) {
      const requestedAgentId = parseAgentSessionKey(requestedKey)?.agentId;
      if (requestedAgentId && requestedAgentId !== agentId && normalizeOptionalString(p.agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `sessions.create key agent (${requestedAgentId}) does not match agentId (${agentId})`,
          ),
        );
        return;
      }
    }
    const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
    let canonicalParentSessionKey: string | undefined;
    if (parentSessionKey) {
      const parent = loadSessionEntry(parentSessionKey);
      if (!parent.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown parent session: ${parentSessionKey}`),
        );
        return;
      }
      canonicalParentSessionKey = parent.canonicalKey;
    }
    if (
      canonicalParentSessionKey &&
      p.emitCommandHooks === true &&
      !requestedKey &&
      !resolveOptionalInitialSessionMessage(p) &&
      cfg.session?.dmScope === "main"
    ) {
      const parentAgentId = normalizeAgentId(
        resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? resolveDefaultAgentId(cfg),
      );
      const parentMainKey = resolveAgentMainSessionKey({ cfg, agentId: parentAgentId });
      if (canonicalParentSessionKey === parentMainKey) {
        const { performGatewaySessionReset } = await loadSessionsRuntimeModule();
        const resetResult = await performGatewaySessionReset({
          key: canonicalParentSessionKey,
          reason: "new",
          commandSource: "webchat",
        });
        if (!resetResult.ok) {
          respond(false, undefined, resetResult.error);
          return;
        }
        respond(
          true,
          {
            ok: true,
            key: resetResult.key,
            sessionId: resetResult.entry.sessionId,
            entry: resetResult.entry,
            runStarted: false,
          },
          undefined,
        );
        emitSessionsChanged(context, {
          sessionKey: resetResult.key,
          reason: "new",
        });
        return;
      }
    }
    if (canonicalParentSessionKey && p.emitCommandHooks === true) {
      const { entry: parentEntry } = loadSessionEntry(canonicalParentSessionKey);
      const parentAgentId = normalizeAgentId(
        resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? resolveDefaultAgentId(cfg),
      );
      const workspaceDir = resolveAgentWorkspaceDir(cfg, parentAgentId);
      if (hasInternalHookListeners("command", "new")) {
        const hookEvent = createInternalHookEvent("command", "new", canonicalParentSessionKey, {
          sessionEntry: parentEntry,
          previousSessionEntry: parentEntry,
          commandSource: "webchat",
          cfg,
          workspaceDir,
        });
        await triggerInternalHook(hookEvent);
      }
      const parentTarget = resolveGatewaySessionStoreTarget({
        cfg,
        key: canonicalParentSessionKey,
      });
      const { emitGatewayBeforeResetPluginHook } = await loadSessionsRuntimeModule();
      await emitGatewayBeforeResetPluginHook({
        cfg,
        key: canonicalParentSessionKey,
        target: parentTarget,
        storePath: parentTarget.storePath,
        entry: parentEntry,
        reason: "new",
      });
    }
    const loweredRequestedKey = normalizeOptionalLowercaseString(requestedKey);
    const key = requestedKey
      ? loweredRequestedKey === "global" || loweredRequestedKey === "unknown"
        ? loweredRequestedKey
        : toAgentStoreSessionKey({
            agentId,
            requestKey: requestedKey,
            mainKey: cfg.session?.mainKey,
          })
      : buildDashboardSessionKey(agentId);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const targetAgentId = resolveAgentIdFromSessionKey(target.canonicalKey);
    const created = await updateSessionStore(target.storePath, async (store) => {
      const patched = await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: target.canonicalKey,
        patch: {
          key: target.canonicalKey,
          label: normalizeOptionalString(p.label),
          model: normalizeOptionalString(p.model),
        },
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
      if (!patched.ok || !canonicalParentSessionKey) {
        return patched;
      }
      const nextEntry: SessionEntry = {
        ...patched.entry,
        parentSessionKey: canonicalParentSessionKey,
      };
      store[target.canonicalKey] = nextEntry;
      return {
        ...patched,
        entry: nextEntry,
      };
    });
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    const ensured = ensureSessionTranscriptFile({
      sessionId: created.entry.sessionId,
      storePath: target.storePath,
      sessionFile: created.entry.sessionFile,
      agentId: targetAgentId,
    });
    if (!ensured.ok) {
      await updateSessionStore(target.storePath, (store) => {
        delete store[target.canonicalKey];
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to create session transcript: ${ensured.error}`),
      );
      return;
    }

    const createdEntry =
      created.entry.sessionFile === ensured.transcriptPath
        ? created.entry
        : {
            ...created.entry,
            sessionFile: ensured.transcriptPath,
          };
    if (createdEntry !== created.entry) {
      await updateSessionStore(target.storePath, (store) => {
        const existing = store[target.canonicalKey];
        if (existing) {
          store[target.canonicalKey] = {
            ...existing,
            sessionFile: ensured.transcriptPath,
          };
        }
      });
    }

    const initialMessage = resolveOptionalInitialSessionMessage(p);
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    const messageSeq = initialMessage
      ? (await readSessionMessageCountAsync(
          createdEntry.sessionId,
          target.storePath,
          createdEntry.sessionFile,
        )) + 1
      : undefined;

    if (initialMessage) {
      await chatHandlers["chat.send"]({
        req,
        params: {
          sessionKey: target.canonicalKey,
          message: initialMessage,
          idempotencyKey: randomUUID(),
        },
        respond: (ok, payload, error, meta) => {
          if (ok && payload && typeof payload === "object") {
            runPayload = payload as Record<string, unknown>;
          } else {
            runError = error;
          }
          runMeta = meta;
        },
        context,
        client,
        isWebchatConnect,
      });
    }

    const runStarted =
      runPayload !== undefined &&
      shouldAttachPendingMessageSeq({
        payload: runPayload,
        cached: runMeta?.cached === true,
      });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        sessionId: createdEntry.sessionId,
        entry: createdEntry,
        runStarted,
        ...(runPayload ? runPayload : {}),
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
        ...(runError ? { runError } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "send",
      });
    }
    if (canonicalParentSessionKey && p.emitCommandHooks === true) {
      const { entry: parentEntry } = loadSessionEntry(canonicalParentSessionKey);
      const parentTarget = resolveGatewaySessionStoreTarget({
        cfg,
        key: canonicalParentSessionKey,
      });
      const { emitGatewaySessionEndPluginHook, emitGatewaySessionStartPluginHook } =
        await loadSessionsRuntimeModule();
      emitGatewaySessionEndPluginHook({
        cfg,
        sessionKey: canonicalParentSessionKey,
        sessionId: parentEntry?.sessionId,
        storePath: parentTarget.storePath,
        sessionFile: parentEntry?.sessionFile,
        agentId: parentTarget.agentId,
        reason: "new",
        nextSessionId: createdEntry.sessionId,
        nextSessionKey: target.canonicalKey,
      });
      emitGatewaySessionStartPluginHook({
        cfg,
        sessionKey: target.canonicalKey,
        sessionId: createdEntry.sessionId,
        resumedFrom: parentEntry?.sessionId,
        storePath: target.storePath,
        sessionFile: createdEntry.sessionFile,
        agentId: target.agentId,
      });
    }
  },
  "sessions.compaction.branch": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionBranchParams,
        "sessions.compaction.branch",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const loaded = loadSessionEntry(key);
    const { cfg, entry, canonicalKey } = loaded;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: canonicalKey });
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint?.preCompaction.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    const branchedSession = await forkCompactionCheckpointTranscriptAsync({
      sourceFile: checkpoint.preCompaction.sessionFile,
      sessionDir: path.dirname(checkpoint.preCompaction.sessionFile),
    });
    if (!branchedSession?.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create checkpoint branch transcript"),
      );
      return;
    }
    const nextKey = buildDashboardSessionKey(target.agentId);
    const label = entry.label?.trim() ? `${entry.label.trim()} (checkpoint)` : "Checkpoint branch";
    const nextEntry = cloneCheckpointSessionEntry({
      currentEntry: entry,
      nextSessionId: branchedSession.sessionId,
      nextSessionFile: branchedSession.sessionFile,
      label,
      parentSessionKey: canonicalKey,
      totalTokens: checkpoint.tokensBefore,
    });

    await updateSessionStore(target.storePath, (store) => {
      store[nextKey] = nextEntry;
    });

    respond(
      true,
      {
        ok: true,
        sourceKey: canonicalKey,
        key: nextKey,
        sessionId: nextEntry.sessionId,
        checkpoint,
        entry: nextEntry,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: canonicalKey,
      reason: "checkpoint-branch",
    });
    emitSessionsChanged(context, {
      sessionKey: nextKey,
      reason: "checkpoint-branch",
    });
  },
  "sessions.compaction.restore": async ({
    req,
    params,
    respond,
    context,
    client,
    isWebchatConnect,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionRestoreParams,
        "sessions.compaction.restore",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "restore", client, isWebchatConnect, respond })) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const loaded = loadSessionEntry(key);
    const { entry, canonicalKey, storePath } = loaded;
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint?.preCompaction.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    const interruptResult = await interruptSessionRunIfActive({
      req,
      context,
      client,
      isWebchatConnect,
      requestedKey: key,
      canonicalKey,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      respond(false, undefined, interruptResult.error);
      return;
    }

    const restoredSession = await forkCompactionCheckpointTranscriptAsync({
      sourceFile: checkpoint.preCompaction.sessionFile,
      sessionDir: path.dirname(checkpoint.preCompaction.sessionFile),
    });
    if (!restoredSession?.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to restore checkpoint transcript"),
      );
      return;
    }
    const nextEntry = cloneCheckpointSessionEntry({
      currentEntry: entry,
      nextSessionId: restoredSession.sessionId,
      nextSessionFile: restoredSession.sessionFile,
      totalTokens: checkpoint.tokensBefore,
      preserveCompactionCheckpoints: true,
    });

    await updateSessionStore(storePath, (store) => {
      store[canonicalKey] = nextEntry;
    });

    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        sessionId: nextEntry.sessionId,
        checkpoint,
        entry: nextEntry,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: canonicalKey,
      reason: "checkpoint-restore",
    });
  },
  "sessions.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.send",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: false,
    });
  },
  "sessions.steer": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.steer",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: true,
    });
  },
  "sessions.abort": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const requestedRunId = readStringValue(p.runId);
    const requestedKey = normalizeOptionalString(p.key);
    const requestedParamAgentId = normalizeOptionalString(p.agentId);
    const scopedRequestedKey = resolveScopedAbortKey({
      cfg,
      key: requestedKey,
      agentId: requestedParamAgentId,
    });
    if (requestedKey && requestedParamAgentId && !scopedRequestedKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      );
      return;
    }
    const requestedKeyAgentId = scopedRequestedKey
      ? resolveSessionKeyAgentId(scopedRequestedKey, cfg)
      : undefined;
    const activeRunSessionKey = requestedRunId
      ? context.chatAbortControllers.get(requestedRunId)?.sessionKey
      : undefined;
    const inferredRunAgentId =
      requestedParamAgentId ??
      requestedKeyAgentId ??
      (requestedRunId && !activeRunSessionKey ? resolveDefaultAgentId(cfg) : undefined);
    const requestedRunAgentId = requestedRunId
      ? inferredRunAgentId
        ? normalizeAgentId(inferredRunAgentId)
        : undefined
      : undefined;
    const scopedActiveRunSessionKey = activeRunSessionKey
      ? requestedRunAgentId
        ? sessionKeyBelongsToAgent(activeRunSessionKey, requestedRunAgentId, cfg)
          ? activeRunSessionKey
          : undefined
        : activeRunSessionKey
      : undefined;
    const keyCandidate =
      scopedRequestedKey ??
      scopedActiveRunSessionKey ??
      (requestedRunId
        ? resolveSessionKeyForRun(requestedRunId, {
            agentId: requestedRunAgentId ?? resolveDefaultAgentId(cfg),
          })
        : undefined);
    if (!keyCandidate && requestedRunId) {
      respond(true, { ok: true, abortedRunId: null, status: "no-active-run" });
      return;
    }
    const key = requireSessionKey(keyCandidate, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    const requestedKeyAliases =
      requestedKey &&
      requestedKey !== key &&
      (!requestedParamAgentId || sessionKeyBelongsToAgent(requestedKey, requestedParamAgentId, cfg))
        ? [requestedKey]
        : undefined;
    const abortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      activeRunSessionKey: scopedActiveRunSessionKey,
      aliasKeys: requestedKeyAliases,
    });
    // Capture run kinds before the abort because abortChatRunById deletes entries
    // from chatAbortControllers synchronously. We use this snapshot to choose the
    // correct dedupe namespace: agent-kind runs use "agent:" (their runId equals
    // their idempotency key), while chat-send runs use "chat:" so the abort
    // snapshot does not collide with the agent RPC dedupe cache.
    const preAbortRunKinds = new Map<string, "chat-send" | "agent" | undefined>();
    if (requestedRunId) {
      preAbortRunKinds.set(requestedRunId, context.chatAbortControllers.get(requestedRunId)?.kind);
    } else {
      for (const [rid, entry] of context.chatAbortControllers) {
        preAbortRunKinds.set(rid, entry.kind);
      }
    }
    let abortedRunId: string | null = null;
    await chatHandlers["chat.abort"]({
      req,
      params: {
        sessionKey: abortSessionKey,
        runId: requestedRunId,
      },
      respond: (ok, payload, error, meta) => {
        if (!ok) {
          respond(ok, payload, error, meta);
          return;
        }
        const runIds =
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { runIds?: unknown[] }).runIds)
            ? (payload as { runIds: unknown[] }).runIds.filter((value): value is string =>
                Boolean(normalizeOptionalString(value)),
              )
            : [];
        const firstAbortedRunId = runIds[0] ?? null;
        abortedRunId = firstAbortedRunId;
        if (firstAbortedRunId) {
          const endedAt = Date.now();
          const runKind = preAbortRunKinds.get(firstAbortedRunId);
          const dedupePrefix = runKind === "agent" ? "agent" : "chat";
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `${dedupePrefix}:${firstAbortedRunId}`,
            entry: {
              ts: endedAt,
              ok: true,
              payload: {
                status: "timeout",
                runId: firstAbortedRunId,
                stopReason: "rpc",
                endedAt,
              },
            },
          });
        }
        respond(
          true,
          {
            ok: true,
            abortedRunId,
            status: abortedRunId ? "aborted" : "no-active-run",
          },
          undefined,
          meta,
        );
      },
      context,
      client,
      isWebchatConnect,
    });
    if (abortedRunId) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        reason: "abort",
      });
    }
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }

    triggerSessionPatchHook({
      cfg,
      sessionEntry: applied.entry,
      sessionKey: target.canonicalKey ?? key,
      patch: p,
    });

    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const resolvedDisplayModel = resolveSessionDisplayModelIdentityRef({
      cfg,
      agentId,
      provider: resolved.provider,
      model: resolved.model,
    });
    const agentRuntime = resolveModelAgentRuntimeMetadata({
      cfg,
      agentId,
      provider: resolvedDisplayModel.provider,
      model: resolvedDisplayModel.model,
      sessionKey: target.canonicalKey ?? key,
      acpRuntime: applied.entry?.acp != null,
      acpBackend: applied.entry?.acp?.backend,
    });
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolvedDisplayModel.provider,
        model: resolvedDisplayModel.model,
        agentRuntime,
      },
    };
    respond(true, result, undefined);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "patch",
    });
  },
  "sessions.pluginPatch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (
      !assertValidParams(params, validateSessionsPluginPatchParams, "sessions.pluginPatch", respond)
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    if (!scopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.pluginPatch requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    const pluginId = normalizeOptionalString(params.pluginId);
    const namespace = normalizeOptionalString(params.namespace);
    if (!pluginId || !namespace) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "pluginId and namespace are required"),
      );
      return;
    }
    if (params.unset === true && params.value !== undefined) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch cannot specify both unset and value",
        ),
      );
      return;
    }
    if (params.value !== undefined && !isPluginJsonValue(params.value)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch value must be JSON-compatible",
        ),
      );
      return;
    }
    const patched = await patchPluginSessionExtension({
      cfg: context.getRuntimeConfig(),
      sessionKey: key,
      pluginId,
      namespace,
      value: params.value,
      unset: params.unset === true,
    });
    if (!patched.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, patched.error));
      return;
    }
    respond(true, { ok: true, key: patched.key, value: patched.value }, undefined);
    emitSessionsChanged(context, {
      sessionKey: patched.key,
      reason: "plugin-patch",
    });
  },
  "sessions.reset": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const { performGatewaySessionReset } = await loadSessionsRuntimeModule();
    const result = await performGatewaySessionReset({
      key,
      reason,
      commandSource: "gateway:sessions.reset",
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, key: result.key, entry: result.entry }, undefined);
    emitSessionsChanged(context, {
      sessionKey: result.key,
      reason,
    });
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect, context }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
    const {
      archiveSessionTranscriptsForSessionDetailed,
      cleanupSessionBeforeMutation,
      emitGatewaySessionEndPluginHook,
      emitSessionUnboundLifecycleEvent,
    } = await loadSessionsRuntimeModule();

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    if (rejectPluginRuntimeDeleteMismatch({ client, key: canonicalKey ?? key, entry, respond })) {
      return;
    }
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archivedTranscripts =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSessionDetailed({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    const archived = archivedTranscripts.map((entry) => entry.archivedPath);
    if (deleted) {
      emitGatewaySessionEndPluginHook({
        cfg,
        sessionKey: target.canonicalKey ?? key,
        sessionId,
        storePath,
        sessionFile: entry?.sessionFile,
        agentId: target.agentId,
        reason: "deleted",
        archivedTranscripts,
      });
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
    if (deleted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "delete",
      });
    }
  },
  "sessions.get": async ({ params, respond, context }) => {
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const { target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    const store = loadSessionStore(storePath);
    const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const { messages } = await readRecentSessionMessagesWithStatsAsync(
      entry.sessionId,
      storePath,
      entry.sessionFile,
      {
        maxMessages: limit,
        maxLines: limit * 20 + 20,
      },
    );
    respond(true, { messages }, undefined);
  },
  "sessions.compact": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "compact", client, isWebchatConnect, respond })) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : undefined;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    if (maxLines === undefined) {
      const interruptResult = await interruptSessionRunIfActive({
        req,
        context,
        client,
        isWebchatConnect,
        requestedKey: key,
        canonicalKey: target.canonicalKey,
        sessionId,
      });
      if (interruptResult.error) {
        respond(false, undefined, interruptResult.error);
        return;
      }

      const resolvedModel = resolveSessionModelRef(cfg, entry, target.agentId);
      const workspaceDir =
        normalizeOptionalString(entry?.spawnedWorkspaceDir) ||
        resolveAgentWorkspaceDir(cfg, target.agentId);
      const operationId = randomUUID();
      emitSessionOperation(context, {
        operationId,
        operation: "compact",
        phase: "start",
        sessionKey: target.canonicalKey,
      });
      let result: Awaited<ReturnType<typeof compactEmbeddedPiSession>>;
      try {
        result = await compactEmbeddedPiSession({
          sessionId,
          sessionKey: target.canonicalKey,
          allowGatewaySubagentBinding: true,
          sessionFile: filePath,
          workspaceDir,
          config: cfg,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          agentHarnessId: entry?.sessionId === sessionId ? entry.agentHarnessId : undefined,
          thinkLevel: normalizeThinkLevel(entry?.thinkingLevel),
          reasoningLevel: normalizeReasoningLevel(entry?.reasoningLevel),
          bashElevated: {
            enabled: false,
            allowed: false,
            defaultLevel: "off",
          },
          trigger: "manual",
        });
      } catch (err) {
        emitSessionOperation(context, {
          operationId,
          operation: "compact",
          phase: "end",
          sessionKey: target.canonicalKey,
          completed: false,
          reason: formatErrorMessage(err),
        });
        throw err;
      }
      emitSessionOperation(context, {
        operationId,
        operation: "compact",
        phase: "end",
        sessionKey: target.canonicalKey,
        completed: result.ok && result.compacted,
        reason: result.reason,
      });

      if (result.ok && result.compacted) {
        await updateSessionStore(storePath, (store) => {
          const entryKey = compactTarget.primaryKey;
          const entryToUpdate = store[entryKey];
          if (!entryToUpdate) {
            return;
          }
          entryToUpdate.updatedAt = Date.now();
          entryToUpdate.compactionCount = Math.max(0, entryToUpdate.compactionCount ?? 0) + 1;
          if (result.result?.sessionId && result.result.sessionId !== entryToUpdate.sessionId) {
            entryToUpdate.sessionId = result.result.sessionId;
          }
          if (result.result?.sessionFile) {
            entryToUpdate.sessionFile = result.result.sessionFile;
          }
          delete entryToUpdate.inputTokens;
          delete entryToUpdate.outputTokens;
          if (
            typeof result.result?.tokensAfter === "number" &&
            Number.isFinite(result.result.tokensAfter)
          ) {
            entryToUpdate.totalTokens = result.result.tokensAfter;
            entryToUpdate.totalTokensFresh = true;
          } else {
            delete entryToUpdate.totalTokens;
            delete entryToUpdate.totalTokensFresh;
          }
        });
      }

      respond(
        true,
        {
          ok: result.ok,
          key: target.canonicalKey,
          compacted: result.compacted,
          reason: result.reason,
          result: result.result,
        },
        undefined,
      );
      if (result.ok) {
        emitSessionsChanged(context, {
          sessionKey: target.canonicalKey,
          reason: "compact",
          compacted: result.compacted,
        });
      }
      return;
    }

    const tail = readRecentSessionTranscriptLines({
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: target.agentId,
      maxLines,
    });
    const lines = tail?.lines ?? [];
    const totalLines = tail?.totalLines ?? 0;
    if (totalLines <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: totalLines,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: lines.length,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "compact",
      compacted: true,
    });
  },
};

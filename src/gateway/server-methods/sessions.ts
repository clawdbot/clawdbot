// Sessions gateway methods implement list/create/patch/delete/reset/compact/
// restore/preview/send flows over session stores, transcripts, and active runs.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
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
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsPatchParams,
  validateSessionsPluginPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsSearchParams,
  validateSessionsSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent-runner/runs.js";
import { compactEmbeddedAgentSession } from "../../agents/embedded-agent.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { stagedPostCompactionDelegateCount } from "../../auto-reply/continuation-delegate-store.js";
import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import {
  runSessionsCleanup,
  serializeSessionCleanupResult,
  resolveMainSessionKey,
  resolveSessionWorkStartError,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  listConfiguredSessionStoreAgentIds,
  deleteSessionEntryLifecycle,
  type SessionEntry,
} from "../../config/sessions.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import {
  applySessionPatchProjection,
  loadTranscriptEvents,
  preflightSessionTranscriptForManualCompact,
  resolveSessionTranscriptRuntimeTarget,
  trimSessionTranscriptForManualCompact,
  loadSessionStoreEntrySnapshot,
} from "../../config/sessions/session-accessor.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disableCronJobsBoundToSession } from "../../cron/job-session-bindings.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import {
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import {
  handleSessionStateSessionDeleted,
  recordSessionCompacted,
} from "../../sessions/session-state-events.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { canReviewOperatorApproval } from "../operator-approval-authorization.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../operator-scopes.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import {
  createFileBackedCompactionCheckpointStore,
  getSessionCompactionCheckpoint,
  listSessionCompactionCheckpoints,
} from "../session-compaction-checkpoints.js";
import {
  buildDashboardSessionKey,
  createGatewaySession,
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
} from "../session-create-service.js";
import {
  deleteSessionGroup,
  ensureSessionGroupRegistered,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
} from "../session-groups.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../session-store-key.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessageCountAsync,
  readSessionPreviewItemsFromTranscript,
} from "../session-transcript-readers.js";
import {
  buildGatewaySessionRow,
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  resolveDeletedAgentIdFromSessionKey,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
  resolveGatewaySessionThinkingProjection,
  resolveSessionDisplayModelIdentityRef,
  resolveSessionModelRef,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { chatHandlers } from "./chat.js";
import { loadOptionalServerMethodModelCatalog } from "./optional-model-catalog.js";
import {
  hasTrackedActiveSessionRun,
  hasVisibleActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/sessions");

const compactionCheckpointStore = createFileBackedCompactionCheckpointStore();
const MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE =
  "Checkpoint branch and restore are unavailable while model selection is locked.";

function buildManualCompactionReleaseFollowupRun(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  model: { provider: string; model: string };
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  targetAgentId: string;
  workspaceDir: string;
}): FollowupRun {
  const deliveryContext = deliveryContextFromSession(params.entry);
  const messageProvider = deliveryContext?.channel;
  const cwd = normalizeOptionalString(params.entry.spawnedCwd);
  return {
    prompt: "",
    enqueuedAt: Date.now(),
    ...(deliveryContext?.channel ? { originatingChannel: deliveryContext.channel } : {}),
    ...(deliveryContext?.to ? { originatingTo: deliveryContext.to } : {}),
    ...(deliveryContext?.accountId ? { originatingAccountId: deliveryContext.accountId } : {}),
    ...(deliveryContext?.threadId !== undefined
      ? { originatingThreadId: deliveryContext.threadId }
      : {}),
    run: {
      agentId: params.targetAgentId,
      agentDir: params.workspaceDir,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      ...(cwd ? { cwd } : {}),
      config: params.cfg,
      provider: params.model.provider,
      model: params.model.model,
      ...(messageProvider ? { messageProvider } : {}),
      ...(deliveryContext?.accountId ? { agentAccountId: deliveryContext.accountId } : {}),
      timeoutMs: 0,
      blockReplyBreak: "message_end",
    },
  };
}

function sessionHasPostCompactionDelegates(params: {
  entry?: SessionEntry;
  sessionKey: string;
}): boolean {
  return (
    stagedPostCompactionDelegateCount(params.sessionKey) > 0 ||
    (params.entry?.pendingPostCompactionDelegates?.length ?? 0) > 0
  );
}

async function releaseManualPostCompactionDelegatesIfNeeded(params: {
  cfg: OpenClawConfig;
  compactionCount: number | undefined;
  entry: SessionEntry;
  model: { provider: string; model: string };
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  store: Record<string, SessionEntry>;
  storePath: string;
  targetAgentId: string;
  workspaceDir: string;
}): Promise<void> {
  if (
    !sessionHasPostCompactionDelegates({
      entry: params.entry,
      sessionKey: params.sessionKey,
    })
  ) {
    return;
  }
  const releaseFollowupRun = buildManualCompactionReleaseFollowupRun({
    cfg: params.cfg,
    entry: params.entry,
    model: params.model,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    targetAgentId: params.targetAgentId,
    workspaceDir: params.workspaceDir,
  });
  try {
    const { releasePostCompactionDelegatesAfterCompaction } =
      await import("../../auto-reply/reply/agent-runner-execution.js");
    await releasePostCompactionDelegatesAfterCompaction({
      activeSessionStore: params.store,
      compactionCount: params.compactionCount,
      followupRun: releaseFollowupRun,
      sessionEntry: params.entry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  } catch (err) {
    // Manual compaction already succeeded and the session store/transcript now
    // reflects the compacted state. Match request_compaction's tolerant release
    // semantics so post-compaction maintenance cannot turn a successful compact
    // into a failed RPC.
    log.warn(
      `[sessions.compact:post-compaction-release-failed] session=${params.sessionKey} reason=${formatErrorMessage(err)}`,
    );
  }
}

function filterSessionStoreToConfiguredAgents(
  cfg: OpenClawConfig,
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  const configuredAgentIds = new Set(listConfiguredSessionStoreAgentIds(cfg));
  const isConfiguredSessionKey = (key: string | undefined) => {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) {
      return false;
    }
    const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: normalizedKey });
    const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
    return configuredAgentIds.has(normalizeAgentId(agentId));
  };
  return Object.fromEntries(
    Object.entries(store).filter(([key, entry]) => {
      if (key === "global" || key === "unknown") {
        return true;
      }
      if (isConfiguredSessionKey(key)) {
        return true;
      }
      // Keep spawned child sessions visible when their parent belongs to a configured agent.
      return (
        isConfiguredSessionKey(entry?.spawnedBy) || isConfiguredSessionKey(entry?.parentSessionKey)
      );
    }),
  );
}

const loadSessionsRuntimeModule = createLazyRuntimeModule(() => import("./sessions.runtime.js"));

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

function resolveGatewaySessionTargetFromKey(
  key: string,
  cfg: OpenClawConfig,
  opts?: { agentId?: string },
) {
  const target = resolveGatewaySessionStoreTarget({
    cfg,
    key,
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
  });
  return { cfg, target, storePath: target.storePath };
}

function loadAccessorSessionEntryForGatewayTarget(params: {
  key: string;
  cfg: OpenClawConfig;
  agentId?: string;
}) {
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg: params.cfg,
    key: params.key,
    clone: false,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  let best:
    | {
        entry: SessionEntry;
        sessionStoreKey: string;
      }
    | undefined;
  for (const sessionStoreKey of target.storeKeys) {
    const entry = target.store[sessionStoreKey];
    if (entry) {
      if (!best || (entry.updatedAt ?? 0) > (best.entry.updatedAt ?? 0)) {
        best = { entry, sessionStoreKey };
      }
    }
  }
  if (best) {
    return {
      target,
      storePath: target.storePath,
      entry: best.entry,
      canonicalKey: target.canonicalKey,
      sessionStoreKey: best.sessionStoreKey,
    };
  }
  return {
    target,
    storePath: target.storePath,
    entry: undefined,
    canonicalKey: target.canonicalKey,
    sessionStoreKey: target.canonicalKey,
  };
}

function loadSessionEntriesForTarget(params: {
  key: string;
  cfg: OpenClawConfig;
  agentId?: string;
}) {
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg: params.cfg,
    key: params.key,
    clone: false,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const store = target.store;
  const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
  return { target, storePath: target.storePath, store, entry };
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
  await expectDefined(
    sessionsHandlers["sessions.create"],
    "sessions.create handler",
  )({
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
    if (active.controlUiVisible === false) {
      continue;
    }
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

function resolveSessionMessageSubscriptionKey(params: {
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): string {
  const agentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : params.canonicalKey === "global" && params.defaultAgentId
      ? normalizeAgentId(params.defaultAgentId)
      : undefined;
  // Global session message subscriptions need per-agent channels to avoid cross-agent fanout.
  return params.canonicalKey === "global" && agentId
    ? `agent:${agentId}:global`
    : params.canonicalKey;
}

async function interruptSessionRunIfActive(params: {
  req: GatewayRequestHandlerOptions["req"];
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  sessionId?: string;
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const cfg = params.context.getRuntimeConfig();
  const hasTrackedRun = hasTrackedActiveSessionRun({
    context: params.context,
    requestedKey: params.requestedKey,
    canonicalKey: params.canonicalKey,
    agentId: params.agentId,
    defaultAgentId: resolveDefaultAgentId(cfg),
  });
  const hasEmbeddedRun =
    typeof params.sessionId === "string" && params.sessionId
      ? isEmbeddedAgentRunActive(params.sessionId)
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

    await expectDefined(
      chatHandlers["chat.abort"],
      "chat.abort handler",
    )({
      req: params.req,
      params: {
        sessionKey: abortSessionKey,
        ...(params.canonicalKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
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
    abortEmbeddedAgentRun(params.sessionId);
  }

  // Clear queued follow-up work for both requested aliases and the canonical session id.
  clearSessionQueues([params.requestedKey, params.canonicalKey, params.sessionId]);

  if (hasEmbeddedRun && params.sessionId) {
    const ended = await waitForEmbeddedAgentRunEnd(params.sessionId, 15_000);
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
  const cfg = params.context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(
    cfg,
    key,
    (p as { agentId?: string }).agentId,
  );
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return;
  }
  const requestedAgentId = requestedAgent.agentId;
  const loaded = loadSessionEntry(key, { agentId: requestedAgentId });
  const { legacyKey } = loaded;
  let { entry, canonicalKey, storePath } = loaded;
  // Reject sends/steers targeting sessions whose owning agent was deleted (#65524).
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, canonicalKey, entry, {
    acpMetadataSessionKey: legacyKey ?? canonicalKey,
  });
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
  const rawIdempotencyKey = (p as { idempotencyKey?: string }).idempotencyKey;
  const explicitIdempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : undefined;
  const idempotencyKey = explicitIdempotencyKey ?? randomUUID();
  const dispatchChatSend = async (respond: RespondFn) => {
    await expectDefined(
      chatHandlers["chat.send"],
      "chat.send handler",
    )({
      req: params.req,
      params: {
        sessionKey: canonicalKey,
        ...(canonicalKey === "global" && requestedAgentId ? { agentId: requestedAgentId } : {}),
        message: (p as { message: string }).message,
        thinking: (p as { thinking?: string }).thinking,
        attachments: (p as { attachments?: unknown[] }).attachments,
        timeoutMs: (p as { timeoutMs?: number }).timeoutMs,
        idempotencyKey,
      },
      respond,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });
  };
  const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
  if (archivedSessionError) {
    // An explicit retry may already have a terminal chat.send result. Let the
    // owning handler replay that result before it applies the archive guard.
    if (explicitIdempotencyKey) {
      await dispatchChatSend(params.respond);
      return;
    }
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
    return;
  }
  if (!entry?.sessionId && !params.interruptIfActive && isAgentMainSessionKey(cfg, canonicalKey)) {
    // Sending to an empty agent main session should create it; steering still requires an active row.
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
      agentId: requestedAgentId,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      params.respond(false, undefined, interruptResult.error);
      return;
    }
    interruptedActiveRun = interruptResult.interrupted;
  }

  const messageSeq =
    (await readSessionMessageCountAsync({
      agentId: requestedAgentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey: canonicalKey,
      storePath,
    })) + 1;
  let sendAcked = false;
  let sendPayload: unknown;
  let sendCached = false;
  let startedRunId: string | undefined;
  await dispatchChatSend((ok, payload, error, meta) => {
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
  });
  if (sendAcked) {
    if (shouldAttachPendingMessageSeq({ payload: sendPayload, cached: sendCached })) {
      await reactivateCompletedSubagentSession({
        sessionKey: canonicalKey,
        runId: startedRunId,
        task: (p as { message: string }).message,
      });
    }
    emitSessionsChanged(params.context, {
      sessionKey: canonicalKey,
      ...(canonicalKey === "global" && requestedAgentId ? { agentId: requestedAgentId } : {}),
      reason: interruptedActiveRun ? "steer" : "send",
    });
  }
}
export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.search": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (params.agentId && !params.sessionKeys) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
      );
      return;
    }
    const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    const sessionKeys = params.sessionKeys?.map((sessionKey) =>
      requestedAgentId
        ? resolveStoredSessionKeyForAgentStore({ cfg, agentId: requestedAgentId, sessionKey })
        : resolveSessionStoreKey({ cfg, sessionKey }),
    );
    const agentIds = new Set(
      sessionKeys?.map((sessionKey) =>
        requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
          ? requestedAgentId
          : resolveSessionStoreAgentId(cfg, sessionKey),
      ),
    );
    if (
      agentIds.size > 1 ||
      (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.search supports one agent per call"),
      );
      return;
    }
    const agentId =
      requestedAgentId ?? agentIds.values().next().value ?? resolveDefaultAgentId(cfg);
    try {
      const result = searchSessionTranscripts({
        agentId,
        query,
        limit: params.limit,
        ...(sessionKeys ? { sessionKeys } : {}),
      });
      respond(true, {
        results: result.hits,
        ...(result.indexing ? { indexing: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
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
          () => loadOptionalServerMethodModelCatalog(context, "sessions.list"),
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
            return result.sessions.map((session) => {
              const activeRunState = resolveVisibleActiveSessionRunState({
                context,
                requestedKey: session.key,
                canonicalKey: session.key,
                sessionId: session.sessionId,
                ...(session.key === "global" && p.agentId ? { agentId: p.agentId } : {}),
                defaultAgentId: resolveDefaultAgentId(cfg),
              });
              return Object.assign({}, session, {
                hasActiveRun: activeRunState.active,
                ...(activeRunState.runIds.length > 0
                  ? { activeRunIds: activeRunState.runIds }
                  : {}),
              });
            });
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
    const p = params;
    try {
      const { mode, appliedSummaries } = await runSessionsCleanup({
        cfg: context.getRuntimeConfig(),
        opts: {
          agent: p.agent,
          allAgents: p.allAgents,
          enforce: p.enforce,
          activeKey: p.activeKey,
          fixMissing: p.fixMissing,
          fixDmScope: p.fixDmScope,
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
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (p.includeApprovals === true && !canReviewOperatorApproval(client)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.messages.subscribe includeApprovals requires a paired device and gateway scope: ${APPROVALS_SCOPE}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { canonicalKey } = loadSessionEntry(key, { agentId: requestedAgentId });
    const subscriptionKey = resolveSessionMessageSubscriptionKey({
      canonicalKey,
      agentId: requestedAgentId,
      defaultAgentId: resolveDefaultAgentId(cfg),
    });
    if (connId) {
      let approvalReplay;
      if (p.includeApprovals === true) {
        // Subscribe before the authoritative snapshot so a transition cannot
        // land between replay and live delivery. Clients reconcile by id.
        const rollbackSubscription = context.subscribeSessionMessageEvents(
          connId,
          subscriptionKey,
          { includeApprovals: true },
        );
        try {
          approvalReplay = context.listSessionPendingApprovals?.(subscriptionKey, client);
        } catch (error) {
          rollbackSubscription?.();
          context.logGateway.error(`session approval replay failed: ${String(error)}`);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "session approval replay unavailable"),
          );
          return;
        }
        if (!approvalReplay) {
          rollbackSubscription?.();
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "session approval replay unavailable"),
          );
          return;
        }
      } else {
        context.subscribeSessionMessageEvents(connId, subscriptionKey);
      }
      respond(
        true,
        {
          subscribed: true,
          key: canonicalKey,
          ...(p.includeApprovals === true
            ? {
                approvalReplay,
              }
            : {}),
        },
        undefined,
      );
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
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { canonicalKey } = loadSessionEntry(key, { agentId: requestedAgentId });
    const subscriptionKey = resolveSessionMessageSubscriptionKey({
      canonicalKey,
      agentId: requestedAgentId,
      defaultAgentId: resolveDefaultAgentId(cfg),
    });
    if (connId) {
      context.unsubscribeSessionMessageEvents(connId, subscriptionKey);
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
        const cachedStoreTarget = resolveGatewaySessionStoreTargetWithStore({
          cfg,
          key,
        });
        const store = storeCache.get(cachedStoreTarget.storePath) ?? cachedStoreTarget.store;
        storeCache.set(cachedStoreTarget.storePath, store);
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
          {
            agentId: target.agentId,
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey: target.canonicalKey,
            storePath: target.storePath,
          },
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
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const { target, storePath, store, entry } = loadSessionEntriesForTarget({ key, cfg });
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
      includeDerivedTitles: p.includeDerivedTitles,
      includeLastMessage: p.includeLastMessage,
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
    if ("missing" in resolved) {
      respond(true, { ok: false }, undefined);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.compaction.list": ({ params, respond, context }) => {
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
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { entry, canonicalKey } = loadAccessorSessionEntryForGatewayTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
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
  "sessions.compaction.get": ({ params, respond, context }) => {
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
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { entry, canonicalKey } = loadAccessorSessionEntryForGatewayTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
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
    const initialMessage = resolveOptionalInitialSessionMessage(p);
    const requestedCwd = normalizeOptionalString(p.cwd);
    const requestedExecNode = normalizeOptionalString(p.execNode);
    if (requestedCwd && p.worktree !== true && !requestedExecNode) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create cwd requires worktree=true or execNode",
        ),
      );
      return;
    }
    const cwdIsAbsolute =
      !requestedCwd ||
      path.isAbsolute(requestedCwd) ||
      Boolean(requestedExecNode && path.win32.isAbsolute(requestedCwd));
    if (!cwdIsAbsolute) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd must be absolute"),
      );
      return;
    }
    if (requestedExecNode && p.worktree === true) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create worktree cannot target execNode"),
      );
      return;
    }
    const requestedWorktreeBaseRef = normalizeOptionalString(p.worktreeBaseRef);
    const requestedWorktreeName = normalizeOptionalString(p.worktreeName);
    if ((requestedWorktreeBaseRef || requestedWorktreeName) && p.worktree !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create worktreeBaseRef/worktreeName require worktree=true",
        ),
      );
      return;
    }
    let sessionKey = p.key;
    let sessionAgentId = p.agentId;
    let sessionWorktree: Awaited<ReturnType<typeof managedWorktrees.create>> | undefined;
    const sessionExecCwd = requestedExecNode ? requestedCwd : undefined;
    let sessionCwd: string | undefined;
    let sessionSourceRoot: string | undefined;
    let provisionedSessionWorktree = false;
    if (p.worktree === true) {
      // The normal path stays at operator.write and checks out the configured agent workspace.
      // An explicit cwd can target another host checkout, so method-scopes requires admin.
      const explicitKey = normalizeOptionalString(p.key);
      const requestedKey = explicitKey ?? "global";
      const requestedAgent = resolveRequestedGlobalAgentId(cfg, requestedKey, p.agentId);
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      const agentId = normalizeAgentId(
        requestedAgent.agentId ??
          normalizeOptionalString(p.agentId) ??
          parseAgentSessionKey(requestedKey)?.agentId ??
          resolveDefaultAgentId(cfg),
      );
      let targetKey = explicitKey;
      let preservesUnspecifiedKey = false;
      const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
      if (
        !targetKey &&
        parentSessionKey &&
        p.emitCommandHooks === true &&
        !initialMessage &&
        cfg.session?.dmScope === "main"
      ) {
        const parent = loadSessionEntry(
          parentSessionKey,
          requestedAgent.agentId ? { agentId: requestedAgent.agentId } : undefined,
        );
        const parentAgentId = normalizeAgentId(
          requestedAgent.agentId ?? resolveSessionStoreAgentId(cfg, parent.canonicalKey),
        );
        if (
          parent.entry?.sessionId &&
          parent.canonicalKey === resolveAgentMainSessionKey({ cfg, agentId: parentAgentId })
        ) {
          targetKey = parent.canonicalKey;
          preservesUnspecifiedKey = true;
        }
      }
      targetKey ??= buildDashboardSessionKey(agentId);
      const target = resolveGatewaySessionStoreTarget({ cfg, key: targetKey, agentId });
      sessionKey = preservesUnspecifiedKey ? undefined : targetKey;
      sessionAgentId = target.agentId;
      const workspace = requestedCwd ?? resolveAgentWorkspaceDir(cfg, target.agentId);
      // Subdirectory workspaces are valid: the worktree service resolves the repo root
      // via git discovery, so the preflight must accept ancestor .git entries too.
      if (!insideGitCheckout(workspace)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
        );
        return;
      }
      try {
        const requestedRepository = await managedWorktrees.resolveRepositoryPaths(workspace);
        sessionSourceRoot = requestedRepository.sourceRoot;
        const existing = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
        let existingDirectory = false;
        if (existing) {
          try {
            existingDirectory = fs.lstatSync(existing.path).isDirectory();
          } catch {
            // Missing registry targets are replaced; periodic GC retires their stale rows.
          }
        }
        if (existing && existingDirectory) {
          if (existing.repoRoot !== requestedRepository.canonicalRoot) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "session worktree belongs to a different repository",
              ),
            );
            return;
          }
          // Adopting an existing checkout cannot honor a different name or a
          // new base; fail loudly instead of silently ignoring the request.
          if (
            (requestedWorktreeName && existing.name !== requestedWorktreeName) ||
            requestedWorktreeBaseRef
          ) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `session is already bound to worktree ${existing.name} (${existing.branch})`,
              ),
            );
            return;
          }
          sessionWorktree = existing;
        } else {
          const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
          sessionWorktree = await managedWorktrees.create({
            repoRoot: workspace,
            ownerKind: "session",
            ownerId: target.canonicalKey,
            name: requestedWorktreeName,
            baseRef: requestedWorktreeBaseRef,
            // .openclaw/worktree-setup.sh runs repo code; keep it admin-only so this
            // write-scoped path cannot execute a repo script the admin RPC gates.
            runSetupScript: scopes.includes(ADMIN_SCOPE),
          });
          provisionedSessionWorktree = true;
        }
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        return;
      }
      // Nested workspaces run from the matching subdirectory inside the worktree, mirroring
      // how the session would have run in the source checkout; the worktree root would
      // silently change tool/file scope for subdirectory-configured agents.
      sessionCwd = sessionWorktree.path;
      try {
        const relative = path.relative(
          sessionSourceRoot ?? fs.realpathSync(sessionWorktree.repoRoot),
          fs.realpathSync(workspace),
        );
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          sessionCwd = path.join(sessionWorktree.path, relative);
          fs.mkdirSync(sessionCwd, { recursive: true });
        }
      } catch {
        sessionCwd = sessionWorktree.path;
      }
    }
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    let messageSeq: number | undefined;
    const created = await createGatewaySession({
      cfg,
      key: sessionKey,
      agentId: sessionAgentId,
      label: p.label,
      model: p.model,
      parentSessionKey: p.parentSessionKey,
      spawnedCwd: sessionCwd,
      worktree: sessionWorktree
        ? {
            id: sessionWorktree.id,
            branch: sessionWorktree.branch,
            repoRoot: sessionWorktree.repoRoot,
          }
        : undefined,
      execNode: requestedExecNode,
      execCwd: sessionExecCwd,
      clearExecBinding: !requestedExecNode,
      // A plain New Chat that resets an existing session must not inherit its prior worktree cwd.
      clearSpawnedCwd: p.worktree !== true,
      fork: p.fork,
      emitCommandHooks: p.emitCommandHooks,
      resetMainWhenUnspecified: !initialMessage,
      commandSource: "webchat",
      loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      afterCreate: initialMessage
        ? async ({ key, agentId, entry, storePath }) => {
            messageSeq =
              (await readSessionMessageCountAsync({
                agentId,
                sessionEntry: entry,
                sessionId: entry.sessionId,
                sessionKey: key,
                storePath,
              })) + 1;
            await expectDefined(
              chatHandlers["chat.send"],
              "chat.send handler",
            )({
              req,
              params: {
                sessionKey: key,
                ...(key === "global" ? { agentId } : {}),
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
        : undefined,
    });
    if (!created.ok) {
      if (sessionWorktree && provisionedSessionWorktree) {
        try {
          await managedWorktrees.remove({
            id: sessionWorktree.id,
            reason: "session-create-failed",
            force: true,
          });
        } catch (error) {
          log.warn(
            `failed to clean up worktree after session creation failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      respond(false, undefined, created.error);
      return;
    }
    // Leaving an isolated checkout via a plain New Chat detaches the session from its
    // worktree; remove it when lossless so the reset does not orphan a protected worktree.
    if (p.worktree !== true) {
      try {
        const owned = managedWorktrees.findLiveByOwner("session", created.key);
        if (owned) {
          await managedWorktrees.removeIfLossless(owned.id);
        }
      } catch (error) {
        log.warn(
          `failed to release worktree for reset session ${created.key}: ${formatErrorMessage(error)}`,
        );
      }
    }
    const createdWorktree = sessionWorktree
      ? {
          id: sessionWorktree.id,
          path: sessionWorktree.path,
          branch: sessionWorktree.branch,
        }
      : undefined;
    if (created.resetExisting) {
      respond(
        true,
        {
          ok: true,
          key: created.key,
          sessionId: created.entry.sessionId,
          entry: created.entry,
          resolved: created.resolved,
          runStarted: false,
          ...(createdWorktree ? { worktree: createdWorktree } : {}),
        },
        undefined,
      );
      emitSessionsChanged(context, {
        sessionKey: created.key,
        ...(created.key === "global" ? { agentId: created.agentId } : {}),
        reason: "new",
      });
      return;
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
        key: created.key,
        sessionId: created.entry.sessionId,
        entry: created.entry,
        runStarted,
        ...(runPayload ? runPayload : {}),
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
        ...(runError ? { runError } : {}),
        resolved: created.resolved,
        ...(createdWorktree ? { worktree: createdWorktree } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: created.key,
      ...(created.key === "global" ? { agentId: created.agentId } : {}),
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: created.key,
        ...(created.key === "global" ? { agentId: created.agentId } : {}),
        reason: "send",
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
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { entry, canonicalKey, sessionStoreKey, target, storePath } =
      loadAccessorSessionEntryForGatewayTarget({
        key,
        cfg,
        agentId: requestedAgent.agentId,
      });
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    const nextKey = buildDashboardSessionKey(target.agentId);
    const branchedSession = await compactionCheckpointStore.branchCheckpointSession({
      agentId: target.agentId,
      storePath,
      sourceKey: canonicalKey,
      sourceStoreKey: sessionStoreKey,
      nextKey,
      checkpointId,
    });
    if (
      branchedSession.status === "missing-checkpoint" ||
      branchedSession.status === "missing-boundary"
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    if (branchedSession.status === "missing-session") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    if (branchedSession.status === "model-selection-locked") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
      );
      return;
    }
    if (branchedSession.status === "failed") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create checkpoint branch transcript"),
      );
      return;
    }

    respond(
      true,
      {
        ok: true,
        sourceKey: canonicalKey,
        key: branchedSession.key,
        sessionId: branchedSession.entry.sessionId,
        checkpoint: branchedSession.checkpoint,
        entry: branchedSession.entry,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: canonicalKey,
      ...(canonicalKey === "global" && requestedAgent.agentId
        ? { agentId: requestedAgent.agentId }
        : {}),
      reason: "checkpoint-branch",
    });
    emitSessionsChanged(context, {
      sessionKey: branchedSession.key,
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
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { entry, canonicalKey, sessionStoreKey, storePath } =
      loadAccessorSessionEntryForGatewayTarget({
        key,
        cfg,
        agentId: requestedAgent.agentId,
      });
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    const lifecycleIdentities = [
      key,
      canonicalKey,
      sessionStoreKey,
      entry.sessionId,
      entry.lifecycleRevision,
    ];
    const restoreLockIdentities = [entry.sessionId, entry.lifecycleRevision];
    let admittedWorkReleased = true;
    let restoreTargetStillCurrent = true;
    let restoreBlockedByModelLock = false;
    // Restore replaces the active transcript identity. Hold the same lifecycle fence as
    // compaction so neither operation can publish state from the other's obsolete session.
    await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: restoreLockIdentities,
      prepare: async () => {
        const current = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          agentId: requestedAgent.agentId,
        });
        const currentCheckpoint = current.entry
          ? getSessionCompactionCheckpoint({ entry: current.entry, checkpointId })
          : undefined;
        restoreTargetStillCurrent =
          current.entry?.sessionId === entry.sessionId &&
          current.entry.lifecycleRevision === entry.lifecycleRevision &&
          currentCheckpoint !== undefined;
        if (!restoreTargetStillCurrent) {
          return;
        }
        restoreBlockedByModelLock = current.entry?.modelSelectionLocked === true;
        if (restoreBlockedByModelLock) {
          return;
        }
        clearSessionQueues([
          key,
          current.canonicalKey,
          current.sessionStoreKey,
          current.entry?.sessionId,
        ]);
        admittedWorkReleased = await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: lifecycleIdentities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
      },
      run: async () => {
        if (!restoreTargetStillCurrent) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session ${key} changed before checkpoint restore. Retry.`,
              { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
            ),
          );
          return;
        }
        if (restoreBlockedByModelLock) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
          );
          return;
        }
        if (!admittedWorkReleased) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is still active; try again.`),
          );
          return;
        }
        const current = loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          agentId: requestedAgent.agentId,
        });
        if (!current.entry?.sessionId) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
          );
          return;
        }
        if (current.entry.modelSelectionLocked === true) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
          );
          return;
        }
        const currentCheckpoint = getSessionCompactionCheckpoint({
          entry: current.entry,
          checkpointId,
        });
        if (!currentCheckpoint) {
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
          canonicalKey: current.canonicalKey,
          agentId: requestedAgent.agentId,
          sessionId: current.entry.sessionId,
        });
        if (interruptResult.error) {
          respond(false, undefined, interruptResult.error);
          return;
        }

        const restoredSession = await compactionCheckpointStore.restoreCheckpointSession({
          agentId: requestedAgent.agentId,
          storePath,
          sessionKey: current.canonicalKey,
          sessionStoreKey: current.sessionStoreKey,
          checkpointId,
        });
        if (
          restoredSession.status === "missing-checkpoint" ||
          restoredSession.status === "missing-boundary"
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
          );
          return;
        }
        if (restoredSession.status === "missing-session") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
          );
          return;
        }
        if (restoredSession.status === "model-selection-locked") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_CHECKPOINT_MESSAGE),
          );
          return;
        }
        if (restoredSession.status === "failed") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "failed to restore checkpoint transcript"),
          );
          return;
        }

        respond(
          true,
          {
            ok: true,
            key: restoredSession.key,
            sessionId: restoredSession.entry.sessionId,
            checkpoint: restoredSession.checkpoint,
            entry: restoredSession.entry,
          },
          undefined,
        );
        emitSessionsChanged(context, {
          sessionKey: current.canonicalKey,
          ...(current.canonicalKey === "global" && requestedAgent.agentId
            ? { agentId: requestedAgent.agentId }
            : {}),
          reason: "checkpoint-restore",
        });
      },
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
    const activeRun = requestedRunId ? context.chatAbortControllers.get(requestedRunId) : undefined;
    const activeRunSessionKey = activeRun?.sessionKey;
    const activeRunAgentId = normalizeOptionalString(activeRun?.agentId);
    const inferredRunAgentId =
      requestedParamAgentId ??
      (requestedRunId && scopedRequestedKey?.toLowerCase() === "global"
        ? activeRunAgentId
        : undefined) ??
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
    const requestedGlobalAgent = resolveRequestedGlobalAgentId(
      cfg,
      key,
      requestedParamAgentId ?? requestedRunAgentId,
    );
    if (!requestedGlobalAgent.ok) {
      respond(false, undefined, requestedGlobalAgent.error);
      return;
    }
    const requestedGlobalAgentId = requestedGlobalAgent.agentId;
    const { canonicalKey } = loadSessionEntry(key, { agentId: requestedGlobalAgentId });
    const requestedKeyAliases =
      requestedKey &&
      requestedKey !== key &&
      (!requestedParamAgentId || sessionKeyBelongsToAgent(requestedKey, requestedParamAgentId, cfg))
        ? [requestedKey]
        : undefined;
    const resolvedAbortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      activeRunSessionKey: scopedActiveRunSessionKey,
      aliasKeys: requestedKeyAliases,
    });
    const abortSessionKey =
      canonicalKey === "global" && requestedGlobalAgentId ? "global" : resolvedAbortSessionKey;
    const abortAgentId =
      abortSessionKey === "global" ? (requestedGlobalAgentId ?? activeRunAgentId) : undefined;
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
    await expectDefined(
      chatHandlers["chat.abort"],
      "chat.abort handler",
    )({
      req,
      params: {
        sessionKey: abortSessionKey,
        runId: requestedRunId,
        ...(abortAgentId ? { agentId: abortAgentId } : {}),
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
                ...(abortAgentId ? { agentId: abortAgentId } : {}),
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
        ...(canonicalKey === "global" && abortAgentId ? { agentId: abortAgentId } : {}),
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

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {
      agentId: requestedAgentId,
    });
    const canonicalKey = target.canonicalKey ?? key;
    const lifecycleEntry = loadSessionEntry(key, { agentId: requestedAgentId }).entry;
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      canonicalKey,
      lifecycleEntry,
    );
    if (missingHarnessSessionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError));
      return;
    }
    const lifecycleIdentities = [canonicalKey, key, lifecycleEntry?.sessionId];
    if (p.archived === true && isSessionLifecycleMutationActive(storePath, lifecycleIdentities)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive a session with an active run."),
      );
      return;
    }
    let patchModelCatalog: Awaited<ReturnType<typeof context.loadGatewayModelCatalog>> | undefined;
    const loadPatchModelCatalog = async () => {
      const catalog = await context.loadGatewayModelCatalog();
      patchModelCatalog = catalog;
      return catalog;
    };
    const applyPatch = async () => {
      const currentLifecycleEntry = loadSessionEntry(key, { agentId: requestedAgentId }).entry;
      // A reset queued ahead of archive can rotate the row before this mutation starts.
      // Never apply stale destructive intent to the replacement session identity.
      const lifecycleEntryRemoved =
        lifecycleEntry !== undefined && currentLifecycleEntry === undefined;
      const archiveTargetChanged =
        p.archived === true &&
        (lifecycleEntry === undefined
          ? currentLifecycleEntry !== undefined
          : currentLifecycleEntry !== undefined &&
            (currentLifecycleEntry.sessionId !== lifecycleEntry.sessionId ||
              currentLifecycleEntry.lifecycleRevision !== lifecycleEntry.lifecycleRevision));
      if (lifecycleEntryRemoved || archiveTargetChanged) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before patch. Retry.`),
        );
        return null;
      }
      if (p.archived === true) {
        if (canonicalKey === "global" || isAgentMainSessionKey(cfg, canonicalKey)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive an agent's main session."),
          );
          return null;
        }
        const { entry } = loadSessionEntry(key, { agentId: requestedAgentId });
        const activeIdentities = [canonicalKey, key, entry?.sessionId];
        if (
          isSessionWorkAdmissionActive(storePath, activeIdentities) ||
          replyRunRegistry.isActive(canonicalKey) ||
          replyRunRegistry.isActive(key) ||
          hasVisibleActiveSessionRun({
            context,
            requestedKey: key,
            canonicalKey,
            sessionId: entry?.sessionId,
            defaultAgentId: resolveDefaultAgentId(cfg),
          })
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive a session with an active run."),
          );
          return null;
        }
      }
      return await applySessionPatchProjection({
        agentId: target.agentId,
        storePath,
        resolveTarget: ({ entries }) => {
          const store = Object.fromEntries(
            entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
          );
          const { target: migratedTarget, primaryKey } = migrateAndPruneGatewaySessionStoreKey({
            cfg,
            key,
            store,
            agentId: requestedAgentId,
          });
          return { primaryKey, candidateKeys: migratedTarget.storeKeys };
        },
        project: async ({ primaryKey, existingEntry, entries }) =>
          await projectSessionsPatchEntry({
            cfg,
            entries,
            existingEntry,
            storeKey: primaryKey,
            agentId: requestedAgentId,
            patch: p,
            loadGatewayModelCatalog: loadPatchModelCatalog,
          }),
      });
    };
    const applied = await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: lifecycleIdentities,
      run: applyPatch,
    });
    if (!applied) {
      return;
    }
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

    // Cron mutations are operator.admin surface while archive is write-scoped;
    // only cascade for internal callers (client == null) or admin operators so
    // write-scoped archiving cannot flip admin-managed schedules.
    const callerScopes = client?.connect ? (client.connect.scopes ?? []) : null;
    const callerCanManageCron = callerScopes === null || callerScopes.includes(ADMIN_SCOPE);
    if (p.archived === true && callerCanManageCron) {
      // Archived sessions reject new work, so schedules bound to them would
      // only accumulate failing runs; disable them with the archive.
      try {
        const disabledJobIds = await disableCronJobsBoundToSession({
          cron: context.cron,
          cfg,
          sessionKey: target.canonicalKey ?? key,
        });
        if (disabledJobIds.length > 0) {
          log.info(
            `sessions.patch: disabled cron jobs bound to archived session ${target.canonicalKey ?? key}: ${disabledJobIds.join(", ")}`,
          );
        }
      } catch (error) {
        // Best-effort by design: archive is the primary action and must not
        // fail or roll back on cron-store errors. Any job left enabled fails
        // closed at run start because archived sessions reject new work.
        log.warn(
          `sessions.patch: failed to disable cron jobs for archived session ${target.canonicalKey ?? key}: ${formatErrorMessage(error)}`,
        );
      }
    }

    // Absorb ad-hoc categories into the gateway group catalog so ordering
    // covers every group an operator UI can observe.
    if (typeof p.category === "string" && p.category.trim()) {
      ensureSessionGroupRegistered(p.category);
    }

    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(
      target.canonicalKey === "global"
        ? target.agentId
        : (parsed?.agentId ?? resolveDefaultAgentId(cfg)),
    );
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const resolvedDisplayModel = resolveSessionDisplayModelIdentityRef({
      cfg,
      agentId,
      provider: resolved.provider,
      model: resolved.model,
    });
    const thinkingProjection = resolveGatewaySessionThinkingProjection({
      cfg,
      agentId,
      provider: resolvedDisplayModel.provider ?? resolved.provider,
      model: resolvedDisplayModel.model ?? resolved.model,
      sessionKey: target.canonicalKey ?? key,
      entry: applied.entry,
      modelCatalog: patchModelCatalog,
    });
    const resolvedThinkingMetadata =
      patchModelCatalog === undefined
        ? {}
        : {
            thinkingLevel: thinkingProjection.effectiveThinkingLevel,
            thinkingLevels: thinkingProjection.thinkingLevels,
          };
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolvedDisplayModel.provider,
        model: resolvedDisplayModel.model,
        agentRuntime: thinkingProjection.agentRuntime,
        ...resolvedThinkingMetadata,
      },
    };
    respond(true, result, undefined);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      ...(target.canonicalKey === "global" && requestedAgentId
        ? { agentId: requestedAgentId }
        : {}),
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
      ...(p.agentId ? { agentId: p.agentId } : {}),
      reason,
      commandSource: "gateway:sessions.reset",
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(
      true,
      { ok: true, key: result.key, entry: result.entry, resolved: result.resolved },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: result.key,
      ...(result.key === "global" ? { agentId: result.agentId } : {}),
      reason,
    });
  },
  "sessions.delete": async ({ req, params, respond, client, isWebchatConnect, context }) => {
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

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {
      agentId: requestedAgentId,
    });
    const mainKey = resolveMainSessionKey(cfg);
    const isSelectedNonDefaultGlobal =
      target.canonicalKey === "global" &&
      requestedAgentId !== undefined &&
      requestedAgentId !== resolveDefaultAgentId(cfg);
    if (target.canonicalKey === mainKey && !isSelectedNonDefaultGlobal) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
    const {
      cleanupSessionBeforeMutation,
      emitGatewaySessionEndPluginHook,
      emitSessionUnboundLifecycleEvent,
    } = await loadSessionsRuntimeModule();

    const initialDeleteEntry = loadSessionEntry(key, {
      agentId: requestedAgentId,
    }).entry;
    const rejectModelSelectionLockedDelete = (entry: SessionEntry | undefined): boolean => {
      if (!isModelSelectionLocked(entry)) {
        return false;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "This session cannot be deleted while model selection is locked.",
        ),
      );
      return true;
    };
    if (rejectModelSelectionLockedDelete(initialDeleteEntry)) {
      return;
    }
    // archivedOnly is the archive-then-delete contract: the dispatcher grants
    // it to write-scope operators, so the target must actually be archived.
    if (p.archivedOnly === true && initialDeleteEntry?.archivedAt === undefined) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Session ${key} is not archived. Archive it first, then delete it.`,
        ),
      );
      return;
    }
    const expectedSessionId = p.expectedSessionId?.trim();
    const expectedLifecycleRevision = p.expectedLifecycleRevision?.trim();
    const expectedSessionUpdatedAt = p.expectedSessionUpdatedAt;
    const expectedLifecycleRevisionMatches = (entry: SessionEntry | undefined): boolean =>
      !expectedLifecycleRevision || entry?.lifecycleRevision === expectedLifecycleRevision;
    const expectedSessionIdMatches = (entry: SessionEntry | undefined): boolean => {
      if (!expectedSessionId || entry?.sessionId === expectedSessionId) {
        return true;
      }
      return false;
    };
    const respondSessionChanged = () => {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before deletion. Retry.`, {
          details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
        }),
      );
    };
    const rejectExpectedSessionMismatch = (entry: SessionEntry | undefined): boolean => {
      const updatedAtMatches =
        expectedSessionUpdatedAt === undefined || entry?.updatedAt === expectedSessionUpdatedAt;
      if (
        expectedLifecycleRevisionMatches(entry) &&
        expectedSessionIdMatches(entry) &&
        updatedAtMatches
      ) {
        return false;
      }
      respondSessionChanged();
      return true;
    };
    if (rejectExpectedSessionMismatch(initialDeleteEntry)) {
      return;
    }
    if (
      rejectPluginRuntimeDeleteMismatch({
        client,
        key: target.canonicalKey ?? key,
        entry: initialDeleteEntry,
        respond,
      })
    ) {
      return;
    }
    let abortResult:
      | {
          ok: boolean;
          error?: ReturnType<typeof errorShape>;
        }
      | undefined;
    const abortSessionKey = target.canonicalKey ?? key;
    const chatAbort = chatHandlers["chat.abort"];
    if (!chatAbort) {
      throw new Error("chat.abort handler is not registered");
    }
    await chatAbort({
      req,
      params: {
        sessionKey: abortSessionKey,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      },
      respond: (ok, _payload, error) => {
        abortResult = { ok, ...(error ? { error } : {}) };
      },
      context,
      client,
      isWebchatConnect,
    });
    if (abortResult?.ok === false) {
      respond(false, undefined, abortResult.error);
      return;
    }
    const deleteLifecycleIdentities = [
      target.canonicalKey,
      key,
      initialDeleteEntry?.sessionId,
      expectedSessionId,
    ];
    let admittedWorkReleased = true;
    let expectedSessionStillCurrent = true;
    let deleteBlockedByModelLock = false;
    const deletion = await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: deleteLifecycleIdentities,
      prepare: async () => {
        const preparedEntry = loadSessionEntry(key, { agentId: requestedAgentId }).entry;
        deleteBlockedByModelLock = rejectModelSelectionLockedDelete(preparedEntry);
        if (deleteBlockedByModelLock) {
          return;
        }
        expectedSessionStillCurrent = !rejectExpectedSessionMismatch(preparedEntry);
        if (!expectedSessionStillCurrent) {
          return;
        }
        admittedWorkReleased = await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: deleteLifecycleIdentities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
      },
      run: async () => {
        if (deleteBlockedByModelLock || !expectedSessionStillCurrent) {
          return undefined;
        }
        if (!admittedWorkReleased) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is still active; try again.`),
          );
          return undefined;
        }
        const { entry, legacyKey, canonicalKey } = loadSessionEntry(key, {
          agentId: requestedAgentId,
        });
        if (rejectModelSelectionLockedDelete(entry)) {
          return undefined;
        }
        if (rejectExpectedSessionMismatch(entry)) {
          return undefined;
        }
        // Recheck under the lifecycle lock: an unarchive racing the pre-lock
        // check must not let an archive-gated delete remove an active session.
        if (p.archivedOnly === true && entry?.archivedAt === undefined) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session ${key} is not archived. Archive it first, then delete it.`,
            ),
          );
          return undefined;
        }
        if (
          rejectPluginRuntimeDeleteMismatch({
            client,
            key: canonicalKey ?? key,
            entry,
            respond,
          })
        ) {
          return undefined;
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
          return undefined;
        }
        const postCleanupEntry = loadSessionEntry(key, {
          agentId: requestedAgentId,
        }).entry;
        if (
          !expectedLifecycleRevisionMatches(postCleanupEntry) ||
          !expectedSessionIdMatches(postCleanupEntry)
        ) {
          respondSessionChanged();
          return undefined;
        }
        const result = await deleteSessionEntryLifecycle({
          agentId: target.agentId,
          archiveTranscript: deleteTranscript,
          expectedEntry: postCleanupEntry,
          expectedLifecycleRevision,
          expectedSessionId,
          expectedUpdatedAt: postCleanupEntry?.updatedAt,
          storePath,
          target: {
            canonicalKey: target.canonicalKey,
            storeKeys: target.storeKeys,
          },
        });
        if (result.expectedEntryMismatch) {
          respondSessionChanged();
          return undefined;
        }
        if (result.deleted) {
          emitGatewaySessionEndPluginHook({
            cfg,
            sessionKey: target.canonicalKey ?? key,
            sessionId: result.deletedSessionId,
            storePath,
            sessionFile: result.deletedSessionFile,
            agentId: target.agentId,
            reason: "deleted",
            archivedTranscripts: result.archivedTranscripts,
          });
          await emitSessionUnboundLifecycleEvent({
            targetSessionKey: target.canonicalKey ?? key,
            reason: "session-delete",
            emitHooks: p.emitLifecycleHooks !== false,
          });
        }
        return result;
      },
    });
    if (!deletion) {
      return;
    }
    const deleted = deletion.deleted;
    const archivedTranscripts = deletion.archivedTranscripts;
    const archived = archivedTranscripts.map((entryLocal) => entryLocal.archivedPath);

    // Dirty or unpushed worktrees survive session deletion; tell the caller so
    // operator UIs can point at the preserved checkout instead of orphaning it.
    let worktreePreserved: { id: string; branch: string; path: string } | undefined;
    if (deleted) {
      // requestedAgentId wins: "global" canonical keys resolve to the default store
      // agent, which would purge the wrong agent's rows for explicit-agent deletes.
      handleSessionStateSessionDeleted(
        target.canonicalKey ?? key,
        requestedAgentId ?? resolveSessionStoreAgentId(cfg, target.canonicalKey ?? key),
      );
      try {
        const worktree = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
        if (worktree && !(await managedWorktrees.removeIfLossless(worktree.id))) {
          worktreePreserved = { id: worktree.id, branch: worktree.branch, path: worktree.path };
        }
      } catch (error) {
        log.warn(
          `failed to clean up worktree for deleted session ${target.canonicalKey}: ${formatErrorMessage(error)}`,
        );
      }
    }

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        deleted,
        archived,
        ...(worktreePreserved ? { worktreePreserved } : {}),
      },
      undefined,
    );
    if (deleted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        ...(target.canonicalKey === "global" && requestedAgentId
          ? { agentId: requestedAgentId }
          : {}),
        reason: "delete",
      });
    }
  },
  "sessions.groups.list": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsListParams, "sessions.groups.list", respond)
    ) {
      return;
    }
    respond(true, { groups: listSessionGroups() }, undefined);
  },
  "sessions.groups.put": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsPutParams, "sessions.groups.put", respond)
    ) {
      return;
    }
    respond(true, { ok: true, groups: putSessionGroups(params.names) }, undefined);
    // Catalog-only changes still need to reach other open clients.
    emitSessionsChanged(context, { reason: "groups" });
  },
  "sessions.groups.rename": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsRenameParams,
        "sessions.groups.rename",
        respond,
      )
    ) {
      return;
    }
    try {
      const result = await renameSessionGroup({
        cfg: context.getRuntimeConfig(),
        name: params.name,
        to: params.to,
      });
      respond(true, { ok: true, ...result }, undefined);
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.groups.delete": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsDeleteParams,
        "sessions.groups.delete",
        respond,
      )
    ) {
      return;
    }
    try {
      const result = await deleteSessionGroup({
        cfg: context.getRuntimeConfig(),
        name: params.name,
      });
      respond(true, { ok: true, ...result }, undefined);
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.get": async ({ params, respond, context }) => {
    const p = params as {
      key?: unknown;
      sessionKey?: unknown;
      limit?: unknown;
      agentId?: unknown;
    };
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(
      cfg,
      key,
      normalizeOptionalString(p.agentId),
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { storePath, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const { messages } = await readRecentSessionMessagesWithStatsAsync(
      {
        agentId: requestedAgent.agentId,
        sessionEntry: entry,
        sessionId: entry.sessionId,
        sessionKey: key,
        storePath,
      },
      {
        maxMessages: limit,
        maxLines: limit * 20 + 20,
        allowResetArchiveFallback: true,
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

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {
      agentId: requestedAgentId,
    });
    // Lock + read in a short critical section; transcript work happens outside.
    // The projection resolver re-runs gateway key migration on the writer
    // snapshot so alias promotion/pruning persists through the accessor.
    let compactPrimaryKey = target.canonicalKey;
    const compactRead = await applySessionPatchProjection({
      agentId: target.agentId,
      storePath,
      resolveTarget: ({ entries }) => {
        const snapshot = Object.fromEntries(
          entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
        );
        const { target: migratedTarget, primaryKey } = migrateAndPruneGatewaySessionStoreKey({
          cfg,
          key,
          store: snapshot,
          agentId: requestedAgentId,
        });
        compactPrimaryKey = primaryKey;
        return { primaryKey, candidateKeys: migratedTarget.storeKeys };
      },
      // Read-only projection: persist the resolved row unchanged so the alias
      // migration above is saved even when compaction bails out below.
      project: ({ existingEntry }) =>
        existingEntry ? { ok: true, entry: existingEntry } : { ok: false },
    });
    const compactTarget = {
      entry: compactRead.ok ? compactRead.entry : undefined,
      primaryKey: compactPrimaryKey,
    };
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

    if (maxLines !== undefined) {
      const trimPreflight = await preflightSessionTranscriptForManualCompact(
        {
          sessionId,
          storePath,
          sessionKey: compactTarget.primaryKey,
          agentId: target.agentId,
        },
        { maxLines, sessionFile: entry.sessionFile },
      );
      if (!trimPreflight.compacted) {
        respond(
          true,
          {
            ok: true,
            key: target.canonicalKey,
            compacted: false,
            ...("kept" in trimPreflight
              ? { kept: trimPreflight.kept }
              : { reason: "no transcript" }),
          },
          undefined,
        );
        return;
      }
    } else {
      const transcriptEvents = await loadTranscriptEvents({
        agentId: target.agentId,
        sessionId,
        sessionKey: compactTarget.primaryKey,
        storePath,
      }).catch(() => []);
      if (transcriptEvents.length === 0) {
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
    }

    const lifecycleRevision = entry.lifecycleRevision;
    const lifecycleIdentities = [
      key,
      target.canonicalKey,
      compactTarget.primaryKey,
      sessionId,
      lifecycleRevision,
    ];
    let sessionStillCurrent = true;
    let admittedWorkReleased = true;
    try {
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: lifecycleIdentities,
        kind: "compaction",
        prepare: async () => {
          const latestEntry = loadAccessorSessionEntryForGatewayTarget({
            key,
            cfg,
            agentId: requestedAgentId,
          }).entry;
          sessionStillCurrent = Boolean(
            latestEntry &&
            latestEntry.sessionId === sessionId &&
            latestEntry.lifecycleRevision === lifecycleRevision &&
            !resolveSessionWorkStartError(target.canonicalKey, latestEntry),
          );
          if (!sessionStillCurrent) {
            return;
          }
          // Drop work queued against the pre-compaction transcript before its
          // active admission drains and no longer exposes queue cleanup.
          clearSessionQueues([key, target.canonicalKey, compactTarget.primaryKey, sessionId]);
          admittedWorkReleased = await interruptSessionWorkAdmissions({
            scope: storePath,
            identities: lifecycleIdentities,
            timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          });
        },
        run: async () => {
          if (!sessionStillCurrent) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} changed before compaction. Retry.`,
                { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
              ),
            );
            return;
          }
          if (!admittedWorkReleased) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is still active; try again.`),
            );
            return;
          }

          const latestEntry = loadAccessorSessionEntryForGatewayTarget({
            key,
            cfg,
            agentId: requestedAgentId,
          }).entry;
          if (
            !latestEntry ||
            latestEntry.sessionId !== sessionId ||
            latestEntry.lifecycleRevision !== lifecycleRevision ||
            resolveSessionWorkStartError(target.canonicalKey, latestEntry)
          ) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} changed before compaction. Retry.`,
                { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
              ),
            );
            return;
          }

          const interruptResult = await interruptSessionRunIfActive({
            req,
            context,
            client,
            isWebchatConnect,
            requestedKey: key,
            canonicalKey: target.canonicalKey,
            agentId: requestedAgentId,
            sessionId,
          });
          if (interruptResult.error) {
            respond(false, undefined, interruptResult.error);
            return;
          }

          const operationId = randomUUID();
          if (maxLines !== undefined) {
            const trimResult = await trimSessionTranscriptForManualCompact(
              {
                sessionId,
                storePath,
                sessionKey: compactTarget.primaryKey,
                agentId: target.agentId,
              },
              { maxLines, sessionFile: latestEntry.sessionFile },
            );
            respond(
              true,
              {
                ok: true,
                key: target.canonicalKey,
                compacted: trimResult.compacted,
                ...(trimResult.compacted
                  ? { archived: trimResult.archived, kept: trimResult.kept }
                  : "kept" in trimResult
                    ? { kept: trimResult.kept }
                    : { reason: "no transcript" }),
              },
              undefined,
            );
            if (trimResult.compacted) {
              const snapshotAfterTrim = loadSessionStoreEntrySnapshot({
                sessionKey: target.canonicalKey,
                storePath,
              });
              const storeAfterTrim = snapshotAfterTrim.store;
              const entryAfterTrim = snapshotAfterTrim.entry ?? latestEntry;
              await releaseManualPostCompactionDelegatesIfNeeded({
                cfg,
                compactionCount: entryAfterTrim.compactionCount ?? 0,
                entry: entryAfterTrim,
                model: resolveSessionModelRef(cfg, entryAfterTrim, target.agentId),
                sessionFile:
                  entryAfterTrim.sessionFile ??
                  latestEntry.sessionFile ??
                  path.join(storePath, `.jsonl`),
                sessionId: entryAfterTrim.sessionId,
                sessionKey: target.canonicalKey,
                store: storeAfterTrim,
                storePath,
                targetAgentId: target.agentId,
                workspaceDir:
                  normalizeOptionalString(entryAfterTrim.spawnedWorkspaceDir) ||
                  resolveAgentWorkspaceDir(cfg, target.agentId),
              });
              recordSessionCompacted({
                sessionKey: target.canonicalKey,
                operationId,
                sessionId,
                agentId: target.agentId ?? requestedAgentId,
              });
              emitSessionsChanged(context, {
                sessionKey: target.canonicalKey,
                ...(target.canonicalKey === "global" && target.agentId
                  ? { agentId: target.agentId }
                  : {}),
                reason: "compact",
                compacted: true,
              });
            }
            return;
          }

          const transcriptEvents = await loadTranscriptEvents({
            agentId: target.agentId,
            sessionId,
            sessionKey: compactTarget.primaryKey,
            storePath,
          }).catch(() => []);
          if (transcriptEvents.length === 0) {
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
          const compactionTranscriptTarget = await resolveSessionTranscriptRuntimeTarget({
            agentId: target.agentId,
            sessionId,
            sessionKey: compactTarget.primaryKey,
            storePath,
          });

          const resolvedModel = resolveSessionModelRef(cfg, latestEntry, target.agentId);
          const workspaceDir =
            resolveIngressWorkspaceOverrideForSessionRun({
              spawnedBy: latestEntry.spawnedBy,
              workspaceDir: latestEntry.spawnedWorkspaceDir,
              cwd: latestEntry.spawnedCwd,
            }) ?? resolveAgentWorkspaceDir(cfg, target.agentId);
          emitSessionOperation(context, {
            operationId,
            operation: "compact",
            phase: "start",
            sessionKey: target.canonicalKey,
            ...(target.canonicalKey === "global" && target.agentId
              ? { agentId: target.agentId }
              : {}),
          });
          const emitCompactionEnd = (completed: boolean, reason?: string) =>
            emitSessionOperation(context, {
              operationId,
              operation: "compact",
              phase: "end",
              sessionKey: target.canonicalKey,
              ...(target.canonicalKey === "global" && target.agentId
                ? { agentId: target.agentId }
                : {}),
              completed,
              reason,
            });
          let result: Awaited<ReturnType<typeof compactEmbeddedAgentSession>>;
          try {
            result = await compactEmbeddedAgentSession({
              sessionId,
              sessionKey: target.canonicalKey,
              agentId: target.agentId,
              sessionTarget: {
                agentId: target.agentId,
                sessionId,
                sessionKey: target.canonicalKey,
                storePath,
              },
              allowGatewaySubagentBinding: true,
              sessionFile: compactionTranscriptTarget.sessionFile,
              workspaceDir,
              cwd: normalizeOptionalString(latestEntry.spawnedCwd),
              config: cfg,
              provider: resolvedModel.provider,
              model: resolvedModel.model,
              authProfileId: latestEntry.authProfileOverride,
              authProfileIdSource:
                latestEntry.authProfileOverrideSource ??
                (latestEntry.authProfileOverride
                  ? typeof latestEntry.authProfileOverrideCompactionCount === "number"
                    ? "auto"
                    : "user"
                  : undefined),
              agentHarnessId:
                latestEntry.modelSelectionLocked === true
                  ? resolvePersistedSessionRuntimeId(latestEntry)
                  : latestEntry.agentHarnessId,
              modelSelectionLocked: latestEntry.modelSelectionLocked === true,
              thinkLevel: normalizeThinkLevel(latestEntry.thinkingLevel),
              reasoningLevel: normalizeReasoningLevel(latestEntry.reasoningLevel),
              bashElevated: {
                enabled: false,
                allowed: false,
                defaultLevel: "off",
              },
              trigger: "manual",
            });
          } catch (err) {
            emitCompactionEnd(false, formatErrorMessage(err));
            throw err;
          }
          if (result.ok && result.compacted) {
            let persisted: boolean;
            let releaseSessionEntry: SessionEntry | undefined;
            let releaseSessionStore: Record<string, SessionEntry> | undefined;
            try {
              // Guarded terminal persist: skip when session ownership rotated
              // while compaction ran (sessionId/lifecycleRevision/work-start).
              const persistProjection = await applySessionPatchProjection({
                agentId: target.agentId,
                storePath,
                resolveTarget: () => ({ primaryKey: compactTarget.primaryKey }),
                project: ({ existingEntry }) => {
                  if (
                    !existingEntry ||
                    existingEntry.sessionId !== sessionId ||
                    existingEntry.lifecycleRevision !== lifecycleRevision ||
                    resolveSessionWorkStartError(target.canonicalKey, existingEntry)
                  ) {
                    return { ok: false };
                  }
                  const entryToUpdate = existingEntry;
                  entryToUpdate.updatedAt = Date.now();
                  entryToUpdate.compactionCount =
                    Math.max(0, entryToUpdate.compactionCount ?? 0) + 1;
                  if (
                    result.result?.sessionId &&
                    result.result.sessionId !== entryToUpdate.sessionId
                  ) {
                    entryToUpdate.sessionId = result.result.sessionId;
                  }
                  delete entryToUpdate.inputTokens;
                  delete entryToUpdate.outputTokens;
                  delete entryToUpdate.contextBudgetStatus;
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
                  return { ok: true, entry: entryToUpdate };
                },
              });
              persisted = persistProjection.ok;
              if (persistProjection.ok) {
                releaseSessionEntry = persistProjection.entry;
                releaseSessionStore = { [target.canonicalKey]: persistProjection.entry };
              }
            } catch (err) {
              emitCompactionEnd(false, formatErrorMessage(err));
              throw err;
            }
            if (!persisted) {
              const reason = `Session ${key} changed before compaction completed. Retry.`;
              emitCompactionEnd(false, reason);
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.INVALID_REQUEST, reason, {
                  details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
                }),
              );
              return;
            }
            if (releaseSessionEntry && releaseSessionStore) {
              await releaseManualPostCompactionDelegatesIfNeeded({
                cfg,
                compactionCount: releaseSessionEntry.compactionCount ?? 0,
                entry: releaseSessionEntry,
                model: resolvedModel,
                sessionFile:
                  releaseSessionEntry.sessionFile ??
                  entry.sessionFile ??
                  formatSqliteSessionFileMarker({
                    agentId: target.agentId ?? requestedAgentId ?? resolveDefaultAgentId(cfg),
                    sessionId: releaseSessionEntry.sessionId,
                    storePath,
                  }),
                sessionId: releaseSessionEntry.sessionId,
                sessionKey: target.canonicalKey,
                store: releaseSessionStore,
                storePath,
                targetAgentId: target.agentId,
                workspaceDir,
              });
            }
            recordSessionCompacted({
              sessionKey: target.canonicalKey,
              operationId,
              sessionId: result.result?.sessionId ?? sessionId,
              agentId: target.agentId ?? requestedAgentId,
            });
          }

          emitCompactionEnd(result.ok && result.compacted, result.reason);
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
              ...(target.canonicalKey === "global" && target.agentId
                ? { agentId: target.agentId }
                : {}),
              reason: "compact",
              compacted: result.compacted,
            });
          }
        },
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
};

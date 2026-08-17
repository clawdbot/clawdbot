// Gateway session reset/delete service.
// Rotates transcripts and coordinates lifecycle cleanup across runtimes/hooks.
import { randomUUID } from "node:crypto";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { tryPrepareFreshManagerRuntimeSession } from "../acp/control-plane/manager.runtime-resume-state.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import {
  readAcpSessionMeta,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope.js";
import {
  clearBootstrapSnapshot,
  clearBootstrapSnapshotOnSessionBoundary,
} from "../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../agents/cli-session.js";
import { resetRegisteredAgentHarnessSessions } from "../agents/harness/registry.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../auto-reply/reply/session-hooks.js";
import { clearSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  resolveSessionWorkStartError,
  SESSION_TOTAL_TOKENS_VERSION,
  type SessionEntry,
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "../config/sessions.js";
import { rebindCliSessionReseedReceiptsForReset } from "../config/sessions/cli-session-binding.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import {
  buildSessionCreationStamp,
  type SessionCreatedActor,
  type SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import {
  emitSessionAutoResetHook,
  hasSessionAutoResetListeners,
  isSessionAutoResetReason,
} from "../hooks/session-auto-reset.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPluginHostCleanup } from "../plugins/host-hook-cleanup.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import {
  isIncognitoSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../sessions/agent-harness-session-key.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
} from "../sessions/model-overrides.js";
import {
  hasOnlySessionLifecycleMutationKindActive,
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import {
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
  recordSessionCreated,
} from "../sessions/session-state-events.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import { findDirectChildSessionsForParent } from "./session-child-sessions.js";
import {
  type PreparedGatewaySessionLifecycle,
  type PrepareGatewaySessionLifecycle,
  rollbackGatewaySessionPreparation,
} from "./session-lifecycle-preparation.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";
import {
  archiveSessionTranscriptsDetailed,
  resolveStableSessionEndTranscript,
  type ArchivedSessionTranscript,
} from "./session-transcript-files.fs.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";
import {
  loadSessionEntry,
  resolveGatewaySessionStoreTarget,
  resolveSessionStoreKey,
} from "./session-utils.js";
import type { SessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import {
  resolveSessionWorkerPlacementMutationError,
  retireSessionWorkerPlacementBeforeMutation,
} from "./worker-environments/session-placement-lifecycle.js";

function resolveLifecycleAgentId(cfg: OpenClawConfig, agentId?: string): string {
  return normalizeAgentId(
    agentId ?? tryResolveLegacyCompatibilityAgentId(cfg) ?? resolveDefaultAgentId(cfg),
  );
}

type McpRunEndWatcherState = {
  cancellations: Map<string, () => void>;
  retirements: Set<Promise<void>>;
  watchers: Map<string, Promise<void>>;
};

const mcpRunEndWatcherState = resolveGlobalSingleton<McpRunEndWatcherState>(
  Symbol.for("openclaw.mcpRunEndWatchers"),
  () => ({ cancellations: new Map(), retirements: new Set(), watchers: new Map() }),
  async (state) => {
    for (const cancel of state.cancellations.values()) {
      cancel();
    }
    await Promise.allSettled([...state.watchers.values(), ...state.retirements]);
    state.cancellations.clear();
    state.retirements.clear();
    state.watchers.clear();
  },
);
const mcpRunEndWatchers = mcpRunEndWatcherState.watchers;

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

export function archiveSessionTranscriptsForSessionDetailed(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
  incognito?: boolean;
  onArchiveError?: (err: unknown, sourcePath: string) => void;
}): ArchivedSessionTranscript[] {
  if (!params.sessionId || params.incognito === true) {
    return [];
  }
  return archiveSessionTranscriptsDetailed({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
    onArchiveError: params.onArchiveError,
  });
}

export function emitGatewaySessionEndPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
  workspaceDir?: string;
  reason:
    | "new"
    | "reset"
    | "idle"
    | "daily"
    | "compaction"
    | "deleted"
    | "shutdown"
    | "restart"
    | "unknown";
  archivedTranscripts?: ArchivedSessionTranscript[];
  nextSessionId?: string;
  nextSessionKey?: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  // Drop this session from the shutdown finalizer's tracked set unconditionally
  // -- even when no plugin hooks are registered for `session_end`, the session
  // is being closed here and must not be re-finalized by a later shutdown drain.
  forgetActiveSessionForShutdown(params.sessionId);
  const hookRunner = getGlobalHookRunner();
  const shouldEmitAutoReset =
    isSessionAutoResetReason(params.reason) && hasSessionAutoResetListeners();
  const shouldEmitPluginHook = hookRunner?.hasHooks("session_end") === true;
  if (!shouldEmitAutoReset && !shouldEmitPluginHook) {
    return;
  }
  const transcript = resolveStableSessionEndTranscript({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    archivedTranscripts: params.archivedTranscripts,
  });
  if (shouldEmitAutoReset) {
    emitSessionAutoResetHook({
      cfg: params.cfg,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      reason: params.reason,
      sessionFile: transcript.sessionFile,
      transcriptArchived: transcript.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      storePath: params.storePath,
    });
  }
  if (!shouldEmitPluginHook) {
    return;
  }
  if (!hookRunner) {
    return;
  }
  const payload = buildSessionEndHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    reason: params.reason,
    sessionFile: transcript.sessionFile,
    transcriptArchived: transcript.transcriptArchived,
    nextSessionId: params.nextSessionId,
    nextSessionKey: params.nextSessionKey,
  });
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await hookRunner.runSessionEnd(payload.event, payload.context);
  }).catch((err: unknown) => {
    logVerbose(`session_end hook failed: ${String(err)}`);
  });
}

export function emitGatewaySessionStartPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  resumedFrom?: string;
  storePath?: string;
  sessionFile?: string;
  agentId: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  // Track the session for the shutdown finalizer even when no plugin hooks are
  // registered locally, so a later restart still emits a typed `session_end`
  // for sessions that opened while a `session_end` plugin was attached. The
  // tracker is keyed by `sessionId`, so a session that is subsequently closed
  // via reset / delete / compaction is forgotten before the shutdown drain
  // ever runs (see #57790).
  if (params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_start")) {
    return;
  }
  const payload = buildSessionStartHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    resumedFrom: params.resumedFrom,
  });
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await hookRunner.runSessionStart(payload.event, payload.context);
  }).catch((err: unknown) => {
    logVerbose(`session_start hook failed: ${String(err)}`);
  });
}

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  await getSessionBindingService().unbind({
    targetSessionKey: params.targetSessionKey,
    reason: params.reason,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
  assertCurrent?: () => void;
}) {
  // Session lifecycle mutation owns this heavy runtime edge; read-only gateway
  // commands such as status must not load the embedded-agent barrel.
  const [embeddedAgent, mcpTools, { clearFinishedSessionsForScopes }] = await Promise.all([
    import("../agents/embedded-agent.js"),
    import("../agents/agent-bundle-mcp-tools.js"),
    import("../agents/bash-process-registry.js"),
  ]);
  params.assertCurrent?.();
  const closeTrackedBrowserTabs = async () => {
    params.assertCurrent?.();
    const closeKeys = new Set<string>([
      params.key,
      params.target.canonicalKey,
      ...params.target.storeKeys,
      params.sessionId ?? "",
    ]);
    await cleanupBrowserSessionsForLifecycleEnd({
      cfg: params.cfg,
      sessionKeys: [...closeKeys],
      onWarn: (message) => logVerbose(message),
    });
    params.assertCurrent?.();
  };

  params.assertCurrent?.();
  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  // Process scopes may use the requested alias, canonical key, or session id.
  // Clear only completed records so reset/delete cannot erase another scope's
  // output or hide a background process whose owner has not confirmed exit.
  const processScopeKeys = new Set(queueKeys);
  processScopeKeys.add(params.key);
  clearFinishedSessionsForScopes(processScopeKeys);
  clearSessionResetRuntimeState([...queueKeys], {
    activeReplySessionId: params.sessionId,
    agentId: resolveLifecycleAgentId(params.cfg, params.target.agentId),
  });
  await stopSubagentsForRequester({
    cfg: params.cfg,
    requesterSessionKey: params.target.canonicalKey,
  });
  if (!params.sessionId) {
    params.assertCurrent?.();
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  const sessionId = params.sessionId;
  params.assertCurrent?.();
  const cleanupProviderResources = () => {
    try {
      cleanupSessionResources(sessionId);
    } catch (error) {
      logVerbose(
        `sessions cleanup: failed to dispose provider resources for ${sessionId}: ${String(error)}`,
      );
    }
  };
  const retireMcpRuntime = async (retainAcrossReuse: boolean) => {
    await mcpTools.retireSessionMcpRuntime({
      sessionId,
      reason: "gateway-session-cleanup",
      preserveActiveLeases: true,
      retainAcrossReuse,
      onError: (error, retiredSessionId) => {
        logVerbose(
          `sessions cleanup: failed to dispose bundle MCP runtime for ${retiredSessionId}: ${String(error)}`,
        );
      },
    });
  };
  const ensureMcpRetirementWatcher = (): Promise<void> => {
    return getOrCreatePromise(
      mcpRunEndWatchers,
      sessionId,
      async () => {
        let cancelWatcher = () => {};
        const cancelled = new Promise<false>((resolve) => {
          cancelWatcher = () => resolve(false);
        });
        mcpRunEndWatcherState.cancellations.set(sessionId, cancelWatcher);
        try {
          while (
            await Promise.race([
              embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, null),
              cancelled,
            ])
          ) {
            // A replacement can register after the wait promise settles but before
            // this continuation runs. Keep the required retirement armed for it.
            if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
              continue;
            }
            const retirement = retireMcpRuntime(false);
            mcpRunEndWatcherState.retirements.add(retirement);
            try {
              await retirement;
            } finally {
              mcpRunEndWatcherState.retirements.delete(retirement);
            }
            if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
              continue;
            }
            cleanupProviderResources();
            return;
          }
        } catch (error) {
          logVerbose(
            `sessions cleanup: failed to disarm deferred MCP retirement: ${String(error)}`,
          );
        } finally {
          if (mcpRunEndWatcherState.cancellations.get(sessionId) === cancelWatcher) {
            mcpRunEndWatcherState.cancellations.delete(sessionId);
          }
        }
      },
      { evictOnSettled: true },
    );
  };
  // Register against the run being stopped before abort or any await allows a
  // later embedded or reply-backed run to replace it in the active registry.
  const mcpRetirementWatcher = ensureMcpRetirementWatcher();
  embeddedAgent.abortEmbeddedAgentRun(sessionId);
  // Mark cleanup before waiting so the timeout path cannot strand MCP children.
  // Active tool/app leases keep in-flight work alive until their final release.
  await retireMcpRuntime(true);
  const ended = await embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, 15_000);
  params.assertCurrent?.();
  // A stopping run can create or reuse its runtime while we wait. Retire again
  // after a clean stop; otherwise keep the required marker armed for late work.
  await retireMcpRuntime(!ended);
  params.assertCurrent?.();
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (ended && !embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
    params.assertCurrent?.();
    mcpRunEndWatcherState.cancellations.get(sessionId)?.();
    await mcpRetirementWatcher;
    cleanupProviderResources();
    await closeTrackedBrowserTabs();
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  fallbackSessionKeys?: Array<string | undefined>;
  reason: "session-reset" | "session-delete";
  onResetMeta?: (params: { sessionKey: string; meta: SessionAcpMeta }) => void;
  deferResetState?: boolean;
  onDeferredResetState?: (params: { sessionKey: string; meta: SessionAcpMeta }) => void;
  assertCurrent?: () => void;
  shouldCleanup?: () => boolean;
}) {
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return undefined;
  }
  params.assertCurrent?.();
  const sessionKeys = Array.from(
    new Set(
      [params.sessionKey, ...(params.fallbackSessionKeys ?? [])]
        .map((key) => (typeof key === "string" ? key.trim() : ""))
        .filter(Boolean),
    ),
  );
  let acpMeta: SessionAcpMeta | undefined;
  let acpSessionKey = params.sessionKey;
  for (const sessionKey of sessionKeys) {
    acpMeta = readAcpSessionMeta({ sessionKey, agentId: params.agentId, cfg: params.cfg });
    if (acpMeta) {
      acpSessionKey = sessionKey;
      break;
    }
  }
  if (!acpMeta) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return undefined;
  }
  params.assertCurrent?.();
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        reason: params.reason,
      });
    },
  });
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return undefined;
  }
  params.assertCurrent?.();
  if (cancelOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  if (params.shouldCleanup && !params.shouldCleanup()) {
    return undefined;
  }
  params.assertCurrent?.();
  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        reason: params.reason,
        discardPersistentState: true,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      });
    },
  });
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return undefined;
  }
  params.assertCurrent?.();
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  if (params.reason === "session-delete") {
    params.assertCurrent?.();
    await upsertAcpSessionMeta({
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      agentId: params.agentId,
      mutate: () => null,
    });
    params.assertCurrent?.();
  } else if (params.deferResetState) {
    params.onDeferredResetState?.({
      sessionKey: acpSessionKey,
      meta: acpMeta,
    });
  } else {
    const resetMeta = await ensureFreshAcpResetState({
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      agentId: params.agentId,
      reason: params.reason,
      acpMeta,
      assertCurrent: params.assertCurrent,
      shouldApply: params.shouldCleanup,
    });
    if (resetMeta) {
      params.onResetMeta?.({ sessionKey: acpSessionKey, meta: resetMeta });
    }
  }
  return undefined;
}

function buildPendingAcpMeta(base: SessionAcpMeta, now: number): SessionAcpMeta {
  const currentIdentity = base.identity;
  const nextIdentity = currentIdentity
    ? {
        state: "pending" as const,
        ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
        source: currentIdentity.source,
        lastUpdatedAt: now,
      }
    : undefined;
  return {
    backend: base.backend,
    agent: base.agent,
    runtimeSessionName: base.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: base.mode,
    ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    state: "idle",
    lastActivityAt: now,
  };
}

async function ensureFreshAcpResetState(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: "session-reset" | "session-delete";
  acpMeta: SessionAcpMeta;
  assertCurrent?: () => void;
  shouldApply?: () => boolean;
}): Promise<SessionAcpMeta | undefined> {
  if (params.reason !== "session-reset") {
    return undefined;
  }
  const latestMeta =
    readAcpSessionMeta({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      cfg: params.cfg,
    }) ?? params.acpMeta;
  if (
    !latestMeta?.identity ||
    latestMeta.identity.state !== "resolved" ||
    (!latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId)
  ) {
    return undefined;
  }

  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  params.assertCurrent?.();
  // The helper records skipped/failed preparation; only lifecycle staleness aborts here.
  await tryPrepareFreshManagerRuntimeSession({
    deps: { getRuntimeBackend: getAcpRuntimeBackend },
    cfg: params.cfg,
    meta: latestMeta,
    sessionKey: params.sessionKey,
    logPrefix: `sessions.${params.reason}`,
  });
  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  params.assertCurrent?.();

  const now = Date.now();
  let resetMeta: SessionAcpMeta | undefined;
  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  params.assertCurrent?.();
  await upsertAcpSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    mutate: (current) => {
      if (params.shouldApply && !params.shouldApply()) {
        return current;
      }
      resetMeta = buildPendingAcpMeta(current ?? latestMeta, now);
      return resetMeta;
    },
  });
  params.assertCurrent?.();
  return resetMeta;
}

async function closeChildAcpRuntimesForParent(params: {
  cfg: OpenClawConfig;
  parentKey: string;
  reason: "session-reset" | "session-delete";
  assertCurrent?: () => void;
  shouldCleanup?: () => boolean;
}): Promise<void> {
  // Enumerate across every agent session store, not just the parent's: ACP
  // spawns create child keys under the target agent (`agent:<targetAgentId>:acp:…`)
  // whose entries live in that agent's store, which is a different file from the
  // parent's under the default per-agent layout. The combined gateway store
  // aggregates all agent stores under canonical keys (same source the dashboard
  // session list uses).
  let children: Array<{ sessionKey: string }>;
  try {
    if (params.shouldCleanup && !params.shouldCleanup()) {
      return;
    }
    params.assertCurrent?.();
    children = findDirectChildSessionsForParent({
      cfg: params.cfg,
      parentKey: params.parentKey,
    }).flatMap(({ sessionKey }) => {
      const acpMeta = readAcpSessionMeta({ sessionKey });
      return acpMeta ? [{ sessionKey }] : [];
    });
  } catch (error) {
    logVerbose(
      `sessions.${params.reason}: failed to enumerate sessions for child ACP cleanup: ${String(error)}`,
    );
    return;
  }
  // Close only direct ACP-backed children of the session being mutated; the
  // parent itself is closed separately by the caller. Without this, child ACP
  // sessions spawned via sessions_spawn are orphaned on parent reset/delete.
  // Close children concurrently so total latency is bounded by a single ACP
  // cleanup timeout window rather than scaling with the number of stuck
  // children; per-child failures are logged best-effort and never propagated,
  // so a stuck child cannot block or fail the parent mutation.
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return;
  }
  params.assertCurrent?.();
  await Promise.allSettled(
    children.map(({ sessionKey }) =>
      closeAcpRuntimeForSession({
        cfg: params.cfg,
        sessionKey,
        reason: params.reason,
        assertCurrent: params.assertCurrent,
        shouldCleanup: params.shouldCleanup,
      }).then((childError) => {
        if (childError) {
          logVerbose(`sessions.${params.reason}: child ACP cleanup incomplete for ${sessionKey}`);
        }
      }),
    ),
  );
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return;
  }
  params.assertCurrent?.();
}

export async function cleanupSessionBeforeMutation(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
  onAcpResetMeta?: (params: { sessionKey: string; meta: SessionAcpMeta }) => void;
  assertCurrent?: () => void;
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    target: params.target,
    sessionId: params.entry?.sessionId,
    assertCurrent: params.assertCurrent,
  });
  if (cleanupError) {
    return cleanupError;
  }
  const pluginCleanup = await runPluginHostCleanup({
    cfg: params.cfg,
    registry: getActivePluginRegistry(),
    reason: params.reason === "session-reset" ? "reset" : "delete",
    sessionKey: params.target.canonicalKey ?? params.key,
    shouldCleanup: () => {
      params.assertCurrent?.();
      return true;
    },
  });
  params.assertCurrent?.();
  for (const failure of pluginCleanup.failures) {
    logVerbose(
      `plugin host cleanup failed for ${failure.pluginId}/${failure.hookId}: ${String(failure.error)}`,
    );
  }
  const parentSessionKey = params.target.canonicalKey ?? params.canonicalKey ?? params.key;
  const parentAcpError = await closeAcpRuntimeForSession({
    cfg: params.cfg,
    sessionKey: parentSessionKey,
    agentId: params.target.agentId,
    fallbackSessionKeys: [params.canonicalKey, params.legacyKey, params.key],
    reason: params.reason,
    onResetMeta: params.onAcpResetMeta,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  await closeChildAcpRuntimesForParent({
    cfg: params.cfg,
    parentKey: params.target.canonicalKey ?? params.canonicalKey ?? params.key,
    reason: params.reason,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  if (parentAcpError) {
    return parentAcpError;
  }
  if (params.entry?.sessionId) {
    // Clear physical harness ownership after the old run drains but before the
    // store can expose a successor generation to a new turn.
    const resetParams = {
      agentId: resolveLifecycleAgentId(params.cfg, params.target.agentId),
      sessionId: params.entry.sessionId,
      sessionKey: params.target.canonicalKey ?? params.key,
      sessionFile: params.target.canonicalKey ?? params.key,
      reason: params.reason === "session-reset" ? "reset" : "deleted",
    } satisfies Parameters<typeof resetRegisteredAgentHarnessSessions>[0];
    await resetRegisteredAgentHarnessSessions(resetParams);
    params.assertCurrent?.();
  }
  return undefined;
}

export async function emitGatewayBeforeResetPluginHook(params: {
  cfg: OpenClawConfig;
  key: string;
  messages?: unknown[];
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  storePath: string;
  entry?: SessionEntry;
  reason: "new" | "reset";
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset")) {
    return;
  }

  const sessionKey = params.target.canonicalKey ?? params.key;
  const sessionId = params.entry?.sessionId;
  const agentId = resolveLifecycleAgentId(params.cfg, params.target.agentId);
  const sessionFile = sessionId
    ? formatSqliteSessionFileMarker({ agentId, sessionId, storePath: params.storePath })
    : undefined;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const messages =
    params.messages ??
    (await readGatewayBeforeResetPluginHookMessages({
      agentId,
      entry: params.entry,
      sessionId,
      sessionKey,
      storePath: params.storePath,
    }));

  void hookRunner
    .runBeforeReset(
      {
        sessionFile,
        messages,
        reason: params.reason,
      },
      {
        agentId,
        sessionKey,
        sessionId,
        workspaceDir,
      },
    )
    .catch((err: unknown) => {
      logVerbose(`before_reset hook failed: ${String(err)}`);
    });
}

async function readGatewayBeforeResetPluginHookMessages(params: {
  agentId: string;
  entry?: SessionEntry;
  sessionId?: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  if (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0) {
    return [];
  }
  try {
    return await readSessionMessagesAsync(
      {
        agentId: params.agentId,
        sessionEntry: params.entry,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      {
        mode: "full",
        reason: "before_reset hook payload",
      },
    );
  } catch (err) {
    logVerbose(
      `before_reset: failed to read session messages for ${params.sessionId}; firing hook with empty messages (${String(err)})`,
    );
    return [];
  }
}

export async function performGatewaySessionReset(params: {
  key: string;
  agentId?: string;
  spawnedCwd?: string;
  sessionRoot?: string;
  permissionMode?: SessionEntry["permissionMode"];
  /** Prepares session-owned resources while the target lifecycle fence is held. */
  prepareLifecycle?: PrepareGatewaySessionLifecycle;
  onLifecycleCleanupError?: (error: unknown) => void;
  /** Bind session exec to host=node with this node id; caller scope-checks. */
  execNode?: string;
  /** Working directory interpreted only by execNode. */
  execCwd?: string;
  /** Clear a prior node binding when a new Gateway-host session replaces it. */
  clearExecBinding?: boolean;
  // A plain New Chat must return to the agent workspace instead of inheriting the previous
  // turn's session worktree cwd; only worktree-requested resets carry a spawnedCwd forward.
  clearSpawnedCwd?: boolean;
  reason: "new" | "reset";
  commandSource: string;
  /** Trusted provenance for a reset that materializes a previously missing row. */
  creation?: { via: SessionCreatedVia; actor?: SessionCreatedActor };
  /** Exact plugin namespace authorized by the scoped plugin runtime. */
  authorizedPluginId?: string;
  workerPlacementContext?: SessionWorkerPlacementContext;
  assertCurrent?: () => void;
  assertAuthorizedInstance?: () => void;
  onCommitted?: (commit: { key: string; sessionId: string }) => void;
}): Promise<
  | {
      ok: true;
      key: string;
      entry: SessionEntry;
      resolved: { modelProvider: string; model: string };
      agentId: string;
      storePath: string;
    }
  | {
      ok: true;
      key: string;
      agentId: string;
      storePath: string;
      incognitoDeleted: true;
    }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const resetTarget = (() => {
    const cfg = getRuntimeConfig();
    const explicitAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    const parsedKey = parseAgentSessionKey(params.key);
    const inferredGlobalAgentId =
      !explicitAgentId &&
      parsedKey &&
      resolveSessionStoreKey({ cfg, sessionKey: params.key }) === "global"
        ? normalizeAgentId(parsedKey.agentId)
        : undefined;
    const requestedAgentId = explicitAgentId ?? inferredGlobalAgentId;
    if (requestedAgentId && !listAgentIds(cfg).includes(requestedAgentId)) {
      return {
        ok: false as const,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id: ${requestedAgentId}`),
      };
    }
    if (
      explicitAgentId &&
      parsedKey?.agentId &&
      normalizeAgentId(parsedKey.agentId) !== explicitAgentId
    ) {
      return {
        ok: false as const,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      };
    }
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key: params.key,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    });
    return { ok: true as const, cfg, target, storePath: target.storePath, requestedAgentId };
  })();
  if (!resetTarget.ok) {
    return resetTarget;
  }
  const reportLifecycleCleanupError = (error: unknown) => {
    if (params.onLifecycleCleanupError) {
      params.onLifecycleCleanupError(error);
      return;
    }
    logVerbose(`session lifecycle resource cleanup failed: ${String(error)}`);
  };
  const initialResetEntry = loadSessionEntry(
    params.key,
    resetTarget.requestedAgentId ? { agentId: resetTarget.requestedAgentId } : undefined,
  ).entry;
  const initialOwnershipError = resolvePluginSessionOwnershipError({
    action: "reset",
    entry: initialResetEntry,
    key: resetTarget.target.canonicalKey,
    pluginOwnerId: params.authorizedPluginId,
  });
  if (initialOwnershipError) {
    return { ok: false, error: initialOwnershipError };
  }
  const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
    resetTarget.target.canonicalKey,
    initialResetEntry,
  );
  if (missingHarnessSessionError) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError),
    };
  }
  // Reject before interrupting admitted work or firing reset hooks. The model lock is
  // session-id scoped, so rotating first would silently detach native harness ownership.
  if (isModelSelectionLocked(initialResetEntry)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_RESET_MESSAGE),
    };
  }
  const workerPlacementContext =
    params.workerPlacementContext ??
    (await import("./session-worker-placement-context.js")).resolveSessionWorkerPlacementContext();
  const initialPlacementError = resolveSessionWorkerPlacementMutationError({
    action: "reset",
    context: workerPlacementContext,
    key: params.key,
    sessionId: normalizeOptionalString(initialResetEntry?.sessionId),
  });
  if (initialPlacementError) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, initialPlacementError.message),
    };
  }
  const resetLifecycleIdentities = [
    resetTarget.target.canonicalKey,
    params.key,
    initialResetEntry?.sessionId,
  ];
  const activeLifecycleMutation = isSessionLifecycleMutationActive(
    resetTarget.storePath,
    resetLifecycleIdentities,
  );
  const activeCompaction = hasOnlySessionLifecycleMutationKindActive(
    resetTarget.storePath,
    resetLifecycleIdentities,
    "compaction",
  );
  if (activeLifecycleMutation && !activeCompaction) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `Session ${params.key} has another lifecycle mutation in progress; try again.`,
      ),
    };
  }
  let admittedWorkReleased = true;
  let resetPreparationError: ReturnType<typeof errorShape> | undefined;
  let preparedResetSessionId: string | undefined;
  let preparedLifecycle: PreparedGatewaySessionLifecycle | undefined;
  let lifecyclePreparationCommitted = false;
  return await runExclusiveSessionLifecycleMutation({
    scope: resetTarget.storePath,
    identities: resetLifecycleIdentities,
    // Mark the mutation first, then interrupt outside the identity lock. This
    // lets aborted runs finish admission cleanup without deadlocking reset.
    prepare: async () => {
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
      const { entry: currentEntry, canonicalKey: currentCanonicalKey } = loadSessionEntry(
        params.key,
        resetTarget.requestedAgentId ? { agentId: resetTarget.requestedAgentId } : undefined,
      );
      // Check the locked generation before interrupting any work; a replaced
      // foreign row must not be reset or have its admitted run cancelled.
      resetPreparationError = resolvePluginSessionOwnershipError({
        action: "reset",
        entry: currentEntry,
        key: resetTarget.target.canonicalKey,
        pluginOwnerId: params.authorizedPluginId,
      });
      if (resetPreparationError) {
        return;
      }
      const currentMissingHarnessSessionError = resolveMissingAgentHarnessSessionError(
        resetTarget.target.canonicalKey,
        currentEntry,
      );
      if (currentMissingHarnessSessionError) {
        resetPreparationError = errorShape(
          ErrorCodes.INVALID_REQUEST,
          currentMissingHarnessSessionError,
        );
        return;
      }
      const placementError = resolveSessionWorkerPlacementMutationError({
        action: "reset",
        context: workerPlacementContext,
        key: params.key,
        sessionId: normalizeOptionalString(currentEntry?.sessionId),
      });
      if (placementError) {
        resetPreparationError = errorShape(ErrorCodes.INVALID_REQUEST, placementError.message);
        return;
      }
      const archivedSessionError = resolveSessionWorkStartError(currentCanonicalKey, currentEntry);
      if (archivedSessionError) {
        resetPreparationError = errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError);
        return;
      }
      if (isModelSelectionLocked(currentEntry)) {
        resetPreparationError = errorShape(
          ErrorCodes.INVALID_REQUEST,
          MODEL_SELECTION_LOCKED_RESET_MESSAGE,
        );
        return;
      }
      const incognito =
        currentEntry?.incognito === true || isIncognitoSessionKey(resetTarget.target.canonicalKey);
      if (incognito && !currentEntry) {
        resetPreparationError = errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown session: ${params.key}`,
        );
        return;
      }
      preparedResetSessionId = normalizeOptionalString(currentEntry?.sessionId);
      admittedWorkReleased = await interruptSessionWorkAdmissions({
        scope: resetTarget.storePath,
        identities: resetLifecycleIdentities,
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
      if (admittedWorkReleased && params.prepareLifecycle) {
        const prepared = await params.prepareLifecycle({
          agentId: resetTarget.target.agentId,
          entry: currentEntry,
          key: resetTarget.target.canonicalKey,
          storePath: resetTarget.storePath,
        });
        if (!prepared.ok) {
          resetPreparationError = prepared.error;
          return;
        }
        preparedLifecycle = prepared.value;
      }
    },
    run: async () => {
      const { cfg, target, storePath, requestedAgentId } = resetTarget;
      if (resetPreparationError) {
        return { ok: false, error: resetPreparationError };
      }
      if (!admittedWorkReleased) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${params.key} is still active; try again in a moment.`,
          ),
        };
      }
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
      const { entry, legacyKey, canonicalKey } = loadSessionEntry(
        params.key,
        requestedAgentId ? { agentId: requestedAgentId } : undefined,
      );
      if (normalizeOptionalString(entry?.sessionId) !== preparedResetSessionId) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${params.key} changed before reset. Retry.`,
          ),
        };
      }
      const currentOwnershipError = resolvePluginSessionOwnershipError({
        action: "reset",
        entry,
        key: canonicalKey,
        pluginOwnerId: params.authorizedPluginId,
      });
      if (currentOwnershipError) {
        return { ok: false, error: currentOwnershipError };
      }
      const placementError = resolveSessionWorkerPlacementMutationError({
        action: "reset",
        context: workerPlacementContext,
        key: params.key,
        sessionId: normalizeOptionalString(entry?.sessionId),
      });
      if (placementError) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, placementError.message),
        };
      }
      const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
      if (archivedSessionError) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError),
        };
      }
      if (isModelSelectionLocked(entry)) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_RESET_MESSAGE),
        };
      }
      const incognito = entry?.incognito === true || isIncognitoSessionKey(target.canonicalKey);
      if (incognito && !entry) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.key}`),
        };
      }
      // Drain first so a legitimate local turn can release its claim. Retire only
      // after every non-destructive guard is rechecked; a placement race must abort
      // before hooks, runtime cleanup, or session mutation begins.
      const placementRetirementError = retireSessionWorkerPlacementBeforeMutation({
        action: "reset",
        context: workerPlacementContext,
        key: params.key,
        sessionId: normalizeOptionalString(entry?.sessionId),
      });
      if (placementRetirementError) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, placementRetirementError.message),
        };
      }
      const hadExistingEntry = Boolean(entry);
      const detachedWorktreeId = params.clearSpawnedCwd
        ? normalizeOptionalString(entry?.worktree?.id)
        : undefined;
      const resetLifecycleRevision = entry?.lifecycleRevision;
      const agentId = resolveLifecycleAgentId(cfg, target.agentId);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const resetPluginRegistry = getActivePluginRegistry();
      const isResetLifecycleCurrent = () => {
        try {
          params.assertCurrent?.();
          return true;
        } catch {
          return false;
        }
      };
      let deferredAcpResetState: { sessionKey: string; meta: SessionAcpMeta } | undefined;
      const hookEvent = createInternalHookEvent(
        "command",
        params.reason,
        target.canonicalKey ?? params.key,
        {
          agentId,
          sessionEntry: entry,
          previousSessionEntry: entry,
          commandSource: params.commandSource,
          cfg,
          storePath,
          workspaceDir,
        },
      );
      await triggerInternalHook(hookEvent);
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
      // Cleanup below is destructive. Once it starts, finish rotating the same
      // session even if gateway ownership changes; otherwise runtime state can be
      // reset while the persisted session still points at the old conversation.
      const runtimeCleanupError = await ensureSessionRuntimeCleanup({
        cfg,
        key: params.key,
        target,
        sessionId: entry?.sessionId,
      });
      if (runtimeCleanupError) {
        return { ok: false, error: runtimeCleanupError };
      }
      const parentSessionKey = target.canonicalKey ?? canonicalKey ?? params.key;
      const parentAcpError = await closeAcpRuntimeForSession({
        cfg,
        sessionKey: parentSessionKey,
        agentId: target.agentId,
        fallbackSessionKeys: [canonicalKey, legacyKey, params.key],
        reason: "session-reset",
        deferResetState: true,
        onDeferredResetState: (state) => {
          deferredAcpResetState = state;
        },
      });
      if (parentAcpError) {
        return { ok: false, error: parentAcpError };
      }
      const pluginCleanup = await runPluginHostCleanup({
        cfg,
        registry: resetPluginRegistry,
        reason: "reset",
        sessionKey: target.canonicalKey ?? params.key,
        skipPersistentSessionState: true,
      });
      for (const failure of pluginCleanup.failures) {
        logVerbose(
          `plugin host cleanup failed for ${failure.pluginId}/${failure.hookId}: ${String(failure.error)}`,
        );
      }
      await closeChildAcpRuntimesForParent({
        cfg,
        parentKey: target.canonicalKey ?? canonicalKey ?? params.key,
        reason: "session-reset",
      });
      if (entry?.sessionId) {
        await resetRegisteredAgentHarnessSessions({
          agentId,
          sessionId: entry.sessionId,
          sessionKey: target.canonicalKey ?? params.key,
          sessionFile: target.canonicalKey ?? params.key,
          reason: "reset",
        });
      }
      const beforeResetMessages = getGlobalHookRunner()?.hasHooks("before_reset")
        ? await readGatewayBeforeResetPluginHookMessages({
            agentId: resolveLifecycleAgentId(cfg, target.agentId ?? requestedAgentId),
            entry,
            sessionId: entry?.sessionId,
            sessionKey: target.canonicalKey ?? params.key,
            storePath,
          })
        : undefined;

      if (incognito) {
        if (!entry) {
          return {
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.key}`),
          };
        }
        await emitGatewayBeforeResetPluginHook({
          cfg,
          key: params.key,
          messages: beforeResetMessages,
          target,
          storePath,
          entry,
          reason: params.reason,
        });
        const deleted = await deleteSessionEntryLifecycle({
          agentId: target.agentId,
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
          expectedEntry: entry,
          expectedSessionId: entry.sessionId,
          expectedUpdatedAt: entry.updatedAt,
          storePath,
          target: {
            canonicalKey: target.canonicalKey,
            storeKeys: target.storeKeys,
          },
        });
        if (!deleted.deleted) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session ${params.key} changed before reset. Retry.`,
            ),
          };
        }
        handleSessionStateSessionDeleted(target.canonicalKey, agentId);
        notifyGatewaySessionReset(target.canonicalKey, target.agentId);
        emitGatewaySessionEndPluginHook({
          cfg,
          sessionKey: target.canonicalKey,
          sessionId: entry.sessionId,
          storePath,
          sessionFile: target.canonicalKey,
          agentId: target.agentId,
          reason: params.reason,
          archivedTranscripts: [],
        });
        await emitSessionUnboundLifecycleEvent({
          targetSessionKey: target.canonicalKey,
          reason: "session-reset",
        });
        return {
          ok: true,
          key: target.canonicalKey,
          agentId: target.agentId,
          storePath,
          incognitoDeleted: true,
        };
      }

      let createdNewEntry = false;
      params.assertAuthorizedInstance?.();
      const boundaryEntry = loadSessionEntry(
        params.key,
        requestedAgentId ? { agentId: requestedAgentId } : undefined,
      ).entry;
      if (boundaryEntry?.sessionId !== entry?.sessionId) {
        params.assertCurrent?.();
        throw new Error(`Session ${params.key} changed before reset boundary append.`);
      }
      let resetBoundaryAppended = false;
      let resetSkipped = false;
      const lifecyclePromise = resetSessionEntryLifecycle({
        archivePreviousTranscript: false,
        agentId: target.agentId,
        resetBoundaryReason: boundaryEntry ? params.reason : undefined,
        storePath,
        target: {
          canonicalKey: target.canonicalKey,
          storeKeys: [
            ...new Set(
              [...target.storeKeys, canonicalKey, legacyKey, params.key].filter(
                (key): key is string => Boolean(key),
              ),
            ),
          ],
        },
        buildNextEntry: ({ currentEntry, primaryKey }) => {
          params.assertAuthorizedInstance?.();
          createdNewEntry = currentEntry === undefined;
          if (currentEntry?.sessionId !== boundaryEntry?.sessionId) {
            if (currentEntry) {
              resetSkipped = true;
              return currentEntry;
            }
            params.assertCurrent?.();
            throw new Error(`Session ${params.key} changed before reset boundary commit.`);
          }
          if (
            currentEntry &&
            !isResetLifecycleCurrent() &&
            currentEntry.lifecycleRevision !== resetLifecycleRevision
          ) {
            // A newer owner already replaced or removed the session while cleanup
            // targeted the old lifecycle. Preserve that newer state instead of resetting it.
            resetSkipped = true;
            return currentEntry;
          }
          resetBoundaryAppended = currentEntry !== undefined;
          const resetPreservedSelection = resolveResetPreservedSelection({
            entry: currentEntry,
          });
          const now = Date.now();
          const nextSessionId = currentEntry?.sessionId ?? randomUUID();
          const creationStamp = currentEntry
            ? {
                createdVia: currentEntry.createdVia,
                createdActor: currentEntry.createdActor,
                createdAt: currentEntry.createdAt,
                projectId: currentEntry.projectId,
              }
            : params.creation
              ? buildSessionCreationStamp(params.creation)
              : {};
          const nextEntry: SessionEntry = {
            sessionId: nextSessionId,
            lifecycleRevision: randomUUID(),
            updatedAt: now,
            sessionStartedAt: now,
            systemSent: false,
            abortedLastRun: false,
            thinkingLevel: currentEntry?.thinkingLevel,
            fastMode: currentEntry?.fastMode,
            toolOverrides: currentEntry?.toolOverrides,
            verboseLevel: currentEntry?.verboseLevel,
            traceLevel: currentEntry?.traceLevel,
            reasoningLevel: currentEntry?.reasoningLevel,
            elevatedLevel: currentEntry?.elevatedLevel,
            ttsAuto: currentEntry?.ttsAuto,
            execHost: params.execNode
              ? "node"
              : params.clearExecBinding
                ? undefined
                : currentEntry?.execHost,
            execSecurity: currentEntry?.execSecurity,
            execAsk: currentEntry?.execAsk,
            execNode: params.execNode
              ? params.execNode
              : params.clearExecBinding
                ? undefined
                : currentEntry?.execNode,
            execCwd: params.execNode
              ? params.execCwd
              : params.clearExecBinding
                ? undefined
                : currentEntry?.execCwd,
            responseUsage: currentEntry?.responseUsage,
            pinnedAt: currentEntry?.pinnedAt,
            // Resets should keep the user's explicit selection, but clear any
            // temporary fallback model that was pinned during the previous run.
            ...resetPreservedSelection,
            groupActivation: currentEntry?.groupActivation,
            groupActivationNeedsSystemIntro: currentEntry?.groupActivationNeedsSystemIntro,
            chatType: currentEntry?.chatType,
            compactionCount: 0,
            sendPolicy: currentEntry?.sendPolicy,
            queueMode: currentEntry?.queueMode,
            queueDebounceMs: currentEntry?.queueDebounceMs,
            queueCap: currentEntry?.queueCap,
            queueDrop: currentEntry?.queueDrop,
            spawnedBy: currentEntry?.spawnedBy,
            completionOwnerSessionKey: currentEntry?.completionOwnerSessionKey,
            inheritedToolPolicyVersion: currentEntry?.inheritedToolPolicyVersion,
            inheritedToolAllow: currentEntry?.inheritedToolAllow,
            inheritedToolDeny: currentEntry?.inheritedToolDeny,
            spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
            spawnedCwd: params.clearSpawnedCwd
              ? undefined
              : (preparedLifecycle?.spawnedCwd ?? params.spawnedCwd ?? currentEntry?.spawnedCwd),
            sessionRoot: params.clearSpawnedCwd
              ? undefined
              : (preparedLifecycle?.sessionRoot ?? params.sessionRoot ?? currentEntry?.sessionRoot),
            permissionMode: params.clearSpawnedCwd
              ? undefined
              : (params.permissionMode ?? currentEntry?.permissionMode),
            worktree: params.clearSpawnedCwd
              ? undefined
              : (preparedLifecycle?.worktree ?? currentEntry?.worktree),
            parentSessionKey: currentEntry?.parentSessionKey,
            parentSessionId: currentEntry?.parentSessionId,
            ...creationStamp,
            forkSource: currentEntry?.forkSource,
            forkedFromParent: sessionEntryForkedFromParent(currentEntry) ? true : undefined,
            spawnDepth: currentEntry?.spawnDepth,
            subagentRole: currentEntry?.subagentRole,
            subagentControlScope: currentEntry?.subagentControlScope,
            label: currentEntry?.label,
            displayName: currentEntry?.displayName,
            delivery: currentEntry?.delivery,
            pendingDeliveryNotice: currentEntry?.pendingDeliveryNotice,
            groupId: currentEntry?.groupId,
            subject: currentEntry?.subject,
            groupChannel: currentEntry?.groupChannel,
            space: currentEntry?.space,
            pluginOwnerId: currentEntry?.pluginOwnerId ?? params.authorizedPluginId,
            cliSessionBindings: currentEntry?.cliSessionBindings,
            cliSessionIds: currentEntry?.cliSessionIds,
            claudeCliSessionId: currentEntry?.claudeCliSessionId,
            usageFamilyKey: currentEntry?.usageFamilyKey,
            usageFamilySessionIds: currentEntry?.usageFamilySessionIds,
            // Do not carry the cached skills catalog across /new. Long-lived channel
            // sessions (Signal DMs/groups in particular) otherwise keep advertising a
            // stale <available_skills> block even after reset/restart, because the
            // skills snapshot version is runtime-local and may reset to 0.
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          };
          // Drop CLI provider bindings so the next turn after reset starts a fresh
          // CLI conversation on the provider side. Preserved only for spawned
          // subagents (canonical `:subagent:` keys), where Tak Hoffman's fa56682b3ced
          // regression fix intentionally protects CLI continuity for
          // orchestration-driven resets. Non-subagent sessions that happen to set
          // `parentSessionKey` (e.g. dashboard children) are not exempt.
          if (resetBoundaryAppended && !isSubagentSessionKey(primaryKey)) {
            clearAllCliSessions(nextEntry);
          } else {
            nextEntry.cliSessionBindings = rebindCliSessionReseedReceiptsForReset(
              nextEntry.cliSessionBindings,
              nextSessionId,
            );
          }
          return nextEntry;
        },
        afterEntryMutation: async (mutation) => {
          if (resetSkipped) {
            return;
          }
          clearBootstrapSnapshotOnSessionBoundary({
            boundaryAppended: resetBoundaryAppended,
            sessionKey: target.canonicalKey ?? params.key,
          });
          if (createdNewEntry) {
            recordSessionCreated({
              sessionKey: target.canonicalKey ?? params.key,
              agentId,
              entry: mutation.nextEntry,
            });
          }
          let committedAcpResetState: { sessionKey: string; meta: SessionAcpMeta } | undefined;
          if (deferredAcpResetState) {
            const identity = deferredAcpResetState.meta.identity;
            if (
              identity?.state === "resolved" &&
              (identity.acpxSessionId || identity.agentSessionId)
            ) {
              committedAcpResetState = {
                sessionKey: deferredAcpResetState.sessionKey,
                meta: buildPendingAcpMeta(deferredAcpResetState.meta, Date.now()),
              };
              // Session row rotation and ACP metadata cannot share a transaction.
              // Bind captured ACP state before acknowledging the committed reset so the
              // new session never observes an unreadable old-session row.
              writeAcpSessionMetaForMigration({
                sessionKey: committedAcpResetState.sessionKey,
                sessionId: mutation.nextEntry.sessionId,
                lifecycleRevision: mutation.nextEntry.lifecycleRevision,
                meta: committedAcpResetState.meta,
              });
            }
          }
          params.onCommitted?.({
            key: target.canonicalKey,
            sessionId: mutation.nextEntry.sessionId,
          });
          if (committedAcpResetState && isResetLifecycleCurrent()) {
            // The helper records skipped/failed preparation instead of silently
            // resuming the old backend conversation after an apparently
            // successful reset.
            await tryPrepareFreshManagerRuntimeSession({
              deps: { getRuntimeBackend: getAcpRuntimeBackend },
              cfg,
              meta: committedAcpResetState.meta,
              sessionKey: committedAcpResetState.sessionKey,
              logPrefix: "sessions.session-reset",
            });
          }
          await emitGatewayBeforeResetPluginHook({
            cfg,
            key: params.key,
            messages: beforeResetMessages,
            target,
            storePath,
            entry: mutation.previousEntry,
            reason: params.reason,
          });
        },
      });
      const lifecycle: Awaited<ReturnType<typeof resetSessionEntryLifecycle>> =
        await lifecyclePromise;
      lifecyclePreparationCommitted = !resetSkipped;
      if (!resetSkipped) {
        const resetSessionKey = target.canonicalKey ?? params.key;
        handleSessionStateSessionReset(resetSessionKey);
        notifyGatewaySessionReset(resetSessionKey, target.agentId);
      }
      const next = lifecycle.nextEntry;
      const selectedModel = resolveSessionModelRef(cfg, next, target.agentId);
      const resolved = {
        modelProvider: selectedModel.provider,
        model: selectedModel.model,
      };
      // Runtime model identity is a response projection, not reset persistence. Keep the
      // established RPC entry shape while the stored row retains selection intent only.
      const responseEntry: SessionEntry = {
        ...next,
        modelProvider: resolved.modelProvider,
        model: resolved.model,
      };
      const oldSessionId = lifecycle.previousSessionId;
      const oldSessionFile = lifecycle.previousSessionFile;

      const archivedTranscripts = lifecycle.archivedTranscripts;
      if (!resetSkipped) {
        emitGatewaySessionEndPluginHook({
          cfg,
          sessionKey: target.canonicalKey ?? params.key,
          sessionId: oldSessionId,
          storePath,
          sessionFile: oldSessionFile,
          agentId: target.agentId,
          reason: params.reason,
          archivedTranscripts,
          nextSessionId: next.sessionId,
        });
        emitGatewaySessionStartPluginHook({
          cfg,
          sessionKey: target.canonicalKey ?? params.key,
          sessionId: next.sessionId,
          resumedFrom: oldSessionId,
          storePath,
          sessionFile: target.canonicalKey ?? params.key,
          agentId: target.agentId,
        });
      }
      if (hadExistingEntry && !resetSkipped) {
        await emitSessionUnboundLifecycleEvent({
          targetSessionKey: target.canonicalKey ?? params.key,
          reason: "session-reset",
        });
      }
      if (!resetSkipped && detachedWorktreeId) {
        // Preserve reset notifications and unbinding order, but finalize the exact
        // old checkout before the fence opens to same-key successors.
        try {
          await managedWorktrees.removeIfLossless(detachedWorktreeId);
        } catch (error) {
          reportLifecycleCleanupError(error);
        }
      }
      return {
        ok: true,
        key: target.canonicalKey,
        entry: responseEntry,
        resolved,
        agentId: target.agentId,
        storePath,
      };
    },
    finalize: async () => {
      if (!lifecyclePreparationCommitted) {
        await rollbackGatewaySessionPreparation({
          prepared: preparedLifecycle,
          onError: reportLifecycleCleanupError,
        });
      }
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

// Gateway session reset/delete service.
// Rotates transcripts and coordinates lifecycle cleanup across runtimes/hooks.
import { randomUUID } from "node:crypto";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
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
} from "../agents/agent-scope.js";
import {
  clearBootstrapSnapshot,
  clearBootstrapSnapshotOnSessionBoundary,
} from "../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../agents/cli-session.js";
import { resetRegisteredAgentHarnessSessions } from "../agents/harness/registry.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveSessionPlacementResetBlock } from "../agents/session-placement-admission.js";
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
  type SessionEntry,
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "../config/sessions.js";
import { rebindCliSessionReseedReceiptsForReset } from "../config/sessions/cli-session-binding.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import {
  buildSessionCreationStamp,
  type SessionCreatedActor,
  type SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import {
  formatSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesTarget,
} from "../config/sessions/sqlite-marker.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
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
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
  noteActiveSessionForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import { findDirectChildSessionsForParent } from "./session-child-sessions.js";
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

const mcpRunEndWatchers = new Map<string, Promise<void>>();

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
  agentId?: string;
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
  if (!hookRunner?.hasHooks("session_end")) {
    return;
  }
  const transcript = resolveStableSessionEndTranscript({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    archivedTranscripts: params.archivedTranscripts,
  });
  const payload = buildSessionEndHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cfg: params.cfg,
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
  agentId?: string;
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
    cfg: params.cfg,
    resumedFrom: params.resumedFrom,
  });
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await hookRunner.runSessionStart(payload.event, payload.context);
  }).catch((err: unknown) => {
    logVerbose(`session_start hook failed: ${String(err)}`);
  });
}

const SHUTDOWN_DRAIN_DEFAULT_TOTAL_TIMEOUT_MS = 2_000;

type DrainActiveSessionsForShutdownResult = {
  emittedSessionIds: string[];
  timedOut: boolean;
};

/**
 * Emit a typed `session_end` for every session that received `session_start`
 * but did not yet receive a paired `session_end`. The bounded total timeout
 * mirrors the gateway lifecycle hook timeout so a slow plugin cannot block
 * SIGTERM/SIGINT past the runtime's overall shutdown grace window.
 *
 * Sessions that have already been finalized through replace / reset / delete /
 * compaction are forgotten from the tracker by `emitGatewaySessionEndPluginHook`
 * before this drain runs, so they will not be double-fired here.
 */
export async function drainActiveSessionsForShutdown(params: {
  reason: "shutdown" | "restart";
  totalTimeoutMs?: number;
}): Promise<DrainActiveSessionsForShutdownResult> {
  const tracked = listActiveSessionsForShutdown();
  if (tracked.length === 0) {
    return { emittedSessionIds: [], timedOut: false };
  }
  const totalTimeoutMs = Math.max(
    100,
    Math.floor(params.totalTimeoutMs ?? SHUTDOWN_DRAIN_DEFAULT_TOTAL_TIMEOUT_MS),
  );
  const emittedSessionIds: string[] = [];
  const hookRunner = getGlobalHookRunner();
  let settledEmissions = 0;
  // Inline the session_end emission instead of calling
  // `emitGatewaySessionEndPluginHook`, because that helper uses fire-and-forget
  // (`void hookRunner.runSessionEnd(...)`). Start every tracked session's
  // emission before awaiting the bounded aggregate so one slow plugin write
  // cannot prevent later active sessions from receiving `session_end`.
  const drain = Promise.allSettled(
    tracked.map(async (entry) => {
      try {
        forgetActiveSessionForShutdown(entry.sessionId);
        emittedSessionIds.push(entry.sessionId);
        if (!hookRunner?.hasHooks("session_end")) {
          return;
        }
        const transcript = resolveStableSessionEndTranscript({
          sessionId: entry.sessionId,
          storePath: entry.storePath,
          sessionFile: entry.sessionFile,
          agentId: entry.agentId,
        });
        const payload = buildSessionEndHookPayload({
          sessionId: entry.sessionId,
          sessionKey: entry.sessionKey,
          cfg: entry.cfg,
          reason: params.reason,
          sessionFile: transcript.sessionFile,
          transcriptArchived: transcript.transcriptArchived,
        });
        await hookRunner.runSessionEnd(payload.event, payload.context);
      } catch (err) {
        logVerbose(`session_end hook failed during shutdown drain: ${String(err)}`);
      } finally {
        settledEmissions++;
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), totalTimeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([drain.then(() => "ok" as const), timeout]);
    if (result === "timeout") {
      logVerbose(
        `shutdown session-end drain timed out after ${totalTimeoutMs}ms with ${tracked.length - settledEmissions} session_end handler(s) still pending`,
      );
      return { emittedSessionIds, timedOut: true };
    }
    return { emittedSessionIds, timedOut: false };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
  const [embeddedAgent, mcpTools] = await Promise.all([
    import("../agents/embedded-agent.js"),
    import("../agents/agent-bundle-mcp-tools.js"),
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
  clearSessionResetRuntimeState([...queueKeys], {
    activeReplySessionId: params.sessionId,
  });
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    params.assertCurrent?.();
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  const sessionId = params.sessionId;
  params.assertCurrent?.();
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
  const ensureMcpRetirementWatcher = () => {
    if (mcpRunEndWatchers.has(sessionId)) {
      return;
    }
    const watcherRef: { current?: Promise<void> } = {};
    const watcher = (async () => {
      while (await embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, null)) {
        // A replacement can register after the wait promise settles but before
        // this continuation runs. Keep the required retirement armed for it.
        if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
          continue;
        }
        if (mcpRunEndWatchers.get(sessionId) === watcherRef.current) {
          mcpRunEndWatchers.delete(sessionId);
        }
        await retireMcpRuntime(false);
        return;
      }
    })();
    watcherRef.current = watcher;
    mcpRunEndWatchers.set(sessionId, watcher);
    void watcher
      .catch((error: unknown) => {
        logVerbose(`sessions cleanup: failed to disarm deferred MCP retirement: ${String(error)}`);
      })
      .finally(() => {
        if (mcpRunEndWatchers.get(sessionId) === watcher) {
          mcpRunEndWatchers.delete(sessionId);
        }
      });
  };
  // Register against the run being stopped before abort or any await allows a
  // later embedded or reply-backed run to replace it in the active registry.
  ensureMcpRetirementWatcher();
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
  if (ended) {
    params.assertCurrent?.();
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
    acpMeta = readAcpSessionMeta({ sessionKey });
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
    }) ?? params.acpMeta;
  if (
    !latestMeta?.identity ||
    latestMeta.identity.state !== "resolved" ||
    (!latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId)
  ) {
    return undefined;
  }

  const backendId = (latestMeta.backend || params.cfg.acp?.backend || "").trim() || undefined;
  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  try {
    params.assertCurrent?.();
    await getAcpRuntimeBackend(backendId)?.runtime.prepareFreshSession?.({
      sessionKey: params.sessionKey,
    });
    if (params.shouldApply && !params.shouldApply()) {
      return undefined;
    }
    params.assertCurrent?.();
  } catch (error) {
    params.assertCurrent?.();
    logVerbose(
      `sessions.${params.reason}: ACP prepareFreshSession failed for ${params.sessionKey}: ${String(error)}`,
    );
  }

  const now = Date.now();
  let resetMeta: SessionAcpMeta | undefined;
  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  params.assertCurrent?.();
  await upsertAcpSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
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
      agentId: normalizeAgentId(params.target.agentId ?? resolveDefaultAgentId(params.cfg)),
      sessionId: params.entry.sessionId,
      sessionKey: params.target.canonicalKey ?? params.key,
      sessionFile: params.entry.sessionFile,
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
  const sessionFile = params.entry?.sessionFile;
  const agentId = normalizeAgentId(params.target.agentId ?? resolveDefaultAgentId(params.cfg));
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
  /** Managed worktree adopted by this reset; cleared together with spawnedCwd. */
  worktree?: { id: string; branch: string; repoRoot: string };
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
  const initialResetEntry = loadSessionEntry(
    params.key,
    resetTarget.requestedAgentId ? { agentId: resetTarget.requestedAgentId } : undefined,
  ).entry;
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
  const initialPlacementBlock = initialResetEntry?.sessionId
    ? resolveSessionPlacementResetBlock(initialResetEntry.sessionId)
    : undefined;
  if (initialPlacementBlock) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Session ${params.key} cannot reset while ${initialPlacementBlock}.`,
      ),
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
  return await runExclusiveSessionLifecycleMutation({
    scope: resetTarget.storePath,
    identities: resetLifecycleIdentities,
    // Mark the mutation first, then interrupt outside the identity lock. This
    // lets aborted runs finish admission cleanup without deadlocking reset.
    prepare: async () => {
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
      admittedWorkReleased = await interruptSessionWorkAdmissions({
        scope: resetTarget.storePath,
        identities: resetLifecycleIdentities,
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
    },
    run: async () => {
      const { cfg, target, storePath, requestedAgentId } = resetTarget;
      if (!admittedWorkReleased) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${params.key} is still active; try again in a moment.`,
          ),
        };
      }
      const { entry, legacyKey, canonicalKey } = loadSessionEntry(
        params.key,
        requestedAgentId ? { agentId: requestedAgentId } : undefined,
      );
      const placementBlock = entry?.sessionId
        ? resolveSessionPlacementResetBlock(entry.sessionId)
        : undefined;
      if (placementBlock) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Session ${params.key} cannot reset while ${placementBlock}.`,
          ),
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
      const hadExistingEntry = Boolean(entry);
      const resetLifecycleRevision = entry?.lifecycleRevision;
      const agentId = normalizeAgentId(target.agentId ?? resolveDefaultAgentId(cfg));
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
          sessionEntry: entry,
          previousSessionEntry: entry,
          commandSource: params.commandSource,
          cfg,
          workspaceDir,
        },
      );
      params.assertCurrent?.();
      params.assertAuthorizedInstance?.();
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
          sessionFile: entry.sessionFile,
          reason: "reset",
        });
      }
      const beforeResetMessages = getGlobalHookRunner()?.hasHooks("before_reset")
        ? await readGatewayBeforeResetPluginHookMessages({
            agentId: normalizeAgentId(
              target.agentId ?? requestedAgentId ?? resolveDefaultAgentId(cfg),
            ),
            entry,
            sessionId: entry?.sessionId,
            sessionKey: target.canonicalKey ?? params.key,
            storePath,
          })
        : undefined;

      const incognito = entry?.incognito === true || isIncognitoSessionKey(target.canonicalKey);
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
        emitGatewaySessionEndPluginHook({
          cfg,
          sessionKey: target.canonicalKey,
          sessionId: entry.sessionId,
          storePath,
          sessionFile: entry.sessionFile,
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
      const resetSessionFile = boundaryEntry?.sessionId
        ? ((sqliteSessionFileMarkerMatchesTarget(boundaryEntry.sessionFile, {
            agentId,
            sessionId: boundaryEntry.sessionId,
            storePath,
          })
            ? boundaryEntry.sessionFile
            : undefined) ??
          formatSqliteSessionFileMarker({
            agentId,
            sessionId: boundaryEntry.sessionId,
            storePath,
          }))
        : undefined;
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
          const parsed = parseAgentSessionKey(primaryKey);
          const sessionAgentId = normalizeAgentId(
            parsed?.agentId ?? target.agentId ?? requestedAgentId ?? resolveDefaultAgentId(cfg),
          );
          const resetPreservedSelection = resolveResetPreservedSelection({
            entry: currentEntry,
          });
          const now = Date.now();
          const nextSessionId = currentEntry?.sessionId ?? randomUUID();
          const sessionFile =
            (currentEntry ? resetSessionFile : undefined) ??
            formatSqliteSessionFileMarker({
              agentId: sessionAgentId,
              sessionId: nextSessionId,
              storePath,
            });
          const creationStamp = currentEntry
            ? {
                createdVia: currentEntry.createdVia,
                createdActor: currentEntry.createdActor,
                createdAt: currentEntry.createdAt,
              }
            : params.creation
              ? buildSessionCreationStamp(params.creation)
              : {};
          const nextEntry: SessionEntry = {
            sessionId: nextSessionId,
            sessionFile,
            lifecycleRevision: randomUUID(),
            updatedAt: now,
            sessionStartedAt: now,
            systemSent: false,
            abortedLastRun: false,
            thinkingLevel: currentEntry?.thinkingLevel,
            fastMode: currentEntry?.fastMode,
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
            icon: currentEntry?.icon,
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
            spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
            spawnedCwd: params.clearSpawnedCwd
              ? undefined
              : (params.spawnedCwd ?? currentEntry?.spawnedCwd),
            worktree: params.clearSpawnedCwd
              ? undefined
              : (params.worktree ?? currentEntry?.worktree),
            parentSessionKey: currentEntry?.parentSessionKey,
            ...creationStamp,
            forkSource: currentEntry?.forkSource,
            forkedFromParent: sessionEntryForkedFromParent(currentEntry) ? true : undefined,
            spawnDepth: currentEntry?.spawnDepth,
            subagentRole: currentEntry?.subagentRole,
            subagentControlScope: currentEntry?.subagentControlScope,
            label: currentEntry?.label,
            displayName: currentEntry?.displayName,
            delivery: currentEntry?.delivery,
            groupId: currentEntry?.groupId,
            subject: currentEntry?.subject,
            groupChannel: currentEntry?.groupChannel,
            space: currentEntry?.space,
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
            try {
              await getAcpRuntimeBackend(
                (committedAcpResetState.meta.backend || cfg.acp?.backend || "").trim() || undefined,
              )?.runtime.prepareFreshSession?.({
                sessionKey: committedAcpResetState.sessionKey,
              });
            } catch (error) {
              logVerbose(
                `sessions.session-reset: ACP prepareFreshSession failed for ${committedAcpResetState.sessionKey}: ${String(error)}`,
              );
            }
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
      if (!resetSkipped) {
        handleSessionStateSessionReset(target.canonicalKey ?? params.key);
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
          sessionFile: next.sessionFile,
          agentId: target.agentId,
        });
      }
      if (hadExistingEntry && !resetSkipped) {
        await emitSessionUnboundLifecycleEvent({
          targetSessionKey: target.canonicalKey ?? params.key,
          reason: "session-reset",
        });
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
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

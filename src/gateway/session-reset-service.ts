// Gateway session reset/delete service.
// Rotates transcripts and coordinates lifecycle cleanup across runtimes/hooks.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import {
  readAcpSessionMeta,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { retireSessionMcpRuntime } from "../agents/agent-bundle-mcp-tools.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../agents/cli-session.js";
import { abortEmbeddedAgentRun, waitForEmbeddedAgentRunEnd } from "../agents/embedded-agent.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../auto-reply/reply/session-hooks.js";
import { clearSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  snapshotSessionOrigin,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import {
  canonicalizeAbsoluteSessionFilePath,
  rewriteSessionFileForNewSessionId,
} from "../config/sessions/session-file-rotation.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPluginHostCleanup } from "../plugins/host-hook-cleanup.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
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
import {
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionMessagesAsync,
  resolveGatewaySessionStoreTarget,
  resolveSessionStoreKey,
  resolveSessionModelRef,
} from "./session-utils.js";

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

function resolveResetSessionFile(params: {
  nextSessionId: string;
  currentEntry?: SessionEntry;
  storePath: string;
  agentId: string;
}): string {
  const currentEntry = params.currentEntry;
  // Preserve explicit session-file placement across reset while swapping the
  // embedded session id, so linked runtimes keep writing beside old transcripts.
  const rewrittenSessionFile = currentEntry?.sessionId
    ? rewriteSessionFileForNewSessionId({
        sessionFile: currentEntry.sessionFile,
        previousSessionId: currentEntry.sessionId,
        nextSessionId: params.nextSessionId,
      })
    : undefined;
  const normalizedRewrittenSessionFile =
    rewrittenSessionFile && path.isAbsolute(rewrittenSessionFile)
      ? canonicalizeAbsoluteSessionFilePath(rewrittenSessionFile)
      : rewrittenSessionFile;
  const preservedSessionFile = normalizedRewrittenSessionFile ?? currentEntry?.sessionFile;
  return resolveSessionFilePath(
    params.nextSessionId,
    preservedSessionFile ? { sessionFile: preservedSessionFile } : undefined,
    resolveSessionFilePathOptions({
      storePath: params.storePath,
      agentId: params.agentId,
    }),
  );
}

function stripRuntimeModelState(entry?: SessionEntry): SessionEntry | undefined {
  if (!entry) {
    return entry;
  }
  return {
    ...entry,
    // Reset should keep user selection preferences but drop per-run resolved
    // model state so the next turn rehydrates from current config.
    model: undefined,
    modelProvider: undefined,
    contextTokens: undefined,
    contextBudgetStatus: undefined,
    systemPromptReport: undefined,
  };
}

export function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
  onArchiveError?: (err: unknown, sourcePath: string) => void;
}): string[] {
  return archiveSessionTranscriptsForSessionDetailed(params).map((entry) => entry.archivedPath);
}

export function archiveSessionTranscriptsForSessionDetailed(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
  onArchiveError?: (err: unknown, sourcePath: string) => void;
}): ArchivedSessionTranscript[] {
  if (!params.sessionId) {
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
  void hookRunner.runSessionEnd(payload.event, payload.context).catch((err: unknown) => {
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
  void hookRunner.runSessionStart(payload.event, payload.context).catch((err: unknown) => {
    logVerbose(`session_start hook failed: ${String(err)}`);
  });
}

const SHUTDOWN_DRAIN_DEFAULT_TOTAL_TIMEOUT_MS = 2_000;

export type DrainActiveSessionsForShutdownResult = {
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
}) {
  const closeTrackedBrowserTabs = async () => {
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
  };

  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  clearSessionResetRuntimeState([...queueKeys]);
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  abortEmbeddedAgentRun(params.sessionId);
  const ended = await waitForEmbeddedAgentRunEnd(params.sessionId, 15_000);
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (ended) {
    await retireSessionMcpRuntime({
      sessionId: params.sessionId,
      reason: "gateway-session-cleanup",
      onError: (error, sessionId) => {
        logVerbose(
          `sessions cleanup: failed to dispose bundle MCP runtime for ${sessionId}: ${String(error)}`,
        );
      },
    });
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
}) {
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
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        reason: params.reason,
      });
    },
  });
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
    await upsertAcpSessionMeta({
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      mutate: () => null,
    });
  } else {
    const resetMeta = await ensureFreshAcpResetState({
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      reason: params.reason,
      acpMeta,
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
  try {
    await getAcpRuntimeBackend(backendId)?.runtime.prepareFreshSession?.({
      sessionKey: params.sessionKey,
    });
  } catch (error) {
    logVerbose(
      `sessions.${params.reason}: ACP prepareFreshSession failed for ${params.sessionKey}: ${String(error)}`,
    );
  }

  const now = Date.now();
  let resetMeta: SessionAcpMeta | undefined;
  await upsertAcpSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    mutate: (current) => {
      resetMeta = buildPendingAcpMeta(current ?? latestMeta, now);
      return resetMeta;
    },
  });
  return resetMeta;
}

async function closeChildAcpRuntimesForParent(params: {
  cfg: OpenClawConfig;
  parentKey: string;
  reason: "session-reset" | "session-delete";
}): Promise<void> {
  // Enumerate across every agent session store, not just the parent's: ACP
  // spawns create child keys under the target agent (`agent:<targetAgentId>:acp:…`)
  // whose entries live in that agent's store, which is a different file from the
  // parent's under the default per-agent layout. The combined gateway store
  // aggregates all agent stores under canonical keys (same source the dashboard
  // session list uses).
  let children: Array<{ sessionKey: string }>;
  try {
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
  await Promise.allSettled(
    children.map(({ sessionKey }) =>
      closeAcpRuntimeForSession({
        cfg: params.cfg,
        sessionKey,
        reason: params.reason,
      }).then((childError) => {
        if (childError) {
          logVerbose(`sessions.${params.reason}: child ACP cleanup incomplete for ${sessionKey}`);
        }
      }),
    ),
  );
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
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    target: params.target,
    sessionId: params.entry?.sessionId,
  });
  if (cleanupError) {
    return cleanupError;
  }
  const pluginCleanup = await runPluginHostCleanup({
    cfg: params.cfg,
    registry: getActivePluginRegistry(),
    reason: params.reason === "session-reset" ? "reset" : "delete",
    sessionKey: params.target.canonicalKey ?? params.key,
  });
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
  });
  await closeChildAcpRuntimesForParent({
    cfg: params.cfg,
    parentKey: params.target.canonicalKey ?? params.canonicalKey ?? params.key,
    reason: params.reason,
  });
  return parentAcpError;
}

export async function emitGatewayBeforeResetPluginHook(params: {
  cfg: OpenClawConfig;
  key: string;
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
  let messages: unknown[] = [];
  try {
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      messages = await readSessionMessagesAsync(sessionId, params.storePath, sessionFile, {
        mode: "full",
        reason: "before_reset hook payload",
      });
    }
  } catch (err) {
    logVerbose(
      `before_reset: failed to read session messages for ${sessionId ?? "(none)"}; firing hook with empty messages (${String(err)})`,
    );
  }

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

export async function performGatewaySessionReset(params: {
  key: string;
  agentId?: string;
  reason: "new" | "reset";
  commandSource: string;
}): Promise<
  | { ok: true; key: string; entry: SessionEntry; agentId: string }
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
  const { cfg, target, storePath, requestedAgentId } = resetTarget;
  const { entry, legacyKey, canonicalKey } = loadSessionEntry(
    params.key,
    requestedAgentId ? { agentId: requestedAgentId } : undefined,
  );
  const hadExistingEntry = Boolean(entry);
  const agentId = normalizeAgentId(target.agentId ?? resolveDefaultAgentId(cfg));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  let pendingAcpResetMeta: { sessionKey: string; meta: SessionAcpMeta } | undefined;
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
  await triggerInternalHook(hookEvent);
  const mutationCleanupError = await cleanupSessionBeforeMutation({
    cfg,
    key: params.key,
    target,
    entry,
    legacyKey,
    canonicalKey,
    reason: "session-reset",
    onAcpResetMeta: (meta) => {
      pendingAcpResetMeta = meta;
    },
  });
  if (mutationCleanupError) {
    return { ok: false, error: mutationCleanupError };
  }

  let oldSessionId: string | undefined;
  let oldSessionFile: string | undefined;
  let resetSourceEntry: SessionEntry | undefined;
  const next = await updateSessionStore(storePath, (store) => {
    const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: params.key,
      store,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    });
    const currentEntry = store[primaryKey];
    resetSourceEntry = currentEntry ? { ...currentEntry } : undefined;
    const parsed = parseAgentSessionKey(primaryKey);
    const sessionAgentId = normalizeAgentId(
      parsed?.agentId ?? target.agentId ?? requestedAgentId ?? resolveDefaultAgentId(cfg),
    );
    const resetPreservedSelection = resolveResetPreservedSelection({
      entry: currentEntry,
    });
    const resetEntry = {
      ...stripRuntimeModelState(currentEntry),
      providerOverride: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      authProfileOverride: undefined,
      authProfileOverrideSource: undefined,
      authProfileOverrideCompactionCount: undefined,
      ...resetPreservedSelection,
    };
    const resolvedModel = resolveSessionModelRef(cfg, resetEntry, sessionAgentId);
    oldSessionId = currentEntry?.sessionId;
    oldSessionFile = currentEntry?.sessionFile;
    const now = Date.now();
    const nextSessionId = randomUUID();
    const sessionFile = resolveResetSessionFile({
      nextSessionId,
      currentEntry,
      storePath,
      agentId: sessionAgentId,
    });
    const nextEntry: SessionEntry = {
      sessionId: nextSessionId,
      sessionFile,
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: currentEntry?.thinkingLevel,
      fastMode: currentEntry?.fastMode,
      verboseLevel: currentEntry?.verboseLevel,
      traceLevel: currentEntry?.traceLevel,
      reasoningLevel: currentEntry?.reasoningLevel,
      elevatedLevel: currentEntry?.elevatedLevel,
      ttsAuto: currentEntry?.ttsAuto,
      execHost: currentEntry?.execHost,
      execSecurity: currentEntry?.execSecurity,
      execAsk: currentEntry?.execAsk,
      execNode: currentEntry?.execNode,
      responseUsage: currentEntry?.responseUsage,
      // Resets should keep the user's explicit selection, but clear any
      // temporary fallback model that was pinned during the previous run.
      ...resetPreservedSelection,
      groupActivation: currentEntry?.groupActivation,
      groupActivationNeedsSystemIntro: currentEntry?.groupActivationNeedsSystemIntro,
      chatType: currentEntry?.chatType,
      model: resolvedModel.model,
      modelProvider: resolvedModel.provider,
      contextTokens: resetEntry?.contextTokens,
      compactionCount: currentEntry?.compactionCount,
      compactionCheckpoints: currentEntry?.compactionCheckpoints,
      sendPolicy: currentEntry?.sendPolicy,
      queueMode: currentEntry?.queueMode,
      queueDebounceMs: currentEntry?.queueDebounceMs,
      queueCap: currentEntry?.queueCap,
      queueDrop: currentEntry?.queueDrop,
      spawnedBy: currentEntry?.spawnedBy,
      spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
      spawnedCwd: currentEntry?.spawnedCwd,
      parentSessionKey: currentEntry?.parentSessionKey,
      forkedFromParent: currentEntry?.forkedFromParent,
      spawnDepth: currentEntry?.spawnDepth,
      subagentRole: currentEntry?.subagentRole,
      subagentControlScope: currentEntry?.subagentControlScope,
      label: currentEntry?.label,
      displayName: currentEntry?.displayName,
      channel: currentEntry?.channel,
      groupId: currentEntry?.groupId,
      subject: currentEntry?.subject,
      groupChannel: currentEntry?.groupChannel,
      space: currentEntry?.space,
      origin: snapshotSessionOrigin(currentEntry),
      deliveryContext: currentEntry?.deliveryContext,
      cliSessionBindings: currentEntry?.cliSessionBindings,
      cliSessionIds: currentEntry?.cliSessionIds,
      claudeCliSessionId: currentEntry?.claudeCliSessionId,
      lastChannel: currentEntry?.lastChannel,
      lastTo: currentEntry?.lastTo,
      lastAccountId: currentEntry?.lastAccountId,
      lastThreadId: currentEntry?.lastThreadId,
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
    if (!isSubagentSessionKey(primaryKey)) {
      clearAllCliSessions(nextEntry);
    }
    store[primaryKey] = nextEntry;
    return nextEntry;
  });
  if (pendingAcpResetMeta) {
    writeAcpSessionMetaForMigration({
      sessionKey: pendingAcpResetMeta.sessionKey,
      sessionId: next.sessionId,
      meta: pendingAcpResetMeta.meta,
    });
  }
  await emitGatewayBeforeResetPluginHook({
    cfg,
    key: params.key,
    target,
    storePath,
    entry: resetSourceEntry,
    reason: params.reason,
  });

  const archivedTranscripts = archiveSessionTranscriptsForSessionDetailed({
    sessionId: oldSessionId,
    storePath,
    sessionFile: oldSessionFile,
    agentId: target.agentId,
    reason: "reset",
  });
  fs.mkdirSync(path.dirname(next.sessionFile as string), { recursive: true });
  if (!fs.existsSync(next.sessionFile as string)) {
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: next.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(next.sessionFile as string, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
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
  if (hadExistingEntry) {
    await emitSessionUnboundLifecycleEvent({
      targetSessionKey: target.canonicalKey ?? params.key,
      reason: "session-reset",
    });
  }
  return { ok: true, key: target.canonicalKey, entry: next, agentId: target.agentId };
}

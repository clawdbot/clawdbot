/** Main ACP session manager implementation and public control-plane facade. */
import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { toErrorObject } from "../../infra/errors.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import { cancelManagerActiveTurn, runManagerCancelSession } from "./manager.cancel-session.js";
import { runManagerCloseSession } from "./manager.close-session.js";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import { runManagerInitializeSession } from "./manager.initialize-session.js";
import { registerAcpSessionManagerDisposer } from "./manager.lifecycle.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { ensureManagerRuntimeHandle } from "./manager.runtime-handle-ensure.js";
import {
  runResetManagerSessionRuntimeOptions,
  runSetManagerSessionConfigOption,
  runSetManagerSessionRuntimeMode,
  runUpdateManagerSessionRuntimeOptions,
  type RuntimeOptionCommandServices,
} from "./manager.runtime-options-commands.js";
import { runManagerStartupIdentityReconcile } from "./manager.startup-identity-reconcile.js";
import { runManagerGetSessionStatus } from "./manager.status.js";
import { runManagerTurn } from "./manager.turn-runner.js";
import {
  type AcpCloseSessionInput,
  type AcpCloseSessionResult,
  type AcpInitializeSessionInput,
  type AcpManagerObservabilitySnapshot,
  type AcpRunTurnInput,
  type AcpSessionManagerDeps,
  type AcpSessionResolution,
  type AcpSessionRuntimeOptions,
  type AcpSessionStatus,
  type AcpSessionTarget,
  type AcpStartupIdentityReconcileResult,
  type ActiveTurnState,
  DEFAULT_DEPS,
  type SessionAcpMeta,
  type SessionEntry,
  type TurnLatencyStats,
} from "./manager.types.js";
import {
  resolveAcpSessionTarget,
  normalizeAcpErrorCode,
  acpSessionActorKey,
  resolveMissingMetaError,
} from "./manager.utils.js";
import {
  normalizeText,
  validateRuntimeConfigOptionInput,
  validateRuntimeModeInput,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";
import { SessionActorQueue } from "./session-actor-queue.js";

/** Coordinates ACP session metadata, runtime handles, per-session queues, and turn execution. */
export class AcpSessionManager {
  private readonly actorQueue = new SessionActorQueue();
  private readonly runtimeHandles = new ManagerRuntimeHandleCache();
  private readonly activeTurnBySession = new Map<string, ActiveTurnState>();
  private readonly turnLatencyStats: TurnLatencyStats = {
    completed: 0,
    failed: 0,
    totalMs: 0,
    maxMs: 0,
  };
  private readonly errorCountsByCode = new Map<string, number>();
  private readonly deps: AcpSessionManagerDeps;

  constructor(deps: AcpSessionManagerDeps = DEFAULT_DEPS) {
    this.deps = deps;
    registerAcpSessionManagerDisposer(this, async (reason) => {
      await Promise.all(
        [...this.activeTurnBySession.values()].map(async (activeTurn) => {
          try {
            await cancelManagerActiveTurn({ activeTurn, reason });
          } catch (error) {
            logVerbose(
              `acp-manager: active runtime cancel failed for ${activeTurn.handle.sessionKey}: ${String(error)}`,
            );
          }
        }),
      );
      await this.runtimeHandles.closeAll({ actorQueue: this.actorQueue, reason });
      this.activeTurnBySession.clear();
    });
  }

  resolveSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
  }): AcpSessionResolution {
    if (!params.sessionKey.trim()) {
      return { kind: "none", sessionKey: "" };
    }
    const target = resolveAcpSessionTarget(params);
    const { sessionKey } = target;
    const stored = this.deps.loadSessionEntry({
      cfg: params.cfg,
      ...target,
      clone: false,
    });
    const acp = stored?.acp;
    if (acp) {
      return {
        kind: "ready",
        ...target,
        meta: acp,
        entry: stored.entry,
      };
    }
    if (isAcpSessionKey(sessionKey)) {
      return {
        kind: "stale",
        ...target,
        error: resolveMissingMetaError(sessionKey),
      };
    }
    return {
      kind: "none",
      ...target,
    };
  }

  getObservabilitySnapshot(): AcpManagerObservabilitySnapshot {
    const completedTurns = this.turnLatencyStats.completed + this.turnLatencyStats.failed;
    const averageLatencyMs =
      completedTurns > 0 ? Math.round(this.turnLatencyStats.totalMs / completedTurns) : 0;
    return {
      runtimeCache: this.runtimeHandles.getObservabilitySnapshot(),
      turns: {
        active: this.activeTurnBySession.size,
        queueDepth: this.actorQueue.getTotalPendingCount(),
        completed: this.turnLatencyStats.completed,
        failed: this.turnLatencyStats.failed,
        averageLatencyMs,
        maxLatencyMs: this.turnLatencyStats.maxMs,
      },
      errorsByCode: Object.fromEntries(
        [...this.errorCountsByCode.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }

  async reconcilePendingSessionIdentities(params: {
    cfg: OpenClawConfig;
  }): Promise<AcpStartupIdentityReconcileResult> {
    return await runManagerStartupIdentityReconcile({
      cfg: params.cfg,
      deps: this.deps,
      withSessionActor: this.withSessionActor.bind(this),
      resolveSession: this.resolveSession.bind(this),
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      reconcileRuntimeSessionIdentifiers: this.reconcileRuntimeSessionIdentifiers.bind(this),
    });
  }

  async initializeSession(input: AcpInitializeSessionInput): Promise<{
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    sessionEntry: SessionEntry;
    closeRuntimeOnFailure: () => Promise<void>;
  }> {
    const target = resolveAcpSessionTarget(input);
    return await this.withSessionActor(target, async () => {
      const initialized = await runManagerInitializeSession({
        input,
        ...target,
        deps: this.deps,
        runtimeHandles: this.runtimeHandles,
        writeSessionMeta: this.writeSessionMeta.bind(this),
      });
      return {
        ...initialized,
        // Deletion and shutdown may have already released this exact handle.
        closeRuntimeOnFailure: () =>
          this.withSessionActor(target, () =>
            this.runtimeHandles.close({
              ...target,
              reason: "spawn-failed",
              expectedHandle: initialized.handle,
            }),
          ),
      };
    });
  }

  async getSessionStatus(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    signal?: AbortSignal;
  }): Promise<AcpSessionStatus> {
    const target = resolveAcpSessionTarget(params);
    this.throwIfAborted(params.signal);
    return await this.withSessionActor(
      target,
      async () =>
        await runManagerGetSessionStatus({
          cfg: params.cfg,
          ...target,
          signal: params.signal,
          throwIfAborted: this.throwIfAborted.bind(this),
          resolveSession: this.resolveSession.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          reconcileRuntimeSessionIdentifiers: this.reconcileRuntimeSessionIdentifiers.bind(this),
        }),
      params.signal,
    );
  }

  async setSessionRuntimeMode(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    runtimeMode: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    const runtimeMode = validateRuntimeModeInput(params.runtimeMode);

    return await this.withSessionActor(target, async () => {
      return await runSetManagerSessionRuntimeMode({
        cfg: params.cfg,
        ...target,
        runtimeMode,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async setSessionConfigOption(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    key: string;
    value: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    const normalizedOption = validateRuntimeConfigOptionInput(params.key, params.value);
    const key = normalizedOption.key;
    const value = normalizedOption.value;

    return await this.withSessionActor(target, async () => {
      return await runSetManagerSessionConfigOption({
        cfg: params.cfg,
        ...target,
        key,
        value,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async updateSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    patch: Partial<AcpSessionRuntimeOptions>;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    const validatedPatch = validateRuntimeOptionPatch(params.patch);

    return await this.withSessionActor(target, async () => {
      return await runUpdateManagerSessionRuntimeOptions({
        cfg: params.cfg,
        ...target,
        patch: validatedPatch,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async resetSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    return await this.withSessionActor(target, async () => {
      return await runResetManagerSessionRuntimeOptions({
        cfg: params.cfg,
        ...target,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async runTurn(input: AcpRunTurnInput): Promise<void> {
    const target = resolveAcpSessionTarget(input);
    await this.withSessionActor(
      target,
      async () =>
        await runManagerTurn({
          input,
          ...target,
          deps: this.deps,
          runtimeHandles: this.runtimeHandles,
          activeTurnBySession: this.activeTurnBySession,
          resolveSession: this.resolveSession.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          setSessionState: this.setSessionState.bind(this),
          recordTurnCompletion: this.recordTurnCompletion.bind(this),
          reconcileRuntimeSessionIdentifiers: this.reconcileRuntimeSessionIdentifiers.bind(this),
          writeSessionMeta: this.writeSessionMeta.bind(this),
        }),
      input.signal,
    );
  }

  async cancelSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    reason?: string;
    expectedRunId?: string;
    expectedInstanceId?: string;
    expectedOwnerKey?: string;
  }): Promise<void> {
    const target = resolveAcpSessionTarget(params);
    await runManagerCancelSession({
      cfg: params.cfg,
      ...target,
      reason: params.reason,
      expectedRunId: params.expectedRunId,
      expectedInstanceId: params.expectedInstanceId,
      expectedOwnerKey: params.expectedOwnerKey,
      activeTurnBySession: this.activeTurnBySession,
      withSessionActor: this.withSessionActor.bind(this),
      resolveSession: this.resolveSession.bind(this),
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      setSessionState: this.setSessionState.bind(this),
    });
  }

  async closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult> {
    const target = resolveAcpSessionTarget(input);
    return await this.withSessionActor(
      target,
      async () =>
        await runManagerCloseSession({
          input,
          ...target,
          deps: this.deps,
          runtimeHandles: this.runtimeHandles,
          resolveSession: this.resolveSession.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          writeSessionMeta: this.writeSessionMeta.bind(this),
        }),
    );
  }

  private async ensureRuntimeHandle(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    meta: SessionAcpMeta;
    selectedBackend?: string;
  }): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }> {
    return await ensureManagerRuntimeHandle({
      ...params,
      deps: this.deps,
      runtimeHandles: this.runtimeHandles,
      writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
    });
  }

  private runtimeOptionCommandServices(): RuntimeOptionCommandServices {
    return {
      runtimeHandles: this.runtimeHandles,
      resolveSession: this.resolveSession.bind(this),
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      writeSessionMeta: this.writeSessionMeta.bind(this),
    };
  }

  private recordTurnCompletion(params: { startedAt: number; errorCode?: AcpRuntimeError["code"] }) {
    const durationMs = Math.max(0, Date.now() - params.startedAt);
    this.turnLatencyStats.totalMs += durationMs;
    this.turnLatencyStats.maxMs = Math.max(this.turnLatencyStats.maxMs, durationMs);
    if (params.errorCode) {
      this.turnLatencyStats.failed += 1;
      this.recordErrorCode(params.errorCode);
      return;
    }
    this.turnLatencyStats.completed += 1;
  }

  private recordErrorCode(code: string): void {
    const normalized = normalizeAcpErrorCode(code);
    this.errorCountsByCode.set(normalized, (this.errorCountsByCode.get(normalized) ?? 0) + 1);
  }

  private async setSessionState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    state: SessionAcpMeta["state"];
    lastError?: string;
    clearLastError?: boolean;
  }): Promise<void> {
    await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      skipMaintenance: true,
      takeCacheOwnership: true,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current;
        if (!base) {
          return null;
        }
        const next: SessionAcpMeta = {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          ...(base.identity ? { identity: base.identity } : {}),
          mode: base.mode,
          ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
          ...(base.cwd ? { cwd: base.cwd } : {}),
          state: params.state,
          lastActivityAt: Date.now(),
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
        const lastError = normalizeText(params.lastError);
        if (lastError) {
          next.lastError = lastError;
        } else if (params.clearLastError) {
          delete next.lastError;
        }
        return next;
      },
    });
  }

  private async reconcileRuntimeSessionIdentifiers(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
    failOnStatusError: boolean;
  }): Promise<{
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
  }> {
    return await reconcileManagerRuntimeSessionIdentifiers({
      ...params,
      setCachedHandle: (target, handle) => {
        const cached = this.runtimeHandles.get(target);
        if (cached) {
          cached.handle = handle;
        }
      },
      writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
    });
  }

  private async writeSessionMeta(params: {
    assertCommitAllowed?: () => void;
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    mutate: (
      current: SessionAcpMeta | undefined,
      entry: SessionEntry | undefined,
    ) => SessionAcpMeta | null | undefined;
    failOnError?: boolean;
    skipMaintenance?: boolean;
    takeCacheOwnership?: boolean;
  }): Promise<SessionEntry | null> {
    try {
      return await this.deps.upsertSessionMeta({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        mutate: params.mutate,
        assertCommitAllowed: params.assertCommitAllowed,
        ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
        ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
      });
    } catch (error) {
      if (params.failOnError || error instanceof AgentSelectionRequiredError) {
        throw error;
      }
      logVerbose(
        `acp-manager: failed persisting ACP metadata for ${params.sessionKey}: ${String(error)}`,
      );
      return null;
    }
  }

  private async withSessionActor<T>(
    target: AcpSessionTarget,
    op: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const actorKey = acpSessionActorKey(target);
    this.throwIfAborted(signal);

    let actorStarted = false;
    const queued = this.actorQueue.run(actorKey, async () => {
      actorStarted = true;
      this.throwIfAborted(signal);
      return await op();
    });
    if (!signal) {
      return await queued;
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };
      const settleValue = (value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleError = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(toErrorObject(error, "Non-Error rejection"));
      };
      const onAbort = () => {
        if (actorStarted) {
          return;
        }
        try {
          this.throwIfAborted(signal);
        } catch (error) {
          settleError(error);
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      queued.then(settleValue, settleError);
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }
    throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP operation aborted.");
  }
}

/** Main ACP session manager implementation and public control-plane facade. */
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import { runManagerCancelSession } from "./manager.cancel-session.js";
import { runManagerCloseSession } from "./manager.close-session.js";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import { runManagerInitializeSession } from "./manager.initialize-session.js";
import {
  applyManagerRuntimeControls,
  resolveManagerRuntimeCapabilities,
} from "./manager.runtime-controls.js";
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
  type AcpStartupIdentityReconcileResult,
  type ActiveTurnState,
  DEFAULT_DEPS,
  type SessionAcpMeta,
  type SessionEntry,
  type TurnLatencyStats,
} from "./manager.types.js";
import {
  canonicalizeAcpSessionKey,
  normalizeAcpErrorCode,
  normalizeActorKey,
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
  }

  resolveSession(params: { cfg: OpenClawConfig; sessionKey: string }): AcpSessionResolution {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      return {
        kind: "none",
        sessionKey,
      };
    }
    const acp = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey,
      clone: false,
    })?.acp;
    if (acp) {
      return {
        kind: "ready",
        sessionKey,
        meta: acp,
      };
    }
    if (isAcpSessionKey(sessionKey)) {
      return {
        kind: "stale",
        sessionKey,
        error: resolveMissingMetaError(sessionKey),
      };
    }
    return {
      kind: "none",
      sessionKey,
    };
  }

  getObservabilitySnapshot(cfg: OpenClawConfig): AcpManagerObservabilitySnapshot {
    const completedTurns = this.turnLatencyStats.completed + this.turnLatencyStats.failed;
    const averageLatencyMs =
      completedTurns > 0 ? Math.round(this.turnLatencyStats.totalMs / completedTurns) : 0;
    return {
      runtimeCache: this.runtimeHandles.getObservabilitySnapshot(cfg),
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
  }> {
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(input.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      return await runManagerInitializeSession({
        input,
        sessionKey,
        deps: this.deps,
        runtimeHandles: this.runtimeHandles,
        enforceConcurrentSessionLimit: this.enforceConcurrentSessionLimit.bind(this),
        writeSessionMeta: this.writeSessionMeta.bind(this),
      });
    });
  }

  async getSessionStatus(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    signal?: AbortSignal;
  }): Promise<AcpSessionStatus> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    this.throwIfAborted(params.signal);
    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(
      sessionKey,
      async () =>
        await runManagerGetSessionStatus({
          cfg: params.cfg,
          sessionKey,
          signal: params.signal,
          throwIfAborted: this.throwIfAborted.bind(this),
          resolveSession: this.resolveSession.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          resolveRuntimeCapabilities: this.resolveRuntimeCapabilities.bind(this),
          reconcileRuntimeSessionIdentifiers: this.reconcileRuntimeSessionIdentifiers.bind(this),
        }),
      params.signal,
    );
  }

  async setSessionRuntimeMode(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtimeMode: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const runtimeMode = validateRuntimeModeInput(params.runtimeMode);

    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      return await runSetManagerSessionRuntimeMode({
        cfg: params.cfg,
        sessionKey,
        runtimeMode,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async setSessionConfigOption(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    key: string;
    value: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const normalizedOption = validateRuntimeConfigOptionInput(params.key, params.value);
    const key = normalizedOption.key;
    const value = normalizedOption.value;

    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      return await runSetManagerSessionConfigOption({
        cfg: params.cfg,
        sessionKey,
        key,
        value,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async updateSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    patch: Partial<AcpSessionRuntimeOptions>;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    const validatedPatch = validateRuntimeOptionPatch(params.patch);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }

    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      return await runUpdateManagerSessionRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        patch: validatedPatch,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async resetSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      return await runResetManagerSessionRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        ...this.runtimeOptionCommandServices(),
      });
    });
  }

  async runTurn(input: AcpRunTurnInput): Promise<void> {
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(input.cfg);
    await this.withSessionActor(
      sessionKey,
      async () =>
        await runManagerTurn({
          input,
          sessionKey,
          deps: this.deps,
          runtimeHandles: this.runtimeHandles,
          activeTurnBySession: this.activeTurnBySession,
          resolveSession: this.resolveSession.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          applyRuntimeControls: this.applyRuntimeControls.bind(this),
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
    reason?: string;
  }): Promise<void> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(params.cfg);
    await runManagerCancelSession({
      cfg: params.cfg,
      sessionKey,
      reason: params.reason,
      activeTurnBySession: this.activeTurnBySession,
      withSessionActor: this.withSessionActor.bind(this),
      resolveSession: this.resolveSession.bind(this),
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      setSessionState: this.setSessionState.bind(this),
    });
  }

  async closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult> {
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(input.cfg);
    return await this.withSessionActor(
      sessionKey,
      async () =>
        await runManagerCloseSession({
          input,
          sessionKey,
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
    meta: SessionAcpMeta;
  }): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }> {
    return await ensureManagerRuntimeHandle({
      ...params,
      deps: this.deps,
      runtimeHandles: this.runtimeHandles,
      enforceConcurrentSessionLimit: (limitParams) =>
        this.enforceConcurrentSessionLimit(limitParams),
      writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
    });
  }

  private runtimeOptionCommandServices(): RuntimeOptionCommandServices {
    return {
      runtimeHandles: this.runtimeHandles,
      resolveSession: this.resolveSession.bind(this),
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      resolveRuntimeCapabilities: this.resolveRuntimeCapabilities.bind(this),
      writeSessionMeta: this.writeSessionMeta.bind(this),
    };
  }

  private enforceConcurrentSessionLimit(params: { cfg: OpenClawConfig; sessionKey: string }): void {
    const configuredLimit = params.cfg.acp?.maxConcurrentSessions;
    if (typeof configuredLimit !== "number" || !Number.isFinite(configuredLimit)) {
      return;
    }
    const limit = Math.max(1, Math.floor(configuredLimit));
    if (this.runtimeHandles.has(params.sessionKey)) {
      return;
    }
    const activeCount = this.runtimeHandles.size();
    if (activeCount >= limit) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP max concurrent sessions reached (${activeCount}/${limit}).`,
      );
    }
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

  private async resolveRuntimeCapabilities(params: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    includeStatusConfigOptionKeys?: boolean;
  }): Promise<AcpRuntimeCapabilities> {
    return await resolveManagerRuntimeCapabilities(params);
  }

  private async evictIdleRuntimeHandles(cfg: OpenClawConfig): Promise<void> {
    await this.runtimeHandles.evictIdle({
      cfg,
      actorQueue: this.actorQueue,
      activeTurnBySession: this.activeTurnBySession,
    });
  }

  private async applyRuntimeControls(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }): Promise<void> {
    await applyManagerRuntimeControls({
      ...params,
      getCachedRuntimeState: (sessionKey) => this.runtimeHandles.get(sessionKey),
    });
  }

  private async setSessionState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    state: SessionAcpMeta["state"];
    lastError?: string;
    clearLastError?: boolean;
  }): Promise<void> {
    await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
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
      setCachedHandle: (sessionKey, handle) => {
        const cached = this.runtimeHandles.get(sessionKey);
        if (cached) {
          cached.handle = handle;
        }
      },
      writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
    });
  }

  private async writeSessionMeta(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
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
        mutate: params.mutate,
        ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
        ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
      });
    } catch (error) {
      if (params.failOnError) {
        throw error;
      }
      logVerbose(
        `acp-manager: failed persisting ACP metadata for ${params.sessionKey}: ${String(error)}`,
      );
      return null;
    }
  }

  private async withSessionActor<T>(
    sessionKey: string,
    op: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const actorKey = normalizeActorKey(sessionKey);
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
        reject(toLintErrorObject(error, "Non-Error rejection"));
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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

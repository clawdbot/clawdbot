import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  createRunningTaskRun,
  completeTaskRunByRunId,
  failTaskRunByRunId,
  startTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import {
  createIdentityFromEnsure,
  identityHasStableSessionId,
  identityEquals,
  isSessionIdentityPending,
  mergeSessionIdentity,
  resolveRuntimeResumeSessionId,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "../runtime/session-identity.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
} from "../runtime/types.js";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import {
  applyManagerRuntimeControls,
  resolveManagerRuntimeCapabilities,
} from "./manager.runtime-controls.js";
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
  createUnsupportedControlError,
  hasLegacyAcpIdentityProjection,
  normalizeAcpErrorCode,
  normalizeActorKey,
  requireReadySessionMeta,
  resolveAcpAgentFromSessionKey,
  resolveAcpSessionResolutionError,
  resolveMissingMetaError,
  resolveRuntimeIdleTtlMs,
} from "./manager.utils.js";
import { CachedRuntimeState, RuntimeCache } from "./runtime-cache.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
  validateRuntimeConfigOptionInput,
  validateRuntimeModeInput,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";
import { SessionActorQueue } from "./session-actor-queue.js";

const ACP_TURN_TIMEOUT_GRACE_MS = 1_000;
const ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS = 2_000;
const ACP_TURN_TIMEOUT_REASON = "turn-timeout";
const ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH = 160;
const ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH = 240;

function summarizeBackgroundTaskText(text: string): string {
  const normalized = normalizeText(text) ?? "ACP background task";
  if (normalized.length <= ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH - 1)}…`;
}

function appendBackgroundTaskProgressSummary(current: string, chunk: string): string {
  const normalizedChunk = normalizeText(chunk)?.replace(/\s+/g, " ");
  if (!normalizedChunk) {
    return current;
  }
  const combined = current ? `${current} ${normalizedChunk}` : normalizedChunk;
  if (combined.length <= ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH) {
    return combined;
  }
  return `${combined.slice(0, ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH - 1)}…`;
}

function resolveBackgroundTaskFailureStatus(error: AcpRuntimeError): "failed" | "timed_out" {
  return /\btimed out\b/i.test(error.message) ? "timed_out" : "failed";
}

function resolveBackgroundTaskTerminalResult(progressSummary: string): {
  terminalOutcome?: "blocked";
  terminalSummary?: string;
} {
  const normalized = normalizeText(progressSummary)?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return {};
  }
  const permissionDeniedMatch = normalized.match(
    /\b(?:write failed:\s*)?permission denied(?: for (?<path>\S+))?\.?/i,
  );
  if (permissionDeniedMatch) {
    const path = normalizeText(permissionDeniedMatch.groups?.path)?.replace(/[.,;:!?]+$/, "");
    return {
      terminalOutcome: "blocked",
      terminalSummary: path ? `Permission denied for ${path}.` : "Permission denied.",
    };
  }
  if (
    /\bneed a writable session\b/i.test(normalized) ||
    /\bfilesystem authorization\b/i.test(normalized) ||
    /`?apply_patch`?/i.test(normalized)
  ) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Writable session or apply_patch authorization required.",
    };
  }
  return {};
}

type BackgroundTaskContext = {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  runId: string;
  label?: string;
  task: string;
};

export class AcpSessionManager {
  private readonly actorQueue = new SessionActorQueue();
  private readonly actorTailBySession = this.actorQueue.getTailMapForTesting();
  private readonly runtimeCache = new RuntimeCache();
  private readonly activeTurnBySession = new Map<string, ActiveTurnState>();
  private readonly turnLatencyStats: TurnLatencyStats = {
    completed: 0,
    failed: 0,
    totalMs: 0,
    maxMs: 0,
  };
  private readonly errorCountsByCode = new Map<string, number>();
  private evictedRuntimeCount = 0;
  private lastEvictedAt: number | undefined;

  constructor(private readonly deps: AcpSessionManagerDeps = DEFAULT_DEPS) {}

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
      runtimeCache: {
        activeSessions: this.runtimeCache.size(),
        idleTtlMs: resolveRuntimeIdleTtlMs(cfg),
        evictedTotal: this.evictedRuntimeCount,
        ...(this.lastEvictedAt ? { lastEvictedAt: this.lastEvictedAt } : {}),
      },
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
    let checked = 0;
    let resolved = 0;
    let failed = 0;

    let acpSessions: Awaited<ReturnType<AcpSessionManagerDeps["listAcpSessions"]>>;
    try {
      acpSessions = await this.deps.listAcpSessions({
        cfg: params.cfg,
      });
    } catch (error) {
      logVerbose(`acp-manager: startup identity scan failed: ${String(error)}`);
      return { checked, resolved, failed: failed + 1 };
    }

    for (const session of acpSessions) {
      if (!session.acp || !session.sessionKey) {
        continue;
      }
      const currentIdentity = resolveSessionIdentityFromMeta(session.acp);
      if (
        !isSessionIdentityPending(currentIdentity) ||
        !identityHasStableSessionId(currentIdentity)
      ) {
        continue;
      }

      checked += 1;
      try {
        const becameResolved = await this.withSessionActor(session.sessionKey, async () => {
          const resolution = this.resolveSession({
            cfg: params.cfg,
            sessionKey: session.sessionKey,
          });
          if (resolution.kind !== "ready") {
            return false;
          }
          const { runtime, handle, meta } = await this.ensureRuntimeHandle({
            cfg: params.cfg,
            sessionKey: session.sessionKey,
            meta: resolution.meta,
          });
          const reconciled = await this.reconcileRuntimeSessionIdentifiers({
            cfg: params.cfg,
            sessionKey: session.sessionKey,
            runtime,
            handle,
            meta,
            failOnStatusError: false,
          });
          return !isSessionIdentityPending(resolveSessionIdentityFromMeta(reconciled.meta));
        });
        if (becameResolved) {
          resolved += 1;
        }
      } catch (error) {
        failed += 1;
        logVerbose(
          `acp-manager: startup identity reconcile failed for ${session.sessionKey}: ${String(error)}`,
        );
      }
    }

    return { checked, resolved, failed };
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
    const agent = normalizeAgentId(input.agent);
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const backend = this.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
      const runtime = backend.runtime;
      const initialRuntimeOptions = validateRuntimeOptionPatch({
        ...input.runtimeOptions,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      });
      const requestedCwd = initialRuntimeOptions.cwd;
      const requestedModel = initialRuntimeOptions.model;
      const requestedThinking = initialRuntimeOptions.thinking;
      this.enforceConcurrentSessionLimit({
        cfg: input.cfg,
        sessionKey,
      });
      const handle = await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.ensureSession({
            sessionKey,
            agent,
            mode: input.mode,
            resumeSessionId: input.resumeSessionId,
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(requestedThinking ? { thinking: requestedThinking } : {}),
            cwd: requestedCwd,
          }),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      });
      const effectiveCwd = normalizeText(handle.cwd) ?? requestedCwd;
      const effectiveRuntimeOptions = normalizeRuntimeOptions({
        ...initialRuntimeOptions,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      });

      const identityNow = Date.now();
      const initializedIdentity =
        mergeSessionIdentity({
          current: undefined,
          incoming: createIdentityFromEnsure({
            handle,
            now: identityNow,
          }),
          now: identityNow,
        }) ??
        ({
          state: "pending",
          source: "ensure",
          lastUpdatedAt: identityNow,
        } as const);
      const meta: SessionAcpMeta = {
        backend: handle.backend || backend.id,
        agent,
        runtimeSessionName: handle.runtimeSessionName,
        identity: initializedIdentity,
        mode: input.mode,
        ...(Object.keys(effectiveRuntimeOptions).length > 0
          ? { runtimeOptions: effectiveRuntimeOptions }
          : {}),
        cwd: effectiveCwd,
        state: "idle",
        lastActivityAt: Date.now(),
      };

      let persisted: SessionEntry | null = null;
      try {
        persisted = await this.writeSessionMeta({
          cfg: input.cfg,
          sessionKey,
          mutate: () => meta,
          failOnError: true,
        });
      } catch (error) {
        await runtime
          .close({
            handle,
            reason: "init-meta-failed",
          })
          .catch((closeError) => {
            logVerbose(
              `acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`,
            );
          });
        throw error;
      }

      if (!persisted?.acp) {
        await runtime
          .close({
            handle,
            reason: "init-meta-failed",
          })
          .catch((closeError) => {
            logVerbose(
              `acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`,
            );
          });

        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Could not persist ACP metadata for ${sessionKey}.`,
        );
      }
      this.setCachedRuntimeState(sessionKey, {
        runtime,
        handle,
        backend: handle.backend || backend.id,
        agent,
        mode: input.mode,
        cwd: effectiveCwd,
      });
      return {
        runtime,
        handle,
        meta,
      };
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
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(
      sessionKey,
      async () => {
        this.throwIfAborted(params.signal);
        const resolution = this.resolveSession({
          cfg: params.cfg,
          sessionKey,
        });
        const resolvedMeta = requireReadySessionMeta(resolution);
        const {
          runtime,
          handle: ensuredHandle,
          meta: ensuredMeta,
        } = await this.ensureRuntimeHandle({
          cfg: params.cfg,
          sessionKey,
          meta: resolvedMeta,
        });
        let handle = ensuredHandle;
        let meta = ensuredMeta;
        const capabilities = await this.resolveRuntimeCapabilities({ runtime, handle });
        let runtimeStatus: AcpRuntimeStatus | undefined;
        if (runtime.getStatus) {
          runtimeStatus = await withAcpRuntimeErrorBoundary({
            run: async () => {
              this.throwIfAborted(params.signal);
              const status = await runtime.getStatus!({
                handle,
                ...(params.signal ? { signal: params.signal } : {}),
              });
              this.throwIfAborted(params.signal);
              return status;
            },
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "Could not read ACP runtime status.",
          });
        }
        ({ handle, meta, runtimeStatus } = await this.reconcileRuntimeSessionIdentifiers({
          cfg: params.cfg,
          sessionKey,
          runtime,
          handle,
          meta,
          runtimeStatus,
          failOnStatusError: true,
        }));
        const identity = resolveSessionIdentityFromMeta(meta);
        return {
          sessionKey,
          backend: handle.backend || meta.backend,
          agent: meta.agent,
          ...(identity ? { identity } : {}),
          state: meta.state,
          mode: meta.mode,
          runtimeOptions: resolveRuntimeOptionsFromMeta(meta),
          capabilities,
          runtimeStatus,
          lastActivityAt: meta.lastActivityAt,
          lastError: meta.lastError,
        };
      },
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

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
      });
      const capabilities = await this.resolveRuntimeCapabilities({ runtime, handle });
      if (!capabilities.controls.includes("session/set_mode") || !runtime.setMode) {
        throw createUnsupportedControlError({
          backend: handle.backend || meta.backend,
          control: "session/set_mode",
        });
      }

      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.setMode!({
            handle,
            mode: runtimeMode,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime mode.",
      });

      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(meta),
        patch: { runtimeMode },
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: nextOptions,
      });
      return nextOptions;
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

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
      });
      const inferredPatch = inferRuntimeOptionPatchFromConfigOption(key, value);
      const capabilities = await this.resolveRuntimeCapabilities({ runtime, handle });
      if (
        !capabilities.controls.includes("session/set_config_option") ||
        !runtime.setConfigOption
      ) {
        throw createUnsupportedControlError({
          backend: handle.backend || meta.backend,
          control: "session/set_config_option",
        });
      }

      const advertisedKeys = new Set(
        (capabilities.configOptionKeys ?? [])
          .map((entry) => normalizeText(entry))
          .filter(Boolean) as string[],
      );
      if (advertisedKeys.size > 0 && !advertisedKeys.has(key)) {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNSUPPORTED_CONTROL",
          `ACP backend "${handle.backend || meta.backend}" does not accept config key "${key}".`,
        );
      }

      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.setConfigOption!({
            handle,
            key,
            value,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime config option.",
      });

      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(meta),
        patch: inferredPatch,
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: nextOptions,
      });
      return nextOptions;
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

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(resolvedMeta),
        patch: validatedPatch,
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: nextOptions,
      });
      return nextOptions;
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
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
      });
      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.close({
            handle,
            reason: "reset-runtime-options",
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not reset ACP runtime options.",
      });
      this.clearCachedRuntimeState(sessionKey);
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: {},
      });
      return {};
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
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    await this.withSessionActor(
      sessionKey,
      async () => {
        const turnStartedAt = Date.now();
        const actorKey = normalizeActorKey(sessionKey);
        const taskContext =
          input.mode === "prompt"
            ? this.resolveBackgroundTaskContext({
                cfg: input.cfg,
                sessionKey,
                requestId: input.requestId,
                text: input.text,
              })
            : null;
        if (taskContext) {
          this.createBackgroundTaskRecord(taskContext, turnStartedAt);
        }
        let taskProgressSummary = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const resolution = this.resolveSession({
            cfg: input.cfg,
            sessionKey,
          });
          const resolvedMeta = requireReadySessionMeta(resolution);
          let runtime: AcpRuntime | undefined;
          let handle: AcpRuntimeHandle | undefined;
          let meta: SessionAcpMeta | undefined;
          let activeTurn: ActiveTurnState | undefined;
          let internalAbortController: AbortController | undefined;
          let onCallerAbort: (() => void) | undefined;
          let activeTurnStarted = false;
          let sawTurnOutput = false;
          let retryFreshHandle = false;
          let skipPostTurnCleanup = false;
          try {
            const ensured = await this.ensureRuntimeHandle({
              cfg: input.cfg,
              sessionKey,
              meta: resolvedMeta,
            });
            runtime = ensured.runtime;
            handle = ensured.handle;
            meta = ensured.meta;
            await this.applyRuntimeControls({
              sessionKey,
              runtime,
              handle,
              meta,
            });

            await this.setSessionState({
              cfg: input.cfg,
              sessionKey,
              state: "running",
              clearLastError: true,
            });

            internalAbortController = new AbortController();
            onCallerAbort = () => {
              internalAbortController?.abort();
            };
            if (input.signal?.aborted) {
              internalAbortController.abort();
            } else if (input.signal) {
              input.signal.addEventListener("abort", onCallerAbort, { once: true });
            }

            activeTurn = {
              runtime,
              handle,
              abortController: internalAbortController,
            };
            this.activeTurnBySession.set(actorKey, activeTurn);
            activeTurnStarted = true;

            let streamError: AcpRuntimeError | null = null;
            const combinedSignal =
              input.signal && typeof AbortSignal.any === "function"
                ? AbortSignal.any([input.signal, internalAbortController.signal])
                : internalAbortController.signal;
            const eventGate = { open: true };
            const turnPromise = (async () => {
              for await (const event of runtime.runTurn({
                handle,
                text: input.text,
                attachments: input.attachments,
                mode: input.mode,
                requestId: input.requestId,
                signal: combinedSignal,
              })) {
                if (!eventGate.open) {
                  continue;
                }
                if (event.type === "error") {
                  streamError = new AcpRuntimeError(
                    normalizeAcpErrorCode(event.code),
                    normalizeText(event.message) || "ACP turn failed before completion.",
                  );
                } else if (event.type === "text_delta" || event.type === "tool_call") {
                  sawTurnOutput = true;
                  if (event.type === "text_delta" && event.stream !== "thought" && event.text) {
                    taskProgressSummary = appendBackgroundTaskProgressSummary(
                      taskProgressSummary,
                      event.text,
                    );
                  }
                  if (taskContext) {
                    this.markBackgroundTaskRunning(taskContext.runId, {
                      sessionKey,
                      lastEventAt: Date.now(),
                      progressSummary: taskProgressSummary || null,
                    });
                  }
                }
                if (input.onEvent) {
                  await input.onEvent(event);
                }
              }
              if (eventGate.open && streamError) {
                throw streamError;
              }
            })();
            const turnTimeoutMs = this.resolveTurnTimeoutMs({
              cfg: input.cfg,
              meta,
            });
            const sessionMode = meta.mode;
            await this.awaitTurnWithTimeout({
              sessionKey,
              turnPromise,
              timeoutMs: turnTimeoutMs + ACP_TURN_TIMEOUT_GRACE_MS,
              timeoutLabelMs: turnTimeoutMs,
              onTimeout: async () => {
                eventGate.open = false;
                skipPostTurnCleanup = true;
                if (!activeTurn) {
                  return;
                }
                await this.cleanupTimedOutTurn({
                  sessionKey,
                  activeTurn,
                  mode: sessionMode,
                });
              },
            });
            if (streamError) {
              throw streamError;
            }
            this.recordTurnCompletion({
              startedAt: turnStartedAt,
            });
            if (taskContext) {
              const terminalResult = resolveBackgroundTaskTerminalResult(taskProgressSummary);
              this.markBackgroundTaskTerminal(taskContext.runId, {
                sessionKey,
                status: "succeeded",
                endedAt: Date.now(),
                lastEventAt: Date.now(),
                error: undefined,
                progressSummary: taskProgressSummary || null,
                terminalSummary: terminalResult.terminalSummary ?? null,
                terminalOutcome: terminalResult.terminalOutcome,
              });
            }
            await this.setSessionState({
              cfg: input.cfg,
              sessionKey,
              state: "idle",
              clearLastError: true,
            });
            return;
          } catch (error) {
            const acpError = toAcpRuntimeError({
              error,
              fallbackCode: activeTurnStarted ? "ACP_TURN_FAILED" : "ACP_SESSION_INIT_FAILED",
              fallbackMessage: activeTurnStarted
                ? "ACP turn failed before completion."
                : "Could not initialize ACP session runtime.",
            });
            retryFreshHandle = await this.prepareFreshHandleRetry({
              attempt,
              cfg: input.cfg,
              sessionKey,
              error: acpError,
              sawTurnOutput,
              runtime,
              meta,
            });
            if (retryFreshHandle) {
              continue;
            }
            this.recordTurnCompletion({
              startedAt: turnStartedAt,
              errorCode: acpError.code,
            });
            if (taskContext) {
              this.markBackgroundTaskTerminal(taskContext.runId, {
                sessionKey,
                status: resolveBackgroundTaskFailureStatus(acpError),
                endedAt: Date.now(),
                lastEventAt: Date.now(),
                error: acpError.message,
                progressSummary: taskProgressSummary || null,
                terminalSummary: null,
              });
            }
            await this.setSessionState({
              cfg: input.cfg,
              sessionKey,
              state: "error",
              lastError: acpError.message,
            });
            throw acpError;
          } finally {
            if (input.signal && onCallerAbort) {
              input.signal.removeEventListener("abort", onCallerAbort);
            }
            if (activeTurn && this.activeTurnBySession.get(actorKey) === activeTurn) {
              this.activeTurnBySession.delete(actorKey);
            }
            if (!retryFreshHandle && !skipPostTurnCleanup && runtime && handle && meta) {
              ({ handle, meta } = await this.reconcileRuntimeSessionIdentifiers({
                cfg: input.cfg,
                sessionKey,
                runtime,
                handle,
                meta,
                failOnStatusError: false,
              }));
            }
            if (
              !retryFreshHandle &&
              !skipPostTurnCleanup &&
              runtime &&
              handle &&
              meta &&
              meta.mode === "oneshot"
            ) {
              try {
                await runtime.close({
                  handle,
                  reason: "oneshot-complete",
                });
              } catch (error) {
                logVerbose(
                  `acp-manager: ACP oneshot close failed for ${sessionKey}: ${String(error)}`,
                );
              } finally {
                this.clearCachedRuntimeState(sessionKey);
              }
            }
          }
          if (retryFreshHandle) {
            continue;
          }
        }
      },
      input.signal,
    );
  }

  private resolveTurnTimeoutMs(params: { cfg: OpenClawConfig; meta: SessionAcpMeta }): number {
    const runtimeTimeoutSeconds = resolveRuntimeOptionsFromMeta(params.meta).timeoutSeconds;
    if (
      typeof runtimeTimeoutSeconds === "number" &&
      Number.isFinite(runtimeTimeoutSeconds) &&
      runtimeTimeoutSeconds > 0
    ) {
      return Math.max(1_000, Math.round(runtimeTimeoutSeconds * 1_000));
    }
    return resolveAgentTimeoutMs({
      cfg: params.cfg,
      minMs: 1_000,
    });
  }

  private async awaitTurnWithTimeout<T>(params: {
    sessionKey: string;
    turnPromise: Promise<T>;
    timeoutMs: number;
    timeoutLabelMs: number;
    onTimeout: () => Promise<void>;
  }): Promise<T> {
    const observedTurnPromise: Promise<
      | {
          kind: "value";
          value: T;
        }
      | {
          kind: "error";
          error: unknown;
        }
    > = params.turnPromise.then(
      (value) => ({
        kind: "value" as const,
        value,
      }),
      (error) => ({
        kind: "error" as const,
        error,
      }),
    );

    if (params.timeoutMs <= 0) {
      const outcome = await observedTurnPromise;
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      return outcome.value;
    }

    const timeoutToken = Symbol("acp-turn-timeout");
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
      timer = setTimeout(() => resolve(timeoutToken), params.timeoutMs);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([observedTurnPromise, timeoutPromise]);
      if (outcome === timeoutToken) {
        void observedTurnPromise.then((lateOutcome) => {
          if (lateOutcome.kind === "error") {
            logVerbose(
              `acp-manager: detached late turn error after timeout for ${params.sessionKey}: ${String(lateOutcome.error)}`,
            );
          }
        });
        await params.onTimeout();
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          `ACP turn timed out after ${Math.max(1, Math.round(params.timeoutLabelMs / 1_000))}s.`,
        );
      }
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      return outcome.value;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async cleanupTimedOutTurn(params: {
    sessionKey: string;
    activeTurn: ActiveTurnState;
    mode: AcpRuntimeSessionMode;
  }): Promise<void> {
    params.activeTurn.abortController.abort();
    if (!params.activeTurn.cancelPromise) {
      params.activeTurn.cancelPromise = params.activeTurn.runtime.cancel({
        handle: params.activeTurn.handle,
        reason: ACP_TURN_TIMEOUT_REASON,
      });
    }
    const cancelFinished = await this.awaitCleanupWithGrace({
      sessionKey: params.sessionKey,
      label: "cancel",
      promise: params.activeTurn.cancelPromise,
    });
    if (params.mode !== "oneshot") {
      return;
    }
    const closePromise = params.activeTurn.runtime.close({
      handle: params.activeTurn.handle,
      reason: ACP_TURN_TIMEOUT_REASON,
    });
    const closeFinished = await this.awaitCleanupWithGrace({
      sessionKey: params.sessionKey,
      label: "close",
      promise: closePromise,
    });
    if (cancelFinished && closeFinished) {
      this.clearCachedRuntimeStateIfHandleMatches({
        sessionKey: params.sessionKey,
        handle: params.activeTurn.handle,
      });
      return;
    }
    void Promise.allSettled([params.activeTurn.cancelPromise, closePromise]).then(() => {
      this.clearCachedRuntimeStateIfHandleMatches({
        sessionKey: params.sessionKey,
        handle: params.activeTurn.handle,
      });
    });
  }

  private async awaitCleanupWithGrace(params: {
    sessionKey: string;
    label: "cancel" | "close";
    promise: Promise<unknown>;
  }): Promise<boolean> {
    const observedCleanupPromise: Promise<
      | {
          kind: "done";
        }
      | {
          kind: "error";
          error: unknown;
        }
    > = params.promise.then(
      () => ({
        kind: "done" as const,
      }),
      (error) => ({
        kind: "error" as const,
        error,
      }),
    );
    const timeoutToken = Symbol(`acp-timeout-${params.label}`);
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
      timer = setTimeout(() => resolve(timeoutToken), ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([observedCleanupPromise, timeoutPromise]);
      if (outcome === timeoutToken) {
        void observedCleanupPromise.then((lateOutcome) => {
          if (lateOutcome.kind === "error") {
            logVerbose(
              `acp-manager: detached timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(lateOutcome.error)}`,
            );
          }
        });
        logVerbose(
          `acp-manager: timed-out turn ${params.label} cleanup exceeded ${ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS}ms for ${params.sessionKey}`,
        );
        return false;
      }
      if (outcome.kind === "error") {
        logVerbose(
          `acp-manager: timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(outcome.error)}`,
        );
      }
      return true;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
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
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    const actorKey = normalizeActorKey(sessionKey);
    const activeTurn = this.activeTurnBySession.get(actorKey);
    if (activeTurn) {
      activeTurn.abortController.abort();
      if (!activeTurn.cancelPromise) {
        activeTurn.cancelPromise = activeTurn.runtime.cancel({
          handle: activeTurn.handle,
          reason: params.reason,
        });
      }
      await withAcpRuntimeErrorBoundary({
        run: async () => await activeTurn.cancelPromise!,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP cancel failed before completion.",
      });
      return;
    }

    await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
      });
      try {
        await withAcpRuntimeErrorBoundary({
          run: async () =>
            await runtime.cancel({
              handle,
              reason: params.reason,
            }),
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP cancel failed before completion.",
        });
        await this.setSessionState({
          cfg: params.cfg,
          sessionKey,
          state: "idle",
          clearLastError: true,
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP cancel failed before completion.",
        });
        await this.setSessionState({
          cfg: params.cfg,
          sessionKey,
          state: "error",
          lastError: acpError.message,
        });
        throw acpError;
      }
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
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: input.cfg,
        sessionKey,
      });
      const resolutionError = resolveAcpSessionResolutionError(resolution);
      if (resolutionError) {
        if (input.requireAcpSession ?? true) {
          throw resolutionError;
        }
        return {
          runtimeClosed: false,
          metaCleared: false,
        };
      }
      const meta = requireReadySessionMeta(resolution);
      const currentIdentity = resolveSessionIdentityFromMeta(meta);
      const shouldSkipRuntimeClose =
        input.discardPersistentState &&
        currentIdentity != null &&
        !identityHasStableSessionId(currentIdentity);

      let runtimeClosed = false;
      let runtimeNotice: string | undefined;
      if (shouldSkipRuntimeClose) {
        if (input.discardPersistentState) {
          const configuredBackend = (meta.backend || input.cfg.acp?.backend || "").trim();
          try {
            await this.deps
              .getRuntimeBackend(configuredBackend || undefined)
              ?.runtime.prepareFreshSession?.({
                sessionKey,
              });
          } catch (error) {
            logVerbose(
              `acp close fast-reset: unable to prepare fresh session for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        this.clearCachedRuntimeState(sessionKey);
      } else {
        try {
          const { runtime: ensuredRuntime, handle } = await this.ensureRuntimeHandle({
            cfg: input.cfg,
            sessionKey,
            meta,
          });
          await withAcpRuntimeErrorBoundary({
            run: async () =>
              await ensuredRuntime.close({
                handle,
                reason: input.reason,
                discardPersistentState: input.discardPersistentState,
              }),
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
          });
          runtimeClosed = true;
          this.clearCachedRuntimeState(sessionKey);
        } catch (error) {
          const acpError = toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
          });
          if (
            input.allowBackendUnavailable &&
            (acpError.code === "ACP_BACKEND_MISSING" ||
              acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
              (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
              this.isRecoverableAcpxExitError(acpError.message))
          ) {
            if (input.discardPersistentState) {
              const configuredBackend = (meta.backend || input.cfg.acp?.backend || "").trim();
              try {
                const runtimeBackend = this.deps.getRuntimeBackend(configuredBackend || undefined);
                if (!runtimeBackend) {
                  throw acpError;
                }
                await runtimeBackend.runtime.prepareFreshSession?.({
                  sessionKey,
                });
              } catch (recoveryError) {
                logVerbose(
                  `acp close recovery: unable to prepare fresh session for ${sessionKey}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
                );
              }
            }
            // Treat unavailable backends as terminal for this cached handle so it
            // cannot continue counting against maxConcurrentSessions.
            this.clearCachedRuntimeState(sessionKey);
            runtimeNotice = acpError.message;
          } else {
            throw acpError;
          }
        }
      }

      let metaCleared = false;
      if (input.discardPersistentState && !input.clearMeta) {
        await this.discardPersistedRuntimeState({
          cfg: input.cfg,
          sessionKey,
        });
      }

      if (input.clearMeta) {
        await this.writeSessionMeta({
          cfg: input.cfg,
          sessionKey,
          mutate: (_current, entry) => {
            if (!entry) {
              return null;
            }
            return null;
          },
          failOnError: true,
        });
        metaCleared = true;
      }

      return {
        runtimeClosed,
        runtimeNotice,
        metaCleared,
      };
    });
  }

  private async ensureRuntimeHandle(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    meta: SessionAcpMeta;
  }): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }> {
    const agent =
      normalizeText(params.meta.agent) || resolveAcpAgentFromSessionKey(params.sessionKey, "main");
    const mode = params.meta.mode;
    const runtimeOptions = resolveRuntimeOptionsFromMeta(params.meta);
    const cwd = runtimeOptions.cwd ?? normalizeText(params.meta.cwd);
    const model = normalizeText(runtimeOptions.model);
    const thinking = normalizeText(runtimeOptions.thinking);
    const configuredBackend = (params.meta.backend || params.cfg.acp?.backend || "").trim();
    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (cached) {
      const backendMatches = !configuredBackend || cached.backend === configuredBackend;
      const agentMatches = cached.agent === agent;
      const modeMatches = cached.mode === mode;
      const cwdMatches = (cached.cwd ?? "") === (cwd ?? "");
      const handleMatchesMeta = this.runtimeHandleMatchesMeta({
        handle: cached.handle,
        meta: params.meta,
      });
      if (
        backendMatches &&
        agentMatches &&
        modeMatches &&
        cwdMatches &&
        handleMatchesMeta &&
        (await this.isCachedRuntimeHandleReusable({
          sessionKey: params.sessionKey,
          runtime: cached.runtime,
          handle: cached.handle,
        }))
      ) {
        return {
          runtime: cached.runtime,
          handle: cached.handle,
          meta: params.meta,
        };
      }
      this.clearCachedRuntimeState(params.sessionKey);
    }

    this.enforceConcurrentSessionLimit({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });

    const backend = this.deps.requireRuntimeBackend(configuredBackend || undefined);
    const runtime = backend.runtime;
    const previousMeta = params.meta;
    const previousIdentity = resolveSessionIdentityFromMeta(previousMeta);
    let identityForEnsure = previousIdentity;
    const persistedResumeSessionId =
      mode === "persistent" ? resolveRuntimeResumeSessionId(previousIdentity) : undefined;
    const shouldPrepareFreshPersistentSession =
      mode === "persistent" &&
      previousIdentity != null &&
      !identityHasStableSessionId(previousIdentity);
    const ensureSession = async (resumeSessionId?: string) =>
      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.ensureSession({
            sessionKey: params.sessionKey,
            agent,
            mode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(model ? { model } : {}),
            ...(thinking ? { thinking } : {}),
            cwd,
          }),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      });
    let ensured: AcpRuntimeHandle;
    if (shouldPrepareFreshPersistentSession) {
      await runtime.prepareFreshSession?.({
        sessionKey: params.sessionKey,
      });
    }
    if (persistedResumeSessionId) {
      try {
        ensured = await ensureSession(persistedResumeSessionId);
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_SESSION_INIT_FAILED",
          fallbackMessage: "Could not initialize ACP session runtime.",
        });
        if (acpError.code !== "ACP_SESSION_INIT_FAILED") {
          throw acpError;
        }
        logVerbose(
          `acp-manager: resume init failed for ${params.sessionKey}; retrying without persisted ACP session id: ${acpError.message}`,
        );
        if (identityForEnsure) {
          const {
            acpxSessionId: _staleAcpxSessionId,
            agentSessionId: _staleAgentSessionId,
            ...retryIdentity
          } = identityForEnsure;
          // The persisted resume identifiers already failed, so do not merge them back into the
          // fresh named-session handle returned by the retry path.
          identityForEnsure = {
            ...retryIdentity,
            state: "pending",
          };
        }
        ensured = await ensureSession();
      }
    } else {
      ensured = await ensureSession();
    }

    const now = Date.now();
    const effectiveCwd = normalizeText(ensured.cwd) ?? cwd;
    const nextRuntimeOptions = normalizeRuntimeOptions({
      ...runtimeOptions,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    });
    const nextIdentity =
      mergeSessionIdentity({
        current: identityForEnsure,
        incoming: createIdentityFromEnsure({
          handle: ensured,
          now,
        }),
        now,
      }) ?? identityForEnsure;
    const nextHandleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
    const nextHandle: AcpRuntimeHandle = {
      ...ensured,
      ...(nextHandleIdentifiers.backendSessionId
        ? { backendSessionId: nextHandleIdentifiers.backendSessionId }
        : {}),
      ...(nextHandleIdentifiers.agentSessionId
        ? { agentSessionId: nextHandleIdentifiers.agentSessionId }
        : {}),
    };
    const nextMeta: SessionAcpMeta = {
      backend: ensured.backend || backend.id,
      agent,
      runtimeSessionName: ensured.runtimeSessionName,
      ...(nextIdentity ? { identity: nextIdentity } : {}),
      mode: params.meta.mode,
      ...(Object.keys(nextRuntimeOptions).length > 0 ? { runtimeOptions: nextRuntimeOptions } : {}),
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      state: previousMeta.state,
      lastActivityAt: now,
      ...(previousMeta.lastError ? { lastError: previousMeta.lastError } : {}),
    };
    const shouldPersistMeta =
      previousMeta.backend !== nextMeta.backend ||
      previousMeta.runtimeSessionName !== nextMeta.runtimeSessionName ||
      !identityEquals(previousIdentity, nextIdentity) ||
      previousMeta.agent !== nextMeta.agent ||
      previousMeta.cwd !== nextMeta.cwd ||
      !runtimeOptionsEqual(previousMeta.runtimeOptions, nextMeta.runtimeOptions) ||
      hasLegacyAcpIdentityProjection(previousMeta);
    if (shouldPersistMeta) {
      await this.writeSessionMeta({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        mutate: (_current, entry) => {
          if (!entry) {
            return null;
          }
          return nextMeta;
        },
      });
    }
    this.setCachedRuntimeState(params.sessionKey, {
      runtime,
      handle: nextHandle,
      backend: ensured.backend || backend.id,
      agent,
      mode,
      cwd: effectiveCwd,
      appliedControlSignature: undefined,
    });
    return {
      runtime,
      handle: nextHandle,
      meta: nextMeta,
    };
  }

  private async isCachedRuntimeHandleReusable(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }): Promise<boolean> {
    if (!params.runtime.getStatus) {
      return true;
    }
    try {
      const status = await params.runtime.getStatus({
        handle: params.handle,
      });
      if (this.isRuntimeStatusUnavailable(status)) {
        this.clearCachedRuntimeState(params.sessionKey);
        logVerbose(
          `acp-manager: evicting cached runtime handle for ${params.sessionKey} after unhealthy status probe: ${status.summary ?? "status unavailable"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.clearCachedRuntimeState(params.sessionKey);
      logVerbose(
        `acp-manager: evicting cached runtime handle for ${params.sessionKey} after status probe failed: ${String(error)}`,
      );
      return false;
    }
  }

  private isRuntimeStatusUnavailable(status: AcpRuntimeStatus | undefined): boolean {
    if (!status) {
      return false;
    }
    const detailsStatus = normalizeLowercaseStringOrEmpty(status.details?.status);
    if (detailsStatus === "dead" || detailsStatus === "no-session") {
      return true;
    }
    const summaryMatch = status.summary?.match(/\bstatus=([^\s]+)/i);
    const summaryStatus = normalizeLowercaseStringOrEmpty(summaryMatch?.[1]);
    return summaryStatus === "dead" || summaryStatus === "no-session";
  }

  private async persistRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    options: AcpSessionRuntimeOptions;
  }): Promise<void> {
    const normalized = normalizeRuntimeOptions(params.options);
    const hasOptions = Object.keys(normalized).length > 0;
    await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        return {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          ...(base.identity ? { identity: base.identity } : {}),
          mode: base.mode,
          runtimeOptions: hasOptions ? normalized : undefined,
          cwd: normalized.cwd,
          state: base.state,
          lastActivityAt: Date.now(),
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
      },
      failOnError: true,
    });

    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (!cached) {
      return;
    }
    if ((cached.cwd ?? "") !== (normalized.cwd ?? "")) {
      this.clearCachedRuntimeState(params.sessionKey);
      return;
    }
    // Persisting options does not guarantee this process pushed all controls to the runtime.
    // Force the next turn to reconcile runtime controls from persisted metadata.
    cached.appliedControlSignature = undefined;
  }

  private enforceConcurrentSessionLimit(params: { cfg: OpenClawConfig; sessionKey: string }): void {
    const configuredLimit = params.cfg.acp?.maxConcurrentSessions;
    if (typeof configuredLimit !== "number" || !Number.isFinite(configuredLimit)) {
      return;
    }
    const limit = Math.max(1, Math.floor(configuredLimit));
    const actorKey = normalizeActorKey(params.sessionKey);
    if (this.runtimeCache.has(actorKey)) {
      return;
    }
    const activeCount = this.runtimeCache.size();
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

  private async prepareFreshHandleRetry(params: {
    attempt: number;
    cfg: OpenClawConfig;
    sessionKey: string;
    error: AcpRuntimeError;
    sawTurnOutput: boolean;
    runtime?: AcpRuntime;
    meta?: SessionAcpMeta;
  }): Promise<boolean> {
    if (params.attempt > 0 || params.sawTurnOutput) {
      return false;
    }
    if (this.isRecoverableAcpxExitError(params.error.message)) {
      this.clearCachedRuntimeState(params.sessionKey);
      logVerbose(
        `acp-manager: retrying ${params.sessionKey} with a fresh runtime handle after early turn failure: ${params.error.message}`,
      );
      return true;
    }
    if (
      !params.runtime ||
      !params.meta ||
      params.meta.mode !== "persistent" ||
      !this.isRecoverableMissingPersistentSessionError(params.error.message)
    ) {
      return false;
    }
    const cleared = await this.clearPersistedRuntimeResumeState({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!cleared) {
      return false;
    }
    if (params.runtime.prepareFreshSession) {
      try {
        await params.runtime.prepareFreshSession({
          sessionKey: params.sessionKey,
        });
      } catch (error) {
        logVerbose(
          `acp-manager: failed preparing a fresh persistent session for ${params.sessionKey}: ${formatErrorMessage(error)}`,
        );
        return false;
      }
    }
    this.clearCachedRuntimeState(params.sessionKey);
    logVerbose(
      `acp-manager: retrying ${params.sessionKey} with a fresh persistent session after missing backend resume target: ${params.error.message}`,
    );
    return true;
  }

  private isRecoverableAcpxExitError(message: string): boolean {
    return /^acpx exited with (code \d+|signal [a-z0-9]+)/i.test(message.trim());
  }

  private isRecoverableMissingPersistentSessionError(message: string): boolean {
    const normalized = message.trim();
    return (
      /persistent acp session .* could not be resumed/i.test(normalized) &&
      /(resource not found|no matching session)/i.test(normalized)
    );
  }

  private async clearPersistedRuntimeResumeState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<boolean> {
    const now = Date.now();
    const updated = await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        const currentIdentity = resolveSessionIdentityFromMeta(base);
        if (!currentIdentity?.acpxSessionId && !currentIdentity?.agentSessionId) {
          return base;
        }
        const nextIdentity = {
          state: "pending" as const,
          ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
          source: currentIdentity.source,
          lastUpdatedAt: now,
        };
        return {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          identity: nextIdentity,
          mode: base.mode,
          ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
          ...(base.cwd ? { cwd: base.cwd } : {}),
          state: base.state,
          lastActivityAt: now,
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
      },
    });
    if (!updated) {
      logVerbose(
        `acp-manager: unable to clear persisted runtime resume state for ${params.sessionKey}`,
      );
      return false;
    }
    return true;
  }

  private async discardPersistedRuntimeState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<void> {
    const now = Date.now();
    await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        const currentIdentity = resolveSessionIdentityFromMeta(base);
        const nextIdentity = currentIdentity
          ? {
              state: "pending" as const,
              ...(currentIdentity.acpxRecordId
                ? { acpxRecordId: currentIdentity.acpxRecordId }
                : {}),
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
      },
      failOnError: true,
    });
  }

  private async evictIdleRuntimeHandles(params: { cfg: OpenClawConfig }): Promise<void> {
    const idleTtlMs = resolveRuntimeIdleTtlMs(params.cfg);
    if (idleTtlMs <= 0 || this.runtimeCache.size() === 0) {
      return;
    }
    const now = Date.now();
    const candidates = this.runtimeCache.collectIdleCandidates({
      maxIdleMs: idleTtlMs,
      now,
    });
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      await this.actorQueue.run(candidate.actorKey, async () => {
        if (this.activeTurnBySession.has(candidate.actorKey)) {
          return;
        }
        const lastTouchedAt = this.runtimeCache.getLastTouchedAt(candidate.actorKey);
        if (lastTouchedAt == null || now - lastTouchedAt < idleTtlMs) {
          return;
        }
        const cached = this.runtimeCache.peek(candidate.actorKey);
        if (!cached) {
          return;
        }
        this.runtimeCache.clear(candidate.actorKey);
        this.evictedRuntimeCount += 1;
        this.lastEvictedAt = Date.now();
        try {
          await cached.runtime.close({
            handle: cached.handle,
            reason: "idle-evicted",
          });
        } catch (error) {
          logVerbose(
            `acp-manager: idle eviction close failed for ${candidate.state.handle.sessionKey}: ${String(error)}`,
          );
        }
      });
    }
  }

  private async resolveRuntimeCapabilities(params: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> {
    return await resolveManagerRuntimeCapabilities(params);
  }

  private async applyRuntimeControls(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }): Promise<void> {
    await applyManagerRuntimeControls({
      ...params,
      getCachedRuntimeState: (sessionKey) => this.getCachedRuntimeState(sessionKey),
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
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
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
        const cached = this.getCachedRuntimeState(sessionKey);
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
  }): Promise<SessionEntry | null> {
    try {
      return await this.deps.upsertSessionMeta({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        mutate: params.mutate,
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
        reject(error);
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

  private getCachedRuntimeState(sessionKey: string): CachedRuntimeState | null {
    return this.runtimeCache.get(normalizeActorKey(sessionKey));
  }

  private setCachedRuntimeState(sessionKey: string, state: CachedRuntimeState): void {
    this.runtimeCache.set(normalizeActorKey(sessionKey), state);
  }

  private clearCachedRuntimeState(sessionKey: string): void {
    this.runtimeCache.clear(normalizeActorKey(sessionKey));
  }

  private clearCachedRuntimeStateIfHandleMatches(params: {
    sessionKey: string;
    handle: AcpRuntimeHandle;
  }): void {
    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (!cached || !this.runtimeHandlesMatch(cached.handle, params.handle)) {
      return;
    }
    this.clearCachedRuntimeState(params.sessionKey);
  }

  private runtimeHandlesMatch(a: AcpRuntimeHandle, b: AcpRuntimeHandle): boolean {
    return (
      a.sessionKey === b.sessionKey &&
      a.backend === b.backend &&
      a.runtimeSessionName === b.runtimeSessionName &&
      (a.cwd ?? "") === (b.cwd ?? "") &&
      (a.acpxRecordId ?? "") === (b.acpxRecordId ?? "") &&
      (a.backendSessionId ?? "") === (b.backendSessionId ?? "") &&
      (a.agentSessionId ?? "") === (b.agentSessionId ?? "")
    );
  }

  private runtimeHandleMatchesMeta(params: {
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }): boolean {
    const identity = resolveSessionIdentityFromMeta(params.meta);
    const expectedHandleIds = resolveRuntimeHandleIdentifiersFromIdentity(identity);
    if ((params.handle.backendSessionId ?? "") !== (expectedHandleIds.backendSessionId ?? "")) {
      return false;
    }
    if ((params.handle.agentSessionId ?? "") !== (expectedHandleIds.agentSessionId ?? "")) {
      return false;
    }

    const expectedAcpxRecordId = identity?.acpxRecordId ?? "";
    const actualAcpxRecordId =
      normalizeText((params.handle as { acpxRecordId?: unknown }).acpxRecordId) ?? "";
    return actualAcpxRecordId === expectedAcpxRecordId;
  }

  private resolveBackgroundTaskContext(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    requestId: string;
    text: string;
  }): BackgroundTaskContext | null {
    const childEntry = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    })?.entry;
    const requesterSessionKey =
      normalizeText(childEntry?.spawnedBy) ?? normalizeText(childEntry?.parentSessionKey);
    if (!requesterSessionKey) {
      return null;
    }
    const parentEntry = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey: requesterSessionKey,
    })?.entry;
    return {
      requesterSessionKey,
      requesterOrigin: parentEntry?.deliveryContext ?? childEntry?.deliveryContext,
      childSessionKey: params.sessionKey,
      runId: params.requestId,
      label: normalizeText(childEntry?.label),
      task: summarizeBackgroundTaskText(params.text),
    };
  }

  private createBackgroundTaskRecord(context: BackgroundTaskContext, startedAt: number): void {
    try {
      createRunningTaskRun({
        runtime: "acp",
        sourceId: context.runId,
        ownerKey: context.requesterSessionKey,
        scopeKind: "session",
        requesterOrigin: context.requesterOrigin,
        childSessionKey: context.childSessionKey,
        runId: context.runId,
        label: context.label,
        task: context.task,
        startedAt,
      });
    } catch (error) {
      logVerbose(
        `acp-manager: failed creating background task for ${context.runId}: ${String(error)}`,
      );
    }
  }

  private markBackgroundTaskRunning(
    runId: string,
    params: {
      sessionKey?: string;
      lastEventAt?: number;
      progressSummary?: string | null;
    },
  ): void {
    try {
      startTaskRunByRunId({
        runId,
        runtime: "acp",
        sessionKey: params.sessionKey,
        lastEventAt: params.lastEventAt,
        progressSummary: params.progressSummary,
      });
    } catch (error) {
      logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
    }
  }

  private markBackgroundTaskTerminal(
    runId: string,
    params: {
      sessionKey?: string;
      status: "succeeded" | "failed" | "timed_out";
      endedAt: number;
      lastEventAt?: number;
      error?: string;
      progressSummary?: string | null;
      terminalSummary?: string | null;
      terminalOutcome?: "succeeded" | "blocked" | null;
    },
  ): void {
    try {
      if (params.status === "succeeded") {
        completeTaskRunByRunId({
          runId,
          runtime: "acp",
          sessionKey: params.sessionKey,
          endedAt: params.endedAt,
          lastEventAt: params.lastEventAt,
          progressSummary: params.progressSummary,
          terminalSummary: params.terminalSummary,
          terminalOutcome: params.terminalOutcome,
        });
        return;
      }
      failTaskRunByRunId({
        runId,
        runtime: "acp",
        sessionKey: params.sessionKey,
        status: params.status,
        endedAt: params.endedAt,
        lastEventAt: params.lastEventAt,
        error: params.error,
        progressSummary: params.progressSummary,
        terminalSummary: params.terminalSummary,
      });
    } catch (error) {
      logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
    }
  }
}

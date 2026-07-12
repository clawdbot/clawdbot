/** Runs ACP turns, failover, timeout cleanup, and detached-task progress mirroring. */
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { expectDefined } from "@openclaw/normalization-core";
import { logVerbose } from "../../globals.js";
import {
  recordSessionHumanDirectMessage,
  recordSubagentTerminalState,
} from "../../sessions/session-state-events.js";
import { AcpRuntimeError, formatAcpErrorChain, toAcpRuntimeError } from "../runtime/errors.js";
import { clearAcpTurnActive, markAcpTurnActive } from "./active-turns.js";
import {
  isFailoverWorthyBackendError,
  resolveBackendCandidatePlan,
  shouldAttemptBackendFailover,
  type BackendAttempt,
} from "./manager.backend-failover.js";
import {
  appendBackgroundTaskProgressSummary,
  createBackgroundTaskRecord,
  markBackgroundTaskRunning,
  markBackgroundTaskTerminal,
  resolveBackgroundTaskContext,
  resolveBackgroundTaskFailureStatus,
  resolveBackgroundTaskTerminalResult,
} from "./manager.background-task.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { prepareFreshManagerRuntimeHandleRetry } from "./manager.runtime-resume-state.js";
import { consumeAcpTurnStream } from "./manager.turn-stream.js";
import {
  awaitTurnWithTimeout,
  cleanupTimedOutTurn,
  resolveTurnTimeoutMs,
} from "./manager.turn-timeout.js";
import type {
  AcpRunTurnInput,
  AcpSessionManagerDeps,
  ActiveTurnState,
  EnsureManagerRuntimeHandle,
  ReconcileManagerRuntimeSessionIdentifiers,
  ResolveManagerSession,
  SetManagerSessionState,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { normalizeActorKey, requireReadySessionMeta } from "./manager.utils.js";

const ACP_TURN_TIMEOUT_GRACE_MS = 1_000;

type ApplyRuntimeControls = (params: {
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
}) => Promise<void>;

/** Executes one ACP prompt turn against the selected backend and records terminal state. */
export async function runManagerTurn(params: {
  input: AcpRunTurnInput;
  sessionKey: string;
  deps: AcpSessionManagerDeps;
  runtimeHandles: ManagerRuntimeHandleCache;
  activeTurnBySession: Map<string, ActiveTurnState>;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  applyRuntimeControls: ApplyRuntimeControls;
  setSessionState: SetManagerSessionState;
  recordTurnCompletion: (params: {
    startedAt: number;
    errorCode?: AcpRuntimeError["code"];
  }) => void;
  reconcileRuntimeSessionIdentifiers: ReconcileManagerRuntimeSessionIdentifiers;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<void> {
  const { input, sessionKey } = params;
  const turnStartedAt = Date.now();
  const actorKey = normalizeActorKey(sessionKey);
  const taskContext =
    input.mode === "prompt"
      ? resolveBackgroundTaskContext({
          deps: params.deps,
          cfg: input.cfg,
          sessionKey,
          requestId: input.requestId,
          text: input.text,
        })
      : null;
  if (taskContext) {
    createBackgroundTaskRecord(taskContext, turnStartedAt);
  }
  let taskProgressSummary = "";
  const initialResolution = params.resolveSession({
    cfg: input.cfg,
    sessionKey,
  });
  const initialMeta = requireReadySessionMeta(initialResolution);
  recordSessionHumanDirectMessage({
    sessionKey,
    entry: initialResolution.kind === "ready" ? initialResolution.entry : undefined,
    actor: { actorType: input.provenance },
    channel: "acp",
    runId: input.requestId,
  });
  // ACP children bypass the subagent registry; terminal outcomes are projected into
  // the signal log here so changesSince histories are not spawn-only for ACP runs.
  const spawnedByWatcher =
    initialResolution.kind === "ready"
      ? (initialResolution.entry?.spawnedBy ?? initialResolution.entry?.parentSessionKey)
      : undefined;
  const { candidateBackends, describeBackendCandidate } = resolveBackendCandidatePlan({
    configuredPrimaryBackend: input.cfg.acp?.backend,
    resolvedPrimaryBackend: initialMeta.backend,
    fallbackBackends: input.cfg.acp?.fallbacks,
  });
  const backendAttempts: BackendAttempt[] = [];
  const recordBackendFailure = async (error: AcpRuntimeError) => {
    const failedBackends = backendAttempts
      .map((attempt) => `${attempt.backend}: ${attempt.error}`)
      .join(" | ");
    const errorToRecord =
      backendAttempts.length > 1
        ? new AcpRuntimeError(
            error.code,
            `All ACP backends failed (${backendAttempts.length}): ${failedBackends}`,
          )
        : error;
    params.recordTurnCompletion({
      startedAt: turnStartedAt,
      errorCode: errorToRecord.code,
    });
    if (taskContext) {
      const failureStatus = resolveBackgroundTaskFailureStatus(errorToRecord);
      markBackgroundTaskTerminal(taskContext.runId, {
        sessionKey,
        status: failureStatus,
        endedAt: Date.now(),
        lastEventAt: Date.now(),
        error: formatAcpErrorChain(errorToRecord),
        progressSummary: taskProgressSummary || null,
        terminalSummary: null,
      });
      if (spawnedByWatcher) {
        recordSubagentTerminalState({
          childSessionKey: sessionKey,
          runId: taskContext.runId,
          requesterSessionKey: spawnedByWatcher,
          outcomeStatus: failureStatus === "timed_out" ? "timeout" : "error",
        });
      }
    }
    await params.setSessionState({
      cfg: input.cfg,
      sessionKey,
      state: "error",
      lastError: formatAcpErrorChain(errorToRecord),
    });
    throw errorToRecord;
  };

  let acpTurnMarkedActive = false;
  // Liveness spans the whole task, not one attempt: mark once before the backend loop
  // (after the ready-meta check, so a pre-loop throw cannot leak it) and clear on every
  // runTurn exit, including unexpected retry/cleanup failures before terminal task writes.
  if (taskContext) {
    markAcpTurnActive(sessionKey);
    acpTurnMarkedActive = true;
  }

  try {
    for (const [backendIdx, currentBackend] of candidateBackends.entries()) {
      if (backendIdx > 0) {
        await params.runtimeHandles.close({
          sessionKey,
          reason: "backend-failover",
        });
        logVerbose(
          `acp-manager: switching backend for ${sessionKey} from ${describeBackendCandidate(
            expectDefined(
              candidateBackends[backendIdx - 1],
              "candidate backends entry at backend idx 1",
            ),
          )} to ${describeBackendCandidate(currentBackend)}`,
        );
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const resolution =
          backendIdx === 0 && attempt === 0
            ? initialResolution
            : params.resolveSession({
                cfg: input.cfg,
                sessionKey,
              });
        const resolvedMeta = requireReadySessionMeta(resolution);
        const metaWithBackend: SessionAcpMeta = currentBackend
          ? { ...resolvedMeta, backend: currentBackend }
          : resolvedMeta;
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
          const ensured = await params.ensureRuntimeHandle({
            cfg: input.cfg,
            sessionKey,
            meta: metaWithBackend,
          });
          runtime = ensured.runtime;
          handle = ensured.handle;
          meta = ensured.meta;
          await params.applyRuntimeControls({
            sessionKey,
            runtime,
            handle,
            meta,
          });

          await params.setSessionState({
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
          params.activeTurnBySession.set(actorKey, activeTurn);
          activeTurnStarted = true;

          const combinedSignal =
            input.signal && typeof AbortSignal.any === "function"
              ? AbortSignal.any([input.signal, internalAbortController.signal])
              : internalAbortController.signal;
          const eventGate = { open: true };
          await input.onLifecycle?.({
            type: "prompt_submitted",
            at: Date.now(),
          });
          const turnPromise = consumeAcpTurnStream({
            runtime,
            turn: {
              handle,
              text: input.text,
              attachments: input.attachments,
              mode: input.mode,
              requestId: input.requestId,
              signal: combinedSignal,
            },
            eventGate,
            onOutputEvent: (event) => {
              sawTurnOutput = true;
              if (event.type === "text_delta" && event.stream !== "thought" && event.text) {
                taskProgressSummary = appendBackgroundTaskProgressSummary(
                  taskProgressSummary,
                  event.text,
                );
              }
              if (taskContext) {
                markBackgroundTaskRunning(taskContext.runId, {
                  sessionKey,
                  lastEventAt: Date.now(),
                  progressSummary: taskProgressSummary || null,
                });
              }
            },
            onEvent: input.onEvent,
          });
          const turnTimeoutMs = resolveTurnTimeoutMs({
            cfg: input.cfg,
            meta,
          });
          const sessionMode = meta.mode;
          const turnOutcome = await awaitTurnWithTimeout({
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
              await cleanupTimedOutTurn({
                sessionKey,
                activeTurn,
                mode: sessionMode,
                clearCachedRuntimeStateIfHandleMatches: (turn) => {
                  params.runtimeHandles.clearIfHandleMatches({
                    sessionKey,
                    handle: turn.handle,
                  });
                },
              });
            },
          });
          if (!turnOutcome.terminalStatus) {
            throw new AcpRuntimeError(
              "ACP_TURN_FAILED",
              "ACP turn ended without a terminal done event.",
            );
          }
          params.recordTurnCompletion({
            startedAt: turnStartedAt,
          });
          if (taskContext) {
            const terminalResult = resolveBackgroundTaskTerminalResult(taskProgressSummary);
            markBackgroundTaskTerminal(taskContext.runId, {
              sessionKey,
              status: turnOutcome.terminalStatus === "cancelled" ? "cancelled" : "succeeded",
              endedAt: Date.now(),
              lastEventAt: Date.now(),
              error: undefined,
              progressSummary: taskProgressSummary || null,
              terminalSummary: terminalResult.terminalSummary ?? null,
              terminalOutcome: terminalResult.terminalOutcome,
            });
            if (spawnedByWatcher) {
              recordSubagentTerminalState({
                childSessionKey: sessionKey,
                runId: taskContext.runId,
                requesterSessionKey: spawnedByWatcher,
                outcomeStatus: turnOutcome.terminalStatus === "cancelled" ? "cancelled" : "ok",
              });
            }
          }
          await params.setSessionState({
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
          retryFreshHandle = await prepareFreshManagerRuntimeHandleRetry({
            attempt,
            cfg: input.cfg,
            sessionKey,
            error: acpError,
            sawTurnOutput,
            runtime,
            meta,
            runtimeHandles: params.runtimeHandles,
            writeSessionMeta: params.writeSessionMeta,
          });
          if (retryFreshHandle) {
            continue;
          }

          const backendAttempt = {
            backend: describeBackendCandidate(currentBackend),
            error: acpError.message,
            code: acpError.code,
            sawOutput: sawTurnOutput,
          };
          backendAttempts.push(backendAttempt);
          if (
            !isFailoverWorthyBackendError(backendAttempt) ||
            !shouldAttemptBackendFailover({
              backendIndex: backendIdx,
              candidateBackends,
            })
          ) {
            await recordBackendFailure(acpError);
          }
          break;
        } finally {
          if (input.signal && onCallerAbort) {
            input.signal.removeEventListener("abort", onCallerAbort);
          }
          if (activeTurn && params.activeTurnBySession.get(actorKey) === activeTurn) {
            params.activeTurnBySession.delete(actorKey);
          }
          if (!retryFreshHandle && !skipPostTurnCleanup && runtime && handle && meta) {
            ({ handle, meta } = await params.reconcileRuntimeSessionIdentifiers({
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
              params.runtimeHandles.clear(sessionKey);
            }
          }
        }
        if (retryFreshHandle) {
          continue;
        }
      }
    }
  } finally {
    if (acpTurnMarkedActive) {
      clearAcpTurnActive(sessionKey);
    }
  }
}

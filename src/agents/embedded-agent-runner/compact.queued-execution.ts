import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptWriteContext,
} from "../../config/sessions/transcript-write-context.js";
import {
  bindContextEngineCompaction,
  inheritRuntimeCompactionDelegate,
} from "../../context-engine/compaction-watchdog.js";
import {
  resolveCompactionSuccessorTranscript,
  type ContextEngine,
  type ContextEngineRuntimeContext,
  type ContextEngineRuntimeSettings,
  type ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import type { CapturedCompactionCheckpointSnapshot } from "../../gateway/session-compaction-checkpoints.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { maybeCompactAgentHarnessSession } from "../harness/compaction.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import type { CompactionRequestConstraints } from "../sessions/compaction/request-budget.js";
import { SessionManager } from "../sessions/index.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { compactionCheckpointStore, persistCompactionCheckpoint } from "./compaction-checkpoint.js";
import { asCompactionHookRunner, runPostCompactionSideEffects } from "./compaction-hooks.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import {
  acceptCompactionSuccessor,
  type AcceptedCompactionSuccessor,
} from "./compaction-successor.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { attachCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import {
  setTranscriptBytePreflightClaim,
  type TranscriptBytePreflightAuthority,
  type TranscriptByteCompactionPersistence,
} from "./transcript-byte-preflight-authority.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

type QueuedCompactionHostCommit = {
  entry: AcceptedCompactionSuccessor["entry"];
  tokensAfter?: number;
  compactionKind: "context-engine" | "server-endpoint";
};

/** Host-only bookkeeping, deliberately separate from plugin compaction parameters. */
export type QueuedCompactionHostOptions = CompactionRequestConstraints & {
  assertActive?: () => void;
  transcriptBytePreflightHarness?: "codex";
  withCompactionPersistence?: TranscriptByteCompactionPersistence;
  onCommitted?: (accepted: AcceptedCompactionSuccessor) => void;
  onHostCompactionCommitted?: (commit: QueuedCompactionHostCommit) => Promise<void> | void;
  onHostCompactionTranscriptSettled?: (commit: QueuedCompactionHostCommit) => Promise<void> | void;
};

export function createQueuedCompactionAbortedResult(): EmbeddedAgentCompactResult {
  return { ok: false, compacted: false, reason: "compaction aborted" };
}

export async function withQueuedCompactionCancellationResult(
  params: Pick<CompactEmbeddedAgentSessionParams, "abortSignal">,
  run: () => Promise<EmbeddedAgentCompactResult>,
): Promise<EmbeddedAgentCompactResult> {
  try {
    return await run();
  } catch (error) {
    const signal = params.abortSignal;
    if (!signal?.aborted || (!isAbortError(error) && error !== signal.reason)) {
      throw error;
    }
    return createQueuedCompactionAbortedResult();
  }
}

export function projectQueuedCompactionSessionTarget(
  params: CompactEmbeddedAgentSessionParams,
): ContextEngineSessionTarget {
  const agentId = params.sessionTarget?.agentId ?? params.agentId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey;
  const storePath = params.sessionTarget?.storePath;
  return {
    ...(agentId ? { agentId } : {}),
    sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(storePath ? { storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
}

function mergeSecondaryNativeHarnessCompactionDetails(params: {
  details: unknown;
  nativeResult: EmbeddedAgentCompactResult | undefined;
  detailsKey: "codexNativeCompaction" | "nativeHarnessCompaction";
}): unknown {
  if (!params.nativeResult) {
    return params.details;
  }
  const details = isRecord(params.details)
    ? params.details
    : params.details === undefined
      ? {}
      : { contextEngine: params.details };
  return {
    ...details,
    [params.detailsKey]: params.nativeResult,
  };
}

/** Both compaction runtimes cancel pending queue admission before releasing their writer. */
function enqueueCompactionInLanes<T>(
  params: Pick<
    CompactEmbeddedAgentSessionParams,
    "sessionKey" | "sessionId" | "lane" | "enqueue" | "abortSignal"
  >,
  run: () => Promise<T>,
): Promise<T> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const options = { abortSignal: params.abortSignal };
  return enqueueCommandInLane(sessionLane, () => enqueueGlobal(run, options), options);
}

export async function runPrimaryNativeCompactionInLanes<T>(
  params: CompactEmbeddedAgentSessionParams & { sessionTarget: SessionTranscriptRuntimeTarget },
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  host: QueuedCompactionHostOptions,
  run: () => Promise<T>,
): Promise<T> {
  return await enqueueCompactionInLanes(params, async () => {
    host.assertActive?.();
    const currentEntry = loadSessionEntryReadOnly({
      ...params.sessionTarget,
      readConsistency: "latest",
    });
    if (
      !currentEntry ||
      currentEntry.sessionId !== expectedEntry.sessionId ||
      currentEntry.lifecycleRevision !== expectedEntry.lifecycleRevision ||
      currentEntry.activeWriterRunId !== expectedEntry.activeWriterRunId
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return run();
  });
}

export async function executeQueuedContextEngineCompaction(input: {
  params: CompactEmbeddedAgentSessionParams;
  preparedParams: CompactEmbeddedAgentSessionParams;
  runtimeTarget: SessionTranscriptRuntimeTarget;
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"];
  host: QueuedCompactionHostOptions;
  contextEngine: ContextEngine;
  contextEngineSessionKey?: string;
  contextEngineRuntimeContext: ContextEngineRuntimeContext;
  contextEngineRuntimeSettings: ContextEngineRuntimeSettings;
  resolvedWorkspaceDir: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  effectiveRuntimeModel?: ProviderRuntimeModel;
  preparedHarnessRuntime?: string;
  contextTokenBudget?: number;
  attemptNativeHarnessCompaction: boolean;
  transcriptBytePreflightAuthority?: TranscriptBytePreflightAuthority;
}): Promise<EmbeddedAgentCompactResult> {
  const {
    params,
    preparedParams,
    runtimeTarget,
    expectedEntry,
    host,
    contextEngine,
    contextEngineSessionKey,
    contextEngineRuntimeContext,
    contextEngineRuntimeSettings,
    resolvedWorkspaceDir,
    preparedModelRuntime,
    effectiveRuntimeModel,
    preparedHarnessRuntime,
    contextTokenBudget,
    attemptNativeHarnessCompaction,
    transcriptBytePreflightAuthority,
  } = input;
  let expected = { ...expectedEntry };
  return await enqueueCompactionInLanes(params, async () => {
    let closed = false;
    const assertCallerActive = () => {
      params.abortSignal?.throwIfAborted();
      if (closed) {
        throw new Error("queued compaction is no longer active");
      }
      host.assertActive?.();
    };
    const assertActive = (target = runtimeTarget, owner = expected) => {
      assertCallerActive();
      const current = loadSessionEntry({ ...target, readConsistency: "latest" });
      if (
        !current ||
        current.sessionId !== owner.sessionId ||
        current.lifecycleRevision !== owner.lifecycleRevision ||
        current.activeWriterRunId !== owner.activeWriterRunId
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    };
    const createTranscriptWriteContext = (
      target: SessionTranscriptRuntimeTarget,
      owner: typeof expectedEntry,
      signal?: AbortSignal,
    ) => {
      const capturedOwner = { ...owner };
      const sessionTarget = {
        ...target,
        expectedLifecycleRevision: capturedOwner.lifecycleRevision,
        expectedWriterRunId: capturedOwner.activeWriterRunId,
      };
      const assertCommitAllowed = () => {
        signal?.throwIfAborted();
        assertActive(sessionTarget, capturedOwner);
      };
      assertCommitAllowed();
      return {
        sessionTarget,
        assertCommitAllowed,
        withTranscriptWrite: async (run) => await run(),
      } satisfies OwnedSessionTranscriptWriteContext;
    };
    const canContinue = () => {
      try {
        assertActive();
        return true;
      } catch (error) {
        if (params.abortSignal?.aborted || closed) {
          return false;
        }
        throw error;
      }
    };
    let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null | undefined;
    let checkpointSnapshotRetained = false;
    try {
      if (params.abortSignal?.aborted) {
        return createQueuedCompactionAbortedResult();
      }
      assertActive();
      // When the context engine owns compaction, its compact() implementation
      // bypasses compactEmbeddedAgentSessionDirect (which fires the hooks internally).
      // Fire before_compaction / after_compaction hooks here so plugin subscribers
      // are notified regardless of which engine is active.
      const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
      checkpointSnapshot = engineOwnsCompaction
        ? await compactionCheckpointStore.captureSnapshot({
            sessionFile: params.sessionFile,
            sessionManager: SessionManager.open(runtimeTarget),
            sessionTarget: runtimeTarget,
          })
        : null;
      assertActive();
      const hookRunner = engineOwnsCompaction
        ? asCompactionHookRunner(getGlobalHookRunner())
        : null;
      const hookSessionKey = runtimeTarget.sessionKey;
      const { sessionAgentId } = resolveSessionAgentIds({
        sessionKey: params.sessionKey,
        config: params.config,
        agentId: params.agentId,
      });
      const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
      const hookCtx = {
        sessionId: params.sessionId,
        agentId: sessionAgentId,
        sessionKey: hookSessionKey,
        workspaceDir: resolvedWorkspaceDir,
        messageProvider: resolvedMessageProvider,
      };
      const runtimeContext = contextEngineRuntimeContext;
      // Engine-owned compaction doesn't load the transcript at this level, so
      // message counts are unavailable. We pass sessionFile so hook subscribers
      // can read the transcript themselves if they need exact counts.
      if (hookRunner?.hasHooks?.("before_compaction") && hookRunner.runBeforeCompaction) {
        try {
          await hookRunner.runBeforeCompaction(
            {
              messageCount: -1,
              sessionFile: params.sessionFile,
            },
            hookCtx,
          );
        } catch (err) {
          log.warn("before_compaction hook failed", {
            errorMessage: formatErrorMessage(err),
          });
        }
      }
      if (params.abortSignal?.aborted) {
        return createQueuedCompactionAbortedResult();
      }
      assertActive();
      // Preserve the delegate's progress-aware watchdog and bound other engines.
      // Queued callers keep result-based failures; recovery rejects cancellation.
      let result: Awaited<ReturnType<typeof contextEngine.compact>>;
      try {
        const compactionSessionTarget = projectQueuedCompactionSessionTarget(params);
        const compact = bindContextEngineCompaction(contextEngine);
        const ownedCompactor: Pick<ContextEngine, "compact" | "info"> = {
          info: contextEngine.info,
          compact: inheritRuntimeCompactionDelegate(compact, (backendParams) => {
            if ((host.requestBudget || host.pendingUserEntryId) && backendParams.runtimeContext) {
              attachCompactionAccountingRecorder(backendParams.runtimeContext, {
                requestBudget: host.requestBudget,
                pendingUserEntryId: host.pendingUserEntryId,
              });
            }
            // Retained backend work keeps the original owner and the timer's
            // composed signal, never a later accepted successor's authority.
            const writeContext = createTranscriptWriteContext(
              runtimeTarget,
              expectedEntry,
              backendParams.abortSignal,
            );
            const clearClaim = setTranscriptBytePreflightClaim(
              backendParams.runtimeContext,
              transcriptBytePreflightAuthority,
              host.withCompactionPersistence,
            );
            return withOwnedSessionTranscriptWrites(writeContext, () =>
              compact(backendParams),
            ).finally(clearClaim);
          }),
        };
        result = await compactContextEngineWithSafetyTimeout(
          ownedCompactor,
          {
            sessionId: params.sessionId,
            sessionKey: hookSessionKey,
            ...(compactionSessionTarget.agentId
              ? { agentId: compactionSessionTarget.agentId }
              : {}),
            sessionTarget: compactionSessionTarget,
            tokenBudget: contextTokenBudget,
            currentTokenCount: params.currentTokenCount,
            compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
            customInstructions: params.customInstructions,
            force:
              params.force === true ||
              params.forcePreflight === true ||
              params.preflightRequired === true ||
              params.trigger === "manual",
            runtimeContext: {
              ...runtimeContext,
              forceReason:
                params.forcePreflight === true || params.preflightRequired === true
                  ? "preflight_required"
                  : params.trigger === "manual"
                    ? "manual"
                    : undefined,
              preflightCompactionTrigger: params.preflightCompactionTrigger,
            },
            runtimeSettings: contextEngineRuntimeSettings,
          },
          resolveCompactionTimeoutMs(params.config),
          params.abortSignal,
        );
      } catch (compactErr) {
        log.warn("context-engine compaction failed", {
          errorMessage: formatErrorMessage(compactErr),
        });
        result = {
          ok: false,
          compacted: false,
          reason: formatErrorMessage(compactErr),
        };
      }
      let successor: Pick<
        AcceptedCompactionSuccessor,
        "sessionId" | "sessionFile" | "sessionTarget"
      > &
        Partial<Pick<AcceptedCompactionSuccessor, "entry">> = {
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        sessionTarget: runtimeTarget,
      };
      let tokensAfter = result.result?.tokensAfter;
      if (result.ok && result.compacted) {
        const proposed = resolveCompactionSuccessorTranscript(result);
        const target = result.result?.sessionTarget;
        const sameTarget =
          (!proposed.sessionId || proposed.sessionId === runtimeTarget.sessionId) &&
          (!proposed.sessionFile || proposed.sessionFile === params.sessionFile) &&
          (!target?.agentId || target.agentId === runtimeTarget.agentId) &&
          (!target?.sessionKey || target.sessionKey === runtimeTarget.sessionKey) &&
          (!target?.storePath || target.storePath === runtimeTarget.storePath);
        // Completion survives cancellation; a proposed successor's token snapshot
        // belongs to that identity only after the host accepts it.
        tokensAfter = sameTarget ? result.result?.tokensAfter : undefined;
        try {
          successor = await acceptCompactionSuccessor({
            config: params.config,
            currentSessionFile: params.sessionFile,
            currentTarget: runtimeTarget,
            expectedEntry,
            assertActive: assertCallerActive,
            result,
            onCommitted: (accepted) => {
              expected = {
                sessionId: accepted.entry.sessionId,
                lifecycleRevision: accepted.entry.lifecycleRevision,
                activeWriterRunId: accepted.entry.activeWriterRunId,
              };
              host.onCommitted?.(accepted);
            },
          });
          tokensAfter = result.result?.tokensAfter;
        } catch (error) {
          if (!params.abortSignal?.aborted) {
            throw error;
          }
        }
      }
      const compactionKind: "context-engine" | "server-endpoint" =
        isRecord(result.result?.details) &&
        result.result.details.compactionKind === "server-endpoint" &&
        typeof tokensAfter === "number"
          ? "server-endpoint"
          : "context-engine";
      const hostCommit = successor.entry
        ? { entry: successor.entry, tokensAfter, compactionKind }
        : undefined;
      if (hostCommit) {
        await host.onHostCompactionCommitted?.(hostCommit);
      }
      const postCompactionSessionId = successor.sessionId;
      const postCompactionSessionFile = successor.sessionFile;
      const postCompactionSessionTarget = successor.sessionTarget;
      let secondaryNativeHarnessCompaction: EmbeddedAgentCompactResult | undefined;
      try {
        if (result.ok && result.compacted && canContinue()) {
          const checkpointContext = createTranscriptWriteContext(
            postCompactionSessionTarget,
            expected,
            params.abortSignal,
          );
          checkpointSnapshotRetained = await withOwnedSessionTranscriptWrites(
            checkpointContext,
            () =>
              persistCompactionCheckpoint({
                config: params.config,
                sessionKey: params.sessionKey,
                sessionId: postCompactionSessionId,
                trigger: params.trigger,
                snapshot: checkpointSnapshot,
                summary: result.result?.summary,
                firstKeptEntryId: result.result?.firstKeptEntryId,
                tokensBefore: result.result?.tokensBefore,
                tokensAfter: result.result?.tokensAfter,
                sessionFile: postCompactionSessionFile,
                sessionTarget: postCompactionSessionTarget,
              }),
          );
        }
        if (result.ok && result.compacted && canContinue() && contextEngine.maintain) {
          const rewriteContext = createTranscriptWriteContext(
            postCompactionSessionTarget,
            expected,
            params.abortSignal,
          );
          const sessionManager = SessionManager.open(
            postCompactionSessionTarget,
            resolvedWorkspaceDir,
          );
          const maintenance = runContextEngineMaintenance({
            contextEngine,
            sessionId: postCompactionSessionId,
            sessionKey: contextEngineSessionKey ?? params.sessionKey,
            sessionTarget: projectQueuedCompactionSessionTarget({
              ...params,
              sessionFile: postCompactionSessionFile,
              sessionId: postCompactionSessionId,
              sessionTarget: postCompactionSessionTarget,
            }),
            sessionFile: postCompactionSessionFile,
            reason: "compaction",
            sessionManager,
            withSessionManagerRewriteLock: async (operation) =>
              await withOwnedSessionTranscriptWrites(rewriteContext, async () => {
                rewriteContext.assertCommitAllowed();
                sessionManager.reloadPersistedTranscript();
                rewriteContext.assertCommitAllowed();
                return await operation();
              }),
            runtimeContext,
            runtimeSettings: contextEngineRuntimeSettings,
            config: params.config,
            contextEngineAgentId: params.contextEngineAgentId,
            assertActive: rewriteContext.assertCommitAllowed,
            abortSignal: params.abortSignal,
          });
          try {
            await maintenance;
          } finally {
            if (hostCommit) {
              // A rewrite can commit before cancellation is observed. Reconcile transcript
              // state before hooks or native sync; the host callback keeps the writer fence.
              await host.onHostCompactionTranscriptSettled?.(hostCommit);
            }
          }
        }
        if (engineOwnsCompaction && result.ok && result.compacted && canContinue()) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: postCompactionSessionId,
            agentId: sessionAgentId,
            sessionFile: postCompactionSessionFile,
            assertActive,
          });
        }
        if (
          result.ok &&
          canContinue() &&
          hookRunner?.hasHooks?.("after_compaction") &&
          hookRunner.runAfterCompaction
        ) {
          try {
            const afterHookCtx = {
              ...hookCtx,
              sessionId: postCompactionSessionId,
            };
            await hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: result.compacted ? -1 : 0,
                tokenCount: result.result?.tokensAfter,
                sessionFile: postCompactionSessionFile,
                ...(postCompactionSessionId !== params.sessionId
                  ? { previousSessionId: params.sessionId }
                  : {}),
              },
              afterHookCtx,
            );
          } catch (err) {
            log.warn("after_compaction hook failed", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
        if (
          (engineOwnsCompaction || transcriptBytePreflightAuthority) &&
          result.ok &&
          result.compacted &&
          canContinue() &&
          attemptNativeHarnessCompaction
        ) {
          try {
            // Committed host compaction stays authoritative; secondary native failure is
            // diagnostic-only in result details and must not trigger a retry.
            // The native bridge owns its terminal-event watchdog. Keep this lane held until
            // that bridge settles; an outer timeout would release transcript ownership while
            // the harness could still be compacting the same session.
            secondaryNativeHarnessCompaction = await maybeCompactAgentHarnessSession(
              {
                ...preparedParams,
                sessionId: postCompactionSessionId,
                sessionFile: postCompactionSessionFile,
                sessionTarget: postCompactionSessionTarget,
                ...(successor.entry
                  ? { sessionEntry: projectPublicSessionEntry(successor.entry) }
                  : {}),
                runtimeModel: effectiveRuntimeModel,
                contextEngine,
                contextTokenBudget,
                contextEngineRuntimeContext,
              },
              { nativeCompactionRequest: "after_context_engine", preparedModelRuntime },
            );
            if (secondaryNativeHarnessCompaction && !secondaryNativeHarnessCompaction.ok) {
              log.warn(
                "secondary native harness compaction failed after context-engine compaction",
                {
                  reason: secondaryNativeHarnessCompaction.reason,
                },
              );
            }
          } catch (err) {
            secondaryNativeHarnessCompaction = {
              ok: false,
              compacted: false,
              reason: formatErrorMessage(err),
            };
            log.warn("secondary native harness compaction threw after context-engine compaction", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
      } catch (error) {
        if (canContinue()) {
          throw error;
        }
        // An abort during maintenance cannot erase the compaction that already completed.
      }
      const secondaryNativeDetailsKey =
        normalizeOptionalAgentRuntimeId(preparedHarnessRuntime) === "codex"
          ? "codexNativeCompaction"
          : "nativeHarnessCompaction";
      return {
        ok: result.ok,
        compacted: result.compacted,
        compactionKind,
        reason: result.reason,
        result: result.result
          ? {
              ...(compactionKind === "server-endpoint"
                ? { kind: "server-endpoint" as const }
                : {
                    summary: result.result.summary ?? "",
                    firstKeptEntryId: result.result.firstKeptEntryId ?? "",
                  }),
              tokensBefore: result.result.tokensBefore,
              tokensAfter,
              details: mergeSecondaryNativeHarnessCompactionDetails({
                details: result.result.details,
                nativeResult: secondaryNativeHarnessCompaction,
                detailsKey: secondaryNativeDetailsKey,
              }),
              ...(postCompactionSessionId !== params.sessionId
                ? { sessionId: postCompactionSessionId }
                : {}),
              ...(postCompactionSessionFile !== params.sessionFile
                ? { sessionFile: postCompactionSessionFile }
                : {}),
            }
          : undefined,
      };
    } finally {
      closed = true;
      if (!checkpointSnapshotRetained) {
        await compactionCheckpointStore.cleanupSnapshot(checkpointSnapshot);
      }
    }
  });
}

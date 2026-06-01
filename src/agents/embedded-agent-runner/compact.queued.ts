import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  captureCompactionCheckpointSnapshotAsync,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
  readSessionLeafIdFromTranscriptAsync,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { isRecoverableNativeHarnessBindingFailure } from "../harness/compaction-recovery.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import {
  maybeCompactAgentHarnessSession,
  resolveAgentHarnessPolicy,
} from "../harness/selection.js";
import { isOpenAIProvider } from "../openai-routing.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON } from "./compact-reasons.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { asCompactionHookRunner, runPostCompactionSideEffects } from "./compaction-hooks.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import {
  rotateTranscriptFileAfterCompaction,
  shouldRotateCompactionTranscript,
} from "./compaction-successor-transcript.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { readAgentModelContextTokens } from "./model-context-tokens.js";
import { resolveModelAsync } from "./model.js";
import type { EmbeddedAgentCompactResult } from "./types.js";
import { normalizeContextTokenBudget } from "./utils.js";

function shouldFallbackAfterHarnessCompaction(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return isRecoverableNativeHarnessBindingFailure(result);
}

const DEFERRED_CONTEXT_ENGINE_COMPACTION_SCHEDULE_FAILURE_REASON =
  "failed to schedule background context-engine maintenance";

function shouldDeferOwningContextEngineBudgetCompaction(params: {
  compactParams: CompactEmbeddedAgentSessionParams;
  contextEngine: ContextEngine;
}): boolean {
  // Request-time budget compaction for context-engine-owned transcripts can
  // spend the whole reply preflight budget. Only defer engines that explicitly
  // advertise background turn maintenance, leaving native/current-session
  // harness compaction synchronous.
  return (
    params.compactParams.deferOwningContextEngineCompaction === true &&
    params.compactParams.trigger === "budget" &&
    params.contextEngine.info.ownsCompaction === true &&
    params.contextEngine.info.turnMaintenanceMode === "background" &&
    typeof params.contextEngine.maintain === "function"
  );
}

async function disposeContextEngine(contextEngine: ContextEngine): Promise<void> {
  try {
    await contextEngine.dispose?.();
  } catch (err) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(err),
    });
  }
}

async function deferOwningContextEngineBudgetCompaction(params: {
  compactParams: CompactEmbeddedAgentSessionParams;
  contextEngine: ContextEngine;
  contextEngineRuntimeContext: ContextEngineRuntimeContext;
}): Promise<EmbeddedAgentCompactResult> {
  let deferredScheduled = false;
  let deferredScheduleFailure: unknown;
  try {
    await runContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.compactParams.sessionId,
      sessionKey: params.compactParams.sessionKey,
      sessionFile: params.compactParams.sessionFile,
      reason: "turn",
      runtimeContext: params.contextEngineRuntimeContext,
      config: params.compactParams.config,
      disposeDeferredContextEngineAfterMaintenance: true,
      onDeferredMaintenance: () => {
        deferredScheduled = true;
      },
      onDeferredMaintenanceFailure: (error) => {
        deferredScheduleFailure = error;
      },
    });
  } catch (err) {
    log.warn("failed to defer context-engine budget compaction", {
      errorMessage: formatErrorMessage(err),
    });
  }

  if (!deferredScheduled || deferredScheduleFailure) {
    await disposeContextEngine(params.contextEngine);
    log.warn(
      `[compaction] failed to schedule context-engine-owned budget compaction background maintenance ` +
        `(sessionKey=${params.compactParams.sessionKey ?? params.compactParams.sessionId}` +
        `${deferredScheduleFailure ? ` error=${formatErrorMessage(deferredScheduleFailure)}` : ""})`,
    );
    return {
      ok: false,
      compacted: false,
      reason: DEFERRED_CONTEXT_ENGINE_COMPACTION_SCHEDULE_FAILURE_REASON,
      failure: { reason: "deferred_compaction_not_scheduled" },
    };
  }

  log.info(
    `[compaction] deferred context-engine-owned budget compaction to background maintenance ` +
      `(sessionKey=${params.compactParams.sessionKey ?? params.compactParams.sessionId} ` +
      `scheduled=${String(deferredScheduled)})`,
  );
  return {
    ok: true,
    compacted: false,
    reason: DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON,
  };
}

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedAgentSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedAgentSession(
  params: CompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult> {
  ensureRuntimePluginsLoaded({
    config: params.config,
    workspaceDir: params.workspaceDir,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  ensureContextEnginesInitialized();
  const agentIds = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, agentIds.sessionAgentId);
  const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
  const contextEngine = await resolveContextEngine(params.config, {
    agentDir,
    workspaceDir: resolvedWorkspaceDir,
  });
  const runtimePolicySessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const runtimePolicyAgentId =
    params.sandboxSessionKey && parseAgentSessionKey(params.sandboxSessionKey)
      ? undefined
      : params.agentId;
  const policyCompactionTarget = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.model,
    authProfileId: params.authProfileId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configuredHarnessPolicy = resolveAgentHarnessPolicy({
    provider: policyCompactionTarget.provider ?? DEFAULT_PROVIDER,
    modelId: policyCompactionTarget.model ?? DEFAULT_MODEL,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
  });
  const configuredHarnessRuntime =
    configuredHarnessPolicy.runtimeSource &&
    configuredHarnessPolicy.runtimeSource !== "implicit" &&
    !isDefaultAgentRuntimeId(configuredHarnessPolicy.runtime)
      ? configuredHarnessPolicy.runtime
      : undefined;
  // The persisted harness id is the runtime contract for this session; config
  // changes can supply a runtime only when the session has no concrete pin.
  const selectedHarnessRuntime = params.agentHarnessId ?? configuredHarnessRuntime;
  const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.model,
    authProfileId: params.authProfileId,
    harnessRuntime: selectedHarnessRuntime,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const ceProvider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
  const ceRuntimeProvider = resolvedCompactionTarget.runtimeProvider ?? ceProvider;
  const ceContextConfigProvider = resolvedCompactionTarget.contextProvider ?? ceProvider;
  const ceModelId = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
  const attemptNativeHarnessCompaction = shouldAttemptNativeHarnessCompaction({
    provider: ceProvider,
    contextProvider: resolvedCompactionTarget.contextProvider,
    selectedHarnessRuntime,
  });
  if (attemptNativeHarnessCompaction) {
    await ensureSelectedAgentHarnessPlugin({
      config: params.config,
      provider: ceProvider,
      modelId: ceModelId,
      agentId: runtimePolicyAgentId,
      sessionKey: runtimePolicySessionKey,
      agentHarnessRuntimeOverride: selectedHarnessRuntime,
      workspaceDir: resolvedWorkspaceDir,
    });
  }
  const { model: ceModel } = await resolveModelAsync(
    ceRuntimeProvider,
    ceModelId,
    agentDir,
    params.config,
  );
  const ceRuntimeModel = ceModel as ProviderRuntimeModel | undefined;
  const resolvedContextTokenBudget =
    normalizeContextTokenBudget(
      resolveContextWindowInfo({
        cfg: params.config,
        provider: ceContextConfigProvider,
        modelId: ceModelId,
        modelContextTokens: readAgentModelContextTokens(ceModel),
        modelContextWindow: ceRuntimeModel?.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      }).tokens,
    ) ?? DEFAULT_CONTEXT_TOKENS;
  const requestedContextTokenBudget = normalizeContextTokenBudget(params.contextTokenBudget);
  const contextTokenBudget = Math.min(
    requestedContextTokenBudget ?? resolvedContextTokenBudget,
    resolvedContextTokenBudget,
  );
  const contextEngineRuntimeContext = buildCompactionContextEngineRuntimeContext({
    params,
    agentDir,
    harnessRuntime: selectedHarnessRuntime,
    contextTokenBudget,
    contextEnginePluginId: resolveContextEngineOwnerPluginId(contextEngine),
  });
  const harnessResult = attemptNativeHarnessCompaction
    ? await maybeCompactAgentHarnessSession({
        ...params,
        contextEngine,
        contextTokenBudget,
        contextEngineRuntimeContext,
      })
    : undefined;
  if (harnessResult) {
    if (!shouldFallbackAfterHarnessCompaction(harnessResult)) {
      await contextEngine.dispose?.();
      return harnessResult;
    }
    log.warn(
      `native harness compaction could not use its session binding; falling back to context engine: ${harnessResult.reason ?? "unknown"}`,
    );
  }
  if (
    shouldDeferOwningContextEngineBudgetCompaction({
      compactParams: params,
      contextEngine,
    })
  ) {
    return await deferOwningContextEngineBudgetCompaction({
      compactParams: params,
      contextEngine,
      contextEngineRuntimeContext,
    });
  }
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null | undefined;
      let checkpointSnapshotRetained = false;
      try {
        // When the context engine owns compaction, its compact() implementation
        // bypasses compactEmbeddedAgentSessionDirect (which fires the hooks internally).
        // Fire before_compaction / after_compaction hooks here so plugin subscribers
        // are notified regardless of which engine is active.
        const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
        checkpointSnapshot = engineOwnsCompaction
          ? await captureCompactionCheckpointSnapshotAsync({
              sessionFile: params.sessionFile,
            })
          : null;
        const hookRunner = engineOwnsCompaction
          ? asCompactionHookRunner(getGlobalHookRunner())
          : null;
        const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
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
        // Bound the plugin-owned compaction with the same finite safety
        // timeout that protects native runtime compaction, and thread the
        // caller's abort signal through, so a slow/hung plugin compact()
        // cannot hang the queued /compact lane indefinitely. A timeout/abort
        // (or any thrown error) is surfaced as a clean { ok: false } result —
        // matching how the run-loop overflow/timeout lanes handle it — instead
        // of throwing a raw rejection at callers that only inspect result.ok.
        let result: Awaited<ReturnType<typeof contextEngine.compact>>;
        try {
          result = await compactContextEngineWithSafetyTimeout(
            contextEngine,
            {
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              sessionFile: params.sessionFile,
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
        const delegatedSessionId = result.result?.sessionId;
        const delegatedSessionFile = result.result?.sessionFile;
        const delegatedRotatedTranscript =
          (typeof delegatedSessionId === "string" && delegatedSessionId !== params.sessionId) ||
          (typeof delegatedSessionFile === "string" && delegatedSessionFile !== params.sessionFile);
        let postCompactionSessionId = delegatedSessionId ?? params.sessionId;
        let postCompactionSessionFile = delegatedSessionFile ?? params.sessionFile;
        let postCompactionLeafId: string | undefined;
        if (result.ok && result.compacted) {
          if (shouldRotateCompactionTranscript(params.config) && !delegatedRotatedTranscript) {
            try {
              const rotation = await rotateTranscriptFileAfterCompaction({
                sessionFile: params.sessionFile,
              });
              if (rotation.rotated) {
                postCompactionSessionId = rotation.sessionId ?? postCompactionSessionId;
                postCompactionSessionFile = rotation.sessionFile ?? postCompactionSessionFile;
                postCompactionLeafId = rotation.leafId;
                log.info(
                  `[compaction] rotated active transcript after context-engine compaction ` +
                    `(sessionKey=${params.sessionKey ?? params.sessionId})`,
                );
              }
            } catch (err) {
              log.warn("failed to rotate compacted transcript", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          if (params.config && params.sessionKey && checkpointSnapshot) {
            try {
              const postLeafId =
                postCompactionLeafId ??
                (await readSessionLeafIdFromTranscriptAsync(postCompactionSessionFile)) ??
                undefined;
              const storedCheckpoint = await persistSessionCompactionCheckpoint({
                cfg: params.config,
                sessionKey: params.sessionKey,
                sessionId: postCompactionSessionId,
                reason: resolveSessionCompactionCheckpointReason({
                  trigger: params.trigger,
                }),
                snapshot: checkpointSnapshot,
                summary: result.result?.summary,
                firstKeptEntryId: result.result?.firstKeptEntryId,
                tokensBefore: result.result?.tokensBefore,
                tokensAfter: result.result?.tokensAfter,
                postSessionFile: postCompactionSessionFile,
                postLeafId,
                postEntryId: postLeafId,
              });
              checkpointSnapshotRetained = storedCheckpoint !== null;
            } catch (err) {
              log.warn("failed to persist compaction checkpoint", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          await runContextEngineMaintenance({
            contextEngine,
            sessionId: postCompactionSessionId,
            sessionKey: params.sessionKey,
            sessionFile: postCompactionSessionFile,
            reason: "compaction",
            runtimeContext,
            config: params.config,
          });
        }
        if (engineOwnsCompaction && result.ok && result.compacted) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            agentId: sessionAgentId,
            sessionFile: postCompactionSessionFile,
          });
        }
        if (
          result.ok &&
          result.compacted &&
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
                compactedCount: -1,
                tokenCount: result.result?.tokensAfter,
                sessionFile: postCompactionSessionFile,
              },
              afterHookCtx,
            );
          } catch (err) {
            log.warn("after_compaction hook failed", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
        return {
          ok: result.ok,
          compacted: result.compacted,
          reason: result.reason,
          result: result.result
            ? {
                summary: result.result.summary ?? "",
                firstKeptEntryId: result.result.firstKeptEntryId ?? "",
                tokensBefore: result.result.tokensBefore,
                tokensAfter: result.result.tokensAfter,
                details: result.result.details,
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
        if (!checkpointSnapshotRetained) {
          await cleanupCompactionCheckpointSnapshot(checkpointSnapshot);
        }
        await contextEngine.dispose?.();
      }
    }),
  );
}

function shouldAttemptNativeHarnessCompaction(params: {
  provider: string;
  contextProvider?: string;
  selectedHarnessRuntime?: string | null;
}): boolean {
  const selectedRuntime = normalizeOptionalAgentRuntimeId(params.selectedHarnessRuntime);
  if (!selectedRuntime || selectedRuntime === "auto" || selectedRuntime === "openclaw") {
    return false;
  }
  return isOpenAIProvider(params.provider) ? params.contextProvider !== undefined : true;
}

function buildCompactionContextEngineRuntimeContext(params: {
  params: CompactEmbeddedAgentSessionParams;
  agentDir: string;
  harnessRuntime?: string;
  contextEnginePluginId?: string;
  contextTokenBudget?: number;
}): ContextEngineRuntimeContext {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.params.sessionKey,
    config: params.params.config,
    agentId: params.params.agentId,
  });
  return {
    ...params.params,
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.params.sessionKey,
      messageChannel: params.params.messageChannel,
      messageProvider: params.params.messageProvider,
      agentAccountId: params.params.agentAccountId,
      currentChannelId: params.params.currentChannelId,
      currentThreadTs: params.params.currentThreadTs,
      currentMessageId: params.params.currentMessageId,
      authProfileId: params.params.authProfileId,
      workspaceDir: params.params.workspaceDir,
      cwd: params.params.cwd,
      agentDir: params.agentDir,
      config: params.params.config,
      skillsSnapshot: params.params.skillsSnapshot,
      senderIsOwner: params.params.senderIsOwner,
      senderId: params.params.senderId,
      provider: params.params.provider,
      modelId: params.params.model,
      harnessRuntime: params.harnessRuntime,
      modelFallbacksOverride: params.params.modelFallbacksOverride,
      thinkLevel: params.params.thinkLevel,
      reasoningLevel: params.params.reasoningLevel,
      bashElevated: params.params.bashElevated,
      extraSystemPrompt: params.params.extraSystemPrompt,
      sourceReplyDeliveryMode: params.params.sourceReplyDeliveryMode,
      ownerNumbers: params.params.ownerNumbers,
    }),
    ...resolveContextEngineCapabilities({
      config: params.params.config,
      sessionKey: params.params.sessionKey,
      agentId: sessionAgentId,
      authProfileId: params.params.authProfileId,
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: "context-engine.compaction",
    }),
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.params.currentTokenCount,
  };
}

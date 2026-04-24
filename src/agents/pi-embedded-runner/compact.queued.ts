import { SessionManager } from "@mariozechner/pi-coding-agent";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { resolveUserPath } from "../../utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { maybeCompactAgentHarnessSession } from "../harness/selection.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import type { CompactEmbeddedPiSessionParams } from "./compact.types.js";
import { asCompactionHookRunner, runPostCompactionSideEffects } from "./compaction-hooks.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { readPiModelContextTokens } from "./model-context-tokens.js";
import { resolveModelAsync } from "./model.js";
import type { EmbeddedPiCompactResult } from "./types.js";

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedPiSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedPiSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult> {
  ensureRuntimePluginsLoaded({
    config: params.config,
    workspaceDir: params.workspaceDir,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  ensureContextEnginesInitialized();
  const contextEngine = await resolveContextEngine(params.config);
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  let contextTokenBudget = params.contextTokenBudget;
  if (!contextTokenBudget || !Number.isFinite(contextTokenBudget) || contextTokenBudget <= 0) {
    const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
      config: params.config,
      provider: params.provider,
      modelId: params.model,
      authProfileId: params.authProfileId,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const ceProvider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
    const ceModelId = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
    const { model: ceModel } = await resolveModelAsync(
      ceProvider,
      ceModelId,
      agentDir,
      params.config,
    );
    const ceRuntimeModel = ceModel as ProviderRuntimeModel | undefined;
    contextTokenBudget = resolveContextWindowInfo({
      cfg: params.config,
      provider: ceProvider,
      modelId: ceModelId,
      modelContextTokens: readPiModelContextTokens(ceModel),
      modelContextWindow: ceRuntimeModel?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    }).tokens;
  }
  const contextEngineRuntimeContext = buildCompactionContextEngineRuntimeContext({
    params,
    agentDir,
    contextTokenBudget,
  });
  const harnessResult = await maybeCompactAgentHarnessSession({
    ...params,
    contextEngine,
    contextTokenBudget,
    contextEngineRuntimeContext,
  });
  if (harnessResult) {
    await contextEngine.dispose?.();
    return harnessResult;
  }
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null = null;
      let checkpointSnapshotRetained = false;
      try {
        // When the context engine owns compaction, its compact() implementation
        // bypasses compactEmbeddedPiSessionDirect (which fires the hooks internally).
        // Fire before_compaction / after_compaction hooks here so plugin subscribers
        // are notified regardless of which engine is active.
        const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
        checkpointSnapshot = engineOwnsCompaction
          ? captureCompactionCheckpointSnapshot({
              sessionManager: SessionManager.open(params.sessionFile),
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
        });
        const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
        const hookCtx = {
          sessionId: params.sessionId,
          agentId: sessionAgentId,
          sessionKey: hookSessionKey,
          workspaceDir: resolveUserPath(params.workspaceDir),
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
        const result = await contextEngine.compact({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          tokenBudget: contextTokenBudget,
          currentTokenCount: params.currentTokenCount,
          compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
          customInstructions: params.customInstructions,
          force: params.trigger === "manual",
          runtimeContext,
        });
        if (result.ok && result.compacted) {
          if (params.config && params.sessionKey && checkpointSnapshot) {
            try {
              const postCompactionSession = SessionManager.open(params.sessionFile);
              const postLeafId = postCompactionSession.getLeafId() ?? undefined;
              const storedCheckpoint = await persistSessionCompactionCheckpoint({
                cfg: params.config,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                reason: resolveSessionCompactionCheckpointReason({
                  trigger: params.trigger,
                }),
                snapshot: checkpointSnapshot,
                summary: result.result?.summary,
                firstKeptEntryId: result.result?.firstKeptEntryId,
                tokensBefore: result.result?.tokensBefore,
                tokensAfter: result.result?.tokensAfter,
                postSessionFile: params.sessionFile,
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
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            reason: "compaction",
            runtimeContext,
          });
        }
        if (engineOwnsCompaction && result.ok && result.compacted) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
          });
        }
        if (
          result.ok &&
          result.compacted &&
          hookRunner?.hasHooks?.("after_compaction") &&
          hookRunner.runAfterCompaction
        ) {
          try {
            await hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: -1,
                tokenCount: result.result?.tokensAfter,
                sessionFile: params.sessionFile,
              },
              hookCtx,
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

function buildCompactionContextEngineRuntimeContext(params: {
  params: CompactEmbeddedPiSessionParams;
  agentDir: string;
  contextTokenBudget?: number;
}): ContextEngineRuntimeContext {
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
      agentDir: params.agentDir,
      config: params.params.config,
      skillsSnapshot: params.params.skillsSnapshot,
      senderIsOwner: params.params.senderIsOwner,
      senderId: params.params.senderId,
      provider: params.params.provider,
      modelId: params.params.model,
      thinkLevel: params.params.thinkLevel,
      reasoningLevel: params.params.reasoningLevel,
      bashElevated: params.params.bashElevated,
      extraSystemPrompt: params.params.extraSystemPrompt,
      ownerNumbers: params.params.ownerNumbers,
    }),
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.params.currentTokenCount,
  };
}

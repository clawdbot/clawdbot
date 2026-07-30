/** Installs attempt-local context engine, tool-result, image, and frame guards. */
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { invalidateComputerFrameIfMissing } from "../../tools/computer-tool.js";
import { readLastCacheTtlTimestamp } from "../cache-ttl.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "../tool-result-context-guard.js";
import { resolveLiveToolResultMaxChars } from "../tool-result-truncation.js";
import { repairAttemptToolUseResultPairing } from "./attempt-transcript-helpers.js";
import { buildLoopPromptCacheInfo } from "./attempt.context-engine-helpers.js";
import { buildAfterTurnRuntimeContext } from "./attempt.prompt-helpers.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type PromptCacheRetention = Parameters<typeof buildLoopPromptCacheInfo>[0]["retention"];

export function installEmbeddedAttemptContextGuards(input: {
  activeContextEngine?: ContextEngine;
  activeSession: AgentSession;
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  computerContextEpoch: { value: number };
  effectiveCwd: string;
  effectiveFsWorkspaceOnly: boolean;
  effectiveWorkspace: string;
  getPrePromptMessageCount: () => number;
  getPromptCache: () => EmbeddedRunAttemptResult["promptCache"];
  getPromptCacheRetention: () => PromptCacheRetention;
  getSystemPrompt: () => string;
  isOpenAIResponsesApi: boolean;
  repairToolUseResultPairing: boolean;
  sessionAgentId: string;
  sessionManager: ReturnType<typeof guardSessionManager>;
  settingsManager: AgentSession["settingsManager"];
  sandbox?: SandboxContext | null;
}): {
  getAfterTurnCheckpoint: () => number | null;
  remove: () => void;
  takePendingMidTurnPrecheckRequest: () => MidTurnPrecheckRequest | null;
} {
  const { activeContextEngine, activeSession, attempt, settingsManager } = input;
  const contextTokenBudget = Math.max(
    1,
    Math.floor(
      attempt.contextTokenBudget ??
        attempt.model.contextWindow ??
        attempt.model.maxTokens ??
        DEFAULT_CONTEXT_TOKENS,
    ),
  );
  const toolResultMaxChars = resolveLiveToolResultMaxChars({
    contextWindowTokens: contextTokenBudget,
  });
  let pendingMidTurnPrecheckRequest: MidTurnPrecheckRequest | null = null;
  let afterTurnCheckpoint: number | null = null;
  const midTurnPrecheckOptions =
    attempt.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true
      ? {
          midTurnPrecheck: {
            enabled: true,
            contextTokenBudget,
            reserveTokens: () => settingsManager.getCompactionReserveTokens(),
            toolResultMaxChars,
            getSystemPrompt: input.getSystemPrompt,
            getPrePromptMessageCount: input.getPrePromptMessageCount,
            onMidTurnPrecheck: (request: MidTurnPrecheckRequest) => {
              pendingMidTurnPrecheckRequest = request;
            },
          },
        }
      : {};

  let removeLoopGuard: () => void;
  if (activeContextEngine?.info.ownsCompaction === true) {
    const selectedContextEngineId = activeContextEngine.info.id;
    const runtimeSettings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      provider: attempt.provider,
      requestedModel: attempt.requestedModelId,
      resolvedModel: attempt.modelId,
      selectedContextEngineId,
      contextEngineSelectionSource: selectedContextEngineId === "legacy" ? "default" : "configured",
      promptTokenBudget: attempt.contextTokenBudget,
      fallbackReason: attempt.fallbackReason,
      degradedReason: attempt.degradedReason,
    });
    const removeContextEngineLoopHook = installContextEngineLoopHook({
      agent: activeSession.agent,
      contextEngine: activeContextEngine,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
      sessionFile: attempt.sessionFile,
      tokenBudget: attempt.contextTokenBudget,
      modelId: attempt.modelId,
      ...(input.repairToolUseResultPairing
        ? {
            repairAssembledMessages: (messages) =>
              repairAttemptToolUseResultPairing(messages, input.isOpenAIResponsesApi),
          }
        : {}),
      getPrePromptMessageCount: input.getPrePromptMessageCount,
      onAfterTurnCheckpoint: (messageCount) => {
        afterTurnCheckpoint = messageCount;
      },
      getRuntimeContext: ({ messages, prePromptMessageCount }) =>
        buildAfterTurnRuntimeContext({
          attempt,
          workspaceDir: input.effectiveWorkspace,
          cwd: input.effectiveCwd,
          agentDir: input.agentDir,
          tokenBudget: attempt.contextTokenBudget,
          promptCache:
            input.getPromptCache() ??
            buildLoopPromptCacheInfo({
              messagesSnapshot: messages,
              prePromptMessageCount,
              retention: input.getPromptCacheRetention(),
              fallbackLastCacheTouchAt: readLastCacheTtlTimestamp(input.sessionManager, {
                provider: attempt.provider,
                modelId: attempt.modelId,
              }),
            }),
        }),
      runtimeSettings,
      isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
    });
    const removeToolResultGuard = installToolResultContextGuard({
      agent: activeSession.agent,
      contextWindowTokens: contextTokenBudget,
      ...midTurnPrecheckOptions,
    });
    removeLoopGuard = () => {
      removeToolResultGuard();
      removeContextEngineLoopHook();
    };
  } else {
    removeLoopGuard = installToolResultContextGuard({
      agent: activeSession.agent,
      contextWindowTokens: contextTokenBudget,
      ...midTurnPrecheckOptions,
    });
  }

  const removeHistoryImagePruneContextTransform = installHistoryImagePruneContextTransform(
    activeSession.agent,
    {
      workspaceDir: input.effectiveWorkspace,
      model: attempt.model,
      maxBytes: MAX_IMAGE_BYTES,
      maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
      workspaceOnly: input.effectiveFsWorkspaceOnly,
      sandbox:
        input.sandbox?.enabled && input.sandbox.fsBridge
          ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
          : undefined,
    },
  );
  const previousComputerFrameTransform = activeSession.agent.transformContext;
  activeSession.agent.transformContext = async (messages, signal) => {
    const transformed = previousComputerFrameTransform
      ? await previousComputerFrameTransform.call(activeSession.agent, messages, signal)
      : messages;
    const modelContext = Array.isArray(transformed) ? transformed : messages;
    invalidateComputerFrameIfMissing({
      contextEpoch: input.computerContextEpoch,
      messages: modelContext,
      imagesBlocked: settingsManager.getBlockImages(),
    });
    return modelContext;
  };

  return {
    getAfterTurnCheckpoint: () => afterTurnCheckpoint,
    remove: () => {
      activeSession.agent.transformContext = previousComputerFrameTransform;
      removeHistoryImagePruneContextTransform();
      removeLoopGuard();
    },
    takePendingMidTurnPrecheckRequest: () => {
      const request = pendingMidTurnPrecheckRequest;
      pendingMidTurnPrecheckRequest = null;
      return request;
    },
  };
}

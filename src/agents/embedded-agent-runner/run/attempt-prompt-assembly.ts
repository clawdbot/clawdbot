/**
 * Assembles hook, orphan-repair, steering, and cache inputs for one prompt.
 */
import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../../config/config.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { annotateInterSessionPromptText } from "../../../sessions/input-provenance.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { describeProviderRequestRoutingSummary } from "../../provider-attribution.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import {
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
} from "../../subagent-registry.js";
import {
  appendModelIdentitySystemPrompt,
  buildModelIdentityPromptLine,
} from "../../system-prompt.js";
import { log } from "../logger.js";
import {
  beginPromptCacheObservation,
  type PromptCacheChange,
} from "../prompt-cache-observability.js";
import type { resolveOrphanRepairPlan } from "./attempt-orphan-repair.js";
import {
  prependSystemPromptAddition,
  resolveAttemptMediaTaskSystemPromptAddition,
  resolvePromptBuildHookResult,
  shouldWarnOnOrphanedUserRepair,
} from "./attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type CacheTrace = ReturnType<typeof createCacheTrace>;
type OrphanRepairPlan = ReturnType<typeof resolveOrphanRepairPlan>;
type CacheRetention = Parameters<typeof beginPromptCacheObservation>[0]["cacheRetention"];
type PromptBuildHookContext = Parameters<typeof resolvePromptBuildHookResult>[0]["hookCtx"];

type EmbeddedAttemptSteeringLease = {
  leaseId: string;
  runIds: string[];
};

type EmbeddedAttemptPromptAssembly = {
  hookCtx: PromptBuildHookContext;
  effectivePrompt: string;
  promptBeforePromptBuildHooks: string;
  promptBuildPrependContext?: string;
  promptBuildAppendContext?: string;
  hasPromptBuildContext: boolean;
  effectiveTranscriptPrompt?: string;
  transcriptPromptForRuntimeSplit?: string;
  promptForRuntimeContextSplit: string;
  promptForModelBeforeRuntimeContextSplit: string;
  promptForRuntimeContextBeforeAnnotation: string;
  transcriptLeafId: string | null;
  heartbeatSummary?: ReturnType<typeof resolveHeartbeatSummaryForAgent>;
  promptCacheChangesForTurn: PromptCacheChange[] | null;
  leasedSteering?: EmbeddedAttemptSteeringLease;
};

export async function prepareEmbeddedAttemptPromptAssembly(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  hookRunner: HookRunner;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  isRawModelRun: boolean;
  orphanRepair?: OrphanRepairPlan;
  sessionAgentId: string;
  runtimeModel: string;
  systemPromptText: string;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
  setLeasedSteering: (lease: EmbeddedAttemptSteeringLease) => void;
  cache: {
    observabilityEnabled: boolean;
    retention: CacheRetention;
    streamStrategy: string;
    transport: AgentSession["agent"]["transport"];
    toolNames: string[];
    trace: CacheTrace;
  };
}): Promise<EmbeddedAttemptPromptAssembly> {
  const { attempt } = input;
  let systemPromptText = input.systemPromptText;
  const setSystemPrompt = (next: string) => {
    systemPromptText = next;
    input.setActiveSessionSystemPrompt(next);
  };
  let effectivePrompt = attempt.prompt;
  const hookCtx = {
    runId: attempt.runId,
    trace: freezeDiagnosticTraceContext(input.diagnosticTrace),
    agentId: input.hookAgentId,
    sessionKey: attempt.sessionKey,
    sessionId: attempt.sessionId,
    workspaceDir: attempt.workspaceDir,
    modelProviderId: attempt.model.provider,
    modelId: attempt.model.id,
    trigger: attempt.trigger,
    ...buildAgentHookContextChannelFields(attempt),
    ...buildAgentHookContextIdentityFields({
      trigger: attempt.trigger,
      senderId: attempt.senderId,
      chatId: attempt.chatId,
      channelContext: attempt.channelContext,
    }),
  };
  const promptBuildMessages =
    pruneProcessedHistoryImages(input.activeSession.messages) ?? input.activeSession.messages;
  const hookResult = input.isRawModelRun
    ? undefined
    : await resolvePromptBuildHookResult({
        config: attempt.config ?? getRuntimeConfig(),
        prompt: attempt.prompt,
        messages: promptBuildMessages,
        hookCtx,
        hookRunner: input.hookRunner,
        bootstrapContextRunKind: attempt.bootstrapContextRunKind,
      });
  const promptBeforePromptBuildHooks = effectivePrompt;
  const promptBuildPrependContext = hookResult?.prependContext;
  const promptBuildAppendContext = hookResult?.appendContext;
  const hasPromptBuildContext =
    Boolean(promptBuildPrependContext?.trim()) || Boolean(promptBuildAppendContext?.trim());

  if (hookResult?.prependContext) {
    effectivePrompt = `${hookResult.prependContext}\n\n${effectivePrompt}`;
    log.debug(`hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`);
  }
  if (hookResult?.appendContext) {
    effectivePrompt = `${effectivePrompt}\n\n${hookResult.appendContext}`;
    log.debug(`hooks: appended context to prompt (${hookResult.appendContext.length} chars)`);
  }
  const legacySystemPrompt = normalizeOptionalString(hookResult?.systemPrompt) ?? "";
  if (legacySystemPrompt) {
    setSystemPrompt(legacySystemPrompt);
    log.debug(`hooks: applied systemPrompt (${legacySystemPrompt.length} chars)`);
  }
  const composedSystemPrompt = composeSystemPromptWithHookContext({
    baseSystemPrompt: systemPromptText,
    prependSystemContext: hookResult?.prependSystemContext,
    appendSystemContext: hookResult?.appendSystemContext,
  });
  if (composedSystemPrompt) {
    setSystemPrompt(composedSystemPrompt);
    log.debug(
      `hooks: applied prependSystemContext/appendSystemContext ` +
        `(${hookResult?.prependSystemContext?.trim().length ?? 0}+${hookResult?.appendSystemContext?.trim().length ?? 0} chars)`,
    );
  }
  const mediaTaskSystemPromptAddition = resolveAttemptMediaTaskSystemPromptAddition({
    sessionKey: attempt.sessionKey,
    trigger: attempt.trigger,
  });
  if (mediaTaskSystemPromptAddition) {
    setSystemPrompt(
      prependSystemPromptAddition({
        systemPrompt: ensureSystemPromptCacheBoundary(systemPromptText),
        systemPromptAddition: mediaTaskSystemPromptAddition,
      }),
    );
  }

  // Keep model identity after the stable cache boundary so media-only dynamic
  // context cannot change the cached prefix between adjacent turns.
  const modelAwareSystemPrompt = appendModelIdentitySystemPrompt({
    systemPrompt:
      buildModelIdentityPromptLine(input.runtimeModel) && systemPromptText.trim().length > 0
        ? ensureSystemPromptCacheBoundary(systemPromptText)
        : systemPromptText,
    model: input.runtimeModel,
  });
  if (modelAwareSystemPrompt !== systemPromptText) {
    setSystemPrompt(modelAwareSystemPrompt);
  }

  let promptCacheChangesForTurn: PromptCacheChange[] | null = null;
  if (input.cache.observabilityEnabled) {
    const cacheObservation = beginPromptCacheObservation({
      sessionId: attempt.sessionId,
      promptCacheKey: attempt.promptCacheKey,
      sessionKey: attempt.sessionKey,
      provider: attempt.provider,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      cacheRetention: input.cache.retention,
      streamStrategy: input.cache.streamStrategy,
      transport: input.cache.transport,
      systemPrompt: systemPromptText,
      toolNames: input.cache.toolNames,
    });
    promptCacheChangesForTurn = cacheObservation.changes;
    input.cache.trace?.recordStage("cache:state", {
      options: {
        snapshot: cacheObservation.snapshot,
        previousCacheRead: cacheObservation.previousCacheRead ?? undefined,
        changes: cacheObservation.changes?.map((change) => ({
          code: change.code,
          detail: change.detail,
        })),
      },
    });
  }

  const routingSummary = describeProviderRequestRoutingSummary({
    provider: attempt.provider,
    api: attempt.model.api,
    baseUrl: attempt.model.baseUrl,
    capability: "llm",
    transport: "stream",
  });
  log.debug(
    `embedded run prompt start: runId=${attempt.runId} sessionId=${attempt.sessionId} ${routingSummary}`,
  );

  const effectiveTranscriptPrompt = attempt.transcriptPrompt;
  let transcriptPromptForRuntimeSplit = effectiveTranscriptPrompt;
  let promptForRuntimeContextSplit = promptBeforePromptBuildHooks;
  const leafEntry = input.orphanRepair?.messageEntry;
  if (leafEntry && input.orphanRepair) {
    const messageMergeStrategy = input.orphanRepair.strategy;
    const orphanPromptMerge = messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
      prompt: effectivePrompt,
      trigger: attempt.trigger,
      leafMessage: leafEntry.message,
    });
    const runtimePromptMerge = messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
      prompt: promptForRuntimeContextSplit,
      trigger: attempt.trigger,
      leafMessage: leafEntry.message,
    });
    const transcriptPromptMerge =
      effectiveTranscriptPrompt === undefined
        ? undefined
        : messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
            prompt: effectiveTranscriptPrompt,
            trigger: attempt.trigger,
            leafMessage: leafEntry.message,
          });
    effectivePrompt = orphanPromptMerge.prompt;
    promptForRuntimeContextSplit = runtimePromptMerge.prompt;
    transcriptPromptForRuntimeSplit =
      transcriptPromptMerge?.prompt ?? transcriptPromptForRuntimeSplit;
    const action = input.orphanRepair.removeLeaf
      ? orphanPromptMerge.merged
        ? "Merged and removed"
        : "Removed already-queued"
      : "Preserved";
    const message =
      `${action} orphaned user message` +
      (input.orphanRepair.removeLeaf
        ? " to prevent consecutive user turns. "
        : " without removing the active session leaf. ") +
      `runId=${attempt.runId} sessionId=${attempt.sessionId} trigger=${attempt.trigger}`;
    if (shouldWarnOnOrphanedUserRepair(attempt.trigger)) {
      log.warn(message);
    } else {
      log.debug(message);
    }
  }

  let leasedSteering: EmbeddedAttemptSteeringLease | undefined;
  if (
    attempt.sessionKey &&
    !input.isRawModelRun &&
    attempt.bootstrapContextRunKind !== "commitment-only"
  ) {
    const leaseId = `${attempt.runId}:agent-steering`;
    const leased = leasePendingAgentSteeringItems({
      requesterSessionKey: attempt.sessionKey,
      leaseId,
    });
    if (leased) {
      leasedSteering = { leaseId, runIds: leased.runIds };
      // Transfer cleanup ownership before any prompt mutation can throw.
      input.setLeasedSteering(leasedSteering);
      effectivePrompt = prependAgentSteeringPrompt({
        steeringPrompt: leased.prompt,
        prompt: effectivePrompt,
      });
      promptForRuntimeContextSplit = prependAgentSteeringPrompt({
        steeringPrompt: leased.prompt,
        prompt: promptForRuntimeContextSplit,
      });
      if (transcriptPromptForRuntimeSplit !== undefined) {
        transcriptPromptForRuntimeSplit = prependAgentSteeringPrompt({
          steeringPrompt: leased.prompt,
          prompt: transcriptPromptForRuntimeSplit,
        });
      }
      log.debug(
        `agent steering: injected ${leased.runIds.length} queued item(s) into parent turn ` +
          `runId=${attempt.runId} sessionKey=${attempt.sessionKey}`,
      );
    }
  }

  const promptForModelBeforeRuntimeContextSplit = effectivePrompt;
  const promptForRuntimeContextBeforeAnnotation = promptForRuntimeContextSplit;
  if (!input.isRawModelRun) {
    promptForRuntimeContextSplit = annotateInterSessionPromptText(
      promptForRuntimeContextSplit,
      attempt.inputProvenance,
    );
  }
  const transcriptLeafId =
    (input.sessionManager.getLeafEntry() as { id?: string } | null | undefined)?.id ?? null;
  const heartbeatSummary =
    attempt.config && input.sessionAgentId
      ? resolveHeartbeatSummaryForAgent(attempt.config, input.sessionAgentId)
      : undefined;

  return {
    hookCtx,
    effectivePrompt,
    promptBeforePromptBuildHooks,
    promptBuildPrependContext,
    promptBuildAppendContext,
    hasPromptBuildContext,
    effectiveTranscriptPrompt,
    transcriptPromptForRuntimeSplit,
    promptForRuntimeContextSplit,
    promptForModelBeforeRuntimeContextSplit,
    promptForRuntimeContextBeforeAnnotation,
    transcriptLeafId,
    heartbeatSummary,
    promptCacheChangesForTurn,
    leasedSteering,
  };
}

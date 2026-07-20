import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import type { ModelFallbackStepFields } from "../model-fallback-observation.js";
import { runWithModelFallback, type ModelFallbackResultClassification } from "../model-fallback.js";
import type { FallbackAttempt } from "../model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "../model-selection-normalize.js";
import { resolveAgentRunAbortLifecycleFields } from "../run-termination.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./result-fallback-classifier.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type RunEntryCandidateOptions = {
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
  isFallbackRetry: boolean;
};

type RunEntryHarnessPreparation =
  | { kind: "direct" }
  | {
      kind: "measured";
      run: (prepare: () => Promise<void>) => Promise<void>;
    };

type DeliveryEvidence = {
  hasDirectlySentBlockReply: boolean;
  hasBlockReplyPipelineOutput: boolean;
};

type RunEntryBehavior =
  | {
      kind: "channel-delivery";
      readDeliveryEvidence: () => DeliveryEvidence;
    }
  | { kind: "followup-delivery" }
  | {
      kind: "command-rpc";
      hasCommittedSideEffect: () => boolean;
    }
  | { kind: "maintenance" };

type RunEntrySessionOverride =
  | { kind: "preserve" }
  | {
      kind: "reconcile-completed";
      reconcile: (candidate: { provider: string; model: string }) => Promise<void>;
    };

export type EmbeddedAgentRunEntryTerminal = {
  outcome: ReturnType<typeof buildAgentRunTerminalOutcome>;
  metadata: Record<string, unknown>;
};

type EmbeddedAgentRunEntryResult<T extends EmbeddedAgentRunResult> = {
  outcome: "completed" | "exhausted";
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  terminal: EmbeddedAgentRunEntryTerminal;
  settleSessionOverride: () => Promise<void>;
};

type EmbeddedAgentRunEntryParams<T extends EmbeddedAgentRunResult> = {
  selection: {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
    fallbacksOverride?: string[];
    agentDir?: string;
  } & ModelManifestNormalizationContext;
  identity: {
    runId: string;
    agentId: string;
    sessionId: string;
    sessionKey?: string;
    lane?: string;
  };
  harness: {
    workspaceDir: string;
    sessionKey?: string;
    preparation: RunEntryHarnessPreparation;
    resolveRuntimeOverride: (provider: string, model: string) => string | undefined;
  };
  behavior: RunEntryBehavior;
  sessionOverride: RunEntrySessionOverride;
  abortSignal?: AbortSignal;
  onFallbackStep?: (step: ModelFallbackStepFields) => void | Promise<void>;
  runCandidate: (provider: string, model: string, options: RunEntryCandidateOptions) => Promise<T>;
};

const PRESERVED_FOLLOWUP_RESULT_CODES = new Set([
  "empty_result",
  "reasoning_only_result",
  "planning_only_result",
]);

function preserveFollowupResultForDelivery(
  classification: ModelFallbackResultClassification,
): ModelFallbackResultClassification {
  if (
    !classification ||
    !("code" in classification) ||
    !classification.code ||
    !PRESERVED_FOLLOWUP_RESULT_CODES.has(classification.code)
  ) {
    return classification;
  }
  // Follow-up delivery owns its terminal fallback, so retain the classified
  // result for that layer instead of replacing it with a summary error.
  return {
    ...classification,
    preserveResultOnExhaustion: true,
    preserveResultPriority: -1,
  };
}

function resolveTerminalStatus(params: {
  result: EmbeddedAgentRunResult;
  fallbackExhausted: boolean;
}): "ok" | "error" | "timeout" {
  const meta = params.result.meta;
  if (meta.stopReason === "timeout" || meta.timeoutPhase) {
    return "timeout";
  }
  if (
    params.fallbackExhausted ||
    meta.aborted === true ||
    meta.error ||
    meta.stopReason === "error"
  ) {
    return "error";
  }
  return "ok";
}

function buildTerminal(params: {
  result: EmbeddedAgentRunResult;
  fallbackExhausted: boolean;
  behavior: RunEntryBehavior;
}): EmbeddedAgentRunEntryTerminal {
  const meta = params.result.meta;
  const outcome = buildAgentRunTerminalOutcome({
    status: resolveTerminalStatus(params),
    error: meta.error?.message,
    stopReason: meta.stopReason,
    livenessState: meta.livenessState,
    timeoutPhase: meta.timeoutPhase,
    providerStarted: meta.providerStarted,
  });
  const metadata: Record<string, unknown> = {};
  if (params.behavior.kind === "channel-delivery" || params.behavior.kind === "followup-delivery") {
    for (const key of [
      "stopReason",
      "yielded",
      "timeoutPhase",
      "providerStarted",
      "aborted",
      "livenessState",
      "replayInvalid",
    ] as const) {
      if (!Object.hasOwn(meta, key)) {
        continue;
      }
      metadata[key] = key in outcome ? outcome[key as keyof typeof outcome] : meta[key];
    }
  } else {
    for (const key of ["stopReason", "livenessState", "timeoutPhase", "providerStarted"] as const) {
      if (outcome[key] !== undefined) {
        metadata[key] = outcome[key];
      }
    }
    if (typeof meta.aborted === "boolean") {
      metadata.aborted = meta.aborted;
    }
    if (meta.replayInvalid === true) {
      metadata.replayInvalid = true;
    }
    if (meta.yielded === true) {
      metadata.yielded = true;
    }
  }
  return { outcome, metadata };
}

/** Runs a fallback candidate chain and prepares its shared terminal settlement state. */
export async function runEmbeddedAgentEntry<T extends EmbeddedAgentRunResult>(
  params: EmbeddedAgentRunEntryParams<T>,
): Promise<EmbeddedAgentRunEntryResult<T>> {
  let candidateIndex = 0;
  const committedSideEffect =
    params.behavior.kind === "command-rpc" ? params.behavior.hasCommittedSideEffect : undefined;
  const fallbackResult = await runWithModelFallback<T>({
    ...params.selection,
    ...params.identity,
    abortSignal: params.abortSignal,
    resolveAgentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride,
    prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
      const prepare = () =>
        ensureSelectedAgentHarnessPlugin({
          config: params.selection.cfg,
          provider,
          modelId: model,
          agentId: params.identity.agentId,
          sessionKey: params.harness.sessionKey,
          agentHarnessId: agentHarnessRuntimeOverride,
          agentHarnessRuntimeOverride,
          workspaceDir: params.harness.workspaceDir,
        });
      if (params.harness.preparation.kind === "measured") {
        await params.harness.preparation.run(prepare);
      } else {
        await prepare();
      }
    },
    onFallbackStep: params.onFallbackStep,
    ...(params.behavior.kind === "maintenance"
      ? {}
      : {
          classifyResult: ({
            result,
            provider,
            model,
          }: {
            result: T;
            provider: string;
            model: string;
          }) => {
            const deliveryEvidence =
              params.behavior.kind === "channel-delivery"
                ? params.behavior.readDeliveryEvidence()
                : undefined;
            const classification = classifyEmbeddedAgentRunResultForModelFallback({
              result,
              provider,
              model,
              ...deliveryEvidence,
            });
            const effectiveClassification =
              params.behavior.kind === "followup-delivery"
                ? preserveFollowupResultForDelivery(classification)
                : classification;
            return effectiveClassification && committedSideEffect?.()
              ? undefined
              : effectiveClassification;
          },
        }),
    ...(committedSideEffect ? { canFallbackAfterError: () => !committedSideEffect() } : {}),
    ...(params.behavior.kind === "maintenance"
      ? {}
      : {
          mergeExhaustedResult: ({
            latestResult,
            preferredResult,
          }: {
            latestResult: T;
            preferredResult: T;
          }) =>
            mergeEmbeddedAgentRunResultForModelFallbackExhaustion({
              latestResult,
              preferredResult,
            }) as T,
        }),
    run: async (provider, model, options) => {
      const isFallbackRetry = candidateIndex > 0;
      candidateIndex += 1;
      return params.runCandidate(provider, model, {
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
        isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
        isFallbackRetry,
      });
    },
  });
  const abortFields =
    params.behavior.kind === "command-rpc"
      ? resolveAgentRunAbortLifecycleFields(params.abortSignal)
      : {};
  const result =
    abortFields.aborted === true
      ? ({
          ...fallbackResult.result,
          meta: {
            ...fallbackResult.result.meta,
            ...abortFields,
          },
        } as T)
      : fallbackResult.result;
  const settledResult = {
    ...fallbackResult,
    outcome:
      fallbackResult.outcome === "exhausted" ? ("exhausted" as const) : ("completed" as const),
    result,
  };
  const terminal = buildTerminal({
    result,
    fallbackExhausted: settledResult.outcome === "exhausted",
    behavior: params.behavior,
  });
  let sessionOverrideSettled = false;
  const settleSessionOverride = async () => {
    if (sessionOverrideSettled) {
      return;
    }
    sessionOverrideSettled = true;
    if (
      settledResult.outcome === "completed" &&
      params.sessionOverride.kind === "reconcile-completed"
    ) {
      await params.sessionOverride.reconcile({
        provider: settledResult.provider,
        model: settledResult.model,
      });
    }
  };
  return { ...settledResult, terminal, settleSessionOverride };
}

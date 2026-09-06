import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import {
  formatAgentRunRouteChange,
  normalizeAgentRunTerminalReceipt,
} from "../agent-run-terminal-receipt.js";
import {
  buildAgentRunTerminalReplySnapshot,
  normalizeAgentRunTerminalReplySnapshot,
} from "../agent-run-terminal-reply.js";
import {
  createContextEngineLogicalTurnLease,
  type ContextEngineLogicalTurnLease,
} from "../harness/context-engine-logical-turn.js";
import {
  discardContextEngineTurnAttemptIntent,
  finalizeAcceptedContextEngineTurn,
  type ContextEngineTurnAttemptFacts,
} from "../harness/context-engine-turn-attempt.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { selectAgentHarness } from "../harness/selection.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import type { ModelFallbackStepFields } from "../model-fallback-observation.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import type {
  FallbackAttempt,
  ModelFallbackAttemptProvenance,
  ModelFallbackRouteResolution,
} from "../model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { resolveAgentRunAbortLifecycleFields } from "../run-termination.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./result-fallback-classifier.js";
import type { EmbeddedAgentRunResult, TraceAttempt } from "./types.js";

type RunEntryCandidateOptions = {
  classifyResult: (result: EmbeddedAgentRunResult) => ModelFallbackResultClassification;
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
  isFallbackRetry: boolean;
  modelRoutingProvenance: ModelFallbackAttemptProvenance;
  contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease;
  onContextEngineTurnCandidate: (facts: ContextEngineTurnAttemptFacts) => void;
};

type RunEntryCandidate<T> = {
  result: T;
  classification?: ModelFallbackResultClassification;
  turnAttempt?: ContextEngineTurnAttemptFacts;
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
  outcome: ReturnType<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>;
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
    requestedRouteResolution?: ModelFallbackRouteResolution;
    fallbacksOverride?: string[];
    agentDir?: string;
    userLockedAuthProfileId?: string;
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
    resolveContextEngineHost?: (
      provider: string,
      model: string,
    ) => ContextEngineHostSupport | undefined;
  };
  behavior: RunEntryBehavior;
  sessionOverride: RunEntrySessionOverride;
  abortSignal?: AbortSignal;
  onFallbackStep?: (step: ModelFallbackStepFields) => void | Promise<void>;
  /** Runs once after the successful winner is accepted, before post-turn context commit. */
  onAcceptedTerminal?: () => void | (() => void) | Promise<void | (() => void)>;
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

function resolveTerminalOutcome(params: {
  result: EmbeddedAgentRunResult;
  fallbackExhausted: boolean;
}): EmbeddedAgentRunEntryTerminal["outcome"] {
  const meta = params.result.meta;
  return buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: params.fallbackExhausted || meta.error ? "error" : "end",
    data: { ...meta, error: meta.error?.message },
  });
}

function canAdvanceContextEngineTurn(params: {
  result: EmbeddedAgentRunResult;
  fallbackOutcome: "completed" | "exhausted";
  terminal: EmbeddedAgentRunEntryTerminal;
}): boolean {
  const meta = params.result.meta;
  return (
    params.fallbackOutcome === "completed" &&
    params.terminal.outcome.status === "ok" &&
    meta.yielded !== true &&
    meta.aborted !== true &&
    meta.error === undefined &&
    meta.timeoutPhase === undefined &&
    meta.stopReason !== "error" &&
    meta.stopReason !== "timeout"
  );
}

function mergeRunEntryExecutionTrace<T extends EmbeddedAgentRunResult>(params: {
  result: T;
  terminalStatus: EmbeddedAgentRunEntryTerminal["outcome"]["status"];
  provider: string;
  model: string;
  requestedProvider: string;
  requestedModel: string;
  fallbackAttempts: FallbackAttempt[];
}): T {
  const currentTrace = params.result.meta.executionTrace;
  const winnerProvider =
    params.terminalStatus === "ok" ? (currentTrace?.winnerProvider ?? params.provider) : undefined;
  const winnerModel =
    params.terminalStatus === "ok" ? (currentTrace?.winnerModel ?? params.model) : undefined;
  const outerAttempts: TraceAttempt[] = params.fallbackAttempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    result: attempt.reason === "timeout" ? "timeout" : "candidate_failed",
    ...(attempt.reason ? { reason: attempt.reason } : {}),
    ...(typeof attempt.status === "number" ? { status: attempt.status } : {}),
  }));
  const innerAttempts = (currentTrace?.attempts ?? []).filter(
    (attempt) => attempt.result !== "success",
  );
  const winnerAttempt = currentTrace?.attempts?.findLast(
    (attempt) =>
      attempt.result === "success" &&
      attempt.provider === winnerProvider &&
      attempt.model === winnerModel,
  );
  const attempts = [
    ...outerAttempts,
    ...innerAttempts,
    ...(winnerProvider && winnerModel
      ? [
          winnerAttempt ?? {
            provider: winnerProvider,
            model: winnerModel,
            result: "success" as const,
          },
        ]
      : []),
  ];
  const terminalReceipt = params.result.meta.agentMeta?.terminalReceipt;
  const requested = { provider: params.requestedProvider, model: params.requestedModel };
  const agentMeta = terminalReceipt
    ? {
        ...params.result.meta.agentMeta,
        terminalReceipt: {
          ...terminalReceipt,
          requested,
          rerouted:
            terminalReceipt.rerouted ||
            terminalReceipt.effective.provider !== requested.provider ||
            terminalReceipt.effective.model !== requested.model,
        },
      }
    : params.result.meta.agentMeta;
  return {
    ...params.result,
    meta: {
      ...params.result.meta,
      agentMeta,
      executionTrace: {
        ...currentTrace,
        winnerProvider,
        winnerModel,
        attempts: attempts.length > 0 ? attempts : undefined,
        fallbackUsed: currentTrace?.fallbackUsed === true || outerAttempts.length > 0,
      },
    },
  };
}

function buildTerminal(params: {
  result: EmbeddedAgentRunResult;
  outcome: EmbeddedAgentRunEntryTerminal["outcome"];
  behavior: RunEntryBehavior;
  runId: string;
  requested: { provider: string; model: string };
  sessionId: string;
}): EmbeddedAgentRunEntryTerminal {
  const meta = params.result.meta;
  const outcome = params.outcome;
  const internalReply = params.result.messagingToolSourceReplyPayloads?.findLast(
    (payload) => payload.sourceReplyFinal === true,
  );
  let terminalReply =
    normalizeAgentRunTerminalReplySnapshot(meta.terminalReply) ??
    buildAgentRunTerminalReplySnapshot(
      // Internal UI delivery still needs forwarding by A2A. Its final payload
      // owns that reply even when the model subsequently emits NO_REPLY.
      internalReply
        ? { visibleText: internalReply.text }
        : {
            visibleText: meta.finalAssistantVisibleText,
            rawText: meta.finalAssistantRawText,
            terminalReplyKind: meta.terminalReplyKind,
          },
    );
  const agentMeta = meta.agentMeta;
  const normalizedTerminalReceipt =
    normalizeAgentRunTerminalReceipt(agentMeta?.terminalReceipt) ??
    // CLI backends report delivery without an embedded model-turn receipt.
    // The entry owner supplies run identity; the tool supplied the send fact.
    (params.result.sourceReplyDelivered && agentMeta?.provider && agentMeta.model
      ? {
          runId: params.runId,
          sessionId: params.sessionId,
          turnId: params.runId,
          requested: params.requested,
          effective: {
            provider: agentMeta.provider,
            model: agentMeta.model,
            responseModel: agentMeta.model,
          },
          successfulToolNames: ["message"],
          sourceReplyDelivered: true as const,
          rerouted:
            agentMeta.provider !== params.requested.provider ||
            agentMeta.model !== params.requested.model,
        }
      : undefined);
  const terminalReceipt =
    normalizedTerminalReceipt?.runId === params.runId
      ? {
          ...normalizedTerminalReceipt,
          terminalDisposition:
            terminalReply.disposition === "visible"
              ? ("visible" as const)
              : ("not-visible" as const),
        }
      : undefined;
  const modelRouteChange = formatAgentRunRouteChange(terminalReceipt, params.runId);
  if (modelRouteChange && terminalReply.disposition === "visible") {
    // Carry one receipt-owned fact beside assistant text so internal parents can
    // report the reroute without exposing it through raw external delivery.
    terminalReply = { ...terminalReply, modelRouteChange };
  }
  const metadata: Record<string, unknown> = { terminalReply };
  if (terminalReceipt) {
    metadata.terminalReceipt = terminalReceipt;
  }
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

/** Runs one logical turn across model candidates and advances only the accepted winner. */
export async function runEmbeddedAgentEntry<T extends EmbeddedAgentRunResult>(
  params: EmbeddedAgentRunEntryParams<T>,
): Promise<EmbeddedAgentRunEntryResult<T>> {
  const contextEngineLogicalTurnLease = await createContextEngineLogicalTurnLease({
    config: params.selection.cfg,
    agentDir: params.selection.agentDir,
    workspaceDir: params.harness.workspaceDir,
  });
  let unsettledContextEngineTurnAttempt: ContextEngineTurnAttemptFacts | undefined;
  let candidateIndex = 0;
  const committedSideEffect =
    params.behavior.kind === "command-rpc" ? params.behavior.hasCommittedSideEffect : undefined;
  const readChannelDeliveryEvidence =
    params.behavior.kind === "channel-delivery" ? params.behavior.readDeliveryEvidence : undefined;
  const preparedHarnessRuntimes = new Set<string>();
  const prepareHarnessRuntime = async (candidate: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => {
    const key = [
      candidate.provider,
      candidate.model,
      candidate.agentHarnessRuntimeOverride ?? "",
    ].join("\0");
    if (preparedHarnessRuntimes.has(key)) {
      return;
    }
    const prepare = () =>
      ensureSelectedAgentHarnessPlugin({
        config: params.selection.cfg,
        provider: candidate.provider,
        modelId: candidate.model,
        agentId: params.identity.agentId,
        sessionKey: params.harness.sessionKey,
        agentHarnessId: candidate.agentHarnessRuntimeOverride,
        agentHarnessRuntimeOverride: candidate.agentHarnessRuntimeOverride,
        workspaceDir: params.harness.workspaceDir,
        pluginRegistry: requireActivePluginRegistry(),
      });
    if (params.harness.preparation.kind === "measured") {
      await params.harness.preparation.run(prepare);
    } else {
      await prepare();
    }
    preparedHarnessRuntimes.add(key);
  };
  // Thrown candidate errors skip result classification, so without an error-path
  // backstop the loop advances to the next candidate even when the attempt already
  // delivered its reply, producing a duplicate visible answer (#113788). Consult the
  // same live delivery evidence the result classifier already uses so both exit
  // paths suppress fallback after a delivered reply.
  const canFallbackAfterError = committedSideEffect
    ? () => !committedSideEffect()
    : readChannelDeliveryEvidence
      ? () => {
          const evidence = readChannelDeliveryEvidence();
          return !evidence.hasDirectlySentBlockReply && !evidence.hasBlockReplyPipelineOutput;
        }
      : undefined;
  try {
    const fallbackResult = await runWithModelFallback<RunEntryCandidate<T>>({
      ...params.selection,
      ...params.identity,
      abortSignal: params.abortSignal,
      resolveAgentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride,
      prepareCandidateChain: async (candidates) => {
        for (const candidate of candidates) {
          try {
            const agentHarnessRuntimeOverride = params.harness.resolveRuntimeOverride(
              candidate.provider,
              candidate.model,
            );
            await prepareHarnessRuntime({
              provider: candidate.provider,
              model: candidate.model,
              ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
            });
            const resolvedHost = params.harness.resolveContextEngineHost?.(
              candidate.provider,
              candidate.model,
            );
            const host =
              resolvedHost ??
              (() => {
                const harness = selectAgentHarness({
                  provider: candidate.provider,
                  modelId: candidate.model,
                  config: params.selection.cfg,
                  agentId: params.identity.agentId,
                  sessionKey: params.harness.sessionKey,
                  agentHarnessRuntimeOverride,
                });
                return {
                  id: `agent-harness:${harness.id}`,
                  label: `agent harness "${harness.id}"`,
                  capabilities: harness.contextEngineHostCapabilities ?? [],
                };
              })();
            contextEngineLogicalTurnLease.selectForHost({
              host,
              operation: "agent-run",
              requiresDurableCommit: false,
            });
          } catch {
            contextEngineLogicalTurnLease.degradeBeforeStart(
              "a model fallback candidate harness could not be validated before dispatch",
            );
            return;
          }
        }
      },
      prepareAgentHarnessRuntime: prepareHarnessRuntime,
      onFallbackStep: params.onFallbackStep,
      ...(params.behavior.kind === "maintenance"
        ? {}
        : {
            classifyResult: ({ result }: { result: RunEntryCandidate<T> }) => result.classification,
          }),
      ...(canFallbackAfterError ? { canFallbackAfterError } : {}),
      ...(params.behavior.kind === "maintenance"
        ? {}
        : {
            mergeExhaustedResult: ({
              latestResult,
              preferredResult,
            }: {
              latestResult: RunEntryCandidate<T>;
              preferredResult: RunEntryCandidate<T>;
            }) => ({
              result: mergeEmbeddedAgentRunResultForModelFallbackExhaustion({
                latestResult: latestResult.result,
                preferredResult: preferredResult.result,
              }) as T,
              turnAttempt: latestResult.turnAttempt,
            }),
          }),
      run: async (provider, model, options) => {
        if (!options) {
          throw new Error("Model fallback attempt is missing routing provenance");
        }
        const isFallbackRetry = candidateIndex > 0;
        candidateIndex += 1;
        let contextEngineTurnCandidate: ContextEngineTurnAttemptFacts | undefined;
        let classified:
          | { result: EmbeddedAgentRunResult; value: ModelFallbackResultClassification }
          | undefined;
        const classifyResult = (result: EmbeddedAgentRunResult) => {
          if (!classified || classified.result !== result) {
            const classification =
              params.behavior.kind === "maintenance"
                ? undefined
                : classifyEmbeddedAgentRunResultForModelFallback({
                    result,
                    provider,
                    model,
                    ...readChannelDeliveryEvidence?.(),
                  });
            const effectiveClassification =
              params.behavior.kind === "followup-delivery"
                ? preserveFollowupResultForDelivery(classification)
                : classification;
            // Keep pre-release acceptance for the exact result. Failed finalization
            // returns a replacement that must not inherit its predecessor's decision.
            classified = {
              result,
              value:
                effectiveClassification && committedSideEffect?.()
                  ? undefined
                  : effectiveClassification,
            };
          }
          return classified.value;
        };
        const result = await params.runCandidate(provider, model, {
          classifyResult,
          allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
          isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
          isFallbackRetry,
          modelRoutingProvenance: options.modelRoutingProvenance,
          contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: (facts) => {
            contextEngineTurnCandidate = facts;
            unsettledContextEngineTurnAttempt = facts;
          },
        });
        return {
          result,
          classification: classifyResult(result),
          turnAttempt: contextEngineTurnCandidate,
        };
      },
    });
    const abortFields =
      params.behavior.kind === "command-rpc"
        ? resolveAgentRunAbortLifecycleFields(params.abortSignal)
        : {};
    const candidateResult =
      abortFields.aborted === true
        ? ({
            ...fallbackResult.result.result,
            meta: {
              ...fallbackResult.result.result.meta,
              ...abortFields,
            },
          } as T)
        : fallbackResult.result.result;
    const outcome =
      fallbackResult.outcome === "exhausted" ? ("exhausted" as const) : ("completed" as const);
    // A completed fallback search can still return a failed or interrupted run.
    const terminalOutcome = resolveTerminalOutcome({
      result: candidateResult,
      fallbackExhausted: outcome === "exhausted",
    });
    const result = mergeRunEntryExecutionTrace({
      result: candidateResult,
      terminalStatus: terminalOutcome.status,
      provider: fallbackResult.provider,
      model: fallbackResult.model,
      requestedProvider: params.selection.provider,
      requestedModel: params.selection.model,
      fallbackAttempts: fallbackResult.attempts,
    });
    const settledResult = {
      ...fallbackResult,
      outcome,
      result,
    };
    const terminal = buildTerminal({
      result,
      outcome: terminalOutcome,
      behavior: params.behavior,
      runId: params.identity.runId,
      requested: { provider: params.selection.provider, model: params.selection.model },
      sessionId: params.identity.sessionId,
    });
    const acceptedTerminal =
      !params.abortSignal?.aborted &&
      canAdvanceContextEngineTurn({
        result,
        fallbackOutcome: settledResult.outcome,
        terminal,
      });
    let releaseAcceptedTerminalWork: (() => void) | undefined;
    if (acceptedTerminal) {
      const acceptedTerminalWork = await params.onAcceptedTerminal?.();
      if (typeof acceptedTerminalWork === "function") {
        releaseAcceptedTerminalWork = acceptedTerminalWork;
      }
    }
    try {
      if (fallbackResult.result.turnAttempt) {
        if (acceptedTerminal) {
          await finalizeAcceptedContextEngineTurn({
            facts: fallbackResult.result.turnAttempt,
            lease: contextEngineLogicalTurnLease,
          });
        } else {
          discardContextEngineTurnAttemptIntent({
            facts: fallbackResult.result.turnAttempt,
            lease: contextEngineLogicalTurnLease,
          });
        }
        unsettledContextEngineTurnAttempt = undefined;
      }
    } finally {
      releaseAcceptedTerminalWork?.();
    }
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
  } finally {
    if (unsettledContextEngineTurnAttempt) {
      discardContextEngineTurnAttemptIntent({
        facts: unsettledContextEngineTurnAttempt,
        lease: contextEngineLogicalTurnLease,
      });
    }
    await contextEngineLogicalTurnLease.dispose();
  }
}

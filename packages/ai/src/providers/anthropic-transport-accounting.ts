import type { AiModelFetchProvenance, AiModelTransportOutcome } from "../host.js";
import {
  createModelTransportEventScope,
  type PendingTransportEvent,
} from "../transports/model-transport-accounting-internal.js";
import type { Model, StreamOptions } from "../types.js";
import {
  readTerminalFallbackUsage,
  reconcileAnthropicFallback,
  type AnthropicFallbackBoundaryAuthority,
  type AnthropicFallbackResolution,
  type TerminalFallbackUsage,
} from "./anthropic-fallback-reconciliation.js";
import {
  anthropicRequestEnablesServerFallback,
  resolveAnthropicFallbackModelIdentity,
  type AnthropicFallbackBoundary,
} from "./anthropic-server-fallback.js";

const ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT = Symbol.for(
  "openclaw.anthropicTransportAccountingContext",
);
const ANTHROPIC_TRANSPORT = "sse";

type AnthropicTransportPhaseReason = "initial" | "payload_recovery";
export type { AnthropicFallbackResolution } from "./anthropic-fallback-reconciliation.js";

type AnthropicTransportAccountingState = {
  events: ReturnType<typeof createModelTransportEventScope>;
};

type AnthropicTransportAccountingContext = {
  state?: AnthropicTransportAccountingState;
  reason: AnthropicTransportPhaseReason;
};

type AnthropicTransportOptions = StreamOptions & {
  [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]?: AnthropicTransportAccountingContext;
};

export type AnthropicTransportAccounting = {
  onFetchDispatch: () => void;
  wrapFetch(
    fetch: typeof globalThis.fetch,
    provenance?: AiModelFetchProvenance,
  ): typeof globalThis.fetch;
  observeFinalRequestPayload(payload: unknown): void;
  observeFallbackBoundary(boundary: AnthropicFallbackBoundary): void;
  observeFallbackContent(): void;
  observeTerminalUsage(usage: unknown): void;
  sealTerminalUsage(): void;
  observeSemanticCoverage(
    reason:
      | "transport_terminal_unverified"
      | "transport_endpoint_authority_partial"
      | "transport_submission_authority_partial",
  ): void;
  completeSuccess(): AnthropicFallbackResolution;
  completeFailure(error: unknown): AnthropicFallbackResolution;
  fail(error: unknown): AnthropicFallbackResolution | undefined;
};

function resolveTransportOutcome(
  _error: unknown,
  signal: AbortSignal | undefined,
): AiModelTransportOutcome {
  return signal?.aborted ? "aborted" : "failed";
}

function createAccountingState(params: {
  model: Model<"anthropic-messages">;
  callId?: string;
  scopeId: string;
}): AnthropicTransportAccountingState {
  return {
    events: createModelTransportEventScope({
      model: params.model,
      callId: params.callId,
      scopeId: params.scopeId,
      eventIdPrefix: "anthropic",
    }),
  };
}

export function withAnthropicTransportAccountingPhase<T extends object | undefined>(
  options: T,
  reason: AnthropicTransportPhaseReason,
): T extends object ? T : Record<string, never> {
  const source = options as AnthropicTransportOptions | undefined;
  const context = source?.[ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT];
  return {
    ...options,
    [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]: {
      state: context?.state,
      reason,
    },
  } as T extends object ? T : Record<string, never>;
}

export function inheritAnthropicTransportAccountingContext<T extends object>(
  source: unknown,
  target: T,
): T {
  const context = (source as AnthropicTransportOptions | undefined)?.[
    ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT
  ];
  return context
    ? Object.assign(target, { [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]: context })
    : target;
}

export function createAnthropicTransportAccounting(params: {
  fallbackBoundaryAuthority?: AnthropicFallbackBoundaryAuthority;
  maxRetries?: number;
  model: Model<"anthropic-messages">;
  options: StreamOptions | undefined;
  serverFallbackEnabled: boolean;
}): AnthropicTransportAccounting {
  const options = params.options as AnthropicTransportOptions | undefined;
  const context =
    options?.[ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT] ??
    ({ reason: "initial" } satisfies AnthropicTransportAccountingContext);
  const state =
    context.state ??
    createAccountingState({
      model: params.model,
      callId: options?.requestId,
      scopeId: options?.requestId ?? `${Date.now()}:${Math.random()}`,
    });
  context.state = state;

  const fallbackBoundaryAuthority =
    params.fallbackBoundaryAuthority ??
    (params.serverFallbackEnabled ? "server_authoritative" : "client_provisional");
  let serverFallbackEnabled = params.serverFallbackEnabled;
  let phaseInvocationCount = 0;
  let currentInvocationOrdinal = 0;
  let invocationPendingDispatch = false;
  let zeroSubmissionObservedForInvocation = false;
  let fetchProvenance: AiModelFetchProvenance | undefined;
  let fallbackCoverageObserved = false;
  let activeAttempt: PendingTransportEvent | undefined;
  let pendingResponseAttempt: PendingTransportEvent | undefined;
  let pendingResponseStatus: number | undefined;
  let provisionalTerminalUsage: TerminalFallbackUsage | undefined;
  let provisionalTerminalFallbackEvidenceObserved = false;
  let terminalUsage: TerminalFallbackUsage | undefined;
  let terminalFallbackEvidenceObserved = false;
  let endpointAuthorityPartial = false;
  let submissionAuthorityPartial = false;
  let finalized = false;
  let finalizedResolution: AnthropicFallbackResolution | undefined;
  const fallbackBoundaries: AnthropicFallbackBoundary[] = [];
  const confirmedProductTransitions: AnthropicFallbackBoundary[] = [];
  let pendingProductTransitions: AnthropicFallbackBoundary[] = [];
  const semanticCoverageReasons = new Set<
    | "transport_terminal_unverified"
    | "transport_endpoint_authority_partial"
    | "transport_submission_authority_partial"
  >();

  const settlePending = (outcome: AiModelTransportOutcome) => {
    activeAttempt?.finish(outcome);
    activeAttempt = undefined;
    pendingResponseAttempt?.finish(outcome, pendingResponseStatus);
    pendingResponseAttempt = undefined;
    pendingResponseStatus = undefined;
  };
  const takeActiveAttempt = (): PendingTransportEvent | undefined => {
    const attempt = activeAttempt;
    activeAttempt = undefined;
    return attempt;
  };
  const finishPendingResponse = (outcome: AiModelTransportOutcome): void => {
    pendingResponseAttempt?.finish(outcome, pendingResponseStatus);
    pendingResponseAttempt = undefined;
    pendingResponseStatus = undefined;
  };
  const observeFallbackCoverage = (force = false): void => {
    if (
      fallbackCoverageObserved ||
      submissionAuthorityPartial ||
      (!force && !serverFallbackEnabled && fallbackBoundaries.length === 0)
    ) {
      return;
    }
    fallbackCoverageObserved = true;
    state.events.observeCoverage({
      transport: ANTHROPIC_TRANSPORT,
      scope: "provider_fallbacks",
      state: "lower_bound",
      reason: "terminal_metadata_unavailable",
    });
  };
  const flushSemanticCoverage = (): void => {
    for (const reason of semanticCoverageReasons) {
      state.events.observeCoverage({
        transport: ANTHROPIC_TRANSPORT,
        scope: "transport_semantics",
        state: "unverified",
        reason,
      });
    }
    semanticCoverageReasons.clear();
  };
  const finalizeTerminal = (outcome: AiModelTransportOutcome): AnthropicFallbackResolution => {
    if (finalized) {
      return (
        finalizedResolution ?? {
          traceValid: false,
          transitions: [],
          productTransitions: [],
        }
      );
    }
    const resolution =
      serverFallbackEnabled || fallbackBoundaries.length > 0 || terminalUsage !== undefined
        ? reconcileAnthropicFallback({
            boundaryAuthority: fallbackBoundaryAuthority,
            requestedModel: params.model.id,
            boundaries: fallbackBoundaries,
            confirmedProductTransitions,
            terminalUsage,
          })
        : {
            traceValid: true,
            transitions: [],
            productTransitions: [],
          };
    if (submissionAuthorityPartial) {
      finishPendingResponse(outcome);
      flushSemanticCoverage();
      finalized = true;
      finalizedResolution = resolution;
      return resolution;
    }
    if (endpointAuthorityPartial && terminalUsage?.state !== "valid") {
      observeFallbackCoverage(true);
    }
    if (!resolution.traceValid) {
      const hadPendingResponse = Boolean(pendingResponseAttempt);
      finishPendingResponse(outcome);
      if (!hadPendingResponse) {
        flushSemanticCoverage();
      }
      observeFallbackCoverage(terminalFallbackEvidenceObserved || fallbackBoundaries.length > 0);
      flushSemanticCoverage();
      finalized = true;
      finalizedResolution = resolution;
      return resolution;
    }
    if (resolution.transitions.length > 0 && !pendingResponseAttempt) {
      flushSemanticCoverage();
      observeFallbackCoverage(true);
    } else {
      for (const transition of resolution.transitions) {
        state.events.observeProviderFallback({
          transport: ANTHROPIC_TRANSPORT,
          fromModel: transition.fromModel,
          toModel: transition.toModel,
        });
      }
    }
    finishPendingResponse(outcome);
    flushSemanticCoverage();
    finalized = true;
    finalizedResolution = resolution;
    return resolution;
  };

  return {
    onFetchDispatch: () => {
      if (finalized || fetchProvenance !== "dispatch_attested") {
        return;
      }
      invocationPendingDispatch = false;
      zeroSubmissionObservedForInvocation = false;
      activeAttempt = state.events.startAttempt({
        transport: ANTHROPIC_TRANSPORT,
        reason: currentInvocationOrdinal === 1 ? context.reason : "retry",
      });
    },
    wrapFetch(fetch, provenance) {
      fetchProvenance = provenance;
      return async (input, init) => {
        if (!finalized) {
          if (provenance !== "dispatch_attested") {
            submissionAuthorityPartial = true;
            semanticCoverageReasons.add("transport_submission_authority_partial");
          }
          currentInvocationOrdinal = ++phaseInvocationCount;
          invocationPendingDispatch = true;
          zeroSubmissionObservedForInvocation = false;
          activeAttempt = undefined;
        }
        try {
          const response = await fetch(input, init);
          if (finalized) {
            return response;
          }
          invocationPendingDispatch = false;
          const attempt = takeActiveAttempt();
          if (attempt) {
            if (response.ok) {
              pendingResponseAttempt = attempt;
              pendingResponseStatus = response.status;
            } else {
              attempt.finish("failed", response.status);
            }
          }
          return response;
        } catch (error) {
          if (finalized) {
            throw error;
          }
          const failedBeforeDispatch = invocationPendingDispatch;
          invocationPendingDispatch = false;
          const attempt = takeActiveAttempt();
          if (attempt) {
            const outcome = resolveTransportOutcome(error, options?.signal);
            attempt.finish(outcome);
            observeFallbackCoverage();
          } else if (
            fetchProvenance === "dispatch_attested" &&
            failedBeforeDispatch &&
            !zeroSubmissionObservedForInvocation
          ) {
            zeroSubmissionObservedForInvocation = true;
            const outcome = options?.signal?.aborted ? "aborted" : "failed";
            state.events.observeZeroSubmission({
              transport: ANTHROPIC_TRANSPORT,
              outcome,
            });
          }
          throw error;
        }
      };
    },
    observeFinalRequestPayload(payload) {
      serverFallbackEnabled =
        serverFallbackEnabled && anthropicRequestEnablesServerFallback(payload);
    },
    observeFallbackBoundary(boundary) {
      fallbackBoundaries.push(boundary);
      const fromIdentity = resolveAnthropicFallbackModelIdentity(boundary.fromModel);
      const toIdentity = resolveAnthropicFallbackModelIdentity(boundary.toModel);
      if (!fromIdentity || !toIdentity || fromIdentity === toIdentity) {
        pendingProductTransitions = [];
        return;
      }
      const pendingTail = pendingProductTransitions.at(-1);
      const pendingTailIdentity = resolveAnthropicFallbackModelIdentity(
        pendingTail?.toModel ?? null,
      );
      pendingProductTransitions =
        pendingProductTransitions.length === 0 || pendingTailIdentity === fromIdentity
          ? [...pendingProductTransitions, boundary]
          : [boundary];
    },
    observeFallbackContent() {
      if (pendingProductTransitions.length === 0) {
        return;
      }
      confirmedProductTransitions.push(...pendingProductTransitions);
      pendingProductTransitions = [];
    },
    observeTerminalUsage(usage) {
      if (
        !usage ||
        typeof usage !== "object" ||
        Array.isArray(usage) ||
        !Object.hasOwn(usage, "iterations")
      ) {
        return;
      }
      const iterations = (usage as { iterations?: unknown }).iterations;
      provisionalTerminalFallbackEvidenceObserved ||=
        Array.isArray(iterations) &&
        iterations.some(
          (iteration) =>
            iteration !== null &&
            typeof iteration === "object" &&
            !Array.isArray(iteration) &&
            (iteration as { type?: unknown }).type === "fallback_message",
        );
      provisionalTerminalUsage = readTerminalFallbackUsage(usage);
    },
    sealTerminalUsage() {
      terminalUsage = provisionalTerminalUsage;
      terminalFallbackEvidenceObserved = provisionalTerminalFallbackEvidenceObserved;
    },
    observeSemanticCoverage(reason) {
      endpointAuthorityPartial ||= reason === "transport_endpoint_authority_partial";
      submissionAuthorityPartial ||= reason === "transport_submission_authority_partial";
      semanticCoverageReasons.add(reason);
    },
    completeSuccess() {
      return finalizeTerminal("completed");
    },
    completeFailure(error) {
      return finalizeTerminal(resolveTransportOutcome(error, options?.signal));
    },
    fail(error) {
      if (finalized) {
        return undefined;
      }
      const resolution =
        fallbackBoundaries.length > 0
          ? reconcileAnthropicFallback({
              boundaryAuthority: fallbackBoundaryAuthority,
              requestedModel: params.model.id,
              boundaries: fallbackBoundaries,
              confirmedProductTransitions,
              terminalUsage: undefined,
            })
          : undefined;
      const observedResolution =
        provisionalTerminalUsage !== undefined
          ? reconcileAnthropicFallback({
              boundaryAuthority: fallbackBoundaryAuthority,
              requestedModel: params.model.id,
              boundaries: fallbackBoundaries,
              confirmedProductTransitions,
              terminalUsage: provisionalTerminalUsage,
            })
          : resolution;
      if (invocationPendingDispatch) {
        submissionAuthorityPartial = true;
        semanticCoverageReasons.add("transport_submission_authority_partial");
        invocationPendingDispatch = false;
      }
      const hadUnsettledResponse = Boolean(activeAttempt || pendingResponseAttempt);
      const responseCouldContainFallback =
        pendingResponseStatus !== undefined &&
        pendingResponseStatus >= 200 &&
        pendingResponseStatus < 300 &&
        (serverFallbackEnabled || endpointAuthorityPartial);
      if (pendingResponseAttempt) {
        const observedTransitions = observedResolution?.transitions.length
          ? observedResolution.transitions
          : (resolution?.productTransitions ?? []);
        for (const transition of observedTransitions) {
          if (transition.fromModel && transition.toModel) {
            state.events.observeProviderFallback({
              transport: ANTHROPIC_TRANSPORT,
              fromModel: transition.fromModel,
              toModel: transition.toModel,
            });
          }
        }
      }
      settlePending(resolveTransportOutcome(error, options?.signal));
      if (!hadUnsettledResponse) {
        flushSemanticCoverage();
      }
      const hasFallbackEvidence =
        fallbackBoundaries.length > 0 ||
        terminalFallbackEvidenceObserved ||
        provisionalTerminalFallbackEvidenceObserved;
      if (responseCouldContainFallback || hasFallbackEvidence) {
        observeFallbackCoverage(true);
      }
      flushSemanticCoverage();
      finalized = true;
      finalizedResolution = resolution;
      return resolution &&
        (resolution.transitions.length > 0 ||
          resolution.productTransitions.length > 0 ||
          resolution.servingModel)
        ? resolution
        : undefined;
    },
  };
}

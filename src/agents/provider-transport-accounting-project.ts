import type { AiModelTransportEvent, AiModelTransportOutcome } from "@openclaw/ai";
import type { CachedInputObservation } from "@openclaw/ai/internal/shared";
import type {
  ProviderTransportAccountingCoverage,
  ProviderTransportAccountingCoverageReason,
  ProviderTransportAccountingSnapshot,
  ProviderTransportAccountingTotalKind,
  ProviderTransportLogicalCall,
} from "./provider-transport-accounting.types.js";

export type ProviderTransportAggregateLowerBoundKey =
  | "attempts"
  | "connections"
  | "fallbacks"
  | "providerFallbacks"
  | "zeroSubmissions";

export function providerTransportAggregateKeyForEventType(
  type: AiModelTransportEvent["type"],
): ProviderTransportAggregateLowerBoundKey {
  switch (type) {
    case "attempt":
      return "attempts";
    case "connection":
      return "connections";
    case "fallback":
      return "fallbacks";
    case "provider_fallback":
      return "providerFallbacks";
    case "coverage":
      return "providerFallbacks";
    case "submission":
      return "zeroSubmissions";
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export type ProviderTransportProjectionCall = {
  callId: string;
  provider: string;
  model: string;
  api: string;
  currentTransport?: string;
  currentServingModel?: string;
  currentServingModelConfirmedByProviderFallback?: boolean;
  nextConnectionOrdinal: number;
  fallbackCause?: {
    transport: string;
    reason: "connection_failure" | "stream_failure";
  };
  lastAttempt?: {
    ordinal: number;
    transport: string;
    servingModel: string;
    outcome: AiModelTransportOutcome;
  };
  phase?: {
    transport: string;
    servingModel: string;
    submissionEvidence: boolean;
    expectedAttemptReason: "initial" | "same_route" | "transport_fallback";
  };
  pendingTransportTarget?: string;
  latestZeroSubmissionOutcome?: "failed" | "aborted";
  logicalOutcome?: AiModelTransportOutcome;
  pendingSettlementOutcome?: AiModelTransportOutcome;
  settledOutcome?: AiModelTransportOutcome;
  finalized?: boolean;
  cachedInput?: CachedInputObservation;
  acceptedCallEventCount: number;
};

export type ProviderTransportProjectionState = {
  logicalCalls: Map<string, ProviderTransportProjectionCall>;
  latestLogicalCallKeyByCallId: Map<string, string>;
  nextLogicalCallLifecycleOrdinal: number;
  eventFingerprints: Map<string, { fingerprint: string; type: AiModelTransportEvent["type"] }>;
  aggregate: {
    attempts: Omit<ProviderTransportAccountingSnapshot["attempts"], "totalKind">;
    connections: Omit<ProviderTransportAccountingSnapshot["connections"], "totalKind">;
    fallbacks: Omit<ProviderTransportAccountingSnapshot["fallbacks"], "totalKind">;
    providerFallbacks: Omit<ProviderTransportAccountingSnapshot["providerFallbacks"], "totalKind">;
    zeroSubmissions: Omit<ProviderTransportAccountingSnapshot["zeroSubmissions"], "totalKind">;
  };
  events: AiModelTransportEvent[];
  acceptedEvents: number;
  nextPrewarmConnectionOrdinal: number;
  callTotalsLowerBound: boolean;
  outcomeTotalsLowerBound: boolean;
  aggregateLowerBounds: {
    attempts: boolean;
    connections: boolean;
    fallbacks: boolean;
    providerFallbacks: boolean;
    zeroSubmissions: boolean;
    events: boolean;
  };
  activeEventType?: AiModelTransportEvent["type"];
  callDetailsTruncated: boolean;
  eventDetailsTruncated: boolean;
  issues: Set<ProviderTransportAccountingCoverageReason>;
};

export function lowerMissingTransportFallbackCause(
  event: Extract<AiModelTransportEvent, { type: "fallback" }>,
  state: ProviderTransportProjectionState,
): void {
  const aggregate =
    event.reason === "connection_failure"
      ? "connections"
      : event.reason === "stream_failure"
        ? "attempts"
        : undefined;
  if (aggregate) {
    state.aggregateLowerBounds[aggregate] = true;
    state.issues.add("transport_totals_lower_bound");
  }
}

export function countProviderTransportFallback(
  event: Extract<AiModelTransportEvent, { type: "fallback" }>,
  state: ProviderTransportProjectionState,
): void {
  state.aggregate.fallbacks.total += 1;
  const key =
    event.reason === "connection_failure"
      ? "connectionFailures"
      : event.reason === "submission_failure"
        ? "submissionFailures"
        : event.reason === "stream_failure"
          ? "streamFailures"
          : event.reason;
  state.aggregate.fallbacks[key] += 1;
}

export function retainProviderTransportEventDetail(
  event: AiModelTransportEvent,
  state: ProviderTransportProjectionState,
  maxEvents: number,
): void {
  if (state.events.length >= maxEvents) {
    state.eventDetailsTruncated = true;
    state.issues.add("transport_details_truncated");
    return;
  }
  state.events.push(event);
}

export function countProviderTransportAttempt(
  event: Extract<AiModelTransportEvent, { type: "attempt" }>,
  state: ProviderTransportProjectionState,
): void {
  state.aggregate.attempts.total += 1;
  switch (event.reason) {
    case "initial":
      state.aggregate.attempts.initial += 1;
      break;
    case "retry":
      state.aggregate.attempts.retries += 1;
      break;
    case "auth_recovery":
      state.aggregate.attempts.authRecoveries += 1;
      break;
    case "payload_recovery":
      state.aggregate.attempts.payloadRecoveries += 1;
      break;
    case "transport_fallback":
      state.aggregate.attempts.transportFallbacks += 1;
      break;
  }
}

function unavailableCoverage(
  reasons: Iterable<ProviderTransportAccountingCoverageReason>,
): ProviderTransportAccountingCoverage {
  return { state: "unavailable", reasons: [...new Set(reasons)] };
}

function totalsKind(lowerBound: boolean): ProviderTransportAccountingTotalKind {
  return lowerBound ? "lower_bound" : "exact";
}

function projectLogicalCall(call: ProviderTransportProjectionCall): ProviderTransportLogicalCall {
  return {
    callId: call.callId,
    provider: call.provider,
    model: call.model,
    api: call.api,
    ...(call.currentTransport ? { transport: call.currentTransport } : {}),
    ...(call.phase?.servingModel || call.currentServingModel
      ? { servingModel: call.phase?.servingModel ?? call.currentServingModel }
      : {}),
    ...(call.logicalOutcome ? { outcome: call.logicalOutcome } : {}),
    cachedInput: call.cachedInput ?? { state: "unknown" },
  };
}

function callHasMissingAttemptEventEvidence(call: ProviderTransportProjectionCall): boolean {
  const hasServerSubmissionWithoutTerminalAttempt = call.phase?.submissionEvidence === true;
  const hasUnresolvedSettlementAfterAcceptedEvent =
    call.pendingSettlementOutcome !== undefined && call.acceptedCallEventCount > 0;
  if (call.latestZeroSubmissionOutcome) {
    return hasUnresolvedSettlementAfterAcceptedEvent;
  }
  return hasServerSubmissionWithoutTerminalAttempt || hasUnresolvedSettlementAfterAcceptedEvent;
}

export function projectProviderTransportAccounting(state: ProviderTransportProjectionState) {
  const issues = new Set(state.issues);
  const calls = [...state.logicalCalls.values()];
  const hasCallWithoutAcceptedTransportEvent = calls.some(
    (call) => call.acceptedCallEventCount === 0,
  );
  const missingAttemptEventEvidence = calls.some(callHasMissingAttemptEventEvidence);
  for (const call of calls) {
    if (!call.logicalOutcome) {
      issues.add("transport_logical_call_incomplete");
    }
    if (call.acceptedCallEventCount === 0) {
      issues.add("not_instrumented");
    }
    if (call.phase?.submissionEvidence) {
      issues.add("not_instrumented");
    }
  }
  const hasSnapshot =
    calls.length > 0 ||
    state.eventFingerprints.size > 0 ||
    state.callTotalsLowerBound ||
    state.outcomeTotalsLowerBound ||
    Object.values(state.aggregateLowerBounds).some(Boolean);
  if (!hasSnapshot) {
    return {
      coverage: unavailableCoverage(issues.size > 0 ? issues : ["not_observed"]),
    };
  }
  const attemptsLowerBound =
    state.aggregateLowerBounds.attempts ||
    hasCallWithoutAcceptedTransportEvent ||
    missingAttemptEventEvidence ||
    calls.some(
      (call) =>
        !call.latestZeroSubmissionOutcome && (!call.lastAttempt || call.pendingTransportTarget),
    );
  const connectionsLowerBound =
    state.aggregateLowerBounds.connections || hasCallWithoutAcceptedTransportEvent;
  const fallbacksLowerBound =
    state.aggregateLowerBounds.fallbacks || hasCallWithoutAcceptedTransportEvent;
  const providerFallbacksLowerBound =
    state.aggregateLowerBounds.providerFallbacks || hasCallWithoutAcceptedTransportEvent;
  const zeroSubmissionsLowerBound =
    state.aggregateLowerBounds.zeroSubmissions || hasCallWithoutAcceptedTransportEvent;
  const eventsLowerBound =
    state.aggregateLowerBounds.events ||
    hasCallWithoutAcceptedTransportEvent ||
    missingAttemptEventEvidence;
  if (
    attemptsLowerBound ||
    connectionsLowerBound ||
    fallbacksLowerBound ||
    providerFallbacksLowerBound ||
    zeroSubmissionsLowerBound ||
    eventsLowerBound
  ) {
    issues.add("transport_totals_lower_bound");
  }
  const outcomeLowerBound =
    state.callTotalsLowerBound ||
    state.outcomeTotalsLowerBound ||
    calls.some((call) => !call.logicalOutcome);
  const snapshot: ProviderTransportAccountingSnapshot = {
    logicalCalls: {
      total: calls.length,
      totalKind: totalsKind(state.callTotalsLowerBound),
      outcomeKind: totalsKind(outcomeLowerBound),
      completed: calls.filter((call) => call.logicalOutcome === "completed").length,
      failed: calls.filter((call) => call.logicalOutcome === "failed").length,
      aborted: calls.filter((call) => call.logicalOutcome === "aborted").length,
      entries: calls.map(projectLogicalCall),
      entriesTruncated: state.callDetailsTruncated,
    },
    attempts: { ...state.aggregate.attempts, totalKind: totalsKind(attemptsLowerBound) },
    connections: {
      ...state.aggregate.connections,
      totalKind: totalsKind(connectionsLowerBound),
    },
    fallbacks: {
      ...state.aggregate.fallbacks,
      totalKind: totalsKind(fallbacksLowerBound),
    },
    providerFallbacks: {
      ...state.aggregate.providerFallbacks,
      totalKind: totalsKind(providerFallbacksLowerBound),
    },
    zeroSubmissions: {
      ...state.aggregate.zeroSubmissions,
      totalKind: totalsKind(zeroSubmissionsLowerBound),
    },
    events: {
      total: state.acceptedEvents,
      totalKind: totalsKind(eventsLowerBound),
      entries: state.events.map((event) => ({ ...event })),
      entriesTruncated: state.eventDetailsTruncated,
    },
  };
  if (state.eventFingerprints.size === 0) {
    return {
      snapshot,
      coverage: unavailableCoverage(issues.size > 0 ? issues : ["not_instrumented"]),
    };
  }
  const reasons = [...issues];
  return {
    snapshot,
    coverage:
      reasons.length === 0
        ? ({ state: "complete" } as const)
        : ({ state: "partial", reasons } as const),
  };
}

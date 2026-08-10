import { AI_MODEL_TRANSPORT_OUTCOMES, type AiModelTransportEvent } from "@openclaw/ai";
import {
  MAX_MODEL_TRANSPORT_ATTEMPTS,
  MAX_MODEL_TRANSPORT_EVENTS,
  MAX_MODEL_TRANSPORT_INVOCATIONS,
  MAX_MODEL_TRANSPORT_LOGICAL_CALLS,
} from "./provider-transport-accounting-limits.js";
import {
  hasTransportFallbackCause,
  isKnownValue,
  normalizeIdentity,
  normalizeTransportEvent,
} from "./provider-transport-accounting-normalize.js";
import {
  countProviderTransportAttempt,
  countProviderTransportFallback,
  lowerMissingTransportFallbackCause,
  projectProviderTransportAccounting,
  providerTransportAggregateKeysForEvent,
  retainProviderTransportAttempt,
  retainProviderTransportInvocation,
  retainProviderTransportEventDetail,
  type ProviderTransportProjectionCall,
} from "./provider-transport-accounting-project.js";
import {
  commitProviderTransportEventIdentity,
  createMutableProviderTransportAccounting,
  hasSameProviderTransportRoute,
  latestProviderTransportLogicalCall,
  markProviderTransportObservationFailure,
  prepareProviderTransportEventIdentity,
  rejectProviderTransportFact as rejectFact,
  rejectProviderTransportValue as rejectValue,
  requireProviderTransportIdentity as requireIdentity,
  type MutableProviderTransportAccounting,
} from "./provider-transport-accounting-state.js";
import {
  bindOrValidateTransport,
  canContinueTransportAttempt,
  expectedTransportAttemptReason,
  pendingOrCurrentTransport,
  rejectAfterAbortedZeroSubmission,
  rejectTransportInvocationRelation,
  transportAttemptReasonMatches,
  validateRequestedTransportIdentity,
  validateTransportEventRoute,
  validateTransportOrdinal,
} from "./provider-transport-accounting-validate.js";
import type {
  ProviderTransportAccountingCollector,
  ProviderTransportAccountingObserver,
} from "./provider-transport-accounting.types.js";

export {
  observeProviderTransportEvent,
  observeProviderTransportLogicalCallFinalized,
  observeProviderTransportLogicalCallSettled,
  observeProviderTransportLogicalCallStarted,
  runOutsideProviderTransportAccountingObserver,
  runWithProviderTransportAccountingObserver,
} from "./provider-transport-accounting-observer.js";
export type {
  ProviderTransportAccountingCollector,
  ProviderTransportAccountingCoverage,
  ProviderTransportAccountingCoverageReason,
  ProviderTransportAccountingObserver,
  ProviderTransportAccountingObservationKind,
  ProviderTransportAccountingSnapshot,
} from "./provider-transport-accounting.types.js";

type TrackedLogicalCall = ProviderTransportProjectionCall;
type RoutePhase = NonNullable<TrackedLogicalCall["phase"]>;
type CallScopedTransportEvent = Exclude<
  AiModelTransportEvent,
  { type: "connection"; reason: "prewarm" }
>;

function correlateTransportEvent(
  event: AiModelTransportEvent,
  state: MutableProviderTransportAccounting,
): { callId?: string; call?: TrackedLogicalCall; identityScope: string } | undefined {
  if (event.type === "connection" && event.reason === "prewarm") {
    return { identityScope: "prewarm" };
  }
  const normalized = normalizeIdentity(event.callId);
  if (!normalized.value) {
    rejectFact(
      state,
      normalized.overflow ? "transport_identity_overflow" : "transport_uncorrelated_event",
      "call_event",
    );
    return undefined;
  }
  const latest = latestProviderTransportLogicalCall(normalized.value, state);
  if (!latest) {
    rejectFact(state, "transport_uncorrelated_event", "call_event");
    return undefined;
  }
  return {
    callId: normalized.value,
    call: latest.call,
    identityScope: latest.key,
  };
}

function requireOpenCall(
  event: CallScopedTransportEvent,
  state: MutableProviderTransportAccounting,
): TrackedLogicalCall | undefined {
  const call = latestProviderTransportLogicalCall(event.callId, state)?.call;
  if (!call) {
    return rejectValue(state, "transport_uncorrelated_event", "call_event");
  }
  if (call.settledOutcome || call.finalized) {
    return rejectValue(state, "transport_event_conflict", "event");
  }
  return call;
}

function markOutcomeConflict(state: MutableProviderTransportAccounting): void {
  rejectFact(state, "transport_event_conflict", "outcome");
}

function sealPendingSettlement(
  call: TrackedLogicalCall,
  state: MutableProviderTransportAccounting,
  observationComplete = false,
): void {
  const pending = call.pendingSettlementOutcome;
  if (!pending || call.settledOutcome || call.pendingTransportTarget || call.phase) {
    return;
  }
  const evidence = call.latestZeroSubmissionOutcome ?? call.lastAttempt?.outcome;
  if (!evidence) {
    if (observationComplete) {
      call.settledOutcome = pending;
      call.pendingSettlementOutcome = undefined;
    }
    return;
  }
  if (evidence === pending) {
    // Failed transport evidence may be followed by delayed retry telemetry in
    // either observer order. Keep it open rather than sealing a false terminal.
    if (evidence === "failed" && !observationComplete) {
      return;
    }
    call.settledOutcome = pending;
    call.pendingSettlementOutcome = undefined;
    return;
  }
  if (evidence === "failed" && !observationComplete) {
    return;
  }
  markOutcomeConflict(state);
  if (pending === "completed") {
    state.aggregateLowerBounds.attempts = true;
    state.aggregateLowerBounds.events = true;
  }
  call.settledOutcome = pending;
  call.pendingSettlementOutcome = undefined;
}

function applyAttempt(
  event: Extract<AiModelTransportEvent, { type: "attempt" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  const call = requireOpenCall(event, state);
  if (
    !call ||
    rejectAfterAbortedZeroSubmission(call, state) ||
    !canContinueTransportAttempt(call, state)
  ) {
    return false;
  }
  const previous = call.lastAttempt;
  const expectedOrdinal = (previous?.ordinal ?? 0) + 1;
  if (
    !validateRequestedTransportIdentity(event, call, state) ||
    !validateTransportOrdinal(event.ordinal, expectedOrdinal, state)
  ) {
    return false;
  }

  const phase = call.phase;
  const expectedTransport = phase?.transport ?? pendingOrCurrentTransport(call) ?? event.transport;
  if (!validateTransportEventRoute(event, expectedTransport, state)) {
    return false;
  }
  const pendingInvocation = call.pendingInvocationAttempt;
  if (
    pendingInvocation &&
    (pendingInvocation.ordinal !== event.ordinal || pendingInvocation.reason !== event.reason)
  ) {
    return rejectTransportInvocationRelation(state);
  }
  const expectedReason = expectedTransportAttemptReason(call);
  if (!transportAttemptReasonMatches(event.reason, expectedReason)) {
    return rejectFact(state, "transport_invalid_fact", "event");
  }
  if (!pendingInvocation) {
    state.issues.add("transport_invocation_relation_incomplete");
    state.aggregateLowerBounds.invocations = true;
  }
  if (
    !call.pendingTransportTarget &&
    !phase &&
    !bindOrValidateTransport(call, event.transport, state)
  ) {
    return false;
  }

  const servingModel = phase?.servingModel ?? call.model;
  call.currentTransport = expectedTransport;
  call.currentServingModel = servingModel;
  call.currentServingModelConfirmedByProviderFallback = phase !== undefined;
  call.latestZeroSubmissionOutcome = undefined;
  call.lastAttempt = {
    ordinal: event.ordinal,
    transport: expectedTransport,
    servingModel,
    outcome: event.outcome,
  };
  call.unsettledInvocations = 0;
  call.pendingInvocationAttempt = undefined;
  call.fallbackCause =
    event.outcome === "failed"
      ? { transport: expectedTransport, reason: "stream_failure" }
      : undefined;
  call.pendingTransportTarget = undefined;
  call.phase = undefined;
  retainProviderTransportAttempt(
    {
      logicalCallOrdinal: call.ordinal,
      ordinal: event.ordinal,
      transport: expectedTransport,
      reason: event.reason,
      outcome: event.outcome,
    },
    state,
    MAX_MODEL_TRANSPORT_ATTEMPTS,
  );
  countProviderTransportAttempt(event, state);
  sealPendingSettlement(call, state);
  return true;
}

function applyInvocation(
  event: Extract<AiModelTransportEvent, { type: "invocation" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  const call = requireOpenCall(event, state);
  if (
    !call ||
    rejectAfterAbortedZeroSubmission(call, state) ||
    !canContinueTransportAttempt(call, state) ||
    !validateRequestedTransportIdentity(event, call, state) ||
    !validateTransportOrdinal(event.ordinal, call.nextInvocationOrdinal, state)
  ) {
    return false;
  }
  const expectedAttemptOrdinal = (call.lastAttempt?.ordinal ?? 0) + 1;
  if (event.attemptOrdinal !== expectedAttemptOrdinal) {
    return rejectTransportInvocationRelation(state);
  }
  const expectedReason = expectedTransportAttemptReason(call);
  if (!transportAttemptReasonMatches(event.reason, expectedReason)) {
    return rejectTransportInvocationRelation(state);
  }
  const pendingInvocation = call.pendingInvocationAttempt;
  if (
    pendingInvocation
      ? pendingInvocation.ordinal !== event.attemptOrdinal ||
        pendingInvocation.reason !== event.reason ||
        pendingInvocation.nextHopOrdinal !== event.hopOrdinal
      : event.hopOrdinal !== 1
  ) {
    return rejectTransportInvocationRelation(state);
  }
  const expectedTransport =
    call.phase?.transport ?? pendingOrCurrentTransport(call) ?? event.transport;
  if (!validateTransportEventRoute(event, expectedTransport, state)) {
    return false;
  }
  if (!call.pendingTransportTarget && !call.phase) {
    if (!bindOrValidateTransport(call, event.transport, state)) {
      return false;
    }
  }
  call.nextInvocationOrdinal += 1;
  call.unsettledInvocations += 1;
  call.pendingInvocationAttempt = {
    ordinal: event.attemptOrdinal,
    reason: event.reason,
    nextHopOrdinal: event.hopOrdinal + 1,
  };
  retainProviderTransportInvocation(event, call.ordinal, state, MAX_MODEL_TRANSPORT_INVOCATIONS);
  return true;
}

function countConnection(
  event: Extract<AiModelTransportEvent, { type: "connection" }>,
  state: MutableProviderTransportAccounting,
): void {
  state.aggregate.connections.total += 1;
  state.aggregate.connections[
    event.reason === "prewarm"
      ? "prewarms"
      : event.reason === "reconnect"
        ? "reconnects"
        : "initial"
  ] += 1;
}

function applyConnection(
  event: Extract<AiModelTransportEvent, { type: "connection" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  if (event.reason === "prewarm") {
    if (!validateTransportOrdinal(event.ordinal, state.nextPrewarmConnectionOrdinal, state)) {
      return false;
    }
    state.nextPrewarmConnectionOrdinal += 1;
    countConnection(event, state);
    return true;
  }
  const call = requireOpenCall(event, state);
  if (
    !call ||
    rejectAfterAbortedZeroSubmission(call, state) ||
    !canContinueTransportAttempt(call, state)
  ) {
    return false;
  }
  const expectedTransport = call.phase?.transport ?? pendingOrCurrentTransport(call);
  if (
    !validateRequestedTransportIdentity(event, call, state) ||
    !validateTransportOrdinal(event.ordinal, call.nextConnectionOrdinal, state) ||
    (expectedTransport ? !validateTransportEventRoute(event, expectedTransport, state) : false)
  ) {
    return false;
  }
  if (!expectedTransport) {
    call.currentTransport = event.transport;
  }
  call.latestZeroSubmissionOutcome = undefined;
  call.nextConnectionOrdinal += 1;
  call.fallbackCause =
    event.outcome === "failed"
      ? { transport: event.transport, reason: "connection_failure" }
      : undefined;
  countConnection(event, state);
  return true;
}

function applyTransportFallback(
  event: Extract<AiModelTransportEvent, { type: "fallback" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  const call = requireOpenCall(event, state);
  if (
    !call ||
    rejectAfterAbortedZeroSubmission(call, state) ||
    call.pendingTransportTarget ||
    call.phase ||
    !canContinueTransportAttempt(call, state) ||
    !validateRequestedTransportIdentity(event, call, state)
  ) {
    if (call && (call.pendingTransportTarget || call.phase)) {
      rejectFact(state, "transport_event_conflict", "event");
    }
    return false;
  }
  if (call.currentTransport && call.currentTransport !== event.fromTransport) {
    return rejectFact(state, "transport_unknown_route", "event");
  }
  if (!hasTransportFallbackCause(event, call)) {
    lowerMissingTransportFallbackCause(event, state);
    return rejectFact(state, "transport_invalid_fact", "event");
  }
  if (!call.currentTransport) {
    call.currentTransport = event.fromTransport;
  }
  call.latestZeroSubmissionOutcome = undefined;
  call.fallbackCause = undefined;
  call.pendingTransportTarget = event.toTransport;
  countProviderTransportFallback(event, state);
  return true;
}

function applyProviderFallback(
  event: Extract<AiModelTransportEvent, { type: "provider_fallback" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  const call = requireOpenCall(event, state);
  if (
    !call ||
    rejectAfterAbortedZeroSubmission(call, state) ||
    !canContinueTransportAttempt(call, state) ||
    !validateRequestedTransportIdentity(event, call, state)
  ) {
    return false;
  }
  const pendingTransportTarget = call.pendingTransportTarget;
  const expectedTransport =
    call.phase?.transport ?? pendingTransportTarget ?? call.currentTransport ?? event.transport;
  if (!validateTransportEventRoute(event, expectedTransport, state)) {
    return false;
  }
  let expectedAttemptReason: RoutePhase["expectedAttemptReason"];
  if (pendingTransportTarget) {
    expectedAttemptReason = "transport_fallback";
  } else if (call.phase) {
    expectedAttemptReason = call.phase.expectedAttemptReason;
  } else {
    expectedAttemptReason = call.lastAttempt ? "same_route" : "initial";
  }

  const phase =
    call.phase ??
    ({
      transport: event.transport,
      servingModel: call.model,
      submissionEvidence: true,
      expectedAttemptReason,
    } satisfies RoutePhase);
  if (event.fromModel !== phase.servingModel || event.toModel === phase.servingModel) {
    return rejectFact(state, "transport_unknown_route", "event");
  }
  if (pendingTransportTarget) {
    call.currentTransport = pendingTransportTarget;
    call.pendingTransportTarget = undefined;
  } else if (!call.currentTransport) {
    call.currentTransport = event.transport;
  }
  phase.servingModel = event.toModel;
  phase.submissionEvidence = true;
  call.phase = phase;
  call.latestZeroSubmissionOutcome = undefined;
  state.aggregate.providerFallbacks.total += 1;
  state.aggregate.providerFallbacks.server += 1;
  return true;
}

function applyCoverage(
  event: Extract<AiModelTransportEvent, { type: "coverage" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  const call = requireOpenCall(event, state);
  if (
    !call ||
    call.latestZeroSubmissionOutcome ||
    call.phase ||
    call.pendingTransportTarget ||
    !validateRequestedTransportIdentity(event, call, state)
  ) {
    if (call && (call.latestZeroSubmissionOutcome || call.phase || call.pendingTransportTarget)) {
      rejectFact(state, "transport_event_conflict", "event");
    }
    return false;
  }
  if (!call.lastAttempt) {
    if (event.scope !== "transport_semantics") {
      return rejectFact(state, "transport_event_conflict", "event");
    }
    if (!bindOrValidateTransport(call, event.transport, state)) {
      return false;
    }
  } else if (
    !validateTransportEventRoute(event, call.lastAttempt.transport, state) ||
    (call.currentTransport !== undefined &&
      !validateTransportEventRoute(event, call.currentTransport, state))
  ) {
    return false;
  }
  if (event.scope === "provider_fallbacks") {
    state.aggregateLowerBounds.providerFallbacks = true;
    if (!call.currentServingModelConfirmedByProviderFallback) {
      call.currentServingModel = undefined;
    }
  } else {
    state.issues.add(event.reason);
    if (event.reason === "transport_submission_authority_partial") {
      state.aggregateLowerBounds.attempts = true;
      state.aggregateLowerBounds.invocations = true;
      state.aggregateLowerBounds.providerFallbacks = true;
      state.aggregateLowerBounds.zeroSubmissions = true;
    }
  }
  return true;
}

function applyZeroSubmission(
  event: Extract<AiModelTransportEvent, { type: "submission" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  const call = requireOpenCall(event, state);
  if (
    !call ||
    rejectAfterAbortedZeroSubmission(call, state) ||
    !canContinueTransportAttempt(call, state) ||
    !validateRequestedTransportIdentity(event, call, state)
  ) {
    return false;
  }
  if (call.phase?.submissionEvidence) {
    return rejectFact(state, "transport_event_conflict", "event");
  }
  if (call.unsettledInvocations > 0) {
    return rejectFact(state, "transport_event_conflict", "event");
  }
  if (call.pendingTransportTarget) {
    if (!validateTransportEventRoute(event, call.pendingTransportTarget, state)) {
      return false;
    }
    call.currentTransport = call.pendingTransportTarget;
    call.pendingTransportTarget = undefined;
  } else if (!bindOrValidateTransport(call, event.transport, state)) {
    return false;
  }
  call.phase = undefined;
  call.latestZeroSubmissionOutcome = event.outcome;
  call.fallbackCause = undefined;
  state.aggregate.zeroSubmissions.total += 1;
  state.aggregate.zeroSubmissions[event.outcome] += 1;
  sealPendingSettlement(call, state);
  return true;
}

function applyTransportEvent(
  event: AiModelTransportEvent,
  state: MutableProviderTransportAccounting,
): boolean {
  switch (event.type) {
    case "invocation":
      return applyInvocation(event, state);
    case "attempt":
      return applyAttempt(event, state);
    case "connection":
      return applyConnection(event, state);
    case "fallback":
      return applyTransportFallback(event, state);
    case "provider_fallback":
      return applyProviderFallback(event, state);
    case "coverage":
      return applyCoverage(event, state);
    case "submission":
      return applyZeroSubmission(event, state);
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return rejectFact(state, "transport_invalid_fact", "event");
    }
  }
}

export function createProviderTransportAccountingCollector(): ProviderTransportAccountingCollector {
  const state = createMutableProviderTransportAccounting();

  const observer: ProviderTransportAccountingObserver = {
    onObservationFailure(_kind) {
      markProviderTransportObservationFailure(state);
    },
    onLogicalCallStarted(rawCall) {
      if (state.sealed) {
        markProviderTransportObservationFailure(state);
        return;
      }
      const callId = requireIdentity(rawCall.callId, state, "call_outcome");
      const provider = requireIdentity(rawCall.provider, state, "call_outcome");
      const model = requireIdentity(rawCall.model, state, "call_outcome");
      const api = requireIdentity(rawCall.api, state, "call_outcome");
      if (!callId || !provider || !model || !api) {
        return;
      }
      const route = { provider, model, api };
      const latest = latestProviderTransportLogicalCall(callId, state);
      if (latest && !latest.call.finalized) {
        if (!hasSameProviderTransportRoute(latest.call, route)) {
          rejectFact(state, "transport_event_conflict", "call_outcome");
        }
        return;
      }
      if (state.logicalCalls.size >= MAX_MODEL_TRANSPORT_LOGICAL_CALLS) {
        state.callDetailsTruncated = true;
        rejectFact(state, "transport_details_truncated", "call_outcome");
        return;
      }
      const lifecycleKey = String(state.nextLogicalCallLifecycleOrdinal);
      state.nextLogicalCallLifecycleOrdinal += 1;
      if (latest?.call.finalized) {
        state.outcomeTotalsLowerBound = true;
        state.aggregateLowerBounds.attempts = true;
        state.aggregateLowerBounds.invocations = true;
        state.aggregateLowerBounds.connections = true;
        state.aggregateLowerBounds.fallbacks = true;
        state.aggregateLowerBounds.providerFallbacks = true;
        state.aggregateLowerBounds.zeroSubmissions = true;
        state.aggregateLowerBounds.events = true;
        state.issues.add("transport_lifecycle_ambiguous");
      }
      state.logicalCalls.set(lifecycleKey, {
        ordinal: Number(lifecycleKey),
        callId,
        ...route,
        nextConnectionOrdinal: 1,
        nextInvocationOrdinal: 1,
        unsettledInvocations: 0,
        acceptedCallEventCount: 0,
      });
      state.latestLogicalCallKeyByCallId.set(callId, lifecycleKey);
    },
    onLogicalCallSettled(rawCallId, rawOutcome, cachedInput = { state: "unknown" }) {
      if (state.sealed) {
        markProviderTransportObservationFailure(state);
        return;
      }
      const callId = requireIdentity(rawCallId, state, "call_outcome");
      if (!callId) {
        return;
      }
      const call = latestProviderTransportLogicalCall(callId, state)?.call;
      if (!call) {
        rejectFact(state, "transport_uncorrelated_event", "call_outcome");
        return;
      }
      if (!isKnownValue(rawOutcome, AI_MODEL_TRANSPORT_OUTCOMES)) {
        rejectFact(state, "transport_invalid_fact", "outcome");
        return;
      }
      if (call.logicalOutcome) {
        if (call.logicalOutcome !== rawOutcome) {
          markOutcomeConflict(state);
        }
        if (
          call.cachedInput?.state === "exact" &&
          cachedInput.state === "exact" &&
          call.cachedInput.tokens !== cachedInput.tokens
        ) {
          rejectFact(state, "transport_event_conflict", "outcome");
        } else if (call.cachedInput?.state !== "exact" || cachedInput.state === "exact") {
          call.cachedInput = cachedInput;
        }
        return;
      }
      call.logicalOutcome = rawOutcome;
      call.cachedInput = cachedInput;
      call.pendingSettlementOutcome = rawOutcome;
      sealPendingSettlement(call, state);
    },
    onTransportEvent(rawEvent) {
      if (state.sealed) {
        markProviderTransportObservationFailure(state);
        return;
      }
      state.activeAggregateKeys = providerTransportAggregateKeysForEvent(rawEvent);
      try {
        const correlation = correlateTransportEvent(rawEvent, state);
        if (!correlation) {
          return;
        }
        const event = normalizeTransportEvent(rawEvent, correlation.callId, (reason, scope) =>
          rejectFact(state, reason, scope),
        );
        if (!event) {
          return;
        }
        const identity = prepareProviderTransportEventIdentity(
          event,
          correlation.identityScope,
          state,
        );
        if (identity.decision !== "accepted") {
          return;
        }
        if (!applyTransportEvent(event, state)) {
          return;
        }
        // Rejected observations must not poison a later valid replay using the same ID.
        commitProviderTransportEventIdentity(identity, state);
        if (correlation.call) {
          correlation.call.acceptedCallEventCount += 1;
        }
        state.acceptedEvents += 1;
        retainProviderTransportEventDetail(event, state, MAX_MODEL_TRANSPORT_EVENTS);
      } finally {
        state.activeAggregateKeys = undefined;
      }
    },
    onLogicalCallFinalized(rawCallId) {
      if (state.sealed) {
        markProviderTransportObservationFailure(state);
        return;
      }
      const callId = requireIdentity(rawCallId, state, "call_outcome");
      if (!callId) {
        return;
      }
      const call = latestProviderTransportLogicalCall(callId, state)?.call;
      if (!call) {
        rejectFact(state, "transport_uncorrelated_event", "call_outcome");
        return;
      }
      if (call.finalized) {
        return;
      }
      call.finalized = true;
      sealPendingSettlement(call, state, true);
    },
  };

  return {
    observer,
    finalize: (callId) => observer.onLogicalCallFinalized(callId),
    seal: () => {
      for (const call of state.logicalCalls.values()) {
        sealPendingSettlement(call, state, true);
      }
      state.sealed = true;
    },
    project: () => projectProviderTransportAccounting(state),
  };
}

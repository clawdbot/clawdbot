import { AI_MODEL_TRANSPORT_OUTCOMES, type AiModelTransportEvent } from "@openclaw/ai";
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
  retainProviderTransportEventDetail,
  type ProviderTransportProjectionCall,
} from "./provider-transport-accounting-project.js";
import {
  commitProviderTransportEventIdentity,
  markProviderTransportObservationFailure,
  prepareProviderTransportEventIdentity,
  rejectProviderTransportFact,
  rejectProviderTransportValue,
  requireProviderTransportIdentity,
  type MutableProviderTransportAccounting,
} from "./provider-transport-accounting-state.js";
import type {
  ProviderTransportAccountingCollector,
  ProviderTransportAccountingObserver,
  ProviderTransportLogicalCallStarted,
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
  ProviderTransportAccountingCoverageReason,
  ProviderTransportAccountingObserver,
  ProviderTransportAccountingObservationKind,
  ProviderTransportAccountingSnapshot,
} from "./provider-transport-accounting.types.js";

const MAX_MODEL_TRANSPORT_LOGICAL_CALLS = 64;
const MAX_MODEL_TRANSPORT_EVENTS = 128;

type RequestedRoute = Omit<ProviderTransportLogicalCallStarted, "callId">;
type TrackedLogicalCall = ProviderTransportProjectionCall;
type RoutePhase = NonNullable<TrackedLogicalCall["phase"]>;
type CallScopedTransportEvent = Exclude<
  AiModelTransportEvent,
  { type: "connection"; reason: "prewarm" }
>;

const rejectFact = rejectProviderTransportFact;
const rejectValue = rejectProviderTransportValue;
const requireIdentity = requireProviderTransportIdentity;

function sameRequestedRoute(left: RequestedRoute, right: RequestedRoute): boolean {
  return left.provider === right.provider && left.model === right.model && left.api === right.api;
}

function eventTransport(event: AiModelTransportEvent): string {
  return event.type === "fallback" ? event.fromTransport : event.transport;
}

function validateRequestedIdentity(
  event: AiModelTransportEvent,
  call: TrackedLogicalCall,
  state: MutableProviderTransportAccounting,
): boolean {
  return event.provider === call.provider && event.model === call.model && event.api === call.api
    ? true
    : rejectFact(state, "transport_unknown_route", "event");
}

function validateEventTransport(
  event: AiModelTransportEvent,
  expectedTransport: string,
  state: MutableProviderTransportAccounting,
): boolean {
  return eventTransport(event) === expectedTransport
    ? true
    : rejectFact(state, "transport_unknown_route", "event");
}

function validateOrdinal(
  actual: number,
  expected: number,
  state: MutableProviderTransportAccounting,
): boolean {
  return actual === expected ? true : rejectFact(state, "transport_invalid_ordinal", "event");
}

function latestLogicalCall(
  callId: string,
  state: MutableProviderTransportAccounting,
): { call: TrackedLogicalCall; key: string } | undefined {
  const key = state.latestLogicalCallKeyByCallId.get(callId);
  const call = key ? state.logicalCalls.get(key) : undefined;
  return call && key ? { call, key } : undefined;
}

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
  const latest = latestLogicalCall(normalized.value, state);
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
  const call = latestLogicalCall(event.callId, state)?.call;
  if (!call) {
    return rejectValue(state, "transport_uncorrelated_event", "call_event");
  }
  if (call.settledOutcome || call.finalized) {
    return rejectValue(state, "transport_event_conflict", "event");
  }
  return call;
}

function canContinueAfterAttempt(
  call: TrackedLogicalCall,
  state: MutableProviderTransportAccounting,
): boolean {
  return !call.lastAttempt || call.lastAttempt.outcome === "failed"
    ? true
    : rejectFact(state, "transport_event_conflict", "event");
}

function bindOrValidateCurrentTransport(
  call: TrackedLogicalCall,
  transport: string,
  state: MutableProviderTransportAccounting,
): boolean {
  if (!call.currentTransport) {
    call.currentTransport = transport;
    return true;
  }
  return call.currentTransport === transport
    ? true
    : rejectFact(state, "transport_unknown_route", "event");
}

function pendingOrCurrentTransport(call: TrackedLogicalCall): string | undefined {
  return call.pendingTransportTarget ?? call.currentTransport;
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

function rejectAfterAbortedZeroSubmission(
  call: TrackedLogicalCall,
  state: MutableProviderTransportAccounting,
): boolean {
  if (call.latestZeroSubmissionOutcome !== "aborted") {
    return false;
  }
  rejectFact(state, "transport_event_conflict", "event");
  return true;
}

function applyAttempt(
  event: Extract<AiModelTransportEvent, { type: "attempt" }>,
  state: MutableProviderTransportAccounting,
): boolean {
  const call = requireOpenCall(event, state);
  if (
    !call ||
    rejectAfterAbortedZeroSubmission(call, state) ||
    !canContinueAfterAttempt(call, state)
  ) {
    return false;
  }
  const previous = call.lastAttempt;
  const expectedOrdinal = (previous?.ordinal ?? 0) + 1;
  if (
    !validateRequestedIdentity(event, call, state) ||
    !validateOrdinal(event.ordinal, expectedOrdinal, state)
  ) {
    return false;
  }

  const phase = call.phase;
  const expectedTransport = phase?.transport ?? pendingOrCurrentTransport(call) ?? event.transport;
  if (!validateEventTransport(event, expectedTransport, state)) {
    return false;
  }
  const expectedReason =
    phase?.expectedAttemptReason ??
    (call.pendingTransportTarget
      ? "transport_fallback"
      : previous || call.latestZeroSubmissionOutcome
        ? "same_route"
        : "initial");
  if (expectedReason === "same_route") {
    if (event.reason === "initial" || event.reason === "transport_fallback") {
      return rejectFact(state, "transport_invalid_fact", "event");
    }
  } else if (event.reason !== expectedReason) {
    return rejectFact(state, "transport_invalid_fact", "event");
  }
  if (
    !call.pendingTransportTarget &&
    !phase &&
    !bindOrValidateCurrentTransport(call, event.transport, state)
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
  call.fallbackCause =
    event.outcome === "failed"
      ? { transport: expectedTransport, reason: "stream_failure" }
      : undefined;
  call.pendingTransportTarget = undefined;
  call.phase = undefined;
  countProviderTransportAttempt(event, state);
  sealPendingSettlement(call, state);
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
    if (!validateOrdinal(event.ordinal, state.nextPrewarmConnectionOrdinal, state)) {
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
    !canContinueAfterAttempt(call, state)
  ) {
    return false;
  }
  const expectedTransport = call.phase?.transport ?? pendingOrCurrentTransport(call);
  if (
    !validateRequestedIdentity(event, call, state) ||
    !validateOrdinal(event.ordinal, call.nextConnectionOrdinal, state) ||
    (expectedTransport ? !validateEventTransport(event, expectedTransport, state) : false)
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
    !canContinueAfterAttempt(call, state) ||
    !validateRequestedIdentity(event, call, state)
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
    !canContinueAfterAttempt(call, state) ||
    !validateRequestedIdentity(event, call, state)
  ) {
    return false;
  }
  const pendingTransportTarget = call.pendingTransportTarget;
  const expectedTransport =
    call.phase?.transport ?? pendingTransportTarget ?? call.currentTransport ?? event.transport;
  if (!validateEventTransport(event, expectedTransport, state)) {
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
    !call.lastAttempt ||
    !validateRequestedIdentity(event, call, state)
  ) {
    if (
      call &&
      (call.latestZeroSubmissionOutcome ||
        call.phase ||
        call.pendingTransportTarget ||
        !call.lastAttempt)
    ) {
      rejectFact(state, "transport_event_conflict", "event");
    }
    return false;
  }
  if (
    !validateEventTransport(event, call.lastAttempt.transport, state) ||
    (call.currentTransport !== undefined &&
      !validateEventTransport(event, call.currentTransport, state))
  ) {
    return false;
  }
  state.aggregateLowerBounds.providerFallbacks = true;
  if (!call.currentServingModelConfirmedByProviderFallback) {
    call.currentServingModel = undefined;
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
    !canContinueAfterAttempt(call, state) ||
    !validateRequestedIdentity(event, call, state)
  ) {
    return false;
  }
  if (call.phase?.submissionEvidence) {
    return rejectFact(state, "transport_event_conflict", "event");
  }
  if (call.pendingTransportTarget) {
    if (!validateEventTransport(event, call.pendingTransportTarget, state)) {
      return false;
    }
    call.currentTransport = call.pendingTransportTarget;
    call.pendingTransportTarget = undefined;
  } else if (!bindOrValidateCurrentTransport(call, event.transport, state)) {
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
  const state: MutableProviderTransportAccounting = {
    logicalCalls: new Map(),
    latestLogicalCallKeyByCallId: new Map(),
    nextLogicalCallLifecycleOrdinal: 1,
    eventFingerprints: new Map(),
    aggregate: {
      attempts: {
        total: 0,
        initial: 0,
        retries: 0,
        authRecoveries: 0,
        payloadRecoveries: 0,
        transportFallbacks: 0,
      },
      connections: { total: 0, initial: 0, prewarms: 0, reconnects: 0 },
      fallbacks: {
        total: 0,
        unsupported: 0,
        connectionFailures: 0,
        submissionFailures: 0,
        streamFailures: 0,
        policy: 0,
      },
      providerFallbacks: { total: 0, server: 0 },
      zeroSubmissions: { total: 0, failed: 0, aborted: 0 },
    },
    events: [],
    acceptedEvents: 0,
    nextPrewarmConnectionOrdinal: 1,
    callTotalsLowerBound: false,
    outcomeTotalsLowerBound: false,
    aggregateLowerBounds: {
      attempts: false,
      connections: false,
      fallbacks: false,
      providerFallbacks: false,
      zeroSubmissions: false,
      events: false,
    },
    callDetailsTruncated: false,
    eventDetailsTruncated: false,
    issues: new Set(),
  };

  const observer: ProviderTransportAccountingObserver = {
    onObservationFailure(_kind) {
      markProviderTransportObservationFailure(state);
    },
    onLogicalCallStarted(rawCall) {
      const callId = requireIdentity(rawCall.callId, state, "call_outcome");
      const provider = requireIdentity(rawCall.provider, state, "call_outcome");
      const model = requireIdentity(rawCall.model, state, "call_outcome");
      const api = requireIdentity(rawCall.api, state, "call_outcome");
      if (!callId || !provider || !model || !api) {
        return;
      }
      const route = { provider, model, api };
      const latest = latestLogicalCall(callId, state);
      if (latest && !latest.call.finalized) {
        if (!sameRequestedRoute(latest.call, route)) {
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
      state.logicalCalls.set(lifecycleKey, {
        callId,
        ...route,
        nextConnectionOrdinal: 1,
        acceptedCallEventCount: 0,
      });
      state.latestLogicalCallKeyByCallId.set(callId, lifecycleKey);
    },
    onLogicalCallSettled(rawCallId, rawOutcome, cachedInput = { state: "unknown" }) {
      const callId = requireIdentity(rawCallId, state, "call_outcome");
      if (!callId) {
        return;
      }
      const call = latestLogicalCall(callId, state)?.call;
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
      state.activeEventType = rawEvent.type;
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
        state.activeEventType = undefined;
      }
    },
    onLogicalCallFinalized(rawCallId) {
      const callId = requireIdentity(rawCallId, state, "call_outcome");
      if (!callId) {
        return;
      }
      const call = latestLogicalCall(callId, state)?.call;
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
    project: () => projectProviderTransportAccounting(state),
  };
}

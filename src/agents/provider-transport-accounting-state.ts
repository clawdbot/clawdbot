import type { AiModelTransportEvent } from "@openclaw/ai";
import {
  normalizeIdentity,
  type LowerBoundScope,
} from "./provider-transport-accounting-normalize.js";
import {
  providerTransportAggregateKeysForEvent,
  type ProviderTransportAggregateLowerBoundKey,
  type ProviderTransportProjectionCall,
  type ProviderTransportProjectionState,
} from "./provider-transport-accounting-project.js";
import type { ProviderTransportAccountingCoverageReason } from "./provider-transport-accounting.types.js";

const MAX_MODEL_TRANSPORT_EVENT_IDENTITIES = 256;

type EventIdentityDecision = "accepted" | "exact_duplicate" | "rejected";

export type PreparedProviderTransportEventIdentity = {
  decision: EventIdentityDecision;
  identityKey?: string;
  record?: {
    aggregateKeys: ProviderTransportAggregateLowerBoundKey[];
    fingerprint: string;
  };
};

export type MutableProviderTransportAccounting = ProviderTransportProjectionState;

export function hasSameProviderTransportRoute(
  left: Pick<ProviderTransportProjectionCall, "provider" | "model" | "api">,
  right: Pick<ProviderTransportProjectionCall, "provider" | "model" | "api">,
): boolean {
  return left.provider === right.provider && left.model === right.model && left.api === right.api;
}

export function latestProviderTransportLogicalCall(
  callId: string,
  state: MutableProviderTransportAccounting,
): { call: ProviderTransportProjectionCall; key: string } | undefined {
  const key = state.latestLogicalCallKeyByCallId.get(callId);
  const call = key ? state.logicalCalls.get(key) : undefined;
  return call && key ? { call, key } : undefined;
}

export function createMutableProviderTransportAccounting(): MutableProviderTransportAccounting {
  return {
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
    attempts: [],
    invocations: [],
    acceptedEvents: 0,
    acceptedInvocations: 0,
    nextInvocationSequence: 1,
    nextPrewarmConnectionOrdinal: 1,
    callTotalsLowerBound: false,
    outcomeTotalsLowerBound: false,
    aggregateLowerBounds: {
      attempts: false,
      invocations: false,
      connections: false,
      fallbacks: false,
      providerFallbacks: false,
      zeroSubmissions: false,
      events: false,
    },
    callDetailsTruncated: false,
    eventDetailsTruncated: false,
    attemptDetailsTruncated: false,
    invocationDetailsTruncated: false,
    sealed: false,
    issues: new Set(),
  };
}

function markCallTotalsLowerBound(state: MutableProviderTransportAccounting): void {
  state.callTotalsLowerBound = true;
  state.issues.add("transport_totals_lower_bound");
}

function markOutcomeTotalsLowerBound(state: MutableProviderTransportAccounting): void {
  state.outcomeTotalsLowerBound = true;
  state.issues.add("transport_outcomes_lower_bound");
}

export function markProviderTransportObservationFailure(
  state: MutableProviderTransportAccounting,
): void {
  markCallTotalsLowerBound(state);
  markOutcomeTotalsLowerBound(state);
  state.aggregateLowerBounds.attempts = true;
  state.aggregateLowerBounds.invocations = true;
  state.aggregateLowerBounds.connections = true;
  state.aggregateLowerBounds.fallbacks = true;
  state.aggregateLowerBounds.providerFallbacks = true;
  state.aggregateLowerBounds.zeroSubmissions = true;
  state.aggregateLowerBounds.events = true;
  state.issues.add("transport_observer_failed");
}

function markEventTotalsLowerBound(state: MutableProviderTransportAccounting): void {
  state.aggregateLowerBounds.events = true;
  for (const aggregateKey of state.activeAggregateKeys ?? []) {
    state.aggregateLowerBounds[aggregateKey] = true;
  }
  state.issues.add("transport_totals_lower_bound");
}

function markLowerBounds(state: MutableProviderTransportAccounting, scope: LowerBoundScope): void {
  if (scope === "call" || scope === "call_event" || scope === "call_outcome" || scope === "all") {
    markCallTotalsLowerBound(state);
  }
  if (
    scope === "outcome" ||
    scope === "call_outcome" ||
    scope === "outcome_event" ||
    scope === "all"
  ) {
    markOutcomeTotalsLowerBound(state);
  }
  if (scope === "event" || scope === "call_event" || scope === "outcome_event" || scope === "all") {
    markEventTotalsLowerBound(state);
  }
}

export function rejectProviderTransportFact(
  state: MutableProviderTransportAccounting,
  reason: ProviderTransportAccountingCoverageReason,
  scope: LowerBoundScope = "event",
): false {
  state.issues.add(reason);
  markLowerBounds(state, scope);
  return false;
}

export function rejectProviderTransportValue(
  state: MutableProviderTransportAccounting,
  reason: ProviderTransportAccountingCoverageReason,
  scope: LowerBoundScope = "event",
): undefined {
  rejectProviderTransportFact(state, reason, scope);
  return undefined;
}

export function requireProviderTransportIdentity(
  value: unknown,
  state: MutableProviderTransportAccounting,
  scope: LowerBoundScope,
): string | undefined {
  const normalized = normalizeIdentity(value);
  if (normalized.value) {
    return normalized.value;
  }
  return rejectProviderTransportValue(
    state,
    normalized.overflow ? "transport_identity_overflow" : "transport_invalid_fact",
    scope,
  );
}

export function prepareProviderTransportEventIdentity(
  event: AiModelTransportEvent,
  identityScope: string,
  state: MutableProviderTransportAccounting,
): PreparedProviderTransportEventIdentity {
  let fingerprint: string;
  try {
    fingerprint = JSON.stringify(event);
  } catch {
    rejectProviderTransportFact(state, "transport_invalid_fact", "event");
    return { decision: "rejected" };
  }
  const identityKey = `${identityScope.length}:${identityScope}:${event.eventId}`;
  const aggregateKeys = providerTransportAggregateKeysForEvent(event);
  const existing = state.eventFingerprints.get(identityKey);
  if (existing?.fingerprint === fingerprint) {
    return { decision: "exact_duplicate" };
  }
  if (existing !== undefined) {
    rejectProviderTransportFact(state, "transport_event_conflict", "event");
    for (const aggregateKey of existing.aggregateKeys) {
      state.aggregateLowerBounds[aggregateKey] = true;
    }
    return { decision: "rejected" };
  }
  if (state.eventFingerprints.size >= MAX_MODEL_TRANSPORT_EVENT_IDENTITIES) {
    rejectProviderTransportFact(state, "transport_details_truncated", "event");
    return { decision: "rejected" };
  }
  return {
    decision: "accepted",
    identityKey,
    record: {
      aggregateKeys,
      fingerprint,
    },
  };
}

export function commitProviderTransportEventIdentity(
  prepared: PreparedProviderTransportEventIdentity,
  state: MutableProviderTransportAccounting,
): void {
  if (prepared.identityKey && prepared.record) {
    state.eventFingerprints.set(prepared.identityKey, prepared.record);
  }
}

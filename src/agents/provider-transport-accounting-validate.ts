import type { AiModelTransportEvent } from "@openclaw/ai";
import type { ProviderTransportProjectionCall } from "./provider-transport-accounting-project.js";
import {
  rejectProviderTransportFact,
  type MutableProviderTransportAccounting,
} from "./provider-transport-accounting-state.js";
import type { ProviderTransportAccountingCoverageReason } from "./provider-transport-accounting.types.js";

type ExpectedAttemptReason = NonNullable<
  ProviderTransportProjectionCall["phase"]
>["expectedAttemptReason"];

export function validateRequestedTransportIdentity(
  event: AiModelTransportEvent,
  call: ProviderTransportProjectionCall,
  state: MutableProviderTransportAccounting,
): boolean {
  return event.provider === call.provider && event.model === call.model && event.api === call.api
    ? true
    : rejectProviderTransportFact(state, "transport_unknown_route", "event");
}

export function validateTransportEventRoute(
  event: AiModelTransportEvent,
  expectedTransport: string,
  state: MutableProviderTransportAccounting,
): boolean {
  const transport = event.type === "fallback" ? event.fromTransport : event.transport;
  return transport === expectedTransport
    ? true
    : rejectProviderTransportFact(state, "transport_unknown_route", "event");
}

export function validateTransportOrdinal(
  actual: number,
  expected: number,
  state: MutableProviderTransportAccounting,
): boolean {
  return actual === expected
    ? true
    : rejectProviderTransportFact(state, "transport_invalid_ordinal", "event");
}

export function expectedTransportAttemptReason(
  call: ProviderTransportProjectionCall,
): ExpectedAttemptReason {
  return (
    call.phase?.expectedAttemptReason ??
    (call.pendingTransportTarget
      ? "transport_fallback"
      : call.lastAttempt || call.latestZeroSubmissionOutcome
        ? "same_route"
        : "initial")
  );
}

export function transportAttemptReasonMatches(
  actual: Extract<AiModelTransportEvent, { type: "attempt" | "invocation" }>["reason"],
  expected: ExpectedAttemptReason,
): boolean {
  return expected === "same_route"
    ? actual !== "initial" && actual !== "transport_fallback"
    : actual === expected;
}

export function rejectTransportInvocationRelation(
  state: MutableProviderTransportAccounting,
  reason: Extract<
    ProviderTransportAccountingCoverageReason,
    "transport_invocation_relation_incomplete" | "transport_invocation_relation_invalid"
  > = "transport_invocation_relation_invalid",
): false {
  state.aggregateLowerBounds.invocations = true;
  return rejectProviderTransportFact(state, reason, "event");
}

export function canContinueTransportAttempt(
  call: ProviderTransportProjectionCall,
  state: MutableProviderTransportAccounting,
): boolean {
  return !call.lastAttempt || call.lastAttempt.outcome === "failed"
    ? true
    : rejectProviderTransportFact(state, "transport_event_conflict", "event");
}

export function bindOrValidateTransport(
  call: ProviderTransportProjectionCall,
  transport: string,
  state: MutableProviderTransportAccounting,
): boolean {
  if (!call.currentTransport) {
    call.currentTransport = transport;
    return true;
  }
  return call.currentTransport === transport
    ? true
    : rejectProviderTransportFact(state, "transport_unknown_route", "event");
}

export function pendingOrCurrentTransport(
  call: ProviderTransportProjectionCall,
): string | undefined {
  return call.pendingTransportTarget ?? call.currentTransport;
}

export function rejectAfterAbortedZeroSubmission(
  call: ProviderTransportProjectionCall,
  state: MutableProviderTransportAccounting,
): boolean {
  if (call.latestZeroSubmissionOutcome !== "aborted") {
    return false;
  }
  rejectProviderTransportFact(state, "transport_event_conflict", "event");
  return true;
}

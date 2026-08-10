import {
  AI_MODEL_TRANSPORT_ATTEMPT_REASONS,
  AI_MODEL_TRANSPORT_CONNECTION_REASONS,
  AI_MODEL_TRANSPORT_FALLBACK_REASONS,
  AI_MODEL_TRANSPORT_OUTCOMES,
  AI_MODEL_ZERO_SUBMISSION_OUTCOMES,
  type AiModelTransportEvent,
} from "@openclaw/ai";
import type { ProviderTransportProjectionCall } from "./provider-transport-accounting-project.js";
import type { ProviderTransportAccountingCoverageReason } from "./provider-transport-accounting.types.js";

const MAX_MODEL_TRANSPORT_IDENTITY_LENGTH = 256;

export type LowerBoundScope =
  | "none"
  | "call"
  | "outcome"
  | "event"
  | "call_event"
  | "call_outcome"
  | "outcome_event"
  | "all";
type RejectTransportFact = (
  reason: ProviderTransportAccountingCoverageReason,
  scope: LowerBoundScope,
) => false;

export function isKnownValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function hasTransportFallbackCause(
  event: Extract<AiModelTransportEvent, { type: "fallback" }>,
  call: ProviderTransportProjectionCall,
): boolean {
  switch (event.reason) {
    case "connection_failure":
      return (
        call.fallbackCause?.transport === event.fromTransport &&
        call.fallbackCause.reason === "connection_failure"
      );
    case "submission_failure":
      return (
        call.fallbackCause === undefined &&
        call.latestZeroSubmissionOutcome === "failed" &&
        call.currentTransport === event.fromTransport
      );
    case "stream_failure":
      return (
        call.fallbackCause?.transport === event.fromTransport &&
        call.fallbackCause.reason === "stream_failure"
      );
    case "policy":
    case "unsupported":
      return true;
  }
  return false;
}

export function normalizeIdentity(value: unknown): { value?: string; overflow: boolean } {
  if (typeof value !== "string") {
    return { overflow: false };
  }
  const normalized = value.trim();
  if (!normalized) {
    return { overflow: false };
  }
  return Array.from(normalized).length <= MAX_MODEL_TRANSPORT_IDENTITY_LENGTH
    ? { value: normalized, overflow: false }
    : { overflow: true };
}

function rejectValue(
  reject: RejectTransportFact,
  reason: ProviderTransportAccountingCoverageReason,
  scope: LowerBoundScope,
): undefined {
  reject(reason, scope);
  return undefined;
}

function requireIdentity(
  value: unknown,
  reject: RejectTransportFact,
  scope: LowerBoundScope,
): string | undefined {
  const normalized = normalizeIdentity(value);
  if (normalized.value) {
    return normalized.value;
  }
  return rejectValue(
    reject,
    normalized.overflow ? "transport_identity_overflow" : "transport_invalid_fact",
    scope,
  );
}

function normalizeStatusCode(value: number | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function normalizeDurationMs(value: number | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeOrdinal(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function normalizeTransportEvent(
  event: AiModelTransportEvent,
  callId: string | undefined,
  reject: RejectTransportFact,
): AiModelTransportEvent | undefined {
  const rawEventId = normalizeIdentity(event.eventId);
  if (!rawEventId.value) {
    return rejectValue(
      reject,
      rawEventId.overflow ? "transport_identity_overflow" : "transport_event_id_missing",
      "event",
    );
  }
  const provider = requireIdentity(event.provider, reject, "event");
  const model = requireIdentity(event.model, reject, "event");
  const api = requireIdentity(event.api, reject, "event");
  if (!provider || !model || !api) {
    return undefined;
  }
  const eventBase = {
    eventId: rawEventId.value,
    provider,
    model,
    api,
  };
  if (event.type === "connection" && event.reason === "prewarm") {
    if ("callId" in event || callId) {
      return rejectValue(reject, "transport_invalid_fact", "event");
    }
    const transport = requireIdentity(event.transport, reject, "event");
    const ordinal = normalizeOrdinal(event.ordinal);
    const statusCode = normalizeStatusCode(event.statusCode);
    const durationMs = normalizeDurationMs(event.durationMs);
    if (!ordinal) {
      return rejectValue(reject, "transport_invalid_ordinal", "event");
    }
    if (
      !transport ||
      !isKnownValue(event.outcome, AI_MODEL_TRANSPORT_OUTCOMES) ||
      statusCode === null ||
      durationMs === null
    ) {
      return rejectValue(reject, "transport_invalid_fact", "event");
    }
    return {
      ...eventBase,
      type: "connection",
      transport,
      ordinal,
      reason: "prewarm",
      outcome: event.outcome,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  if (!callId) {
    return rejectValue(reject, "transport_uncorrelated_event", "call_event");
  }
  const callBase = { ...eventBase, callId };
  switch (event.type) {
    case "attempt": {
      const transport = requireIdentity(event.transport, reject, "event");
      const ordinal = normalizeOrdinal(event.ordinal);
      const statusCode = normalizeStatusCode(event.statusCode);
      const durationMs = normalizeDurationMs(event.durationMs);
      if (!ordinal) {
        return rejectValue(reject, "transport_invalid_ordinal", "event");
      }
      if (
        !transport ||
        !isKnownValue(event.reason, AI_MODEL_TRANSPORT_ATTEMPT_REASONS) ||
        !isKnownValue(event.outcome, AI_MODEL_TRANSPORT_OUTCOMES) ||
        statusCode === null ||
        durationMs === null
      ) {
        return rejectValue(reject, "transport_invalid_fact", "event");
      }
      return {
        ...callBase,
        type: "attempt",
        transport,
        ordinal,
        reason: event.reason,
        outcome: event.outcome,
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    }
    case "connection": {
      const transport = requireIdentity(event.transport, reject, "event");
      const ordinal = normalizeOrdinal(event.ordinal);
      const statusCode = normalizeStatusCode(event.statusCode);
      const durationMs = normalizeDurationMs(event.durationMs);
      if (!ordinal) {
        return rejectValue(reject, "transport_invalid_ordinal", "event");
      }
      if (
        !transport ||
        !isKnownValue(event.reason, AI_MODEL_TRANSPORT_CONNECTION_REASONS) ||
        !isKnownValue(event.outcome, AI_MODEL_TRANSPORT_OUTCOMES) ||
        statusCode === null ||
        durationMs === null
      ) {
        return rejectValue(reject, "transport_invalid_fact", "event");
      }
      return {
        ...callBase,
        type: "connection",
        transport,
        ordinal,
        reason: event.reason,
        outcome: event.outcome,
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    }
    case "fallback": {
      const fromTransport = requireIdentity(event.fromTransport, reject, "event");
      const toTransport = requireIdentity(event.toTransport, reject, "event");
      if (
        !fromTransport ||
        !toTransport ||
        fromTransport === toTransport ||
        !isKnownValue(event.reason, AI_MODEL_TRANSPORT_FALLBACK_REASONS)
      ) {
        return rejectValue(reject, "transport_invalid_fact", "event");
      }
      return {
        ...callBase,
        type: event.type,
        fromTransport,
        toTransport,
        reason: event.reason,
      };
    }
    case "provider_fallback": {
      const transport = requireIdentity(event.transport, reject, "event");
      const fromModel = requireIdentity(event.fromModel, reject, "event");
      const toModel = requireIdentity(event.toModel, reject, "event");
      if (!transport || !fromModel || !toModel || fromModel === toModel) {
        return rejectValue(reject, "transport_invalid_fact", "event");
      }
      return {
        ...callBase,
        type: event.type,
        transport,
        fromModel,
        toModel,
      };
    }
    case "coverage": {
      const transport = requireIdentity(event.transport, reject, "event");
      if (!transport) {
        return rejectValue(reject, "transport_invalid_fact", "event");
      }
      if (event.scope === "provider_fallbacks") {
        if (event.state !== "lower_bound" || event.reason !== "terminal_metadata_unavailable") {
          return rejectValue(reject, "transport_invalid_fact", "event");
        }
        return {
          ...callBase,
          type: event.type,
          transport,
          scope: "provider_fallbacks",
          state: "lower_bound",
          reason: "terminal_metadata_unavailable",
        };
      }
      if (
        event.scope !== "transport_semantics" ||
        event.state !== "unverified" ||
        (event.reason !== "transport_terminal_unverified" &&
          event.reason !== "transport_endpoint_authority_partial" &&
          event.reason !== "transport_submission_authority_partial")
      ) {
        return rejectValue(reject, "transport_invalid_fact", "event");
      }
      return {
        ...callBase,
        type: event.type,
        transport,
        scope: "transport_semantics",
        state: "unverified",
        reason: event.reason,
      };
    }
    case "submission": {
      const transport = requireIdentity(event.transport, reject, "event");
      if (
        !transport ||
        event.total !== 0 ||
        !isKnownValue(event.outcome, AI_MODEL_ZERO_SUBMISSION_OUTCOMES) ||
        (event.outcome === "failed" && event.reason !== "failed_before_submission") ||
        (event.outcome === "aborted" && event.reason !== "aborted_before_submission")
      ) {
        return rejectValue(reject, "transport_invalid_fact", "event");
      }
      return {
        ...callBase,
        type: event.type,
        transport,
        total: 0,
        outcome: event.outcome,
        reason: event.reason,
      };
    }
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return rejectValue(reject, "transport_invalid_fact", "event");
    }
  }
}

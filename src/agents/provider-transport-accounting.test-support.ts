import type {
  AiModelTransportAttemptReason,
  AiModelTransportEvent,
  AiModelTransportOutcome,
} from "@openclaw/ai";
import {
  observeProviderTransportEvent,
  observeProviderTransportLogicalCallStarted,
} from "./provider-transport-accounting.js";

type TestRoute = {
  provider: string;
  model: string;
  api: string;
  transport: string;
};
type TestCallRoute = Pick<TestRoute, "provider" | "model" | "api">;

export const ROUTE = {
  provider: "openai",
  model: "gpt-test",
  api: "openai-responses",
  transport: "http",
} as const satisfies TestRoute;

export const ANTHROPIC_ROUTE = {
  provider: "anthropic",
  model: "claude-fable-5",
  api: "anthropic-messages",
  transport: "sse",
} as const satisfies TestRoute;

export function startCall(callId: string, route: TestCallRoute = ROUTE): void {
  observeProviderTransportLogicalCallStarted({
    callId,
    provider: route.provider,
    model: route.model,
    api: route.api,
  });
}

export function observeMalformedTransportEvent(event: unknown): void {
  observeProviderTransportEvent(event as AiModelTransportEvent);
}

export function emitAttempt(params: {
  callId: string;
  ordinal: number;
  outcome: AiModelTransportOutcome;
  reason?: AiModelTransportAttemptReason;
  transport?: string;
  route?: TestRoute;
  eventId?: string;
}): void {
  const route = params.route ?? ROUTE;
  const transport = params.transport ?? route.transport;
  observeProviderTransportEvent({
    type: "attempt",
    eventId:
      params.eventId ??
      `attempt-${params.callId}-${String(params.ordinal)}-${params.outcome}-${transport}`,
    callId: params.callId,
    provider: route.provider,
    model: route.model,
    api: route.api,
    transport,
    ordinal: params.ordinal,
    reason: params.reason ?? (params.ordinal === 1 ? "initial" : "retry"),
    outcome: params.outcome,
  });
}

export function emitConnection(params: {
  callId: string;
  ordinal: number;
  outcome: AiModelTransportOutcome;
  reason?: "initial" | "reconnect";
  transport?: string;
  route?: TestRoute;
  eventId?: string;
}): void {
  const route = params.route ?? ROUTE;
  const transport = params.transport ?? route.transport;
  observeProviderTransportEvent({
    type: "connection",
    eventId:
      params.eventId ??
      `connection-${params.callId}-${String(params.ordinal)}-${params.outcome}-${transport}`,
    callId: params.callId,
    provider: route.provider,
    model: route.model,
    api: route.api,
    transport,
    ordinal: params.ordinal,
    reason: params.reason ?? (params.ordinal === 1 ? "initial" : "reconnect"),
    outcome: params.outcome,
  });
}

export function emitTransportFallback(params: {
  callId: string;
  fromTransport: string;
  toTransport: string;
  reason?:
    | "unsupported"
    | "connection_failure"
    | "submission_failure"
    | "stream_failure"
    | "policy";
  eventId?: string;
}): void {
  observeProviderTransportEvent({
    type: "fallback",
    eventId: params.eventId ?? `fallback-${params.callId}-${params.toTransport}`,
    callId: params.callId,
    provider: ROUTE.provider,
    model: ROUTE.model,
    api: ROUTE.api,
    fromTransport: params.fromTransport,
    toTransport: params.toTransport,
    reason: params.reason ?? "policy",
  });
}

export function emitServerFallback(params: {
  callId: string;
  fromModel: string;
  toModel: string;
  transport?: string;
  eventId?: string;
}): void {
  observeProviderTransportEvent({
    type: "provider_fallback",
    eventId: params.eventId ?? `server-fallback-${params.callId}-${params.toModel}`,
    callId: params.callId,
    provider: ANTHROPIC_ROUTE.provider,
    model: ANTHROPIC_ROUTE.model,
    api: ANTHROPIC_ROUTE.api,
    transport: params.transport ?? ANTHROPIC_ROUTE.transport,
    fromModel: params.fromModel,
    toModel: params.toModel,
  });
}

export function emitProviderFallbackCoverage(params: {
  callId: string;
  transport?: string;
  eventId?: string;
}): void {
  observeProviderTransportEvent({
    type: "coverage",
    eventId: params.eventId ?? `coverage-${params.callId}`,
    callId: params.callId,
    provider: ANTHROPIC_ROUTE.provider,
    model: ANTHROPIC_ROUTE.model,
    api: ANTHROPIC_ROUTE.api,
    transport: params.transport ?? ANTHROPIC_ROUTE.transport,
    scope: "provider_fallbacks",
    state: "lower_bound",
    reason: "terminal_metadata_unavailable",
  });
}

export function emitZeroSubmission(params: {
  callId: string;
  eventId?: string;
  outcome: "failed" | "aborted";
  transport?: string;
}): void {
  observeProviderTransportEvent({
    type: "submission",
    eventId:
      params.eventId ??
      `zero-${params.callId}-${params.outcome}-${params.transport ?? ROUTE.transport}`,
    callId: params.callId,
    provider: ROUTE.provider,
    model: ROUTE.model,
    api: ROUTE.api,
    transport: params.transport ?? ROUTE.transport,
    total: 0,
    outcome: params.outcome,
    reason: params.outcome === "failed" ? "failed_before_submission" : "aborted_before_submission",
  });
}

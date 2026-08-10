import type { Model } from "@openclaw/llm-core";
import {
  getAiTransportHost,
  type AiModelFetchOptions,
  type AiModelTransportEvent,
  type AiModelTransportAttemptReason,
  type AiModelTransportConnectionReason,
  type AiModelTransportFallbackReason,
  type AiModelTransportOutcome,
  type AiModelZeroSubmissionOutcome,
} from "../host.js";
import { shortHash } from "../utils/hash.js";

type ModelTransportAttemptReason = AiModelTransportAttemptReason;
export type ModelTransportConnectionReason = Exclude<AiModelTransportConnectionReason, "prewarm">;
type ModelTransportFallbackReason = AiModelTransportFallbackReason;
export type ModelTransportOutcome = AiModelTransportOutcome;
type ModelTransportCoverage =
  | {
      reason: "terminal_metadata_unavailable";
      scope: "provider_fallbacks";
      state: "lower_bound";
      transport: string;
    }
  | {
      reason:
        | "transport_terminal_unverified"
        | "transport_endpoint_authority_partial"
        | "transport_submission_authority_partial";
      scope: "transport_semantics";
      state: "unverified";
      transport: string;
    };

export type PendingTransportEvent = {
  finish(outcome: ModelTransportOutcome, statusCode?: number): void;
};

export function createFetchInvocationCompatibilityObservers(
  onInvocation: () => void,
): Pick<AiModelFetchOptions, "onFetchDispatch" | "onFetchInvocation"> {
  let invocationObserved = false;
  return {
    onFetchInvocation() {
      invocationObserved = true;
      onInvocation();
    },
    onFetchDispatch() {
      if (!invocationObserved) {
        onInvocation();
      }
      invocationObserved = false;
    },
  };
}

export type ModelTransportAttemptAuthority = {
  observeServingModel(model: unknown): void;
  readServingModel(): string | undefined;
  finish(outcome: ModelTransportOutcome, statusCode?: number): void;
};

export type ModelTransportEventScope = {
  observeInvocation(params: {
    attemptKey: object;
    transport: string;
    reason: ModelTransportAttemptReason;
  }): number;
  startAttempt(params: {
    transport: string;
    reason: ModelTransportAttemptReason;
  }): PendingTransportEvent;
  startConnection(params: {
    transport: string;
    reason: ModelTransportConnectionReason;
  }): PendingTransportEvent;
  observeFallback(params: {
    fromTransport: string;
    toTransport: string;
    reason: ModelTransportFallbackReason;
  }): void;
  observeCoverage(params: ModelTransportCoverage): void;
  observeProviderFallback(params: { transport: string; fromModel: string; toModel: string }): void;
  observeZeroSubmission(params: { transport: string; outcome: AiModelZeroSubmissionOutcome }): void;
};

export function createModelTransportAttemptAuthority(params: {
  events: ModelTransportEventScope;
  pendingAttempt: PendingTransportEvent;
  requestedModel: string;
  transport: string;
}): ModelTransportAttemptAuthority {
  let currentModel = params.requestedModel;
  let authorityObserved = false;
  let finished = false;

  return {
    observeServingModel(rawModel) {
      const model = typeof rawModel === "string" ? rawModel.trim() : "";
      if (!model) {
        return;
      }
      authorityObserved = true;
      if (model.toLowerCase() === currentModel.toLowerCase()) {
        return;
      }
      params.events.observeProviderFallback({
        transport: params.transport,
        fromModel: currentModel,
        toModel: model,
      });
      currentModel = model;
    },
    readServingModel() {
      return authorityObserved ? currentModel : undefined;
    },
    finish(outcome, statusCode) {
      if (finished) {
        return;
      }
      finished = true;
      // Coverage is valid only after the provider-request attempt closes its route phase.
      params.pendingAttempt.finish(outcome, statusCode);
      if (!authorityObserved) {
        params.events.observeCoverage({
          transport: params.transport,
          scope: "provider_fallbacks",
          state: "lower_bound",
          reason: "terminal_metadata_unavailable",
        });
      }
    },
  };
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function durationSince(startedAt: number): number {
  const duration = nowMs() - startedAt;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function observeModelTransportEventSafely(event: AiModelTransportEvent): void {
  try {
    getAiTransportHost().observeModelTransportEvent(event);
  } catch {
    // Accounting is observational and must never alter provider behavior.
  }
}

function createPendingEvent(
  finish: (outcome: ModelTransportOutcome, statusCode?: number) => void,
): PendingTransportEvent {
  let finished = false;
  return {
    finish(outcome, statusCode) {
      if (finished) {
        return;
      }
      finished = true;
      finish(outcome, statusCode);
    },
  };
}

export function createModelTransportEventScope(params: {
  model: Model;
  callId?: string;
  scopeId: string;
  eventIdPrefix?: string;
  observeEvent?: (event: AiModelTransportEvent) => void;
}): ModelTransportEventScope {
  const callId = params.callId?.trim();
  const routeHash = shortHash(
    `${params.model.provider}\0${params.model.api}\0${params.model.id}\0${params.scopeId}`,
  );
  let attemptOrdinal = 0;
  let invocationOrdinal = 0;
  let invocationAttemptKey: object | undefined;
  let invocationAttemptOrdinal = 0;
  let invocationHopOrdinal = 0;
  let connectionOrdinal = 0;
  let fallbackOrdinal = 0;
  let coverageOrdinal = 0;
  let providerFallbackOrdinal = 0;
  let submissionOrdinal = 0;
  const eventIdPrefix = params.eventIdPrefix ?? "openai";
  const observeEvent = params.observeEvent ?? observeModelTransportEventSafely;

  return {
    observeInvocation({ attemptKey, transport, reason }) {
      if (invocationAttemptKey !== attemptKey) {
        invocationAttemptKey = attemptKey;
        invocationAttemptOrdinal += 1;
        invocationHopOrdinal = 0;
      }
      const ordinal = ++invocationOrdinal;
      invocationHopOrdinal += 1;
      if (callId) {
        observeEvent({
          type: "invocation",
          eventId: `${eventIdPrefix}:${routeHash}:invocation:${ordinal}`,
          callId,
          provider: params.model.provider,
          model: params.model.id,
          api: params.model.api,
          transport,
          ordinal,
          attemptOrdinal: invocationAttemptOrdinal,
          hopOrdinal: invocationHopOrdinal,
          reason,
        });
      }
      return ordinal;
    },
    startAttempt({ transport, reason }) {
      const ordinal = ++attemptOrdinal;
      const startedAt = nowMs();
      return createPendingEvent((outcome, statusCode) => {
        if (!callId) {
          return;
        }
        observeEvent({
          type: "attempt",
          eventId: `${eventIdPrefix}:${routeHash}:attempt:${ordinal}`,
          callId,
          provider: params.model.provider,
          model: params.model.id,
          api: params.model.api,
          transport,
          ordinal,
          reason,
          outcome,
          ...(statusCode === undefined ? {} : { statusCode }),
          durationMs: durationSince(startedAt),
        });
      });
    },
    startConnection({ transport, reason }) {
      const ordinal = ++connectionOrdinal;
      const startedAt = nowMs();
      return createPendingEvent((outcome, statusCode) => {
        if (!callId) {
          return;
        }
        observeEvent({
          type: "connection",
          eventId: `${eventIdPrefix}:${routeHash}:connection:${ordinal}`,
          callId,
          provider: params.model.provider,
          model: params.model.id,
          api: params.model.api,
          transport,
          ordinal,
          reason,
          outcome,
          ...(statusCode === undefined ? {} : { statusCode }),
          durationMs: durationSince(startedAt),
        });
      });
    },
    observeFallback({ fromTransport, toTransport, reason }) {
      if (!callId) {
        return;
      }
      fallbackOrdinal += 1;
      observeEvent({
        type: "fallback",
        eventId: `${eventIdPrefix}:${routeHash}:fallback:${fallbackOrdinal}`,
        callId,
        provider: params.model.provider,
        model: params.model.id,
        api: params.model.api,
        fromTransport,
        toTransport,
        reason,
      });
    },
    observeCoverage(coverage) {
      if (!callId) {
        return;
      }
      coverageOrdinal += 1;
      observeEvent({
        type: "coverage",
        eventId: `${eventIdPrefix}:${routeHash}:coverage:${coverageOrdinal}`,
        callId,
        provider: params.model.provider,
        model: params.model.id,
        api: params.model.api,
        ...coverage,
      });
    },
    observeProviderFallback({ transport, fromModel, toModel }) {
      if (!callId) {
        return;
      }
      providerFallbackOrdinal += 1;
      observeEvent({
        type: "provider_fallback",
        eventId: `${eventIdPrefix}:${routeHash}:provider-fallback:${providerFallbackOrdinal}`,
        callId,
        provider: params.model.provider,
        model: params.model.id,
        api: params.model.api,
        transport,
        fromModel,
        toModel,
      });
    },
    observeZeroSubmission({ transport, outcome }) {
      if (!callId) {
        return;
      }
      submissionOrdinal += 1;
      observeEvent({
        type: "submission",
        eventId: `${eventIdPrefix}:${routeHash}:submission:${submissionOrdinal}`,
        callId,
        provider: params.model.provider,
        model: params.model.id,
        api: params.model.api,
        transport,
        total: 0,
        outcome,
        reason: outcome === "aborted" ? "aborted_before_submission" : "failed_before_submission",
      });
    },
  };
}

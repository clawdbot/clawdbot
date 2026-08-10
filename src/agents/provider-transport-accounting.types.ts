import type { AiModelTransportEvent, AiModelTransportOutcome } from "@openclaw/ai";
import type { CachedInputObservation } from "@openclaw/ai/internal/shared";

export type ProviderTransportAccountingTotalKind = "exact" | "lower_bound";

export type ProviderTransportAccountingCoverageReason =
  | "not_observed"
  | "not_instrumented"
  | "transport_details_truncated"
  | "transport_totals_lower_bound"
  | "transport_outcomes_lower_bound"
  | "transport_identity_overflow"
  | "transport_unknown_route"
  | "transport_uncorrelated_event"
  | "transport_event_id_missing"
  | "transport_event_conflict"
  | "transport_invalid_fact"
  | "transport_invalid_ordinal"
  | "transport_observer_failed"
  | "transport_logical_call_incomplete"
  | "transport_terminal_unverified"
  | "transport_endpoint_authority_partial"
  | "transport_submission_authority_partial";

export type ProviderTransportAccountingCoverage =
  | { state: "complete" }
  | {
      state: "partial" | "unavailable";
      reasons: ProviderTransportAccountingCoverageReason[];
    };

export type ProviderTransportLogicalCall = {
  callId: string;
  provider: string;
  model: string;
  api: string;
  transport?: string;
  servingModel?: string;
  outcome?: AiModelTransportOutcome;
  cachedInput: CachedInputObservation;
};

type ProviderTransportTotals = {
  total: number;
  totalKind: ProviderTransportAccountingTotalKind;
};

export type ProviderTransportAccountingSnapshot = {
  logicalCalls: ProviderTransportTotals & {
    outcomeKind: ProviderTransportAccountingTotalKind;
    completed: number;
    failed: number;
    aborted: number;
    entries: ProviderTransportLogicalCall[];
    entriesTruncated: boolean;
  };
  attempts: ProviderTransportTotals & {
    initial: number;
    retries: number;
    authRecoveries: number;
    payloadRecoveries: number;
    transportFallbacks: number;
  };
  connections: ProviderTransportTotals & {
    initial: number;
    prewarms: number;
    reconnects: number;
  };
  fallbacks: ProviderTransportTotals & {
    unsupported: number;
    connectionFailures: number;
    submissionFailures: number;
    streamFailures: number;
    policy: number;
  };
  providerFallbacks: ProviderTransportTotals & {
    server: number;
  };
  zeroSubmissions: ProviderTransportTotals & {
    failed: number;
    aborted: number;
  };
  events: ProviderTransportTotals & {
    entries: AiModelTransportEvent[];
    entriesTruncated: boolean;
  };
};

export type ProviderTransportLogicalCallStarted = Pick<
  ProviderTransportLogicalCall,
  "callId" | "provider" | "model" | "api"
>;

export type ProviderTransportAccountingObservationKind =
  | "logical_call_started"
  | "logical_call_settled"
  | "logical_call_finalized"
  | "transport_event";

export type ProviderTransportAccountingObserver = {
  onObservationFailure(kind: ProviderTransportAccountingObservationKind): void;
  onLogicalCallStarted(call: ProviderTransportLogicalCallStarted): void;
  onLogicalCallSettled(
    callId: string,
    outcome: AiModelTransportOutcome,
    cachedInput?: CachedInputObservation,
  ): void;
  onTransportEvent(event: AiModelTransportEvent): void;
  onLogicalCallFinalized(callId: string): void;
};

export type ProviderTransportAccountingCollector = {
  observer: ProviderTransportAccountingObserver;
  finalize(callId: string): void;
  project(): {
    snapshot?: ProviderTransportAccountingSnapshot;
    coverage: ProviderTransportAccountingCoverage;
  };
};

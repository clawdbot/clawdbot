import type {
  ProviderTransportAccountingCollector,
  ProviderTransportAccountingSnapshot,
} from "../provider-transport-accounting.js";
import type {
  AgentCommandRunAccountingCoverage,
  AgentCommandRunAccountingCoverageReason,
} from "./run-accounting.types.js";

type ProviderTransportProjection = ReturnType<ProviderTransportAccountingCollector["project"]>;

function createExactZeroProviderTransport(): ProviderTransportAccountingSnapshot {
  return {
    logicalCalls: {
      total: 0,
      totalKind: "exact",
      outcomeKind: "exact",
      completed: 0,
      failed: 0,
      aborted: 0,
      entries: [],
      entriesTruncated: false,
    },
    attempts: {
      total: 0,
      totalKind: "exact",
      initial: 0,
      retries: 0,
      authRecoveries: 0,
      payloadRecoveries: 0,
      transportFallbacks: 0,
    },
    connections: {
      total: 0,
      totalKind: "exact",
      initial: 0,
      prewarms: 0,
      reconnects: 0,
    },
    fallbacks: {
      total: 0,
      totalKind: "exact",
      unsupported: 0,
      connectionFailures: 0,
      submissionFailures: 0,
      streamFailures: 0,
      policy: 0,
    },
    providerFallbacks: { total: 0, totalKind: "exact", server: 0 },
    zeroSubmissions: { total: 0, totalKind: "exact", failed: 0, aborted: 0 },
    events: { total: 0, totalKind: "exact", entries: [], entriesTruncated: false },
  };
}

function isUntouchedProjection(projection: ProviderTransportProjection): boolean {
  return (
    projection.snapshot === undefined &&
    projection.coverage.state === "unavailable" &&
    projection.coverage.reasons.length === 1 &&
    projection.coverage.reasons[0] === "not_observed"
  );
}

function isExactPrewarmOnlyProjection(
  projection: ProviderTransportProjection,
  snapshot: ProviderTransportAccountingSnapshot,
): boolean {
  return (
    projection.coverage.state === "complete" &&
    snapshot.logicalCalls.total === 0 &&
    snapshot.logicalCalls.totalKind === "exact" &&
    snapshot.logicalCalls.outcomeKind === "exact" &&
    snapshot.attempts.total === 0 &&
    snapshot.attempts.totalKind === "exact" &&
    snapshot.connections.total === snapshot.connections.prewarms &&
    snapshot.connections.totalKind === "exact" &&
    snapshot.connections.initial === 0 &&
    snapshot.connections.reconnects === 0 &&
    snapshot.fallbacks.total === 0 &&
    snapshot.fallbacks.totalKind === "exact" &&
    snapshot.providerFallbacks.total === 0 &&
    snapshot.providerFallbacks.totalKind === "exact" &&
    snapshot.zeroSubmissions.total === 0 &&
    snapshot.zeroSubmissions.totalKind === "exact" &&
    snapshot.events.total === snapshot.connections.prewarms &&
    snapshot.events.totalKind === "exact"
  );
}

function providerTransportContradictsExactZero(projection: ProviderTransportProjection): boolean {
  return (
    !isUntouchedProjection(projection) &&
    (!projection.snapshot || !isExactPrewarmOnlyProjection(projection, projection.snapshot))
  );
}

function resolveCommandProviderTransport(
  exactZeroModelWork: boolean,
  projection: ProviderTransportProjection,
  coverage: AgentCommandRunAccountingCoverage,
): { snapshot?: ProviderTransportAccountingSnapshot; coverage: AgentCommandRunAccountingCoverage } {
  if (!exactZeroModelWork) {
    return { snapshot: projection.snapshot, coverage };
  }
  if (isUntouchedProjection(projection)) {
    return { snapshot: createExactZeroProviderTransport(), coverage: { state: "complete" } };
  }
  if (!providerTransportContradictsExactZero(projection)) {
    return { snapshot: projection.snapshot, coverage };
  }
  return {
    snapshot: projection.snapshot,
    coverage: {
      state: "partial",
      reasons: [
        ...new Set([
          ...("reasons" in coverage ? coverage.reasons : []),
          "transport_event_conflict" as const,
        ]),
      ],
    },
  };
}

export function reconcileCommandZeroTransport(params: {
  exactZeroBeforeTransport: boolean;
  projection: ProviderTransportProjection;
  providerCoverage: AgentCommandRunAccountingCoverage;
  modelCallsCoverage: AgentCommandRunAccountingCoverage;
  modelCallCoverageReasons: AgentCommandRunAccountingCoverageReason[];
}) {
  const zeroTransportConflict =
    params.exactZeroBeforeTransport && providerTransportContradictsExactZero(params.projection);
  return {
    zeroTransportConflict,
    exactZeroModelWork: params.exactZeroBeforeTransport && !zeroTransportConflict,
    modelCallsCoverage: zeroTransportConflict
      ? {
          state: "partial" as const,
          reasons: [...params.modelCallCoverageReasons, "transport_event_conflict" as const],
        }
      : params.modelCallsCoverage,
    providerTransport: resolveCommandProviderTransport(
      params.exactZeroBeforeTransport,
      params.projection,
      params.providerCoverage,
    ),
  };
}

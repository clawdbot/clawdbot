import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import {
  agentDurationMetric,
  coverageReasons,
  normalizeTraceReasons,
  observedMetric,
  sumExactMetrics,
  unavailableMetric,
  type AgentExecTraceCacheObservation,
  type AgentExecTraceMetric,
} from "./agent-exec-trace-metrics.js";

const AGENT_EXEC_TRACE_SCHEMA_VERSION = 1 as const;

export type AgentExecTrace = {
  schemaVersion: typeof AGENT_EXEC_TRACE_SCHEMA_VERSION;
  source: "agent-command-accounting";
  route?: {
    provider: string;
    model: string;
    api: string;
    runtime: "embedded";
  };
  metrics: {
    effectiveTurns: AgentExecTraceMetric;
    logicalModelCalls: AgentExecTraceMetric;
    providerAttempts: {
      total: AgentExecTraceMetric;
      initial: AgentExecTraceMetric;
      retries: AgentExecTraceMetric;
      authRecoveries: AgentExecTraceMetric;
      payloadRecoveries: AgentExecTraceMetric;
      transportFallbacks: AgentExecTraceMetric;
    };
    modelFacingApiCalls: AgentExecTraceMetric;
    outerToolCalls: AgentExecTraceMetric;
    codeModeBridgeCalls: AgentExecTraceMetric;
    totalToolOperations: AgentExecTraceMetric;
    underlyingTotalCalls: AgentExecTraceMetric;
    tokens: {
      input: AgentExecTraceMetric;
      cachedInput: AgentExecTraceMetric;
      firstLogicalCallCachedInput: AgentExecTraceCacheObservation;
      output: AgentExecTraceMetric;
      reasoning: AgentExecTraceMetric;
      total: AgentExecTraceMetric;
    };
    agentDurationMs: AgentExecTraceMetric;
    commandExecutionDurationMs: AgentExecTraceMetric;
    wallLatencyMs: AgentExecTraceMetric;
  };
  audit:
    | { state: "valid" }
    | {
        state: "inconclusive";
        reasons: string[];
      };
};

type ProviderTransport = NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>;

function metricWithReasons(value: number | undefined, reasons: Iterable<string>) {
  const normalized = normalizeTraceReasons(reasons);
  return observedMetric({
    value,
    coverage:
      normalized.length === 0 ? { state: "complete" } : { state: "partial", reasons: normalized },
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function modelCallReconciliationReasons(
  snapshot: AgentCommandRunAccountingSnapshot,
  transport: ProviderTransport | undefined,
): string[] {
  const reasons = new Set<string>();
  if (!transport) {
    reasons.add("provider_transport_not_observed");
  }
  if (snapshot.coverage.modelCalls.state !== "complete") {
    for (const reason of coverageReasons(snapshot.coverage.modelCalls)) {
      reasons.add(reason);
    }
  }
  const modelCalls = snapshot.modelCalls;
  if (!modelCalls) {
    reasons.add("model_calls_not_observed");
  } else {
    if (modelCalls.total !== modelCalls.completed + modelCalls.failed) {
      reasons.add("model_call_conservation_mismatch");
    }
    if (transport && modelCalls.total !== transport.logicalCalls.total) {
      reasons.add("model_provider_call_count_mismatch");
    }
    if (transport && modelCalls.completed !== transport.logicalCalls.completed) {
      reasons.add("model_provider_completed_count_mismatch");
    }
    if (
      transport &&
      modelCalls.failed !== transport.logicalCalls.failed + transport.logicalCalls.aborted
    ) {
      reasons.add("model_provider_failed_count_mismatch");
    }
  }
  return [...reasons];
}

function providerLedgerAudit(
  snapshot: AgentCommandRunAccountingSnapshot,
  transport: ProviderTransport | undefined,
): { reasons: string[]; attemptsByCall: ReadonlyMap<string, number> } {
  const reasons = new Set<string>();
  const attemptsByCall = new Map<string, number>();
  if (!transport) {
    return { reasons: ["provider_transport_not_observed"], attemptsByCall };
  }
  if (snapshot.coverage.providerTransport.state !== "complete") {
    for (const reason of coverageReasons(snapshot.coverage.providerTransport)) {
      reasons.add(reason);
    }
  }
  if (transport.logicalCalls.totalKind !== "exact") {
    reasons.add("provider_logical_calls_lower_bound");
  }
  if (transport.logicalCalls.outcomeKind !== "exact") {
    reasons.add("provider_logical_outcomes_lower_bound");
  }
  if (transport.logicalCalls.entriesTruncated) {
    reasons.add("provider_logical_calls_truncated");
  }
  if (transport.logicalCalls.entries.length !== transport.logicalCalls.total) {
    reasons.add("provider_logical_call_entries_incomplete");
  }
  if (
    transport.logicalCalls.total !==
    transport.logicalCalls.completed +
      transport.logicalCalls.failed +
      transport.logicalCalls.aborted
  ) {
    reasons.add("logical_outcome_conservation_mismatch");
  }
  const callIds = new Set<string>();
  const outcomes = { completed: 0, failed: 0, aborted: 0 };
  for (const call of transport.logicalCalls.entries) {
    if (!call.callId || callIds.has(call.callId)) {
      reasons.add("provider_logical_call_identity_invalid");
    }
    callIds.add(call.callId);
    if (!call.outcome) {
      reasons.add("provider_logical_call_terminal_unverified");
    } else {
      outcomes[call.outcome] += 1;
    }
  }
  if (
    outcomes.completed !== transport.logicalCalls.completed ||
    outcomes.failed !== transport.logicalCalls.failed ||
    outcomes.aborted !== transport.logicalCalls.aborted
  ) {
    reasons.add("logical_outcome_entry_mismatch");
  }

  for (const [name, aggregate] of Object.entries({
    attempts: transport.attempts,
    invocations: transport.invocations,
    connections: transport.connections,
    fallbacks: transport.fallbacks,
    provider_fallbacks: transport.providerFallbacks,
    zero_submissions: transport.zeroSubmissions,
    events: transport.events,
  })) {
    if (!aggregate || aggregate.totalKind !== "exact") {
      reasons.add(`provider_${name}_lower_bound`);
    }
  }
  if (!transport.invocations) {
    reasons.add("provider_invocations_unavailable");
  } else {
    if (transport.invocations.entriesTruncated) {
      reasons.add("provider_invocations_truncated");
    }
    if (transport.invocations.entries.length !== transport.invocations.total) {
      reasons.add("provider_invocation_entries_incomplete");
    }
  }
  if (transport.events.entriesTruncated) {
    reasons.add("provider_events_truncated");
  }
  if (transport.events.entries.length !== transport.events.total) {
    reasons.add("provider_event_entries_incomplete");
  }
  if (
    transport.attempts.total !==
    sum([
      transport.attempts.initial,
      transport.attempts.retries,
      transport.attempts.authRecoveries,
      transport.attempts.payloadRecoveries,
      transport.attempts.transportFallbacks,
    ])
  ) {
    reasons.add("provider_attempt_conservation_mismatch");
  }
  if (
    transport.connections.total !==
      sum([
        transport.connections.initial,
        transport.connections.prewarms,
        transport.connections.reconnects,
      ]) ||
    transport.fallbacks.total !==
      sum([
        transport.fallbacks.unsupported,
        transport.fallbacks.connectionFailures,
        transport.fallbacks.submissionFailures,
        transport.fallbacks.streamFailures,
        transport.fallbacks.policy,
      ]) ||
    transport.providerFallbacks.total !== transport.providerFallbacks.server ||
    transport.zeroSubmissions.total !==
      transport.zeroSubmissions.failed + transport.zeroSubmissions.aborted
  ) {
    reasons.add("provider_aggregate_conservation_mismatch");
  }

  // Complete collector coverage already proves event normalization, correlation,
  // ordinals, and sub-bucket derivation. Recheck only exported conservation here.
  let coverageEvents = 0;
  for (const event of transport.events.entries) {
    if (event.type === "coverage") {
      coverageEvents += 1;
      reasons.add(event.reason);
    } else if (event.type === "attempt") {
      attemptsByCall.set(event.callId, (attemptsByCall.get(event.callId) ?? 0) + 1);
    }
  }
  if (transport.invocations) {
    const invocationCountsByCall = new Map<string, number>();
    const priorByCall = new Map<
      string,
      { attemptOrdinal: number; hopOrdinal: number; reason: string; transport: string }
    >();
    for (const [index, invocation] of transport.invocations.entries.entries()) {
      const call = transport.logicalCalls.entries[invocation.logicalCallOrdinal - 1];
      if (invocation.sequence !== index + 1) {
        reasons.add("invocation_global_sequence_invalid");
      }
      if (!call || call.callId !== invocation.callId) {
        reasons.add("invocation_orphan_fact");
        continue;
      }
      if (
        call.provider !== invocation.provider ||
        call.model !== invocation.model ||
        call.api !== invocation.api
      ) {
        reasons.add("invocation_provider_ledger_mismatch");
      }
      const prior = priorByCall.get(invocation.callId);
      if (
        (!prior &&
          (invocation.ordinal !== 1 ||
            invocation.attemptOrdinal !== 1 ||
            invocation.hopOrdinal !== 1 ||
            invocation.reason !== "initial")) ||
        (prior &&
          !(
            (invocation.ordinal === (invocationCountsByCall.get(invocation.callId) ?? 0) + 1 &&
              invocation.attemptOrdinal === prior.attemptOrdinal &&
              invocation.hopOrdinal === prior.hopOrdinal + 1 &&
              invocation.reason === prior.reason &&
              invocation.transport === prior.transport) ||
            (invocation.ordinal === (invocationCountsByCall.get(invocation.callId) ?? 0) + 1 &&
              invocation.attemptOrdinal === prior.attemptOrdinal + 1 &&
              invocation.hopOrdinal === 1 &&
              invocation.reason !== "initial")
          ))
      ) {
        reasons.add("invocation_attempt_conservation_mismatch");
      }
      invocationCountsByCall.set(
        invocation.callId,
        (invocationCountsByCall.get(invocation.callId) ?? 0) + 1,
      );
      priorByCall.set(invocation.callId, {
        attemptOrdinal: invocation.attemptOrdinal,
        hopOrdinal: invocation.hopOrdinal,
        reason: invocation.reason,
        transport: invocation.transport,
      });
    }
    if (
      transport.invocations.total < transport.attempts.total ||
      transport.logicalCalls.entries.some(
        (call) =>
          (invocationCountsByCall.get(call.callId) ?? 0) < (attemptsByCall.get(call.callId) ?? 0),
      )
    ) {
      reasons.add("invocation_attempt_conservation_mismatch");
    }
  }
  if (
    transport.events.total !==
    transport.attempts.total +
      (transport.invocations?.total ?? 0) +
      transport.connections.total +
      transport.fallbacks.total +
      transport.providerFallbacks.total +
      transport.zeroSubmissions.total +
      coverageEvents
  ) {
    reasons.add("provider_event_conservation_mismatch");
  }
  return { reasons: [...reasons], attemptsByCall };
}

function projectRoute(params: {
  snapshot: AgentCommandRunAccountingSnapshot;
  transport: ProviderTransport | undefined;
  observedModel?: string;
  observedProvider?: string;
  authorityReasons: readonly string[];
}): { route?: AgentExecTrace["route"]; reasons: string[] } {
  const reasons = new Set<string>(params.authorityReasons);
  const { snapshot, transport } = params;
  const [candidate] = snapshot.candidates.entries;
  const [effectiveModel] = candidate?.effectiveModels.entries ?? [];
  if (snapshot.coverage.candidates.state !== "complete") {
    for (const reason of coverageReasons(snapshot.coverage.candidates)) {
      reasons.add(reason);
    }
  }
  if (
    snapshot.candidates.total !== 1 ||
    snapshot.candidates.returned !== 1 ||
    snapshot.candidates.threw !== 0 ||
    snapshot.candidates.truncated !== 0 ||
    snapshot.candidates.entries.length !== 1 ||
    candidate?.runtime !== "embedded" ||
    candidate.outcome !== "returned" ||
    candidate.effectiveModels.truncated !== 0 ||
    candidate.effectiveModels.entries.length !== 1 ||
    !effectiveModel ||
    effectiveModel.provider !== candidate.provider ||
    effectiveModel.model !== candidate.model
  ) {
    reasons.add("candidate_route_incomplete");
  }
  if (!transport) {
    reasons.add("provider_transport_not_observed");
  } else {
    if (transport.logicalCalls.total < 1) {
      reasons.add("provider_route_incomplete");
    }
    const [firstCall] = transport.logicalCalls.entries;
    if (
      !firstCall ||
      transport.logicalCalls.entries.some(
        (call) =>
          !call.outcome ||
          call.provider !== firstCall.provider ||
          call.model !== firstCall.model ||
          call.api !== firstCall.api ||
          (call.servingModel !== undefined && call.servingModel !== call.model),
      ) ||
      firstCall.provider !== candidate?.provider ||
      firstCall.model !== candidate.model
    ) {
      reasons.add("provider_route_identity_mismatch");
    }
  }
  if (!params.observedProvider || !params.observedModel) {
    reasons.add("reported_route_identity_missing");
  } else if (
    candidate &&
    (params.observedProvider !== candidate.provider || params.observedModel !== candidate.model)
  ) {
    reasons.add("reported_route_identity_mismatch");
  }
  const firstCall = transport?.logicalCalls.entries[0];
  return {
    ...(reasons.size === 0 && candidate && firstCall
      ? {
          route: {
            provider: candidate.provider,
            model: candidate.model,
            api: firstCall.api,
            runtime: "embedded" as const,
          },
        }
      : {}),
    reasons: [...reasons],
  };
}

function codeModeBridgeMetric(
  snapshot: AgentCommandRunAccountingSnapshot,
  codeModeEngaged: boolean | undefined,
  codeModeConfigured: false | "auto" | true | undefined,
): AgentExecTraceMetric {
  if (codeModeConfigured === false && snapshot.codeMode === undefined) {
    if (codeModeEngaged !== false) {
      return unavailableMetric(["code_mode_engagement_unreported"]);
    }
    return { state: "exact", value: 0 };
  }
  const codeMode = snapshot.codeMode;
  if (!codeMode?.stats) {
    return unavailableMetric(["code_mode_stats_not_observed"]);
  }
  const values = Object.values(codeMode.stats.bridgeCalls);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return unavailableMetric(["code_mode_bridge_count_invalid"]);
  }
  const reasons = new Set<string>();
  if (codeModeEngaged === undefined) {
    reasons.add("code_mode_engagement_unreported");
  }
  if (codeModeConfigured === false) {
    reasons.add("code_mode_configuration_mismatch");
  }
  if (codeModeEngaged !== undefined && codeMode.engaged !== codeModeEngaged) {
    reasons.add("code_mode_engagement_mismatch");
  }
  if (codeMode.lifecycle.finalQuiescence.state !== "quiescent") {
    if ("reasons" in codeMode.lifecycle.finalQuiescence) {
      for (const reason of codeMode.lifecycle.finalQuiescence.reasons) {
        reasons.add(reason);
      }
    } else {
      reasons.add("code_mode_not_quiescent");
    }
  }
  if (
    codeMode.lifecycle.attemptsWithUnresolved !== 0 ||
    codeMode.lifecycle.maxUnresolvedAtExtraction !== 0
  ) {
    reasons.add("code_mode_unresolved_bridge_calls");
  }
  const bridgeCalls = values.reduce((total, value) => total + value, 0);
  const lifecycle = codeMode.stats.bridgeLifecycle;
  const lifecycleValues = Object.values(lifecycle);
  if (lifecycleValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    reasons.add("code_mode_bridge_lifecycle_count_invalid");
  }
  const registered = lifecycle.registered ?? 0;
  const started = lifecycle.started ?? 0;
  const settled = lifecycle.settled ?? 0;
  const failed = lifecycle.failed ?? 0;
  const cancelRequested = lifecycle.cancelRequested ?? 0;
  const cancelledBeforeStart = lifecycle.cancelledBeforeStart ?? 0;
  const settledAfterCancel = lifecycle.settledAfterCancel ?? 0;
  if (
    bridgeCalls !== registered ||
    registered !== settled ||
    started + cancelledBeforeStart !== registered ||
    failed > settled ||
    settledAfterCancel > cancelRequested ||
    cancelRequested !== cancelledBeforeStart + settledAfterCancel ||
    failed + cancelRequested > registered
  ) {
    reasons.add("code_mode_bridge_lifecycle_conservation_mismatch");
  }
  return metricWithReasons(bridgeCalls, reasons);
}

function tokenAuthorityReasons(
  transport: ProviderTransport | undefined,
  authorityReasons: readonly string[],
  attemptsByCall: ReadonlyMap<string, number>,
): string[] {
  const reasons = new Set<string>(authorityReasons);
  if (!transport) {
    return [...reasons];
  }
  if (
    transport.attempts.total !== transport.logicalCalls.total ||
    transport.attempts.initial !== transport.logicalCalls.total ||
    transport.attempts.retries !== 0 ||
    transport.attempts.authRecoveries !== 0 ||
    transport.attempts.payloadRecoveries !== 0 ||
    transport.attempts.transportFallbacks !== 0
  ) {
    reasons.add("provider_attempt_usage_unattributed");
  }
  if (transport.logicalCalls.entries.some((call) => attemptsByCall.get(call.callId) !== 1)) {
    reasons.add("provider_attempt_usage_unproven");
  }
  return [...reasons];
}

function firstLogicalCallCachedInput(
  transport: ProviderTransport | undefined,
  tokenReasons: readonly string[],
): AgentExecTraceCacheObservation {
  const firstCall = transport?.logicalCalls.entries[0];
  if (
    tokenReasons.length > 0 ||
    !firstCall ||
    firstCall.cachedInput.state !== "exact" ||
    !Number.isSafeInteger(firstCall.cachedInput.tokens) ||
    firstCall.cachedInput.tokens < 0
  ) {
    return {
      state: "unknown",
      reasons: normalizeTraceReasons([
        ...tokenReasons,
        ...(firstCall?.cachedInput.state === "exact"
          ? []
          : ["first_logical_call_cached_input_unknown"]),
      ]),
    };
  }
  return { state: "exact", value: firstCall.cachedInput.tokens };
}

function auditTrace(params: {
  metrics: AgentExecTrace["metrics"];
  routeReasons: readonly string[];
}): AgentExecTrace["audit"] {
  const reasons = new Set<string>(params.routeReasons);
  const required: Array<[string, AgentExecTraceMetric]> = [
    ["effective_turns", params.metrics.effectiveTurns],
    ["logical_model_calls", params.metrics.logicalModelCalls],
    ["provider_attempts", params.metrics.providerAttempts.total],
    ["provider_initial_attempts", params.metrics.providerAttempts.initial],
    ["provider_retries", params.metrics.providerAttempts.retries],
    ["provider_auth_recoveries", params.metrics.providerAttempts.authRecoveries],
    ["provider_payload_recoveries", params.metrics.providerAttempts.payloadRecoveries],
    ["provider_transport_fallbacks", params.metrics.providerAttempts.transportFallbacks],
    ["model_facing_api_calls", params.metrics.modelFacingApiCalls],
    ["outer_tool_calls", params.metrics.outerToolCalls],
    ["code_mode_bridge_calls", params.metrics.codeModeBridgeCalls],
    ["total_tool_operations", params.metrics.totalToolOperations],
    ["underlying_total_calls", params.metrics.underlyingTotalCalls],
    ["input_tokens", params.metrics.tokens.input],
    ["cached_input_tokens", params.metrics.tokens.cachedInput],
    ["output_tokens", params.metrics.tokens.output],
    ["reasoning_tokens", params.metrics.tokens.reasoning],
    ["total_tokens", params.metrics.tokens.total],
    ["agent_duration", params.metrics.agentDurationMs],
    ["command_execution_duration", params.metrics.commandExecutionDurationMs],
    ["wall_latency", params.metrics.wallLatencyMs],
  ];
  for (const [name, metric] of required) {
    if (metric.state !== "exact") {
      reasons.add(`${name}_${metric.state}`);
      for (const reason of "reasons" in metric ? (metric.reasons ?? []) : []) {
        reasons.add(reason);
      }
    }
  }
  if (params.metrics.tokens.firstLogicalCallCachedInput.state !== "exact") {
    for (const reason of params.metrics.tokens.firstLogicalCallCachedInput.reasons) {
      reasons.add(reason);
    }
  }
  return reasons.size === 0
    ? { state: "valid" }
    : { state: "inconclusive", reasons: [...reasons].toSorted() };
}

export function projectAgentExecTrace(params: {
  snapshot: AgentCommandRunAccountingSnapshot | undefined;
  agentDurationMs?: number;
  wallLatencyMs?: number;
  codeModeEngaged?: boolean;
  codeModeConfigured?: false | "auto" | true;
  model?: string;
  provider?: string;
}): AgentExecTrace | undefined {
  const snapshot = params.snapshot;
  if (!snapshot) {
    return undefined;
  }
  const transport = snapshot.providerTransport;
  const providerAudit = providerLedgerAudit(snapshot, transport);
  const providerReasons = providerAudit.reasons;
  const modelCallReasons = modelCallReconciliationReasons(snapshot, transport);
  const authorityReasons = normalizeTraceReasons([...providerReasons, ...modelCallReasons]);
  const routeProjection = projectRoute({
    snapshot,
    transport,
    observedModel: params.model,
    observedProvider: params.provider,
    authorityReasons,
  });
  const logicalModelCalls = metricWithReasons(transport?.logicalCalls.total, authorityReasons);
  const attemptReasons = providerReasons;
  const outerToolCalls = observedMetric({
    value: snapshot.toolSummary?.calls,
    coverage: snapshot.coverage.tools,
    reasons: snapshot.toolNamesTruncated ? ["tool_details_truncated"] : [],
  });
  const codeModeBridgeCalls = codeModeBridgeMetric(
    snapshot,
    params.codeModeEngaged,
    params.codeModeConfigured,
  );
  const totalToolOperations = sumExactMetrics(
    [outerToolCalls, codeModeBridgeCalls],
    "tool_operation_components_incomplete",
  );
  const modelFacingApiCalls = metricWithReasons(
    transport?.invocations?.total,
    providerReasons.filter((reason) => reason.includes("invocation")),
  );
  const tokenReasons = tokenAuthorityReasons(
    transport,
    authorityReasons,
    providerAudit.attemptsByCall,
  );
  const tokenMetric = (
    value: number | undefined,
    coverage: AgentCommandRunAccountingSnapshot["coverage"]["usageBuckets"]["input"],
  ) => observedMetric({ value, coverage, reasons: tokenReasons });
  const metrics: AgentExecTrace["metrics"] = {
    effectiveTurns: observedMetric({
      value: snapshot.assistantTurns,
      coverage: snapshot.coverage.assistantTurns,
    }),
    logicalModelCalls,
    providerAttempts: {
      total: metricWithReasons(transport?.attempts.total, attemptReasons),
      initial: metricWithReasons(transport?.attempts.initial, attemptReasons),
      retries: metricWithReasons(transport?.attempts.retries, attemptReasons),
      authRecoveries: metricWithReasons(transport?.attempts.authRecoveries, attemptReasons),
      payloadRecoveries: metricWithReasons(transport?.attempts.payloadRecoveries, attemptReasons),
      transportFallbacks: metricWithReasons(transport?.attempts.transportFallbacks, attemptReasons),
    },
    modelFacingApiCalls,
    outerToolCalls,
    codeModeBridgeCalls,
    totalToolOperations,
    underlyingTotalCalls: sumExactMetrics(
      [modelFacingApiCalls, totalToolOperations],
      "underlying_call_components_incomplete",
    ),
    tokens: {
      input: tokenMetric(snapshot.usage?.input, snapshot.coverage.usageBuckets.input),
      cachedInput: tokenMetric(snapshot.usage?.cacheRead, snapshot.coverage.usageBuckets.cacheRead),
      firstLogicalCallCachedInput: firstLogicalCallCachedInput(transport, tokenReasons),
      output: tokenMetric(snapshot.usage?.output, snapshot.coverage.usageBuckets.output),
      reasoning: tokenMetric(
        snapshot.usage?.reasoningTokens,
        snapshot.coverage.usageBuckets.reasoningTokens,
      ),
      total: tokenMetric(snapshot.usage?.total, snapshot.coverage.usageBuckets.total),
    },
    agentDurationMs: agentDurationMetric(snapshot, params.agentDurationMs),
    commandExecutionDurationMs: observedMetric({
      value: snapshot.commandExecutionDurationMs,
      coverage: snapshot.coverage.commandExecutionDuration,
    }),
    wallLatencyMs: observedMetric({
      value: params.wallLatencyMs,
      coverage: snapshot.coverage.wallLatency,
    }),
  };
  return {
    schemaVersion: AGENT_EXEC_TRACE_SCHEMA_VERSION,
    source: "agent-command-accounting",
    ...(routeProjection.route ? { route: routeProjection.route } : {}),
    metrics,
    audit: auditTrace({
      metrics,
      routeReasons: routeProjection.reasons,
    }),
  };
}

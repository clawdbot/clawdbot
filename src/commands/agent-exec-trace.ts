import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import {
  agentDurationMetric,
  coverageReasons,
  normalizeTraceReasons,
  observedMetric,
  unavailableMetric,
  type AgentExecTraceCacheObservation,
  type AgentExecTraceMetric,
} from "./agent-exec-trace-metrics.js";
import { projectAgentExecInvocationAuthority } from "./agent-exec-trace-receipt.js";
import {
  buildAgentExecTrace,
  type AgentExecTraceSourceInput,
} from "./agent-exec-trace-schema.internal.js";
import type { AgentExecTrace } from "./agent-exec-trace-schema.js";

export {
  normalizeAgentExecInvocationReceipt,
  normalizeAgentExecTrace,
  verifyAgentExecInvocationReceipt,
  verifyAgentExecTrace,
} from "./agent-exec-trace-schema.js";
export type {
  AgentExecInvocationReceipt,
  AgentExecTrace,
  AgentExecTraceSource,
} from "./agent-exec-trace-schema.js";

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

function providerLedgerAudit(transport: ProviderTransport | undefined): {
  reasons: string[];
  attemptsByCall: ReadonlyMap<string, number>;
} {
  const reasons = new Set<string>();
  const attemptsByCall = new Map<string, number>();
  if (!transport) {
    return { reasons: ["provider_transport_not_observed"], attemptsByCall };
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
}): { route?: AgentExecTraceSourceInput["route"]; reasons: string[] } {
  const reasons = new Set<string>(params.authorityReasons);
  const { snapshot, transport } = params;
  const [candidate] = snapshot.candidates.entries;
  const [effectiveModel] = candidate?.effectiveModels.entries ?? [];
  if (snapshot.coverage.candidates.state !== "complete") {
    for (const reason of coverageReasons(snapshot.coverage.candidates)) {
      reasons.add(reason);
    }
  }
  const aggregateMatchesCandidate =
    candidate?.outcome === "returned"
      ? snapshot.candidates.returned === 1 && snapshot.candidates.threw === 0
      : candidate?.outcome === "threw" &&
        snapshot.candidates.returned === 0 &&
        snapshot.candidates.threw === 1;
  if (
    snapshot.candidates.total !== 1 ||
    !aggregateMatchesCandidate ||
    snapshot.candidates.truncated !== 0 ||
    snapshot.candidates.entries.length !== 1 ||
    candidate?.runtime !== "embedded" ||
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
  const hasReportedRoute =
    params.observedProvider !== undefined || params.observedModel !== undefined;
  if (hasReportedRoute && (!params.observedProvider || !params.observedModel)) {
    reasons.add("reported_route_identity_missing");
  } else if (
    params.observedProvider &&
    params.observedModel &&
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
  codeModeConfigured: false | "auto" | true | "unreported" | undefined,
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

function metricReasons(metric: AgentExecTraceMetric): readonly string[] {
  return "reasons" in metric ? (metric.reasons ?? []) : [];
}

export function projectAgentExecTrace(params: {
  snapshot: AgentCommandRunAccountingSnapshot | undefined;
  wallLatencyMs?: number;
  codeModeEngaged?: boolean;
  codeModeConfigured?: false | "auto" | true | "unreported";
  model?: string;
  provider?: string;
}): AgentExecTrace | undefined {
  const snapshot = params.snapshot;
  if (!snapshot) {
    return undefined;
  }
  const invocationAuthority = projectAgentExecInvocationAuthority(snapshot);
  const invocationReceipt = invocationAuthority.receipt;
  const transport =
    invocationReceipt?.complete === true ? invocationAuthority.providerTransport : undefined;
  const authorityValid = transport !== undefined;
  const authorityReasons = authorityValid
    ? []
    : normalizeTraceReasons([
        "invocation_receipt_authority_invalid",
        ...(invocationReceipt?.incompleteReasons ?? ["invocation_receipt_unavailable"]),
      ]);
  const providerAudit = providerLedgerAudit(transport);
  const auditReasons = authorityValid
    ? normalizeTraceReasons([
        ...providerAudit.reasons,
        ...modelCallReconciliationReasons(snapshot, transport),
      ])
    : authorityReasons;
  const routeProjection = projectRoute({
    snapshot,
    transport,
    observedModel: params.model,
    observedProvider: params.provider,
    authorityReasons: auditReasons,
  });
  const codeModeEngaged =
    snapshot.codeMode?.engaged ??
    params.codeModeEngaged ??
    (params.codeModeConfigured === false ? false : undefined);
  const authorityUnavailable = () => unavailableMetric(authorityReasons);
  const logicalModelCalls = authorityValid
    ? metricWithReasons(transport.logicalCalls.total, auditReasons)
    : authorityUnavailable();
  const outerToolCalls = observedMetric({
    value: snapshot.toolSummary?.calls,
    coverage: snapshot.coverage.tools,
    reasons: snapshot.toolNamesTruncated ? ["tool_details_truncated"] : [],
  });
  const codeModeBridgeCalls = codeModeBridgeMetric(
    snapshot,
    codeModeEngaged,
    params.codeModeConfigured,
  );
  const tokenReasons = tokenAuthorityReasons(transport, auditReasons, providerAudit.attemptsByCall);
  const tokenMetric = (
    value: number | undefined,
    coverage: AgentCommandRunAccountingSnapshot["coverage"]["usageBuckets"]["input"],
  ) =>
    authorityValid
      ? observedMetric({ value, coverage, reasons: tokenReasons })
      : authorityUnavailable();
  const facts: AgentExecTraceSourceInput["facts"] = {
    auditReasons: [],
    accounting: {
      effectiveTurns: authorityValid
        ? observedMetric({
            value: snapshot.assistantTurns,
            coverage: snapshot.coverage.assistantTurns,
          })
        : authorityUnavailable(),
      logicalModelCalls,
      providerAttempts: {
        total: authorityValid
          ? metricWithReasons(transport.attempts.total, providerAudit.reasons)
          : authorityUnavailable(),
        initial: authorityValid
          ? metricWithReasons(transport.attempts.initial, providerAudit.reasons)
          : authorityUnavailable(),
        retries: authorityValid
          ? metricWithReasons(transport.attempts.retries, providerAudit.reasons)
          : authorityUnavailable(),
        authRecoveries: authorityValid
          ? metricWithReasons(transport.attempts.authRecoveries, providerAudit.reasons)
          : authorityUnavailable(),
        payloadRecoveries: authorityValid
          ? metricWithReasons(transport.attempts.payloadRecoveries, providerAudit.reasons)
          : authorityUnavailable(),
        transportFallbacks: authorityValid
          ? metricWithReasons(transport.attempts.transportFallbacks, providerAudit.reasons)
          : authorityUnavailable(),
      },
    },
    tools: {
      outerToolCalls: authorityValid ? outerToolCalls : authorityUnavailable(),
      codeModeBridgeCalls: authorityValid ? codeModeBridgeCalls : authorityUnavailable(),
    },
    usage: {
      input: tokenMetric(snapshot.usage?.input, snapshot.coverage.usageBuckets.input),
      cachedInput: tokenMetric(snapshot.usage?.cacheRead, snapshot.coverage.usageBuckets.cacheRead),
      firstLogicalCallCachedInput: authorityValid
        ? firstLogicalCallCachedInput(transport, tokenReasons)
        : { state: "unknown", reasons: authorityReasons },
      output: tokenMetric(snapshot.usage?.output, snapshot.coverage.usageBuckets.output),
      reasoning: tokenMetric(
        snapshot.usage?.reasoningTokens,
        snapshot.coverage.usageBuckets.reasoningTokens,
      ),
      total: tokenMetric(snapshot.usage?.total, snapshot.coverage.usageBuckets.total),
    },
    duration: {
      agentDurationMs: authorityValid ? agentDurationMetric(snapshot) : authorityUnavailable(),
      commandExecutionDurationMs: authorityValid
        ? observedMetric({
            value: snapshot.commandExecutionDurationMs,
            coverage: snapshot.coverage.commandExecutionDuration,
          })
        : authorityUnavailable(),
      wallLatencyMs: authorityValid
        ? observedMetric({
            value: params.wallLatencyMs,
            coverage:
              params.wallLatencyMs === undefined
                ? snapshot.coverage.wallLatency
                : { state: "complete" },
          })
        : authorityUnavailable(),
    },
  };
  facts.auditReasons = normalizeTraceReasons([
    ...routeProjection.reasons,
    ...(invocationReceipt?.incompleteReasons ?? []),
    ...metricReasons(facts.accounting.effectiveTurns),
    ...metricReasons(facts.accounting.logicalModelCalls),
    ...Object.values(facts.accounting.providerAttempts).flatMap(metricReasons),
    ...metricReasons(facts.tools.outerToolCalls),
    ...metricReasons(facts.tools.codeModeBridgeCalls),
    ...metricReasons(facts.usage.input),
    ...metricReasons(facts.usage.cachedInput),
    ...(facts.usage.firstLogicalCallCachedInput.state === "unknown"
      ? facts.usage.firstLogicalCallCachedInput.reasons
      : []),
    ...metricReasons(facts.usage.output),
    ...metricReasons(facts.usage.reasoning),
    ...metricReasons(facts.usage.total),
    ...metricReasons(facts.duration.agentDurationMs),
    ...metricReasons(facts.duration.commandExecutionDurationMs),
    ...metricReasons(facts.duration.wallLatencyMs),
  ]);
  return buildAgentExecTrace({
    mode: {
      configured: params.codeModeConfigured ?? "unreported",
      engaged: codeModeEngaged ?? null,
    },
    ...(routeProjection.route ? { route: routeProjection.route } : {}),
    ...(invocationReceipt ? { invocationReceipt } : {}),
    facts,
  });
}

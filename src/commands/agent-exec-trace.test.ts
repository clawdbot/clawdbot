import type { AiModelTransportEvent } from "@openclaw/ai";
import { describe, expect, it } from "vitest";
import { createCodeModeStats } from "../agents/code-mode-stats.js";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import { createProviderTransportAccountingCollector } from "../agents/provider-transport-accounting.js";
import {
  normalizeAgentExecTrace,
  projectAgentExecTrace,
  verifyAgentExecInvocationReceipt,
  verifyAgentExecTrace,
} from "./agent-exec-trace.js";
import { classifyAgentExecResult } from "./agent-exec.js";

const PROVIDER = "openai";
const MODEL = "gpt-test";
const API = "responses";
const TRANSPORT = "sse";

function attemptEvent(callId: string, ordinal = 1): AiModelTransportEvent {
  return {
    eventId: `attempt-${callId}-${String(ordinal)}`,
    type: "attempt",
    provider: PROVIDER,
    model: MODEL,
    api: API,
    callId,
    transport: TRANSPORT,
    ordinal,
    reason: ordinal === 1 ? "initial" : "retry",
    outcome: "completed",
  };
}

function invocationEvent(params: {
  attemptOrdinal?: number;
  callId: string;
  hopOrdinal?: number;
  ordinal?: number;
}): AiModelTransportEvent {
  const ordinal = params.ordinal ?? 1;
  const attemptOrdinal = params.attemptOrdinal ?? 1;
  return {
    eventId: `invocation-${params.callId}-${String(ordinal)}`,
    type: "invocation",
    provider: PROVIDER,
    model: MODEL,
    api: API,
    callId: params.callId,
    transport: TRANSPORT,
    ordinal,
    attemptOrdinal,
    hopOrdinal: params.hopOrdinal ?? 1,
    reason: attemptOrdinal === 1 ? "initial" : "retry",
  };
}

function zeroSubmissionEvent(callId: string): AiModelTransportEvent {
  return {
    eventId: `zero-${callId}`,
    type: "submission",
    provider: PROVIDER,
    model: MODEL,
    api: API,
    callId,
    transport: TRANSPORT,
    total: 0,
    outcome: "failed",
    reason: "failed_before_submission",
  };
}

function coverageEvent(
  callId: string,
  reason:
    | "transport_terminal_unverified"
    | "transport_endpoint_authority_partial"
    | "transport_submission_authority_partial",
): AiModelTransportEvent {
  return {
    eventId: `coverage-${callId}-${reason}`,
    type: "coverage",
    scope: "transport_semantics",
    state: "unverified",
    reason,
    provider: PROVIDER,
    model: MODEL,
    api: API,
    callId,
    transport: TRANSPORT,
  };
}

function snapshot(callCount = 2): AgentCommandRunAccountingSnapshot {
  const callIds = Array.from({ length: callCount }, (_, index) => `call-${String(index + 1)}`);
  const codeModeStats = createCodeModeStats();
  codeModeStats.bridgeCalls = { search: 1, call: 2 };
  codeModeStats.bridgeLifecycle = {
    registered: 3,
    started: 3,
    settled: 3,
    unresolvedAtExtraction: 0,
  };
  const collector = createProviderTransportAccountingCollector();
  for (const callId of callIds) {
    collector.observer.onLogicalCallStarted({
      callId,
      provider: PROVIDER,
      model: MODEL,
      api: API,
    });
  }
  for (const [index, callId] of callIds.entries()) {
    collector.observer.onTransportEvent(invocationEvent({ callId }));
    collector.observer.onTransportEvent(attemptEvent(callId));
    collector.observer.onLogicalCallSettled(callId, "completed", {
      state: "exact",
      tokens: index === 0 ? 7 : 13,
    });
    collector.finalize(callId);
  }
  collector.seal();
  const projectedTransport = collector.project();
  if (!projectedTransport.snapshot || projectedTransport.coverage.state !== "complete") {
    throw new Error("expected complete provider transport fixture");
  }
  return {
    candidates: {
      total: 1,
      returned: 1,
      threw: 0,
      runtimes: { embedded: 1, cli: 0, native: 0, cloud: 0, unknown: 0 },
      entries: [
        {
          provider: PROVIDER,
          model: MODEL,
          runtime: "embedded",
          outcome: "returned",
          effectiveModels: {
            entries: [{ provider: PROVIDER, model: MODEL }],
            truncated: 0,
          },
        },
      ],
      truncated: 0,
    },
    agentSubmissions: { total: 1, completed: 1, failed: 0 },
    modelCalls: { total: callCount, completed: callCount, failed: 0 },
    assistantTurns: callCount,
    usage: {
      input: 100,
      cacheRead: 20,
      cacheWrite: 0,
      output: 30,
      reasoningTokens: 10,
      total: 140,
    },
    toolSummary: { calls: 1, tools: ["read"] },
    providerTransport: projectedTransport.snapshot,
    agentDurationMs: 110,
    commandExecutionDurationMs: 125,
    coverage: {
      candidates: { state: "complete" },
      agentSubmissions: { state: "complete" },
      modelCalls: { state: "complete" },
      assistantTurns: { state: "complete" },
      usage: { state: "complete" },
      usageBuckets: {
        input: { state: "complete" },
        output: { state: "complete" },
        cacheRead: { state: "complete" },
        cacheWrite: { state: "complete" },
        reasoningTokens: { state: "complete" },
        total: { state: "complete" },
      },
      tools: { state: "complete" },
      cost: { state: "complete" },
      agentTime: { state: "complete" },
      commandExecutionDuration: { state: "complete" },
      wallLatency: { state: "complete" },
      providerTransport: { state: "complete" },
    },
    codeMode: {
      engaged: true,
      stats: codeModeStats,
      lifecycle: {
        maxUnresolvedAtExtraction: 0,
        attemptsWithUnresolved: 0,
        finalQuiescence: { state: "quiescent" },
      },
    },
  };
}

function setInvocationCounts(
  source: AgentCommandRunAccountingSnapshot,
  invocations: readonly number[],
): void {
  const calls = source.providerTransport?.logicalCalls.entries ?? [];
  const transport = source.providerTransport!;
  let sequence = 0;
  transport.invocations!.entries = calls.flatMap((call, index) =>
    Array.from({ length: invocations[index] ?? 0 }, (_, hopIndex) => ({
      sequence: ++sequence,
      logicalCallOrdinal: index + 1,
      callId: call.callId,
      provider: PROVIDER,
      model: MODEL,
      api: API,
      transport: TRANSPORT,
      ordinal: hopIndex + 1,
      attemptOrdinal: 1,
      hopOrdinal: hopIndex + 1,
      reason: "initial" as const,
    })),
  );
  transport.invocations!.total = sequence;
  transport.events.entries = calls.flatMap((call, index) =>
    Array.from({ length: invocations[index] ?? 0 }, (_, hopIndex) =>
      invocationEvent({
        callId: call.callId,
        ordinal: hopIndex + 1,
        hopOrdinal: hopIndex + 1,
      }),
    ).concat(attemptEvent(call.callId)),
  );
  transport.events.total = transport.events.entries.length;
}

function setTerminalZeroSubmission(source: AgentCommandRunAccountingSnapshot): void {
  const callId = "zero-submission-call";
  const collector = createProviderTransportAccountingCollector();
  collector.observer.onLogicalCallStarted({
    callId,
    provider: PROVIDER,
    model: MODEL,
    api: API,
  });
  collector.observer.onTransportEvent(zeroSubmissionEvent(callId));
  collector.observer.onLogicalCallSettled(callId, "failed", { state: "exact", tokens: 0 });
  collector.finalize(callId);
  collector.seal();
  const projected = collector.project();
  if (!projected.snapshot || projected.coverage.state !== "complete") {
    throw new Error("expected complete zero-submission transport fixture");
  }
  source.providerTransport = projected.snapshot;
  source.coverage.providerTransport = projected.coverage;
  source.modelCalls = { total: 1, completed: 0, failed: 1 };
  source.usage = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoningTokens: 0,
    total: 0,
  };
}

function project(source: AgentCommandRunAccountingSnapshot) {
  return projectAgentExecTrace({
    snapshot: source,
    wallLatencyMs: 140,
    codeModeConfigured: true,
    provider: PROVIDER,
    model: MODEL,
  });
}

function expectInconclusiveReason(source: AgentCommandRunAccountingSnapshot, reason: string): void {
  const trace = project(source);
  expect(trace?.audit).toEqual({
    state: "inconclusive",
    reasons: expect.arrayContaining([reason]),
  });
}

describe("agent exec frontier trace projection", () => {
  it("projects an exact conserved happy path", () => {
    const source = snapshot();
    const trace = project(source);

    expect(trace).toMatchObject({
      source: {
        mode: { configured: true, engaged: true },
        route: { provider: PROVIDER, model: MODEL, api: API, runtime: "embedded" },
      },
      projection: {
        metrics: {
          effectiveTurns: { state: "exact", value: 2 },
          logicalModelCalls: { state: "exact", value: 2 },
          providerAttempts: {
            total: { state: "exact", value: 2 },
            retries: { state: "exact", value: 0 },
          },
          modelFacingApiCalls: { state: "exact", value: 2 },
          outerToolCalls: { state: "exact", value: 1 },
          codeModeBridgeCalls: { state: "exact", value: 3 },
          totalToolOperations: { state: "exact", value: 4 },
          underlyingTotalCalls: { state: "exact", value: 6 },
          tokens: {
            input: { state: "exact", value: 100 },
            cachedInput: { state: "exact", value: 20 },
            firstLogicalCallCachedInput: { state: "exact", value: 7 },
            output: { state: "exact", value: 30 },
            reasoning: { state: "exact", value: 10 },
            total: { state: "exact", value: 140 },
          },
          agentDurationMs: { state: "exact", value: 110 },
          commandExecutionDurationMs: { state: "exact", value: 125 },
          wallLatencyMs: { state: "exact", value: 140 },
        },
      },
      audit: { state: "valid" },
    });
  });

  it("conserves mixed physical invocation counts across multiple calls", () => {
    const source = snapshot(3);
    setInvocationCounts(source, [1, 2, 3]);
    const trace = project(source);

    expect(trace?.projection.metrics).toMatchObject({
      logicalModelCalls: { state: "exact", value: 3 },
      providerAttempts: { total: { state: "exact", value: 3 } },
      modelFacingApiCalls: { state: "exact", value: 6 },
      totalToolOperations: { state: "exact", value: 4 },
      underlyingTotalCalls: { state: "exact", value: 10 },
    });
    expect(trace?.audit).toEqual({ state: "valid" });
    expect(verifyAgentExecTrace(JSON.stringify(trace))).toBe(true);
  });

  it("downgrades zero-submission authority at the persistable trace boundary", () => {
    const source = snapshot(1);
    setTerminalZeroSubmission(source);
    const trace = project(source);

    expect(trace?.source.invocationReceipt).toMatchObject({
      complete: false,
      incompleteReasons: ["invocation_receipt_conservation_mismatch"],
      logicalCalls: 1,
      modelFacingApiCalls: 0,
      calls: [{ outcome: "failed", finalized: true }],
      invocations: [],
    });
    expect(trace?.projection.metrics).toMatchObject({
      logicalModelCalls: { state: "unavailable" },
      providerAttempts: {
        total: { state: "unavailable" },
        retries: { state: "unavailable" },
      },
      modelFacingApiCalls: { state: "unavailable" },
      tokens: {
        input: { state: "unavailable" },
        cachedInput: { state: "unavailable" },
        firstLogicalCallCachedInput: { state: "unknown" },
        output: { state: "unavailable" },
        reasoning: { state: "unavailable" },
        total: { state: "unavailable" },
      },
    });
    expect(trace?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["invocation_receipt_conservation_mismatch"]),
    });
    const serialized = JSON.stringify(trace);
    expect(verifyAgentExecTrace(serialized)).toBe(true);
    const persisted = normalizeAgentExecTrace(serialized);
    expect(persisted?.source.invocationReceipt).toMatchObject({
      complete: false,
      incompleteReasons: ["invocation_receipt_conservation_mismatch"],
    });
    expect(persisted?.projection.metrics).toMatchObject({
      logicalModelCalls: { state: "unavailable" },
      providerAttempts: { total: { state: "unavailable" } },
      modelFacingApiCalls: { state: "unavailable" },
    });
    expect(persisted?.audit).toMatchObject({
      state: "inconclusive",
      reasons: expect.arrayContaining(["invocation_receipt_conservation_mismatch"]),
    });
    expect(persisted).toEqual(trace);
    expect(serialized).not.toContain("zeroSubmission");
    expect(serialized).not.toContain("Proof");
  });

  it("withholds all benchmark projections when canonical provider replay fails", () => {
    const source = snapshot();
    source.providerTransport!.events.entries = [];
    source.providerTransport!.events.total = 0;

    const trace = project(source);

    expect(trace?.source.route).toBeUndefined();
    expect(trace?.source.invocationReceipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(trace?.projection.metrics).toMatchObject({
      effectiveTurns: { state: "unavailable" },
      logicalModelCalls: { state: "unavailable" },
      providerAttempts: {
        total: { state: "unavailable" },
        initial: { state: "unavailable" },
        retries: { state: "unavailable" },
      },
      modelFacingApiCalls: { state: "unavailable" },
      outerToolCalls: { state: "unavailable" },
      codeModeBridgeCalls: { state: "unavailable" },
      totalToolOperations: { state: "unavailable" },
      underlyingTotalCalls: { state: "unavailable" },
      tokens: {
        input: { state: "unavailable" },
        cachedInput: { state: "unavailable" },
        firstLogicalCallCachedInput: { state: "unknown" },
        output: { state: "unavailable" },
        reasoning: { state: "unavailable" },
        total: { state: "unavailable" },
      },
      agentDurationMs: { state: "unavailable" },
      commandExecutionDurationMs: { state: "unavailable" },
    });
    expect(trace?.audit).toEqual({
      state: "inconclusive",
      reasons: expect.arrayContaining([
        "invocation_receipt_authority_invalid",
        "provider_event_conservation_mismatch",
        "route_unavailable",
      ]),
    });
  });

  it("keeps calls and attempts exact while retry token attribution is inconclusive", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    transport.attempts.total = 3;
    transport.attempts.retries = 1;
    transport.attempts.entries!.push({
      logicalCallOrdinal: 1,
      ordinal: 2,
      transport: TRANSPORT,
      reason: "retry",
      outcome: "completed",
    });
    transport.invocations!.entries.splice(1, 0, {
      sequence: 2,
      logicalCallOrdinal: 1,
      callId: "call-1",
      provider: PROVIDER,
      model: MODEL,
      api: API,
      transport: TRANSPORT,
      ordinal: 2,
      attemptOrdinal: 2,
      hopOrdinal: 1,
      reason: "retry",
    });
    transport.invocations!.entries[2]!.sequence = 3;
    transport.invocations!.total = 3;
    transport.attempts.entries![0]!.outcome = "failed";
    const initialAttempt = transport.events.entries.find(
      (event) => event.type === "attempt" && event.callId === "call-1" && event.ordinal === 1,
    );
    if (!initialAttempt || initialAttempt.type !== "attempt") {
      throw new Error("expected initial attempt");
    }
    initialAttempt.outcome = "failed";
    transport.events.entries.splice(
      2,
      0,
      invocationEvent({
        callId: "call-1",
        ordinal: 2,
        attemptOrdinal: 2,
      }),
    );
    transport.events.entries.push(attemptEvent("call-1", 2));
    transport.events.total = transport.events.entries.length;
    const trace = project(source);

    expect(trace?.projection.metrics.logicalModelCalls).toEqual({ state: "exact", value: 2 });
    expect(trace?.projection.metrics.providerAttempts.total).toEqual({
      state: "exact",
      value: 3,
    });
    expect(trace?.projection.metrics.tokens.total).toEqual({
      state: "lower_bound",
      value: 140,
      reasons: expect.arrayContaining([
        "provider_attempt_usage_unattributed",
        "provider_attempt_usage_unproven",
      ]),
    });
    expectInconclusiveReason(source, "provider_attempt_usage_unattributed");
  });

  for (const reason of [
    "transport_terminal_unverified",
    "transport_endpoint_authority_partial",
    "transport_submission_authority_partial",
  ] as const) {
    it(`rejects ${reason} as trace authority`, () => {
      const source = snapshot();
      const transport = source.providerTransport!;
      transport.events.entries.push(coverageEvent("call-1", reason));
      transport.events.total = transport.events.entries.length;
      source.coverage.providerTransport = { state: "partial", reasons: [reason] };
      if (reason === "transport_submission_authority_partial") {
        transport.attempts.totalKind = "lower_bound";
        source.coverage.providerTransport.reasons.push("transport_totals_lower_bound");
      }

      const trace = project(source);
      expect(trace?.source.route).toBeUndefined();
      expectInconclusiveReason(source, reason);
    });
  }

  it("rejects provider lower-bound coverage", () => {
    const source = snapshot();
    source.providerTransport!.logicalCalls.totalKind = "lower_bound";
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_totals_lower_bound"],
    };

    expectInconclusiveReason(source, "transport_totals_lower_bound");
  });

  it("rejects unavailable terminal fallback metadata", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    transport.providerFallbacks.totalKind = "lower_bound";
    transport.events.entries.push({
      eventId: "coverage-call-1-terminal-metadata",
      type: "coverage",
      scope: "provider_fallbacks",
      state: "lower_bound",
      reason: "terminal_metadata_unavailable",
      provider: PROVIDER,
      model: MODEL,
      api: API,
      callId: "call-1",
      transport: TRANSPORT,
    });
    transport.events.total = transport.events.entries.length;
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_totals_lower_bound"],
    };

    expectInconclusiveReason(source, "transport_totals_lower_bound");
  });

  it("rejects truncated transport evidence", () => {
    const source = snapshot();
    source.providerTransport!.events.entriesTruncated = true;
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_details_truncated"],
    };

    expectInconclusiveReason(source, "transport_details_truncated");
  });

  it("rejects missing provider ledger conservation", () => {
    const source = snapshot();
    source.providerTransport!.events.total += 1;

    expectInconclusiveReason(source, "provider_event_conservation_mismatch");
  });

  it("rejects model and provider terminal outcome disagreement", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    transport.logicalCalls.completed = 1;
    transport.logicalCalls.aborted = 1;
    transport.logicalCalls.entries[1]!.outcome = "aborted";

    expectInconclusiveReason(source, "provider_event_conservation_mismatch");
  });

  it("rejects transport observer failure coverage", () => {
    const source = snapshot();
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_observer_failed"],
    };

    expectInconclusiveReason(source, "transport_observer_failed");
  });

  it("rejects a cross-domain provider coverage reason", () => {
    const source = snapshot();
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["settled_finalization_failed"],
    } as never;

    expectInconclusiveReason(source, "provider_event_conservation_mismatch");
  });

  it("rejects a missing invocation ledger", () => {
    const source = snapshot();
    delete source.providerTransport!.invocations;
    const trace = projectAgentExecTrace({
      snapshot: source,
      wallLatencyMs: 140,
      codeModeConfigured: true,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(trace?.audit).toEqual({
      state: "inconclusive",
      reasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
  });

  it("uses the sealed accounting route without duplicate result metadata", () => {
    const source = snapshot();
    const trace = projectAgentExecTrace({
      snapshot: source,
      wallLatencyMs: 140,
      codeModeConfigured: true,
    });

    expect(trace?.source.route).toEqual({
      provider: PROVIDER,
      model: MODEL,
      api: API,
      runtime: "embedded",
    });
    expect(trace?.audit).toEqual({ state: "valid" });
  });

  it("ignores unowned caller duration, engagement, and metric fields", () => {
    const trace = projectAgentExecTrace({
      snapshot: snapshot(),
      wallLatencyMs: 140,
      codeModeConfigured: true,
      provider: PROVIDER,
      model: MODEL,
      agentDurationMs: 999_999,
      codeModeEngaged: false,
      metrics: { logicalModelCalls: { state: "exact", value: 999 } },
    } as Parameters<typeof projectAgentExecTrace>[0] & Record<string, unknown>);

    expect(trace?.source.mode).toEqual({ configured: true, engaged: true });
    expect(trace?.source.facts.duration.agentDurationMs).toEqual({
      state: "exact",
      value: 110,
    });
    expect(trace?.projection.metrics.logicalModelCalls).toEqual({
      state: "exact",
      value: 2,
    });
  });

  it("rejects reported route disagreement instead of accepting caller identity", () => {
    const trace = projectAgentExecTrace({
      snapshot: snapshot(),
      wallLatencyMs: 140,
      codeModeConfigured: true,
      provider: "untrusted-provider",
      model: "untrusted-model",
    });

    expect(trace?.source.route).toBeUndefined();
    expect(trace?.audit).toEqual({
      state: "inconclusive",
      reasons: expect.arrayContaining(["reported_route_identity_mismatch"]),
    });
    expect(JSON.stringify(trace)).not.toContain("untrusted-provider");
    expect(JSON.stringify(trace)).not.toContain("untrusted-model");
  });

  it("rejects duplicate or reordered invocation facts", () => {
    const source = snapshot();
    source.providerTransport!.invocations!.entries[1]!.sequence = 1;
    expectInconclusiveReason(source, "provider_event_conservation_mismatch");
  });

  it("rejects a tampered receipt digest", () => {
    const trace = project(snapshot())!;
    const receipt = structuredClone(trace.source.invocationReceipt!);
    receipt.sha256 = "0".repeat(64);
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(false);
  });

  it("accepts only the closed bounded receipt shape", () => {
    const receipt = structuredClone(project(snapshot())!.source.invocationReceipt!);
    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(false);
    expect(verifyAgentExecInvocationReceipt(JSON.stringify(receipt))).toBe(true);

    const extraTopLevel = { ...receipt, rawSnapshot: { privateValue: "redacted" } };
    expect(verifyAgentExecInvocationReceipt(extraTopLevel)).toBe(false);

    const extraNested = structuredClone(receipt) as typeof receipt & {
      invocations: Array<(typeof receipt.invocations)[number] & { requestBody?: string }>;
    };
    extraNested.invocations[0]!.requestBody = "redacted";
    expect(verifyAgentExecInvocationReceipt(extraNested)).toBe(false);

    const oversized = structuredClone(receipt);
    oversized.invocations = Array.from({ length: 129 }, (_, index) => ({
      ...receipt.invocations[0]!,
      sequence: index + 1,
      hopOrdinal: index + 1,
    }));
    oversized.modelFacingApiCalls = 129;
    expect(verifyAgentExecInvocationReceipt(oversized)).toBe(false);

    expect(() => verifyAgentExecInvocationReceipt(null)).not.toThrow();
    expect(verifyAgentExecInvocationReceipt(["not", "a", "receipt"])).toBe(false);
  });

  it("rejects sensitive-looking incomplete reasons before digest verification", () => {
    const source = snapshot();
    delete source.providerTransport!.invocations;
    const receipt = structuredClone(project(source)!.source.invocationReceipt!);
    receipt.incompleteReasons.push("<redacted-private-value>");

    expect(verifyAgentExecInvocationReceipt(receipt)).toBe(false);
  });

  it("rejects unresolved Code Mode bridge work", () => {
    const source = snapshot();
    source.codeMode!.lifecycle.attemptsWithUnresolved = 1;
    source.codeMode!.lifecycle.maxUnresolvedAtExtraction = 1;

    expectInconclusiveReason(source, "code_mode_unresolved_bridge_calls");
  });

  it("rejects Code Mode bridge lifecycle disagreement", () => {
    const source = snapshot();
    source.codeMode!.stats!.bridgeLifecycle.registered = 2;

    expectInconclusiveReason(source, "code_mode_bridge_lifecycle_conservation_mismatch");
  });

  it("rejects overlapping Code Mode failure and cancellation ledgers", () => {
    const source = snapshot();
    source.codeMode!.stats!.bridgeLifecycle.failed = 3;
    source.codeMode!.stats!.bridgeLifecycle.cancelRequested = 3;

    expectInconclusiveReason(source, "code_mode_bridge_lifecycle_conservation_mismatch");
  });

  it("requires explicit direct configuration before projecting zero bridge calls", () => {
    const source = snapshot();
    delete source.codeMode;
    const base = {
      snapshot: source,
      wallLatencyMs: 140,
      provider: PROVIDER,
      model: MODEL,
    } as const;

    expect(projectAgentExecTrace(base)?.projection.metrics.codeModeBridgeCalls).toEqual({
      state: "unavailable",
      reasons: ["code_mode_stats_not_observed"],
    });
    const directTrace = projectAgentExecTrace({ ...base, codeModeConfigured: false });
    expect(directTrace?.projection.metrics.codeModeBridgeCalls).toEqual({
      state: "exact",
      value: 0,
    });
    expect(directTrace?.audit).toEqual({ state: "valid" });
  });

  it("keeps the public result classifier unable to inject trace authority", () => {
    const result = {
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 110,
        agentMeta: {
          sessionId: "session-result",
          provider: PROVIDER,
          model: MODEL,
        },
      },
    };

    expect(classifyAgentExecResult(result)).not.toHaveProperty("trace");
  });
});

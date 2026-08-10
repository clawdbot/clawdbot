import { describe, expect, it } from "vitest";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportEvent,
  observeProviderTransportLogicalCallSettled,
  runWithProviderTransportAccountingObserver,
} from "./provider-transport-accounting.js";
import {
  ANTHROPIC_ROUTE,
  emitAttempt,
  emitConnection,
  emitProviderFallbackCoverage,
  emitServerFallback,
  emitTransportFallback,
  emitZeroSubmission,
  ROUTE,
  startCall,
} from "./provider-transport-accounting.test-support.js";

describe("provider transport accounting transitions", () => {
  it("accepts server fallback on a pending transport target and blocks zero-submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-target", ANTHROPIC_ROUTE);
      emitConnection({
        callId: "call-server-target",
        ordinal: 1,
        transport: "websocket",
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      observeProviderTransportEvent({
        type: "fallback",
        eventId: "anthropic-transport-fallback",
        callId: "call-server-target",
        provider: ANTHROPIC_ROUTE.provider,
        model: ANTHROPIC_ROUTE.model,
        api: ANTHROPIC_ROUTE.api,
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
      });
      emitServerFallback({
        callId: "call-server-target",
        transport: "sse",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
      observeProviderTransportEvent({
        type: "submission",
        eventId: "zero-after-server",
        callId: "call-server-target",
        provider: ANTHROPIC_ROUTE.provider,
        model: ANTHROPIC_ROUTE.model,
        api: ANTHROPIC_ROUTE.api,
        transport: "sse",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      });
      emitAttempt({
        callId: "call-server-target",
        ordinal: 1,
        reason: "transport_fallback",
        route: ANTHROPIC_ROUTE,
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-server-target", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial", reasons: expect.arrayContaining(["transport_event_conflict"]) },
      snapshot: {
        logicalCalls: { completed: 1, entries: [{ servingModel: "claude-opus-5" }] },
        providerFallbacks: { total: 1 },
        zeroSubmissions: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("reconciles settlement before matching attempt telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-first");
      observeProviderTransportLogicalCallSettled("call-settle-first", "completed");
      emitAttempt({ callId: "call-settle-first", ordinal: 1, outcome: "completed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps early completed settlement pending across a failed attempt and retry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-retry");
      observeProviderTransportLogicalCallSettled("call-settle-retry", "completed");
      emitAttempt({ callId: "call-settle-retry", ordinal: 1, outcome: "failed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "lower_bound" },
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId: "call-settle-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 2, retries: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps finalized completed settlement with only failed attempt evidence lower-bound", () => {
    const callId = "call-finalized-missing-completed-attempt";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      observeProviderTransportLogicalCallSettled(callId, "completed");
      emitAttempt({ callId, ordinal: 1, outcome: "failed" });
    });
    collector.finalize(callId);

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining([
          "transport_event_conflict",
          "transport_totals_lower_bound",
        ]),
      },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 1, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("keeps connection-only completed settlement missing terminal attempt evidence lower-bound", () => {
    const callId = "call-finalized-connection-only";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitConnection({
        callId,
        ordinal: 1,
        transport: "websocket",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled(callId, "completed");
    });
    collector.finalize(callId);

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        connections: { total: 1, totalKind: "exact" },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("uses failed zero-submission as the latest submission-failure fallback cause", () => {
    const callId = "call-zero-supersedes-stream-failure";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitAttempt({ callId, ordinal: 1, transport: "websocket", outcome: "failed" });
      emitZeroSubmission({ callId, transport: "websocket", outcome: "failed" });
      emitTransportFallback({
        callId,
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "submission_failure",
      });
      emitAttempt({
        callId,
        ordinal: 2,
        transport: "sse",
        reason: "transport_fallback",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled(callId, "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 2, transportFallbacks: 1, totalKind: "exact" },
        fallbacks: {
          total: 1,
          submissionFailures: 1,
          streamFailures: 0,
          totalKind: "exact",
        },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it("rejects stale stream failure after failed zero-submission supersedes it", () => {
    const callId = "call-stale-stream-after-zero";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitAttempt({ callId, ordinal: 1, transport: "websocket", outcome: "failed" });
      emitZeroSubmission({ callId, transport: "websocket", outcome: "failed" });
      emitTransportFallback({
        callId,
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "stream_failure",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_invalid_fact", "transport_totals_lower_bound"]),
      },
      snapshot: {
        attempts: { total: 1 },
        fallbacks: { total: 0, totalKind: "lower_bound" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps an early failed settlement open until later terminal retry telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-settle-retry");
      observeProviderTransportLogicalCallSettled("call-failed-settle-retry", "failed");
      emitAttempt({ callId: "call-failed-settle-retry", ordinal: 1, outcome: "failed" });
      emitAttempt({
        callId: "call-failed-settle-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 2, retries: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps failed attempt evidence open when settlement arrives before delayed retry telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-evidence-settle-retry");
      emitAttempt({
        callId: "call-failed-evidence-settle-retry",
        ordinal: 1,
        outcome: "failed",
      });
      observeProviderTransportLogicalCallSettled("call-failed-evidence-settle-retry", "failed");
      emitAttempt({
        callId: "call-failed-evidence-settle-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 2, retries: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps failed zero-submission evidence open when settlement precedes retry telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-zero-settle-retry");
      emitZeroSubmission({ callId: "call-failed-zero-settle-retry", outcome: "failed" });
      observeProviderTransportLogicalCallSettled("call-failed-zero-settle-retry", "failed");
      emitAttempt({
        callId: "call-failed-zero-settle-retry",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 1, retries: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it.each([
    {
      name: "failed attempt",
      emitEvidence: (callId: string) => emitAttempt({ callId, ordinal: 1, outcome: "failed" }),
      expected: {
        attempts: { total: 1, totalKind: "exact" },
        zeroSubmissions: { total: 0, totalKind: "exact" },
      },
    },
    {
      name: "failed zero-submission",
      emitEvidence: (callId: string) => emitZeroSubmission({ callId, outcome: "failed" }),
      expected: {
        attempts: { total: 0, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    },
  ])("finalizes terminal $name only at observation completion", ({ emitEvidence, expected }) => {
    const callId = "call-failed-observation-complete";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitEvidence(callId);
      observeProviderTransportLogicalCallSettled(callId, "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        attempts: { totalKind: "lower_bound" },
        events: { totalKind: "lower_bound" },
      },
    });

    collector.finalize(callId);
    collector.finalize(callId);

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "exact" },
        events: { total: 1, totalKind: "exact" },
        ...expected,
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId,
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        attempts: { total: expected.attempts.total, totalKind: "lower_bound" },
      },
    });
  });

  it("keeps a finalized call partial when a fallback target never reports terminal evidence", () => {
    const callId = "call-finalized-pending-fallback";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitAttempt({
        callId,
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId,
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "stream_failure",
      });
      observeProviderTransportLogicalCallSettled(callId, "failed");
    });

    collector.finalize(callId);
    collector.finalize(callId);

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "lower_bound" },
        fallbacks: { total: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "lower_bound" },
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId,
        ordinal: 2,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        attempts: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("keeps early completed settlement open across failed zero-submission and retry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-zero-retry");
      observeProviderTransportLogicalCallSettled("call-settle-zero-retry", "completed");
      emitZeroSubmission({ callId: "call-settle-zero-retry", outcome: "failed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { totalKind: "lower_bound" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId: "call-settle-zero-retry",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 1, retries: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it.each([
    {
      name: "attempt",
      lowerBoundKey: "attempts",
      emit: (callId: string) =>
        emitAttempt({
          callId,
          ordinal: 1,
          reason: "retry",
          outcome: "completed",
        }),
    },
    {
      name: "connection",
      lowerBoundKey: "connections",
      emit: (callId: string) =>
        emitConnection({
          callId,
          ordinal: 1,
          reason: "reconnect",
          outcome: "completed",
        }),
    },
    {
      name: "transport fallback",
      lowerBoundKey: "fallbacks",
      emit: (callId: string) =>
        emitTransportFallback({
          callId,
          fromTransport: ROUTE.transport,
          toTransport: "websocket",
          reason: "policy",
        }),
    },
    {
      name: "provider fallback",
      lowerBoundKey: "providerFallbacks",
      emit: (callId: string) =>
        emitServerFallback({
          callId,
          fromModel: ANTHROPIC_ROUTE.model,
          toModel: "claude-fable-5.1",
        }),
    },
    {
      name: "additional zero-submission",
      lowerBoundKey: "zeroSubmissions",
      emit: (callId: string) => emitZeroSubmission({ callId, outcome: "failed" }),
    },
    {
      name: "coverage",
      lowerBoundKey: "providerFallbacks",
      emit: (callId: string) => emitProviderFallbackCoverage({ callId }),
    },
  ] as const)("rejects $name after an aborted zero-submission", ({ emit, lowerBoundKey }) => {
    const callId = "call-aborted-zero-terminal";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitZeroSubmission({ callId, outcome: "aborted" });
      emit(callId);
      observeProviderTransportLogicalCallSettled(callId, "aborted");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { aborted: 1 },
        [lowerBoundKey]: { totalKind: "lower_bound" },
        zeroSubmissions: { total: 1, aborted: 1, failed: 0 },
      },
    });
  });

  it("keeps a failed zero-submission retryable", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-zero-retryable");
      emitZeroSubmission({ callId: "call-failed-zero-retryable", outcome: "failed" });
      emitAttempt({
        callId: "call-failed-zero-retryable",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-failed-zero-retryable", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 1, retries: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it("separates outcome uncertainty from known logical-call cardinality", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-outcome-conflict");
      emitAttempt({ callId: "call-outcome-conflict", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-outcome-conflict", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          total: 1,
          totalKind: "exact",
          outcomeKind: "lower_bound",
          failed: 1,
        },
        events: { totalKind: "exact" },
      },
    });
  });

  it("makes identical settlement idempotent and contradictory settlement outcome-only", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-idempotent");
      emitAttempt({ callId: "call-settle-idempotent", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "completed");
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "completed");
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          totalKind: "exact",
          outcomeKind: "lower_bound",
          completed: 1,
        },
        events: { totalKind: "exact" },
      },
    });
  });

  it("rejects new post-seal events without changing call or outcome certainty", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-post-seal");
      emitAttempt({ callId: "call-post-seal", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-post-seal", "completed");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "connection-after-seal",
        callId: "call-post-seal",
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "exact", completed: 1 },
        connections: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("accepts the planned PR6B pre-send OpenAI fallback contract fixture", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pr6b-pre");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "pr6b-ws-connection",
        callId: "call-pr6b-pre",
        provider: ROUTE.provider,
        model: ROUTE.model,
        api: ROUTE.api,
        transport: "native-codex-websocket",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-pr6b-pre",
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "connection_failure",
      });
      emitAttempt({
        callId: "call-pr6b-pre",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "native-codex-sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pr6b-pre", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: { attempts: { transportFallbacks: 1 }, logicalCalls: { completed: 1 } },
    });
  });

  it("accepts the planned PR6B post-send OpenAI fallback contract fixture", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pr6b-post");
      emitAttempt({
        callId: "call-pr6b-post",
        ordinal: 1,
        transport: "native-codex-websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-pr6b-post",
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "stream_failure",
      });
      emitAttempt({
        callId: "call-pr6b-post",
        ordinal: 2,
        reason: "transport_fallback",
        transport: "native-codex-sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pr6b-post", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: { attempts: { total: 2, transportFallbacks: 1 }, fallbacks: { streamFailures: 1 } },
    });
  });

  it("accepts the planned PR6C Anthropic retry and serving-transition contract fixture", () => {
    // The audited PR6C branch does not emit this planned restack contract yet.
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      const callId = "call-pr6c";
      startCall(callId, ANTHROPIC_ROUTE);
      emitAttempt({ callId, ordinal: 1, route: ANTHROPIC_ROUTE, outcome: "failed" });
      emitServerFallback({
        callId,
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
      });
      emitAttempt({
        callId,
        ordinal: 2,
        reason: "retry",
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled(callId, "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          entries: [{ model: "claude-fable-5", servingModel: "claude-opus-4-8" }],
        },
        attempts: { total: 2, retries: 1 },
        providerFallbacks: { total: 1, server: 1 },
      },
    });
  });
});

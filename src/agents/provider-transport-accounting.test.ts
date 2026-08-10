import { describe, expect, it } from "vitest";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportEvent,
  observeProviderTransportLogicalCallSettled,
  observeProviderTransportLogicalCallStarted,
  runWithProviderTransportAccountingObserver,
} from "./provider-transport-accounting.js";
import {
  ANTHROPIC_ROUTE,
  emitAttempt,
  emitProviderFallbackCoverage,
  emitTransportFallback,
  emitZeroSubmission,
  observeMalformedTransportEvent,
  ROUTE,
  startCall,
} from "./provider-transport-accounting.test-support.js";

describe("provider transport accounting", () => {
  it("retains repeated retry preflight zero-submissions while leaving the retry tail open", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-repeated");
      emitZeroSubmission({
        callId: "call-zero-repeated",
        eventId: "zero-repeated-1",
        outcome: "failed",
      });
      emitZeroSubmission({
        callId: "call-zero-repeated",
        eventId: "zero-repeated-2",
        outcome: "failed",
      });
      observeProviderTransportLogicalCallSettled("call-zero-repeated", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        zeroSubmissions: { total: 2, failed: 2, totalKind: "exact" },
        events: { total: 2, totalKind: "lower_bound" },
        logicalCalls: { failed: 1, outcomeKind: "exact" },
      },
    });
  });

  it("allows a later physical attempt after retry preflight failures", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-then-attempt");
      emitZeroSubmission({
        callId: "call-zero-then-attempt",
        eventId: "zero-before-attempt-1",
        outcome: "failed",
      });
      emitZeroSubmission({
        callId: "call-zero-then-attempt",
        eventId: "zero-before-attempt-2",
        outcome: "failed",
      });
      emitAttempt({
        callId: "call-zero-then-attempt",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-zero-then-attempt", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 1, retries: 1, totalKind: "exact" },
        zeroSubmissions: { total: 2, failed: 2, totalKind: "exact" },
        logicalCalls: { completed: 1, outcomeKind: "exact" },
      },
    });
  });

  it("isolates concurrent collectors", async () => {
    const first = createProviderTransportAccountingCollector();
    const second = createProviderTransportAccountingCollector();
    await Promise.all([
      runWithProviderTransportAccountingObserver(first.observer, async () => {
        startCall("call-first");
        await Promise.resolve();
        emitAttempt({ callId: "call-first", ordinal: 1, outcome: "completed" });
        observeProviderTransportLogicalCallSettled("call-first", "completed");
      }),
      runWithProviderTransportAccountingObserver(second.observer, async () => {
        startCall("call-second");
        await Promise.resolve();
        emitAttempt({ callId: "call-second", ordinal: 1, outcome: "completed" });
        observeProviderTransportLogicalCallSettled("call-second", "completed");
      }),
    ]);

    expect(first.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: { logicalCalls: { entries: [{ callId: "call-first" }] } },
    });
    expect(second.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: { logicalCalls: { entries: [{ callId: "call-second" }] } },
    });
  });

  it("keeps run prewarm, connection, and attempts separate", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      observeProviderTransportEvent({
        type: "connection",
        eventId: "prewarm-1",
        ...ROUTE,
        ordinal: 1,
        reason: "prewarm",
        outcome: "completed",
      });
      startCall("call-taxonomy");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "connection-1",
        callId: "call-taxonomy",
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      emitAttempt({ callId: "call-taxonomy", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-taxonomy", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 1, initial: 1, retries: 0, transportFallbacks: 0 },
        connections: { total: 2, initial: 1, prewarms: 1, reconnects: 0 },
      },
    });
  });

  it("accepts a call-less prewarm event", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      observeProviderTransportEvent({
        type: "connection",
        eventId: "prewarm-call-less",
        ...ROUTE,
        ordinal: 1,
        reason: "prewarm",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        connections: { total: 1, prewarms: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "exact" },
      },
    });
  });

  it("rejects a fallback without callId as uncorrelated", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      observeMalformedTransportEvent({
        type: "fallback",
        eventId: "fallback-missing-call",
        provider: ROUTE.provider,
        model: ROUTE.model,
        api: ROUTE.api,
        fromTransport: ROUTE.transport,
        toTransport: "sse",
        reason: "policy",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_uncorrelated_event"]),
      },
      snapshot: {
        logicalCalls: { total: 0, totalKind: "lower_bound" },
        fallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("accepts a correlated fallback event", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-correlated-fallback");
      emitAttempt({ callId: "call-correlated-fallback", ordinal: 1, outcome: "failed" });
      emitTransportFallback({
        callId: "call-correlated-fallback",
        fromTransport: ROUTE.transport,
        toTransport: "sse",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        attempts: { total: 1, totalKind: "lower_bound" },
        fallbacks: { total: 1, policy: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "exact" },
      },
    });
  });

  it("lowers every transport total when a logical call has no accepted call event", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-unobserved");
      observeProviderTransportLogicalCallSettled("call-unobserved", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["not_instrumented"]),
      },
      snapshot: {
        logicalCalls: {
          completed: 1,
          outcomeKind: "exact",
          entries: [{ outcome: "completed", cachedInput: { state: "unknown" } }],
        },
        attempts: { total: 0, totalKind: "lower_bound" },
        connections: { total: 0, totalKind: "lower_bound" },
        fallbacks: { total: 0, totalKind: "lower_bound" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        zeroSubmissions: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers every transport total when any logical call lacks accepted call evidence", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-instrumented");
      emitAttempt({ callId: "call-instrumented", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-instrumented", "completed");
      startCall("call-uninstrumented");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial", reasons: expect.arrayContaining(["not_instrumented"]) },
      snapshot: {
        logicalCalls: { total: 2, completed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 1, totalKind: "lower_bound" },
        connections: { totalKind: "lower_bound" },
        fallbacks: { totalKind: "lower_bound" },
        providerFallbacks: { totalKind: "lower_bound" },
        zeroSubmissions: { totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("does not let run-scoped prewarm satisfy call transport instrumentation", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      observeProviderTransportEvent({
        type: "connection",
        eventId: "prewarm-before-unobserved-call",
        ...ROUTE,
        ordinal: 1,
        reason: "prewarm",
        outcome: "completed",
      });
      startCall("call-after-prewarm");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial", reasons: expect.arrayContaining(["not_instrumented"]) },
      snapshot: {
        attempts: { totalKind: "lower_bound" },
        connections: { total: 1, prewarms: 1, totalKind: "lower_bound" },
        fallbacks: { totalKind: "lower_bound" },
        providerFallbacks: { totalKind: "lower_bound" },
        zeroSubmissions: { totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("binds the first concrete connection without inventing submission evidence", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-connection-bind");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "connection-bind",
        callId: "call-connection-bind",
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_logical_call_incomplete"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [
            {
              callId: "call-connection-bind",
              transport: "http",
            },
          ],
        },
        attempts: { total: 0, totalKind: "lower_bound" },
        connections: { total: 1, totalKind: "exact" },
      },
    });
    expect(collector.project().snapshot?.logicalCalls.entries[0]).not.toHaveProperty(
      "servingModel",
    );
  });

  it("does not bind transport from a rejected connection fact", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-rejected-connection");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "connection-bad-ordinal",
        callId: "call-rejected-connection",
        ...ROUTE,
        transport: "websocket",
        ordinal: 2,
        reason: "initial",
        outcome: "completed",
      });
      emitAttempt({
        callId: "call-rejected-connection",
        ordinal: 1,
        transport: "http",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-rejected-connection", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_invalid_ordinal"]),
      },
      snapshot: {
        logicalCalls: { entries: [{ transport: "http", outcome: "completed" }] },
        attempts: { total: 1, totalKind: "exact" },
        connections: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("does not fabricate route facts for an uninstrumented pre-egress failure", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-no-route");
      observeProviderTransportLogicalCallSettled("call-no-route", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["not_instrumented"]),
      },
      snapshot: {
        logicalCalls: {
          total: 1,
          totalKind: "exact",
          outcomeKind: "exact",
          completed: 0,
          failed: 1,
          aborted: 0,
          entries: [{ outcome: "failed", cachedInput: { state: "unknown" } }],
        },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
    expect(collector.project().snapshot?.logicalCalls.entries[0]).not.toHaveProperty("transport");
    expect(collector.project().snapshot?.logicalCalls.entries[0]).not.toHaveProperty(
      "servingModel",
    );
  });

  it("retains ordered per-call cached-input authority without inferring normalized zeros", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-cache-exact");
      observeProviderTransportLogicalCallSettled("call-cache-exact", "completed", {
        state: "exact",
        tokens: 0,
      });
      startCall("call-cache-unknown");
      observeProviderTransportLogicalCallSettled("call-cache-unknown", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          completed: 1,
          failed: 1,
          outcomeKind: "exact",
          entries: [
            {
              callId: "call-cache-exact",
              outcome: "completed",
              cachedInput: { state: "exact", tokens: 0 },
            },
            {
              callId: "call-cache-unknown",
              outcome: "failed",
              cachedInput: { state: "unknown" },
            },
          ],
        },
      },
    });
  });

  it("lowers call and event totals for a missing raw call id", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      observeMalformedTransportEvent({
        type: "attempt",
        eventId: "attempt-missing",
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "unavailable" },
      snapshot: {
        logicalCalls: { total: 0, totalKind: "lower_bound", outcomeKind: "lower_bound" },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it.each([
    ["overflow", "x".repeat(257)],
    ["unknown", "missing-call"],
  ] as const)("lowers call and event totals for a %s raw call id", (_name, callId) => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      observeProviderTransportEvent({
        type: "attempt",
        eventId: `attempt-${_name}`,
        callId,
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "unavailable" },
      snapshot: {
        logicalCalls: { total: 0, totalKind: "lower_bound", outcomeKind: "lower_bound" },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers only event totals for a tracked rejected event", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-invalid-event");
      observeMalformedTransportEvent({
        type: "attempt",
        eventId: "invalid-reason",
        callId: "call-invalid-event",
        ...ROUTE,
        ordinal: 1,
        reason: "unexpected",
        outcome: "failed",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "lower_bound" },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("rejects a malformed correlated prewarm event", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-prewarm");
      observeMalformedTransportEvent({
        type: "connection",
        eventId: "prewarm-correlated",
        callId: "call-prewarm",
        ...ROUTE,
        ordinal: 1,
        reason: "prewarm",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "lower_bound" },
        connections: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers call and outcome certainty for a conflicting start", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-start-conflict");
      observeProviderTransportLogicalCallStarted({
        callId: "call-start-conflict",
        provider: ROUTE.provider,
        model: "different-model",
        api: ROUTE.api,
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { total: 1, totalKind: "lower_bound", outcomeKind: "lower_bound" },
        events: { totalKind: "lower_bound" },
      },
    });
  });

  it("keeps settlement correlation failures out of event totals", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      observeProviderTransportLogicalCallSettled("missing-call", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "lower_bound", outcomeKind: "lower_bound" },
        events: { total: 0, totalKind: "exact" },
      },
    });
  });

  it("treats an exact event duplicate as invisible after settlement", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-duplicate");
      emitAttempt({
        callId: "call-duplicate",
        ordinal: 1,
        outcome: "completed",
        eventId: "attempt-duplicate",
      });
      observeProviderTransportLogicalCallSettled("call-duplicate", "completed");
      emitAttempt({
        callId: "call-duplicate",
        ordinal: 1,
        outcome: "completed",
        eventId: "attempt-duplicate",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: { attempts: { total: 1 }, events: { total: 1 } },
    });
  });

  it("accepts a valid replay after a rejected fact without reserving its event id", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-rejected-id-replay", ANTHROPIC_ROUTE);
      emitProviderFallbackCoverage({
        callId: "call-rejected-id-replay",
        eventId: "replayed-event-id",
      });
      emitAttempt({
        callId: "call-rejected-id-replay",
        ordinal: 1,
        outcome: "completed",
        route: ANTHROPIC_ROUTE,
        eventId: "replayed-event-id",
      });
      emitAttempt({
        callId: "call-rejected-id-replay",
        ordinal: 1,
        outcome: "completed",
        route: ANTHROPIC_ROUTE,
        eventId: "replayed-event-id",
      });
      observeProviderTransportLogicalCallSettled("call-rejected-id-replay", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { total: 1, completed: 1 },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("scopes repeated public call and event ids to finalized lifecycles", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-reused-lifecycle");
      startCall("call-reused-lifecycle");
      emitAttempt({
        callId: "call-reused-lifecycle",
        ordinal: 1,
        outcome: "completed",
        eventId: "shared-lifecycle-event",
      });
      observeProviderTransportLogicalCallSettled("call-reused-lifecycle", "completed");
      startCall("call-reused-lifecycle");
      collector.finalize("call-reused-lifecycle");

      startCall("call-reused-lifecycle");
      emitAttempt({
        callId: "call-reused-lifecycle",
        ordinal: 1,
        outcome: "completed",
        eventId: "shared-lifecycle-event",
      });
      observeProviderTransportLogicalCallSettled("call-reused-lifecycle", "completed");
      collector.finalize("call-reused-lifecycle");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 2,
          completed: 2,
          entries: [
            { callId: "call-reused-lifecycle", outcome: "completed" },
            { callId: "call-reused-lifecycle", outcome: "completed" },
          ],
        },
        attempts: { total: 2, initial: 2, totalKind: "exact" },
        events: { total: 2, totalKind: "exact" },
      },
    });
  });

  it("lowers only event totals for a conflicting duplicate", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-duplicate-conflict");
      emitAttempt({
        callId: "call-duplicate-conflict",
        ordinal: 1,
        outcome: "failed",
        eventId: "attempt-conflict",
      });
      emitAttempt({
        callId: "call-duplicate-conflict",
        ordinal: 1,
        outcome: "completed",
        eventId: "attempt-conflict",
      });
      observeProviderTransportLogicalCallSettled("call-duplicate-conflict", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "exact", failed: 1 },
        attempts: { total: 1, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers both event aggregates for a cross-type event id collision", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-cross-type-id");
      emitAttempt({
        callId: "call-cross-type-id",
        ordinal: 1,
        outcome: "failed",
        eventId: "shared-event-id",
      });
      emitTransportFallback({
        callId: "call-cross-type-id",
        fromTransport: ROUTE.transport,
        toTransport: "sse",
        eventId: "shared-event-id",
      });
      observeProviderTransportLogicalCallSettled("call-cross-type-id", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "lower_bound" },
        fallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers event totals when retained overflow calls have no accepted events", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      for (let index = 0; index < 65; index += 1) {
        startCall(`call-${String(index)}`);
      }
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          total: 64,
          totalKind: "lower_bound",
          outcomeKind: "lower_bound",
          entriesTruncated: true,
        },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("truncates event details without lowering 129 accepted event totals", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-event-details");
      for (let ordinal = 1; ordinal <= 129; ordinal += 1) {
        emitAttempt({
          callId: "call-event-details",
          ordinal,
          reason: ordinal === 1 ? "initial" : "retry",
          outcome: ordinal === 129 ? "completed" : "failed",
          eventId: `event-detail-${String(ordinal)}`,
        });
      }
      observeProviderTransportLogicalCallSettled("call-event-details", "completed");
    });

    const projection = collector.project();
    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_details_truncated"]),
      },
      snapshot: {
        attempts: {
          total: 129,
          totalKind: "exact",
          initial: 1,
          retries: 128,
          authRecoveries: 0,
          payloadRecoveries: 0,
          transportFallbacks: 0,
        },
        events: {
          total: 129,
          totalKind: "exact",
          entriesTruncated: true,
        },
      },
    });
    expect(projection.snapshot?.events.entries).toHaveLength(128);
  });

  it("bounds event identities without lowering retained call outcomes", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-event-identities");
      for (let ordinal = 1; ordinal <= 257; ordinal += 1) {
        emitAttempt({
          callId: "call-event-identities",
          ordinal,
          reason: ordinal === 1 ? "initial" : "retry",
          outcome: "failed",
          eventId: `event-identity-${String(ordinal)}`,
        });
      }
      observeProviderTransportLogicalCallSettled("call-event-identities", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "exact", failed: 1 },
        attempts: { total: 256, totalKind: "lower_bound" },
        events: { total: 256, totalKind: "lower_bound", entriesTruncated: true },
      },
    });
  });
});

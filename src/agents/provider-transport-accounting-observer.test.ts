import { describe, expect, it, vi } from "vitest";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportEvent,
  observeProviderTransportLogicalCallFinalized,
  observeProviderTransportLogicalCallSettled,
  observeProviderTransportLogicalCallStarted,
  runWithProviderTransportAccountingObserver,
  type ProviderTransportAccountingObserver,
} from "./provider-transport-accounting.js";
import { emitAttempt, ROUTE, startCall } from "./provider-transport-accounting.test-support.js";

function createThrowingObserver(
  onObservationFailure: ProviderTransportAccountingObserver["onObservationFailure"],
): ProviderTransportAccountingObserver {
  return {
    onObservationFailure,
    onLogicalCallStarted() {
      throw new Error("start failed");
    },
    onLogicalCallSettled() {
      throw new Error("settle failed");
    },
    onLogicalCallFinalized() {
      throw new Error("finalize failed");
    },
    onTransportEvent() {
      throw new Error("event failed");
    },
  };
}

describe("provider transport accounting observer", () => {
  it("is a no-op without an active observer", () => {
    expect(() => {
      observeProviderTransportLogicalCallStarted({
        callId: "call-none",
        provider: ROUTE.provider,
        model: ROUTE.model,
        api: ROUTE.api,
      });
      observeProviderTransportEvent({
        type: "attempt",
        eventId: "attempt-none",
        callId: "call-none",
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-none", "completed");
      observeProviderTransportLogicalCallFinalized("call-none");
    }).not.toThrow();
  });

  it("reports each failing observation without changing provider behavior", () => {
    const onObservationFailure =
      vi.fn<ProviderTransportAccountingObserver["onObservationFailure"]>();
    const observer = createThrowingObserver(onObservationFailure);

    expect(() =>
      runWithProviderTransportAccountingObserver(observer, () => {
        startCall("call-throws");
        emitAttempt({ callId: "call-throws", ordinal: 1, outcome: "completed" });
        observeProviderTransportLogicalCallSettled("call-throws", "completed");
        observeProviderTransportLogicalCallFinalized("call-throws");
      }),
    ).not.toThrow();
    expect(onObservationFailure.mock.calls).toEqual([
      ["logical_call_started"],
      ["transport_event"],
      ["logical_call_settled"],
      ["logical_call_finalized"],
    ]);
  });

  it("contains failure-reporter exceptions", () => {
    const observer = createThrowingObserver(() => {
      throw new Error("reporter failed");
    });

    expect(() =>
      runWithProviderTransportAccountingObserver(observer, () => {
        startCall("call-reporter-throws");
        emitAttempt({ callId: "call-reporter-throws", ordinal: 1, outcome: "completed" });
        observeProviderTransportLogicalCallSettled("call-reporter-throws", "completed");
        observeProviderTransportLogicalCallFinalized("call-reporter-throws");
      }),
    ).not.toThrow();
  });

  it("lowers every total after a partially applied observer mutation", () => {
    const collector = createProviderTransportAccountingCollector();
    const observer: ProviderTransportAccountingObserver = {
      ...collector.observer,
      onTransportEvent(event) {
        collector.observer.onTransportEvent(event);
        throw new Error("failed after mutation");
      },
    };

    runWithProviderTransportAccountingObserver(observer, () => {
      startCall("call-partial");
      emitAttempt({ callId: "call-partial", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-partial", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining([
          "transport_observer_failed",
          "transport_totals_lower_bound",
          "transport_outcomes_lower_bound",
        ]),
      },
      snapshot: {
        logicalCalls: {
          completed: 1,
          totalKind: "lower_bound",
          outcomeKind: "lower_bound",
        },
        attempts: { total: 1, totalKind: "lower_bound" },
        connections: { totalKind: "lower_bound" },
        fallbacks: { totalKind: "lower_bound" },
        providerFallbacks: { totalKind: "lower_bound" },
        zeroSubmissions: { totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("keeps healthy accounting complete", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-healthy");
      emitAttempt({ callId: "call-healthy", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-healthy", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "exact" },
        attempts: { totalKind: "exact" },
        events: { totalKind: "exact" },
      },
    });
  });
});

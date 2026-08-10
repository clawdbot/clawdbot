import { describe, expect, it } from "vitest";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportLogicalCallFinalized,
  observeProviderTransportLogicalCallSettled,
  runWithProviderTransportAccountingObserver,
} from "./provider-transport-accounting.js";
import {
  emitAttempt,
  emitInvocation,
  startCall,
} from "./provider-transport-accounting.test-support.js";

function projectInvalidInvocation(
  emit: (callId: string) => void,
  callId = "call-invalid-invocation",
) {
  const collector = createProviderTransportAccountingCollector();
  runWithProviderTransportAccountingObserver(collector.observer, () => {
    startCall(callId);
    emit(callId);
  });
  return collector.project();
}

describe("provider transport invocation accounting", () => {
  it("binds redirect hops and retries to their exact owning attempts", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-redirect-retry");
      emitInvocation({
        callId: "call-redirect-retry",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
      });
      emitInvocation({
        callId: "call-redirect-retry",
        ordinal: 2,
        attemptOrdinal: 1,
        hopOrdinal: 2,
      });
      emitAttempt({ callId: "call-redirect-retry", ordinal: 1, outcome: "failed" });
      emitInvocation({
        callId: "call-redirect-retry",
        ordinal: 3,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "retry",
      });
      emitAttempt({
        callId: "call-redirect-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-redirect-retry", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 2, totalKind: "exact" },
        invocations: {
          total: 3,
          totalKind: "exact",
          entries: [
            { attemptOrdinal: 1, hopOrdinal: 1, reason: "initial" },
            { attemptOrdinal: 1, hopOrdinal: 2, reason: "initial" },
            { attemptOrdinal: 2, hopOrdinal: 1, reason: "retry" },
          ],
        },
      },
    });
  });

  it("rejects an invocation for the wrong attempt ordinal", () => {
    const projection = projectInvalidInvocation((callId) => {
      emitInvocation({ callId, ordinal: 1, attemptOrdinal: 2, hopOrdinal: 1 });
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_invocation_relation_invalid"]),
      },
      snapshot: { invocations: { total: 0, totalKind: "lower_bound" } },
    });
  });

  it.each([
    { label: "gap", hops: [1, 3] },
    { label: "duplicate", hops: [1, 1] },
    { label: "reorder", hops: [2] },
  ])("rejects an invocation hop $label", ({ hops }) => {
    const projection = projectInvalidInvocation((callId) => {
      for (const [index, hopOrdinal] of hops.entries()) {
        emitInvocation({
          callId,
          ordinal: index + 1,
          attemptOrdinal: 1,
          hopOrdinal,
          eventId: `invocation-hop-${String(index + 1)}`,
        });
      }
    });

    expect(projection).toMatchObject({
      coverage: {
        state: hops[0] === 1 ? "partial" : "unavailable",
        reasons: expect.arrayContaining(["transport_invocation_relation_invalid"]),
      },
      snapshot: { invocations: { total: hops[0] === 1 ? 1 : 0, totalKind: "lower_bound" } },
    });
  });

  it("rejects an invocation reason that cannot own the attempt", () => {
    const projection = projectInvalidInvocation((callId) => {
      emitInvocation({
        callId,
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "retry",
      });
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_invocation_relation_invalid"]),
      },
      snapshot: { invocations: { total: 0, totalKind: "lower_bound" } },
    });
  });

  it("rejects an attempt reason that contradicts its invocation group", () => {
    const projection = projectInvalidInvocation((callId) => {
      emitInvocation({ callId, ordinal: 1, attemptOrdinal: 1, hopOrdinal: 1 });
      emitAttempt({
        callId,
        ordinal: 1,
        reason: "auth_recovery",
        outcome: "completed",
      });
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_invocation_relation_invalid"]),
      },
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        invocations: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("marks an observed invocation group incomplete when its attempt is missing", () => {
    const projection = projectInvalidInvocation((callId) => {
      emitInvocation({ callId, ordinal: 1, attemptOrdinal: 1, hopOrdinal: 1 });
      observeProviderTransportLogicalCallFinalized(callId);
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_invocation_relation_incomplete"]),
      },
      snapshot: { invocations: { total: 1, totalKind: "lower_bound" } },
    });
  });

  it("keeps invocation groups isolated when a call ID is reused", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      for (const outcome of ["failed", "completed"] as const) {
        startCall("call-reused");
        emitInvocation({
          callId: "call-reused",
          ordinal: 1,
          attemptOrdinal: 1,
          hopOrdinal: 1,
          eventId: `invocation-reused-${outcome}`,
        });
        emitAttempt({
          callId: "call-reused",
          ordinal: 1,
          outcome,
          eventId: `attempt-reused-${outcome}`,
        });
        observeProviderTransportLogicalCallSettled("call-reused", outcome);
        observeProviderTransportLogicalCallFinalized("call-reused");
      }
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_lifecycle_ambiguous"]),
      },
      snapshot: {
        logicalCalls: { total: 2, totalKind: "exact", outcomeKind: "lower_bound" },
        attempts: { total: 2, totalKind: "lower_bound" },
        invocations: {
          total: 2,
          totalKind: "lower_bound",
          entries: [
            { logicalCallOrdinal: 1, attemptOrdinal: 1, hopOrdinal: 1 },
            { logicalCallOrdinal: 2, attemptOrdinal: 1, hopOrdinal: 1 },
          ],
        },
        connections: { totalKind: "lower_bound" },
        fallbacks: { totalKind: "lower_bound" },
        providerFallbacks: { totalKind: "lower_bound" },
        zeroSubmissions: { totalKind: "lower_bound" },
        events: { total: 4, totalKind: "lower_bound" },
      },
    });
  });

  it("does not let a later exact invocation hide an earlier missing invocation", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-mixed-dispatch");
      emitAttempt({ callId: "call-mixed-dispatch", ordinal: 1, outcome: "failed" });
      emitInvocation({
        callId: "call-mixed-dispatch",
        ordinal: 1,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "retry",
      });
      emitAttempt({
        callId: "call-mixed-dispatch",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-mixed-dispatch", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_invocation_relation_incomplete"]),
      },
      snapshot: {
        attempts: { total: 2, totalKind: "exact" },
        invocations: { total: 1, totalKind: "lower_bound" },
      },
    });
  });
});

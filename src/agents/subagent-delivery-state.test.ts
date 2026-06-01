import { describe, expect, it } from "vitest";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { LegacySubagentRunRecord } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function baseRun(overrides: Partial<LegacySubagentRunRecord> = {}): LegacySubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:parent",
    requesterDisplayKey: "agent:main:parent",
    controllerSessionKey: "agent:main:parent",
    task: "inspect",
    cleanup: "keep",
    spawnMode: "run",
    createdAt: 100,
    startedAt: 100,
    expectsCompletionMessage: true,
    ...overrides,
  };
}

describe("normalizeSubagentRunState", () => {
  it("migrates legacy pending delivery fields into nested completion and delivery state", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        frozenResultText: "child output",
        frozenResultCapturedAt: 200,
        pendingFinalDelivery: true,
        pendingFinalDeliveryCreatedAt: 210,
        pendingFinalDeliveryLastAttemptAt: 220,
        pendingFinalDeliveryAttemptCount: 3,
        pendingFinalDeliveryLastError: "sink unavailable",
        pendingFinalDeliveryPayload: {
          requesterSessionKey: "agent:main:parent",
          requesterDisplayKey: "agent:main:parent",
          childSessionKey: "agent:main:subagent:child",
          childRunId: "run-1",
          task: "inspect",
          startedAt: 100,
          expectsCompletionMessage: true,
          frozenResultText: "child output",
        },
      }),
    ) as SubagentRunRecord & { pendingFinalDelivery?: boolean; frozenResultText?: string };

    expect(entry.completion).toMatchObject({
      required: true,
      resultText: "child output",
      capturedAt: 200,
    });
    expect(entry.delivery).toMatchObject({
      status: "pending",
      createdAt: 210,
      lastAttemptAt: 220,
      attemptCount: 3,
      lastError: "sink unavailable",
      payload: expect.objectContaining({ childRunId: "run-1" }),
    });
    expect(entry.pendingFinalDelivery).toBeUndefined();
    expect(entry.frozenResultText).toBeUndefined();
  });

  it("merges partial nested state with legacy fields before stripping legacy fields", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        completion: { required: true },
        delivery: { status: "not_required" },
        pendingFinalDelivery: true,
        pendingFinalDeliveryAttemptCount: 2,
        lastAnnounceRetryAt: 240,
        frozenResultText: "legacy result",
      }),
    ) as SubagentRunRecord & { pendingFinalDelivery?: boolean; lastAnnounceRetryAt?: number };

    expect(entry.completion?.resultText).toBe("legacy result");
    expect(entry.delivery).toMatchObject({
      status: "pending",
      attemptCount: 2,
      lastAttemptAt: 240,
    });
    expect(entry.pendingFinalDelivery).toBeUndefined();
    expect(entry.lastAnnounceRetryAt).toBeUndefined();
  });

  it("migrates in-progress handoff leases to steering leases", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        cleanupHandled: true,
        delivery: {
          status: "in_progress",
          payload: {
            requesterSessionKey: "agent:main:parent",
            requesterDisplayKey: "agent:main:parent",
            childSessionKey: "agent:main:subagent:child",
            childRunId: "run-1",
            task: "inspect",
          },
          handoffLeaseId: "lease-1",
          handoffLeasedAt: 300,
        },
      } as Partial<LegacySubagentRunRecord>),
    ) as SubagentRunRecord & { delivery?: { handoffLeaseId?: string } };

    expect(entry.delivery).toMatchObject({
      status: "in_progress",
      steeringLeaseId: "lease-1",
      steeringLeasedAt: 300,
    });
    expect(entry.delivery?.handoffLeaseId).toBeUndefined();
    expect(entry.cleanupHandled).toBe(false);
  });

  it("clears stale cleanupHandled locks for unfinished restored cleanup", () => {
    const entry = normalizeSubagentRunState(baseRun({ cleanupHandled: true }));

    expect(entry.cleanupHandled).toBe(false);
  });

  it("clears stale cleanupHandled locks after delivered notification if cleanup did not finish", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        cleanupHandled: true,
        delivery: {
          status: "delivered",
          announcedAt: 400,
        },
      }),
    );

    expect(entry.cleanupHandled).toBe(false);
  });

  it("keeps discarded terminal delivery dormant across restart", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        cleanupHandled: true,
        delivery: {
          status: "discarded",
          discardedAt: 400,
          discardReason: "expired",
        },
      }),
    );

    expect(entry.cleanupHandled).toBe(true);
  });
});

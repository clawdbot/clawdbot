import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import { finishFlow } from "../../tasks/task-flow-registry.js";
import {
  consumePendingDelegates,
  enqueuePendingDelegate,
  markPendingDelegateFailed,
  peekSoonestUnmaturedDelegateDueAt,
  pendingDelegateCount,
} from "./delegate-store.js";

type MockFlow = {
  flowId: string;
  ownerKey: string;
  status: string;
  revision: number;
};

export function registerDelegateStoreConsumptionSuite(params: {
  mockFlows: ReadonlyMap<string, MockFlow>;
  loggerRecords: Array<{ level: string; message: string }>;
}): void {
  const { loggerRecords, mockFlows } = params;
  describe("consumePendingDelegates — delayMs gating", () => {
    it("leaves an unmatured delegate (delayMs in the future) in queued state", () => {
      enqueuePendingDelegate("session-1", { task: "future", delayMs: 60_000 });

      const matured = consumePendingDelegates("session-1");
      expect(matured).toEqual([]);
      expect(pendingDelegateCount("session-1")).toBe(1);
    });

    it("drains a matured delegate (delayMs elapsed)", () => {
      enqueuePendingDelegate("session-1", { task: "due", delayMs: 0 });

      const matured = consumePendingDelegates("session-1");
      expect(matured).toHaveLength(1);
      expect(expectDefined(matured.at(0), "matured delegate").task).toBe("due");
      expect(pendingDelegateCount("session-1")).toBe(0);
    });

    it("drains matured entries and re-parks unmatured entries in the same call", () => {
      enqueuePendingDelegate("session-1", { task: "due", delayMs: 0 });
      enqueuePendingDelegate("session-1", { task: "future", delayMs: 60_000 });

      const matured = consumePendingDelegates("session-1");
      expect(matured.map((delegate) => delegate.task)).toEqual(["due"]);
      expect(pendingDelegateCount("session-1")).toBe(1);
    });

    it("treats omitted delayMs as zero (matures immediately, preserves legacy behavior)", () => {
      enqueuePendingDelegate("session-1", { task: "no-delay" });

      const matured = consumePendingDelegates("session-1");
      expect(matured).toHaveLength(1);
      expect(expectDefined(matured.at(0), "matured delegate").task).toBe("no-delay");
    });
  });

  describe("peekSoonestUnmaturedDelegateDueAt", () => {
    it("returns undefined when no entries are queued", () => {
      expect(peekSoonestUnmaturedDelegateDueAt("empty")).toBeUndefined();
    });

    describe("markPendingDelegateFailed", () => {
      beforeEach(() => {
        loggerRecords.length = 0;
      });

      it("emits a breadcrumb instead of silently dropping delegates missing flow metadata", () => {
        markPendingDelegateFailed({ task: "missing metadata" }, "rejected");

        const warnings = loggerRecords.filter(
          (record) =>
            record.level === "warn" &&
            record.message.includes("[continuation:delegate-fail-missing-flow]"),
        );
        expect(warnings).toHaveLength(1);
      });
    });

    it("returns undefined when all queued entries are already due", () => {
      enqueuePendingDelegate("session-1", { task: "due", delayMs: 0 });
      expect(peekSoonestUnmaturedDelegateDueAt("session-1")).toBeUndefined();
    });

    it("returns the soonest dueAt across multiple unmatured entries", () => {
      const before = Date.now();
      enqueuePendingDelegate("session-1", { task: "far", delayMs: 120_000 });
      enqueuePendingDelegate("session-1", { task: "near", delayMs: 30_000 });
      enqueuePendingDelegate("session-1", { task: "mid", delayMs: 60_000 });

      const soonest = peekSoonestUnmaturedDelegateDueAt("session-1");
      expect(soonest).toBeDefined();
      expect(soonest!).toBeGreaterThanOrEqual(before + 30_000);
      expect(soonest!).toBeLessThan(before + 30_000 + 5_000);
    });
  });

  describe("consumePendingDelegates — concurrent-consumer race contract", () => {
    it("sequential consumers: second call sees flow already drained, returns empty", () => {
      enqueuePendingDelegate("session-1", { task: "single" });

      const first = consumePendingDelegates("session-1");
      expect(first).toHaveLength(1);
      expect(expectDefined(first.at(0), "delegate").task).toBe("single");
      expect(consumePendingDelegates("session-1")).toHaveLength(0);
    });

    it("interleaved consumers: only one wins per delegate revision", () => {
      enqueuePendingDelegate("session-1", { task: "raced" });
      const queuedBefore = [...mockFlows.values()].filter(
        (flow) => flow.ownerKey === "session-1" && flow.status === "queued",
      );
      expect(queuedBefore).toHaveLength(1);
      const queuedDelegate = expectDefined(queuedBefore.at(0), "queued delegate");
      const sharedRevision = queuedDelegate.revision;
      const flowId = queuedDelegate.flowId;

      const aResult = finishFlow({
        flowId,
        expectedRevision: sharedRevision,
        currentStep: "Released to continuation scheduler (consumer A)",
        stateJson: { releasedBy: "A" },
      });
      const bResult = finishFlow({
        flowId,
        expectedRevision: sharedRevision,
        currentStep: "Released to continuation scheduler (consumer B)",
        stateJson: { releasedBy: "B" },
      });

      const winners = [aResult, bResult].filter((result) => result.applied);
      const losers = [aResult, bResult].filter((result) => !result.applied);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.reason).toBe("revision_conflict");
      expect(mockFlows.get(flowId)?.status).toBe("succeeded");
      expect(mockFlows.get(flowId)?.revision).toBe(sharedRevision + 1);
    });

    it("two real consume calls release each queued delegate only once", () => {
      enqueuePendingDelegate("session-1", { task: "first" });
      enqueuePendingDelegate("session-1", { task: "second" });
      enqueuePendingDelegate("session-1", { task: "third" });

      const first = consumePendingDelegates("session-1");
      expect(first.map((delegate) => delegate.task)).toEqual(["first", "second", "third"]);
      expect(consumePendingDelegates("session-1")).toHaveLength(0);
    });

    it("interleaved consumers across multiple flows release each flow exactly once", () => {
      enqueuePendingDelegate("session-1", { task: "A" });
      enqueuePendingDelegate("session-1", { task: "B" });
      enqueuePendingDelegate("session-1", { task: "C" });

      const queuedBefore = [...mockFlows.values()]
        .filter((flow) => flow.ownerKey === "session-1" && flow.status === "queued")
        .map((flow) => ({ flowId: flow.flowId, capturedRevision: flow.revision }));
      expect(queuedBefore).toHaveLength(3);

      const results = queuedBefore.map((flow) => [
        finishFlow({
          flowId: flow.flowId,
          expectedRevision: flow.capturedRevision,
          currentStep: "consumer A",
        }),
        finishFlow({
          flowId: flow.flowId,
          expectedRevision: flow.capturedRevision,
          currentStep: "consumer B",
        }),
      ]);

      for (const pair of results) {
        const winners = pair.filter((result) => result.applied);
        const losers = pair.filter((result) => !result.applied);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0]?.reason).toBe("revision_conflict");
      }
      const finalized = [...mockFlows.values()].filter((flow) => flow.ownerKey === "session-1");
      expect(finalized.every((flow) => flow.status === "succeeded")).toBe(true);
    });
  });
}

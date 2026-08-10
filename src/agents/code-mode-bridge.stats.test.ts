import { describe, expect, it } from "vitest";
import {
  cloneCodeModeStats,
  createCodeModeStats,
  drainCodeModeAttemptStats,
  ensureCodeModeStats,
  recordCodeModeBridgeCancelRequested,
  recordCodeModeBridgeCancelledBeforeStart,
  recordCodeModeBridgeRegistered,
  recordCodeModeBridgeSettled,
  recordCodeModeBridgeStarted,
  recordCodeModeControlCall,
  recordCodeModeSnapshot,
  recordCodeModeWorkerRun,
  registerCodeModeStatsSource,
} from "./code-mode-stats.js";
import { CODE_MODE_BRIDGE_METHODS } from "./code-mode-worker-types.js";

describe("Code Mode bridge accounting", () => {
  it("registers every guest bridge method at direct dispatch", () => {
    const stats = createCodeModeStats();
    for (const method of CODE_MODE_BRIDGE_METHODS) {
      recordCodeModeBridgeRegistered(stats, method);
      recordCodeModeBridgeStarted(stats);
      recordCodeModeBridgeSettled(stats, { failed: false, settledAfterCancel: false });
    }

    expect(cloneCodeModeStats(stats)).toEqual({
      controlCalls: {},
      bridgeCalls: Object.fromEntries(CODE_MODE_BRIDGE_METHODS.map((method) => [method, 1])),
      workerRuns: {},
      bridgeLifecycle: {
        registered: CODE_MODE_BRIDGE_METHODS.length,
        started: CODE_MODE_BRIDGE_METHODS.length,
        settled: CODE_MODE_BRIDGE_METHODS.length,
        unresolvedAtExtraction: 0,
      },
      outcomes: {},
    });
  });

  it("records a host failure without fabricating cancellation evidence", () => {
    const stats = createCodeModeStats();
    recordCodeModeBridgeRegistered(stats, "callValue");
    recordCodeModeBridgeStarted(stats);
    recordCodeModeBridgeSettled(stats, { failed: true, settledAfterCancel: false });

    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 1,
      started: 1,
      settled: 1,
      failed: 1,
      unresolvedAtExtraction: 0,
    });
  });

  it("keeps cancelled direct-dispatch work unresolved until it actually settles", () => {
    const stats = createCodeModeStats();
    for (let index = 0; index < 2; index += 1) {
      recordCodeModeBridgeRegistered(stats, "callValue");
      recordCodeModeBridgeStarted(stats);
      recordCodeModeBridgeCancelRequested(stats);
    }
    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 2,
      started: 2,
      cancelRequested: 2,
      unresolvedAtExtraction: 2,
    });

    recordCodeModeBridgeSettled(stats, { failed: false, settledAfterCancel: true });
    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 2,
      started: 2,
      settled: 1,
      cancelRequested: 2,
      settledAfterCancel: 1,
      unresolvedAtExtraction: 1,
    });

    recordCodeModeBridgeSettled(stats, { failed: false, settledAfterCancel: true });
    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 2,
      started: 2,
      settled: 2,
      cancelRequested: 2,
      settledAfterCancel: 2,
      unresolvedAtExtraction: 0,
    });
  });

  it("records queued cancellation separately from active cancellation", () => {
    const stats = createCodeModeStats();
    recordCodeModeBridgeRegistered(stats, "callValue");
    recordCodeModeBridgeCancelRequested(stats);
    recordCodeModeBridgeCancelledBeforeStart(stats);
    recordCodeModeBridgeSettled(stats, { failed: false, settledAfterCancel: false });

    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 1,
      settled: 1,
      cancelRequested: 1,
      cancelledBeforeStart: 1,
      unresolvedAtExtraction: 0,
    });
  });

  it("drains additive source deltas once and samples unique live gauges", () => {
    const owner = { current: {} };
    const local = ensureCodeModeStats(owner);
    expect(local).toBeDefined();
    if (!local) {
      throw new Error("expected local Code Mode stats");
    }
    const parked = createCodeModeStats();
    registerCodeModeStatsSource(owner, local);
    registerCodeModeStatsSource(owner, parked);
    registerCodeModeStatsSource(owner, parked);

    recordCodeModeControlCall(local, "exec");
    recordCodeModeBridgeRegistered(local, "callValue");
    recordCodeModeSnapshot(local, {
      disposition: "accepted",
      measurement: { bytes: 8, serializationMs: 2 },
      coverage: "exact",
    });
    recordCodeModeControlCall(parked, "wait");
    recordCodeModeBridgeRegistered(parked, "search");
    recordCodeModeBridgeSettled(parked, { failed: false, settledAfterCancel: false });
    recordCodeModeSnapshot(parked, {
      disposition: "rejected",
      rejectionReason: "size",
      measurement: { bytes: 12, serializationMs: 3 },
      coverage: "exact",
    });

    expect(drainCodeModeAttemptStats(owner)).toMatchObject({
      controlCalls: { exec: 1, wait: 1 },
      bridgeCalls: { callValue: 1, search: 1 },
      bridgeLifecycle: { registered: 2, settled: 1, unresolvedAtExtraction: 1 },
      snapshots: {
        attempted: 2,
        produced: 2,
        accepted: 1,
        rejected: 1,
        incomplete: 0,
        rejectedByReason: { size: 1 },
        totalBytes: 20,
        maxBytes: 12,
        serializationMs: 5,
        coverage: "exact",
      },
    });

    recordCodeModeBridgeSettled(local, { failed: false, settledAfterCancel: false });
    recordCodeModeWorkerRun(local, "resume", 7);
    recordCodeModeSnapshot(local, {
      disposition: "incomplete",
      coverage: "lower_bound",
    });
    recordCodeModeBridgeRegistered(parked, "describe");
    recordCodeModeSnapshot(parked, {
      disposition: "accepted",
      measurement: { bytes: 10, serializationMs: 4 },
      coverage: "exact",
    });

    expect(drainCodeModeAttemptStats(owner)).toEqual({
      controlCalls: {},
      bridgeCalls: { describe: 1 },
      workerRuns: { resume: { count: 1, elapsedMs: 7 } },
      bridgeLifecycle: {
        registered: 1,
        settled: 1,
        unresolvedAtExtraction: 1,
      },
      snapshots: {
        attempted: 2,
        produced: 1,
        accepted: 1,
        rejected: 0,
        incomplete: 1,
        totalBytes: 10,
        maxBytes: 10,
        serializationMs: 4,
        coverage: "lower_bound",
      },
      outcomes: {},
    });

    recordCodeModeSnapshot(local, {
      disposition: "accepted",
      measurement: { bytes: 14, serializationMs: 2 },
      coverage: "exact",
    });
    recordCodeModeSnapshot(parked, {
      disposition: "accepted",
      measurement: { bytes: 6, serializationMs: 1 },
      coverage: "exact",
    });
    expect(drainCodeModeAttemptStats(owner)?.snapshots).toEqual({
      attempted: 2,
      produced: 2,
      accepted: 2,
      rejected: 0,
      incomplete: 0,
      totalBytes: 20,
      maxBytes: 14,
      serializationMs: 3,
      coverage: "exact",
    });

    expect(drainCodeModeAttemptStats(owner)).toEqual({
      controlCalls: {},
      bridgeCalls: {},
      workerRuns: {},
      bridgeLifecycle: { unresolvedAtExtraction: 1 },
      outcomes: {},
    });
  });
});

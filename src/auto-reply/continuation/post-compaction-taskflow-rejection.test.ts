// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Real-store proof that a released post-compaction row can still be terminalized
 * at queued-delivery time.
 *
 * `dispatchPostCompactionDelegates` enqueues the delivery and only then calls
 * `finalizeStagedPostCompactionDelegates`, so by the time the queue drains, the
 * row is `succeeded` one revision past the claim the queue entry carries. Every
 * delivery-time rejection — stale TTL, chain cap, cost cap, cross-session
 * policy, spawn-forbidden — has to be able to commit a terminal row against that
 * state instead of failing its revision fence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";

vi.mock("../../tasks/task-flow-registry.js", async () => {
  const harness = await import("./delegate-taskflow-registry.test-harness.js");
  return harness.createTaskFlowRegistryMock();
});

import {
  claimStagedPostCompactionTaskFlowDelegates,
  finalizeStagedPostCompactionDelegates,
  stagePostCompactionTaskFlowDelegate,
} from "./delegate-store-post-compaction.js";
import { markPendingDelegateFailed } from "./delegate-store.js";
import { mockTaskFlows, resetMockTaskFlows } from "./delegate-taskflow-registry.test-harness.js";
import { failReleasedPostCompactionDelegate } from "./post-compaction-taskflow-rejection.js";

const SESSION_KEY = "channel:session-1198";
const STALE_SUMMARY = "Post-compaction delegate rejected as stale after 604800001ms.";

/**
 * Reproduce the exact durable state a queued `postCompactionDelegate` entry sees:
 * staged, claimed (the revision the entry records), then finalized to the
 * post-handoff `succeeded` state.
 */
function releaseOneDelegateThroughDurableHandoff() {
  stagePostCompactionTaskFlowDelegate(SESSION_KEY, {
    task: "carry working state",
    stagedAt: Date.now(),
    firstArmedAt: Date.now(),
  });
  const claimed = claimStagedPostCompactionTaskFlowDelegates(SESSION_KEY)[0];
  if (!claimed?.flowId || claimed.expectedRevision === undefined) {
    throw new Error("expected a claimed post-compaction delegate");
  }
  const queuedEntrySource = {
    flowId: claimed.flowId,
    expectedRevision: claimed.expectedRevision,
    task: claimed.task,
  };
  expect(finalizeStagedPostCompactionDelegates([claimed.flowId])).toBe(1);
  return queuedEntrySource;
}

beforeEach(() => {
  setRuntimeConfigSnapshot({
    tools: { sessions_spawn: { attachments: { enabled: true } } },
  });
  resetMockTaskFlows();
});

afterEach(() => {
  resetMockTaskFlows();
});

describe("failReleasedPostCompactionDelegate", () => {
  it("commits a terminal row for work already handed off to the queue", () => {
    const source = releaseOneDelegateThroughDurableHandoff();
    const handedOff = mockTaskFlows.get(source.flowId);
    expect(handedOff).toMatchObject({
      status: "succeeded",
      revision: source.expectedRevision + 1,
    });

    expect(
      failReleasedPostCompactionDelegate(
        source,
        STALE_SUMMARY,
        "Post-compaction delegate rejected",
      ),
    ).toBe(true);
    expect(mockTaskFlows.get(source.flowId)).toMatchObject({
      status: "failed",
      currentStep: "Post-compaction delegate rejected",
    });
  });

  it("is the reason the plain revision-fenced transition is not enough", () => {
    const source = releaseOneDelegateThroughDurableHandoff();

    // Pinning the defect this helper exists for: the queue entry's claim
    // revision is one behind the durably handed-off row, so the strict fence
    // can never commit and the caller would throw instead of terminalizing.
    expect(markPendingDelegateFailed(source, STALE_SUMMARY)).toBe(false);
    expect(mockTaskFlows.get(source.flowId)).toMatchObject({ status: "succeeded" });
  });

  it("keeps the strict fence for a claim that was genuinely superseded", () => {
    const source = releaseOneDelegateThroughDurableHandoff();
    const flow = mockTaskFlows.get(source.flowId);
    if (!flow) {
      throw new Error("expected a handed-off flow");
    }
    // Two revisions past the claim is not the post-handoff shape, so this is a
    // superseded claim and must not be blindly overwritten. `succeeded@+2` is
    // reachable in production — `reserveAcceptedPostCompactionChainHop` produces
    // it — but only after a spawn was accepted, and an accepted spawn has already
    // written its child run, so `maybeFinalizePreviouslyAcceptedDelivery` settles
    // that entry before any rejection gate can observe the row.
    flow.revision += 1;

    expect(failReleasedPostCompactionDelegate(source, STALE_SUMMARY)).toBe(false);
    expect(mockTaskFlows.get(source.flowId)).toMatchObject({ status: "succeeded" });
  });

  it("passes a source-less delegate straight through", () => {
    expect(failReleasedPostCompactionDelegate({ task: "no source row" }, STALE_SUMMARY)).toBe(
      false,
    );
  });
});

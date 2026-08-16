import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
  countActiveDescendantRunsFromRuns,
  countPendingDescendantRunsFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => {
  const liveRuns = new Map<string, SubagentRunRecord>();
  return {
    liveRuns,
    getSubagentRunsForChildSession: vi.fn<(childSessionKey: string) => Iterable<SubagentRunRecord>>(
      () => [],
    ),
    getSubagentSessionListRunsSnapshotForRead: vi.fn<
      (runs: Map<string, SubagentRunRecord>) => Map<string, SubagentRunRecord>
    >(() => new Map()),
    getSubagentRunsSnapshotForChildSession: vi.fn<
      (
        runs: Map<string, SubagentRunRecord>,
        childSessionKey: string,
      ) => Map<string, SubagentRunRecord>
    >(() => new Map()),
    getSubagentRunsSnapshotForController: vi.fn<
      (
        runs: Map<string, SubagentRunRecord>,
        controllerSessionKey: string,
      ) => Map<string, SubagentRunRecord>
    >(() => new Map()),
    getSubagentRunsSnapshotForRead: vi.fn<
      (runs: Map<string, SubagentRunRecord>) => Map<string, SubagentRunRecord>
    >(() => {
      throw new Error("unexpected full registry hydration");
    }),
  };
});

vi.mock("./subagent-registry-memory.js", () => ({
  getSubagentRunsForChildSession: mocks.getSubagentRunsForChildSession,
  subagentRuns: mocks.liveRuns,
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentSessionListRunsSnapshotForRead: mocks.getSubagentSessionListRunsSnapshotForRead,
  getSubagentRunsSnapshotForChildSession: mocks.getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController: mocks.getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
}));

function createRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run";
  const { execution = { status: "running" }, ...recordOverrides } = overrides;
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test task",
    cleanup: "keep",
    createdAt: 1,
    ...recordOverrides,
    execution,
  };
}

describe("subagent registry scoped reads", () => {
  let mod: typeof import("./subagent-registry-read.js");

  beforeEach(async () => {
    mocks.liveRuns.clear();
    mocks.getSubagentRunsForChildSession.mockReset().mockReturnValue([]);
    mocks.getSubagentSessionListRunsSnapshotForRead.mockReset().mockReturnValue(new Map());
    mocks.getSubagentRunsSnapshotForChildSession.mockReset().mockReturnValue(new Map());
    mocks.getSubagentRunsSnapshotForController.mockReset().mockReturnValue(new Map());
    mocks.getSubagentRunsSnapshotForRead.mockClear();
    mod = await import("./subagent-registry-read.js");
  });

  it("uses the child snapshot for latest and display lookups without full hydration", () => {
    const childSessionKey = "agent:main:subagent:child";
    const older = createRun({ runId: "older", childSessionKey, generation: 1, createdAt: 200 });
    const latest = createRun({ runId: "latest", childSessionKey, generation: 2, createdAt: 100 });
    mocks.getSubagentRunsSnapshotForChildSession.mockReturnValue(
      new Map([
        [older.runId, older],
        [latest.runId, latest],
      ]),
    );

    expect(mod.getLatestSubagentRunByChildSessionKey(childSessionKey)).toEqual(latest);
    expect(mod.getSessionDisplaySubagentRunByChildSessionKey(childSessionKey)).toEqual(latest);
    expect(mocks.getSubagentRunsSnapshotForChildSession).toHaveBeenCalledTimes(2);
    expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
  });

  it("prefers the latest indexed live generation without loading persisted rows", () => {
    const childSessionKey = "agent:main:subagent:child";
    const older = createRun({ runId: "older", childSessionKey, generation: 1, createdAt: 200 });
    const latest = createRun({ runId: "latest", childSessionKey, generation: 2, createdAt: 100 });
    mocks.getSubagentRunsForChildSession.mockReturnValue([older, latest]);

    expect(mod.getSessionDisplaySubagentRunByChildSessionKey(childSessionKey)).toBe(latest);
    expect(mocks.getSubagentRunsForChildSession).toHaveBeenCalledWith(childSessionKey);
    expect(mocks.getSubagentRunsSnapshotForChildSession).not.toHaveBeenCalled();
  });

  it("uses the controller snapshot while retaining legacy requester-owned runs", () => {
    const controllerSessionKey = "agent:main:controller";
    const explicit = createRun({
      runId: "explicit",
      controllerSessionKey,
      requesterSessionKey: "agent:main:other",
    });
    const legacy = createRun({ runId: "legacy", requesterSessionKey: controllerSessionKey });
    const other = createRun({
      runId: "other",
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: controllerSessionKey,
    });
    mocks.getSubagentRunsSnapshotForController.mockReturnValue(
      new Map([
        [explicit.runId, explicit],
        [legacy.runId, legacy],
        [other.runId, other],
      ]),
    );

    expect(mod.listSubagentRunsForController(controllerSessionKey)).toEqual([explicit, legacy]);
    expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
  });

  it("keeps every bound read equivalent to its documented snapshot scope", () => {
    const now = Date.now();
    const root = "agent:main:root";
    const controller = "agent:main:controller";
    const reusedChild = "agent:main:subagent:reused";
    const parent = "agent:main:subagent:parent";
    const pendingChild = "agent:main:subagent:pending";
    const settledChild = "agent:main:subagent:settled";
    const suspendedChild = "agent:main:subagent:suspended";
    const oldActive = createRun({
      runId: "run-reused-active",
      childSessionKey: reusedChild,
      requesterSessionKey: root,
      controllerSessionKey: controller,
      generation: 1,
      createdAt: now - 5_000,
      execution: { status: "running", startedAt: now - 4_900 },
    });
    const freshTerminal = createRun({
      runId: "run-reused-terminal",
      childSessionKey: reusedChild,
      requesterSessionKey: root,
      requesterOrigin: { channel: "discord", to: " room " },
      controllerSessionKey: controller,
      generation: 2,
      createdAt: now - 4_000,
      spawnMode: "run",
      cleanupCompletedAt: now - 1_000,
      execution: { status: "terminal", startedAt: now - 3_900, endedAt: now - 2_000 },
    });
    const parentRun = createRun({
      runId: "run-parent",
      childSessionKey: parent,
      requesterSessionKey: root,
      controllerSessionKey: controller,
      createdAt: now - 3_000,
      execution: { status: "running", startedAt: now - 2_900 },
    });
    const pendingRun = createRun({
      runId: "run-pending",
      childSessionKey: pendingChild,
      requesterSessionKey: parent,
      createdAt: now - 2_000,
      execution: { status: "terminal", startedAt: now - 1_900, endedAt: now - 1_500 },
    });
    const settledRun = createRun({
      runId: "run-settled",
      childSessionKey: settledChild,
      requesterSessionKey: parent,
      createdAt: now - 1_800,
      cleanupCompletedAt: now - 1_200,
      execution: { status: "terminal", startedAt: now - 1_700, endedAt: now - 1_300 },
    });
    const suspendedRun = createRun({
      runId: "run-suspended",
      childSessionKey: suspendedChild,
      requesterSessionKey: parent,
      createdAt: now - 1_600,
      delivery: { status: "suspended", disposition: "permanent_failure" },
      execution: { status: "terminal", startedAt: now - 1_500, endedAt: now - 1_100 },
    });
    const snapshot = new Map(
      [oldActive, freshTerminal, parentRun, pendingRun, settledRun, suspendedRun].map(
        (run) => [run.runId, run] as const,
      ),
    );
    const childSnapshot = new Map(
      [oldActive, freshTerminal].map((run) => [run.runId, run] as const),
    );
    const controllerSnapshot = new Map(
      [oldActive, freshTerminal, parentRun].map((run) => [run.runId, run] as const),
    );
    mocks.liveRuns.set(freshTerminal.runId, freshTerminal);
    mocks.liveRuns.set(parentRun.runId, parentRun);
    mocks.getSubagentRunsForChildSession.mockImplementation((childSessionKey) =>
      [...mocks.liveRuns.values()].filter((run) => run.childSessionKey === childSessionKey),
    );
    mocks.getSubagentRunsSnapshotForRead.mockReturnValue(snapshot);
    mocks.getSubagentRunsSnapshotForChildSession.mockReturnValue(childSnapshot);
    mocks.getSubagentRunsSnapshotForController.mockReturnValue(controllerSnapshot);

    const requester = resolveRequesterForChildSessionFromRuns(snapshot, reusedChild);
    const cases = [
      {
        name: "full snapshot index",
        actual: mod.buildSubagentRunReadIndex(now).latestRunsByChildSessionKey,
        expected: buildSubagentRunReadIndexFromRuns({ runs: snapshot, now })
          .latestRunsByChildSessionKey,
      },
      {
        name: "latest full snapshot index",
        actual: mod.buildLatestSubagentRunReadIndex().getLatestSubagentRun(reusedChild),
        expected:
          buildLatestSubagentRunReadIndexFromRuns(snapshot).getLatestSubagentRun(reusedChild),
      },
      {
        name: "controller snapshot",
        actual: mod.listSubagentRunsForController(controller),
        expected: listRunsForControllerFromRuns(controllerSnapshot, controller),
      },
      {
        name: "active descendants from full snapshot",
        actual: mod.countActiveDescendantRuns(root),
        expected: countActiveDescendantRunsFromRuns(snapshot, root),
      },
      {
        name: "pending descendants from full snapshot",
        actual: mod.countPendingDescendantRuns(root),
        expected: countPendingDescendantRunsFromRuns(snapshot, root),
      },
      {
        name: "settle wait from full snapshot",
        actual: mod.hasDescendantRunAwaitingSettle(root, pendingRun.runId),
        expected: hasDescendantRunAwaitingSettleFromRuns(snapshot, root, pendingRun.runId),
      },
      {
        name: "descendant list from full snapshot",
        actual: mod.listDescendantRunsForRequester(root),
        expected: listDescendantRunsForRequesterFromRuns(snapshot, root),
      },
      {
        name: "preferred child run from child snapshot",
        actual: mod.getSubagentRunByChildSessionKey(reusedChild),
        expected: getSubagentRunByChildSessionKeyFromRuns(childSnapshot, reusedChild),
      },
      {
        name: "latest child run from child snapshot",
        actual: mod.getLatestSubagentRunByChildSessionKey(reusedChild),
        expected: getLatestSubagentRunByChildSessionKeyFromRuns(childSnapshot, reusedChild) ?? null,
      },
      {
        name: "display run with live-memory precedence",
        actual: mod.getSessionDisplaySubagentRunByChildSessionKey(reusedChild),
        expected:
          getLatestSubagentRunByChildSessionKeyFromRuns([freshTerminal], reusedChild) ??
          getSubagentRunByChildSessionKeyFromRuns(childSnapshot, reusedChild),
      },
      {
        name: "latest mutation-owned run from live memory",
        actual: mod.getLatestLiveSubagentRunByChildSessionKey(reusedChild),
        expected:
          getLatestSubagentRunByChildSessionKeyFromRuns([freshTerminal], reusedChild) ?? null,
      },
      {
        name: "active child ownership from raw live map",
        actual: mod.isSubagentSessionRunActive(parent),
        expected: isSubagentSessionRunActiveFromRuns(mocks.liveRuns, parent),
      },
      {
        name: "requester runs from raw live map",
        actual: mod.listSubagentRunsForRequester(root),
        expected: listRunsForRequesterFromRuns(mocks.liveRuns, root),
      },
      {
        name: "requester resolution from full snapshot",
        actual: mod.resolveRequesterForChildSession(reusedChild),
        expected: requester
          ? {
              requesterSessionKey: requester.requesterSessionKey,
              requesterOrigin: normalizeDeliveryContext(requester.requesterOrigin),
            }
          : null,
      },
      {
        name: "post-completion ignore from full snapshot",
        actual: mod.shouldIgnorePostCompletionAnnounceForSession(reusedChild),
        expected: shouldIgnorePostCompletionAnnounceForSessionFromRuns(snapshot, reusedChild),
      },
    ];

    for (const testCase of cases) {
      expect(testCase.actual, testCase.name).toEqual(testCase.expected);
    }
  });
});

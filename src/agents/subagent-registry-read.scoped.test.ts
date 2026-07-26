import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
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
}));

vi.mock("./subagent-registry-memory.js", () => ({
  subagentRuns: new Map<string, SubagentRunRecord>(),
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForChildSession: mocks.getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController: mocks.getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
}));

function createRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run";
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test task",
    cleanup: "keep",
    createdAt: 1,
    ...overrides,
  };
}

describe("subagent registry scoped reads", () => {
  let mod: typeof import("./subagent-registry-read.js");

  beforeEach(async () => {
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
});

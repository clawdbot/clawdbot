import { describe, expect, it } from "vitest";
import {
  buildSubagentRunReadIndexFromRuns,
  countActiveDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listRunsForControllerFromRuns,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-default";
  const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${runId}`;
  const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
  return {
    runId,
    childSessionKey,
    controllerSessionKey: overrides.controllerSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: "test task",
    cleanup: "keep",
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  };
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

function listRunsForController(
  index: SubagentRunReadIndex,
  controllerSessionKey: string,
): readonly SubagentRunRecord[] {
  return index.runsByControllerSessionKey.get(controllerSessionKey.trim()) ?? [];
}

describe("subagent registry read index", () => {
  it("matches existing query helpers while reusing one indexed snapshot", () => {
    const now = Date.now();
    const root = "agent:main:main";
    const parent = "agent:main:subagent:parent";
    const liveChild = "agent:main:subagent:parent:subagent:live-child";
    const movedChild = "agent:main:subagent:moved-child";
    const runs = toRunMap([
      makeRun({
        runId: "run-parent",
        childSessionKey: parent,
        controllerSessionKey: root,
        requesterSessionKey: root,
        createdAt: now - 5_000,
        startedAt: now - 4_500,
        endedAt: now - 2_500,
      }),
      makeRun({
        runId: "run-live-child",
        childSessionKey: liveChild,
        controllerSessionKey: parent,
        requesterSessionKey: parent,
        createdAt: now - 2_000,
        startedAt: now - 1_500,
      }),
      makeRun({
        runId: "run-moved-old",
        childSessionKey: movedChild,
        controllerSessionKey: root,
        requesterSessionKey: root,
        createdAt: now - 4_000,
        startedAt: now - 3_500,
      }),
      makeRun({
        runId: "run-moved-new",
        childSessionKey: movedChild,
        controllerSessionKey: "agent:main:other-controller",
        requesterSessionKey: "agent:main:other-controller",
        createdAt: now - 1_000,
        startedAt: now - 900,
      }),
    ]);

    const index = buildSubagentRunReadIndexFromRuns({ runs, now });

    expect(listRunsForController(index, root)).toEqual(listRunsForControllerFromRuns(runs, root));
    expect(index.getDisplaySubagentRun(parent)).toEqual(
      getSubagentRunByChildSessionKeyFromRuns(runs, parent),
    );
    expect(index.countActiveDescendantRuns(root)).toBe(
      countActiveDescendantRunsFromRuns(runs, root),
    );
    expect(index.countActiveDescendantRuns(root)).toBe(1);
  });

  it("handles empty registry snapshots", () => {
    const runs = new Map<string, SubagentRunRecord>();
    const index = buildSubagentRunReadIndexFromRuns({ runs });

    expect(listRunsForController(index, "agent:main:main")).toStrictEqual([]);
    expect(index.getDisplaySubagentRun("agent:main:subagent:missing")).toBeNull();
    expect(index.countActiveDescendantRuns("agent:main:main")).toBe(0);
  });

  it("uses requesterSessionKey when controllerSessionKey is missing", () => {
    const root = "agent:main:main";
    const run = makeRun({
      runId: "run-controller-fallback",
      childSessionKey: "agent:main:subagent:fallback-child",
      requesterSessionKey: root,
      controllerSessionKey: undefined,
    });
    const runs = toRunMap([run]);
    const index = buildSubagentRunReadIndexFromRuns({ runs });

    expect(listRunsForController(index, root)).toEqual(listRunsForControllerFromRuns(runs, root));
    expect(listRunsForController(index, root)).toEqual([run]);
  });

  it("keeps moved middle descendants under the latest requester", () => {
    const now = Date.now();
    const root = "agent:main:root";
    const otherRoot = "agent:main:other-root";
    const middle = "agent:main:subagent:middle";
    const grandchild = "agent:main:subagent:grandchild";
    const runs = toRunMap([
      makeRun({
        runId: "run-middle-old",
        childSessionKey: middle,
        controllerSessionKey: root,
        requesterSessionKey: root,
        createdAt: now - 3_000,
        startedAt: now - 2_900,
      }),
      makeRun({
        runId: "run-grandchild",
        childSessionKey: grandchild,
        controllerSessionKey: middle,
        requesterSessionKey: middle,
        createdAt: now - 2_000,
        startedAt: now - 1_900,
      }),
      makeRun({
        runId: "run-middle-moved",
        childSessionKey: middle,
        controllerSessionKey: otherRoot,
        requesterSessionKey: otherRoot,
        createdAt: now - 1_000,
        startedAt: now - 900,
      }),
    ]);
    const index = buildSubagentRunReadIndexFromRuns({ runs, now });

    expect(index.countActiveDescendantRuns(root)).toBe(
      countActiveDescendantRunsFromRuns(runs, root),
    );
    expect(index.countActiveDescendantRuns(root)).toBe(0);
    expect(index.countActiveDescendantRuns(otherRoot)).toBe(
      countActiveDescendantRunsFromRuns(runs, otherRoot),
    );
    expect(index.countActiveDescendantRuns(otherRoot)).toBe(2);
  });

  it("keeps one snapshot stable for the lifetime of the context", () => {
    const root = "agent:main:main";
    const runs = toRunMap([
      makeRun({
        runId: "run-original",
        childSessionKey: "agent:main:subagent:original",
        requesterSessionKey: root,
        controllerSessionKey: root,
      }),
    ]);
    const index = buildSubagentRunReadIndexFromRuns({ runs });

    runs.set(
      "run-added-after-context",
      makeRun({
        runId: "run-added-after-context",
        childSessionKey: "agent:main:subagent:added",
        requesterSessionKey: root,
        controllerSessionKey: root,
      }),
    );

    expect(listRunsForController(index, root).map((run) => run.runId)).toEqual(["run-original"]);
    expect(
      listRunsForController(buildSubagentRunReadIndexFromRuns({ runs }), root).map(
        (run) => run.runId,
      ),
    ).toEqual(["run-original", "run-added-after-context"]);
  });

  it("normalizes display lookup keys for whitespace-padded child session keys", () => {
    const normalizedChildSessionKey = "agent:main:subagent:whitespace-child";
    const run = makeRun({
      runId: "run-whitespace-child",
      childSessionKey: ` ${normalizedChildSessionKey} `,
      requesterSessionKey: "agent:main:main",
    });
    const runs = toRunMap([run]);
    const index = buildSubagentRunReadIndexFromRuns({ runs });

    expect(index.getDisplaySubagentRun(normalizedChildSessionKey)).toBe(run);
  });

  it("keeps the display-row preference for in-memory records over persisted snapshots", () => {
    const childSessionKey = "agent:main:subagent:display-child";
    const persistedRuns = toRunMap([
      makeRun({
        runId: "run-persisted-newer",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 200,
        startedAt: 200,
      }),
    ]);
    const inMemoryRuns = toRunMap([
      makeRun({
        runId: "run-memory-older-ended",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 100,
        startedAt: 100,
        endedAt: 150,
      }),
    ]);

    const index = buildSubagentRunReadIndexFromRuns({
      runs: persistedRuns,
      inMemoryRuns: inMemoryRuns.values(),
    });

    expect(index.getDisplaySubagentRun(childSessionKey)?.runId).toBe("run-memory-older-ended");
  });
});

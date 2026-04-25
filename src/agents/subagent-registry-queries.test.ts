import { describe, expect, it } from "vitest";
import {
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { STALE_UNENDED_SUBAGENT_RUN_MS } from "./subagent-run-liveness.js";

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-default";
  const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${runId}`;
  const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
  return {
    runId,
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: "test task",
    cleanup: "keep",
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
  };
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

describe("subagent registry query regressions", () => {
  it("does not treat stale unended rows as active child-session liveness", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-live-check";
    const runs = toRunMap([
      makeRun({
        runId: "run-stale",
        childSessionKey,
        createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      }),
    ]);

    expect(isSubagentSessionRunActiveFromRuns(runs, childSessionKey)).toBe(false);

    runs.set(
      "run-fresh",
      makeRun({
        runId: "run-fresh",
        childSessionKey,
        createdAt: now - 60_000,
        startedAt: now - 60_000,
      }),
    );

    expect(isSubagentSessionRunActiveFromRuns(runs, childSessionKey)).toBe(true);
  });

  it("does not count stale unended direct children as active concurrency", () => {
    const now = Date.now();
    const runs = toRunMap([
      makeRun({
        runId: "run-stale-child",
        childSessionKey: "agent:main:subagent:stale-child",
        requesterSessionKey: "agent:main:main",
        createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      }),
      makeRun({
        runId: "run-fresh-child",
        childSessionKey: "agent:main:subagent:fresh-child",
        requesterSessionKey: "agent:main:main",
        createdAt: now - 60_000,
        startedAt: now - 60_000,
      }),
    ]);

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);
  });

  it("does not count stale unended descendants as pending work", () => {
    const now = Date.now();
    const parentSessionKey = "agent:main:subagent:parent-stale-desc";
    const runs = toRunMap([
      makeRun({
        runId: "run-stale-descendant",
        childSessionKey: `${parentSessionKey}:subagent:stale`,
        requesterSessionKey: parentSessionKey,
        createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      }),
      makeRun({
        runId: "run-ended-cleanup-pending",
        childSessionKey: `${parentSessionKey}:subagent:cleanup`,
        requesterSessionKey: parentSessionKey,
        createdAt: now - 10_000,
        startedAt: now - 9_000,
        endedAt: now - 1_000,
        cleanupCompletedAt: undefined,
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(1);
  });

  it("keeps a stale unended orchestrator active only when live descendants remain", () => {
    const now = Date.now();
    const parentSessionKey = "agent:main:subagent:stale-orchestrator";
    const liveChildSessionKey = `${parentSessionKey}:subagent:live-child`;
    const runs = toRunMap([
      makeRun({
        runId: "run-parent-stale",
        childSessionKey: parentSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      }),
      makeRun({
        runId: "run-live-child",
        childSessionKey: liveChildSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: now - 60_000,
        startedAt: now - 60_000,
      }),
    ]);

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);

    runs.set(
      "run-live-child",
      makeRun({
        runId: "run-live-child",
        childSessionKey: liveChildSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: now - 60_000,
        startedAt: now - 60_000,
        endedAt: now - 1_000,
        cleanupCompletedAt: now,
      }),
    );

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(0);
  });

  it("prefers the newest ended child row over an older stale unended row", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-prefer-ended";
    const runs = toRunMap([
      makeRun({
        runId: "run-stale",
        childSessionKey,
        createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      }),
      makeRun({
        runId: "run-ended",
        childSessionKey,
        createdAt: now - 60_000,
        startedAt: now - 59_000,
        endedAt: now - 1_000,
        cleanupCompletedAt: now,
      }),
    ]);

    expect(getSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey)?.runId).toBe("run-ended");
  });

  it("regression descendant count gating, pending descendants block announce until cleanup completion is recorded", () => {
    // Regression guard: parent announce must defer while any descendant cleanup is still pending.
    const parentSessionKey = "agent:main:subagent:parent";
    const runs = toRunMap([
      makeRun({
        runId: "run-parent",
        childSessionKey: parentSessionKey,
        requesterSessionKey: "agent:main:main",
        endedAt: 100,
        cleanupCompletedAt: undefined,
      }),
      makeRun({
        runId: "run-child-fast",
        childSessionKey: `${parentSessionKey}:subagent:fast`,
        requesterSessionKey: parentSessionKey,
        endedAt: 110,
        cleanupCompletedAt: 120,
      }),
      makeRun({
        runId: "run-child-slow",
        childSessionKey: `${parentSessionKey}:subagent:slow`,
        requesterSessionKey: parentSessionKey,
        endedAt: 115,
        cleanupCompletedAt: undefined,
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(1);

    runs.set(
      "run-parent",
      makeRun({
        runId: "run-parent",
        childSessionKey: parentSessionKey,
        requesterSessionKey: "agent:main:main",
        endedAt: 100,
        cleanupCompletedAt: 130,
      }),
    );
    runs.set(
      "run-child-slow",
      makeRun({
        runId: "run-child-slow",
        childSessionKey: `${parentSessionKey}:subagent:slow`,
        requesterSessionKey: parentSessionKey,
        endedAt: 115,
        cleanupCompletedAt: 131,
      }),
    );

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(0);
  });

  it("regression nested parallel counting, traversal includes child and grandchildren pending states", () => {
    // Regression guard: nested fan-out once under-counted grandchildren and announced too early.
    const parentSessionKey = "agent:main:subagent:parent-nested";
    const middleSessionKey = `${parentSessionKey}:subagent:middle`;
    const runs = toRunMap([
      makeRun({
        runId: "run-middle",
        childSessionKey: middleSessionKey,
        requesterSessionKey: parentSessionKey,
        endedAt: 200,
        cleanupCompletedAt: undefined,
      }),
      makeRun({
        runId: "run-middle-a",
        childSessionKey: `${middleSessionKey}:subagent:a`,
        requesterSessionKey: middleSessionKey,
        endedAt: 210,
        cleanupCompletedAt: 215,
      }),
      makeRun({
        runId: "run-middle-b",
        childSessionKey: `${middleSessionKey}:subagent:b`,
        requesterSessionKey: middleSessionKey,
        endedAt: 211,
        cleanupCompletedAt: undefined,
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(2);
    expect(countPendingDescendantRunsFromRuns(runs, middleSessionKey)).toBe(1);
  });

  it("dedupes restarted descendant rows for the same child session when counting pending work", () => {
    const parentSessionKey = "agent:main:subagent:parent-dedupe";
    const childSessionKey = `${parentSessionKey}:subagent:worker`;
    const runs = toRunMap([
      makeRun({
        runId: "run-child-stale",
        childSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 100,
        endedAt: 150,
        cleanupCompletedAt: undefined,
      }),
      makeRun({
        runId: "run-child-current",
        childSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 200,
      }),
      makeRun({
        runId: "run-grandchild-current",
        childSessionKey: `${childSessionKey}:subagent:leaf`,
        requesterSessionKey: childSessionKey,
        createdAt: 210,
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(2);
  });

  it("ignores stale older parent rows when a child session moved to a newer controller", () => {
    const oldParentSessionKey = "agent:main:subagent:old-parent";
    const newParentSessionKey = "agent:main:subagent:new-parent";
    const childSessionKey = "agent:main:subagent:shared-child";
    const runs = toRunMap([
      makeRun({
        runId: "run-old-parent",
        childSessionKey: oldParentSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 100,
      }),
      makeRun({
        runId: "run-new-parent",
        childSessionKey: newParentSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 200,
      }),
      makeRun({
        runId: "run-child-stale-parent",
        childSessionKey,
        requesterSessionKey: oldParentSessionKey,
        controllerSessionKey: oldParentSessionKey,
        createdAt: 300,
        endedAt: 350,
      }),
      makeRun({
        runId: "run-child-current-parent",
        childSessionKey,
        requesterSessionKey: newParentSessionKey,
        controllerSessionKey: newParentSessionKey,
        createdAt: 400,
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, oldParentSessionKey)).toBe(0);
    expect(countPendingDescendantRunsFromRuns(runs, newParentSessionKey)).toBe(1);
  });

  it("regression excluding current run, countPendingDescendantRunsExcludingRun keeps sibling gating intact", () => {
    // Regression guard: excluding the currently announcing run must not hide sibling pending work.
    const runs = toRunMap([
      makeRun({
        runId: "run-self",
        childSessionKey: "agent:main:subagent:self",
        requesterSessionKey: "agent:main:main",
        endedAt: 100,
        cleanupCompletedAt: undefined,
      }),
      makeRun({
        runId: "run-sibling",
        childSessionKey: "agent:main:subagent:sibling",
        requesterSessionKey: "agent:main:main",
        endedAt: 101,
        cleanupCompletedAt: undefined,
      }),
    ]);

    expect(
      countPendingDescendantRunsExcludingRunFromRuns(runs, "agent:main:main", "run-self"),
    ).toBe(1);
    expect(
      countPendingDescendantRunsExcludingRunFromRuns(runs, "agent:main:main", "run-sibling"),
    ).toBe(1);
  });

  it("counts ended orchestrators with pending descendants as active", () => {
    const parentSessionKey = "agent:main:subagent:orchestrator";
    const runs = toRunMap([
      makeRun({
        runId: "run-parent-ended",
        childSessionKey: parentSessionKey,
        requesterSessionKey: "agent:main:main",
        endedAt: 100,
        cleanupCompletedAt: undefined,
      }),
      makeRun({
        runId: "run-child-active",
        childSessionKey: `${parentSessionKey}:subagent:child`,
        requesterSessionKey: parentSessionKey,
      }),
    ]);

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);

    runs.set(
      "run-child-active",
      makeRun({
        runId: "run-child-active",
        childSessionKey: `${parentSessionKey}:subagent:child`,
        requesterSessionKey: parentSessionKey,
        endedAt: 150,
        cleanupCompletedAt: 160,
      }),
    );

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(0);
  });

  it("dedupes stale and current rows for the same child session when counting active runs", () => {
    const childSessionKey = "agent:main:subagent:orch-restarted";
    const runs = toRunMap([
      makeRun({
        runId: "run-old",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 100,
        startedAt: 100,
        endedAt: 150,
        cleanupCompletedAt: undefined,
      }),
      makeRun({
        runId: "run-current",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 200,
        startedAt: 200,
      }),
      makeRun({
        runId: "run-descendant-active",
        childSessionKey: `${childSessionKey}:subagent:child`,
        requesterSessionKey: childSessionKey,
        createdAt: 210,
        startedAt: 210,
      }),
    ]);

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);
  });

  it("scopes direct child listings to the requester run window when requesterRunId is provided", () => {
    const requesterSessionKey = "agent:main:subagent:orchestrator";
    const runs = toRunMap([
      makeRun({
        runId: "run-parent-old",
        childSessionKey: requesterSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 100,
        startedAt: 100,
        endedAt: 150,
      }),
      makeRun({
        runId: "run-parent-current",
        childSessionKey: requesterSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 200,
        startedAt: 200,
        endedAt: 260,
      }),
      makeRun({
        runId: "run-child-stale",
        childSessionKey: `${requesterSessionKey}:subagent:stale`,
        requesterSessionKey,
        createdAt: 130,
      }),
      makeRun({
        runId: "run-child-current-a",
        childSessionKey: `${requesterSessionKey}:subagent:current-a`,
        requesterSessionKey,
        createdAt: 210,
      }),
      makeRun({
        runId: "run-child-current-b",
        childSessionKey: `${requesterSessionKey}:subagent:current-b`,
        requesterSessionKey,
        createdAt: 220,
      }),
      makeRun({
        runId: "run-child-future",
        childSessionKey: `${requesterSessionKey}:subagent:future`,
        requesterSessionKey,
        createdAt: 270,
      }),
    ]);

    const scoped = listRunsForRequesterFromRuns(runs, requesterSessionKey, {
      requesterRunId: "run-parent-current",
    });
    const scopedRunIds = scoped.map((entry) => entry.runId).toSorted();

    expect(scopedRunIds).toEqual(["run-child-current-a", "run-child-current-b"]);
  });

  it("regression post-completion gating, run-mode sessions ignore late announces after cleanup completes", () => {
    // Regression guard: late descendant announces must not reopen run-mode sessions
    // once their own completion cleanup has fully finished.
    const childSessionKey = "agent:main:subagent:orchestrator";
    const runs = toRunMap([
      makeRun({
        runId: "run-older",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 1,
        endedAt: 10,
        cleanupCompletedAt: 11,
        spawnMode: "run",
      }),
      makeRun({
        runId: "run-latest",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 2,
        endedAt: 20,
        cleanupCompletedAt: 21,
        spawnMode: "run",
      }),
    ]);

    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, childSessionKey)).toBe(true);
  });

  it("keeps run-mode orchestrators announce-eligible while waiting on child completions", () => {
    const parentSessionKey = "agent:main:subagent:orchestrator";
    const childOneSessionKey = `${parentSessionKey}:subagent:child-one`;
    const childTwoSessionKey = `${parentSessionKey}:subagent:child-two`;

    const runs = toRunMap([
      makeRun({
        runId: "run-parent",
        childSessionKey: parentSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 1,
        endedAt: 100,
        cleanupCompletedAt: undefined,
        spawnMode: "run",
      }),
      makeRun({
        runId: "run-child-one",
        childSessionKey: childOneSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 2,
        endedAt: 110,
        cleanupCompletedAt: undefined,
      }),
      makeRun({
        runId: "run-child-two",
        childSessionKey: childTwoSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 3,
        endedAt: 111,
        cleanupCompletedAt: undefined,
      }),
    ]);

    expect(resolveRequesterForChildSessionFromRuns(runs, childOneSessionKey)).toMatchObject({
      requesterSessionKey: parentSessionKey,
    });
    expect(resolveRequesterForChildSessionFromRuns(runs, childTwoSessionKey)).toMatchObject({
      requesterSessionKey: parentSessionKey,
    });
    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, parentSessionKey)).toBe(
      false,
    );

    runs.set(
      "run-child-one",
      makeRun({
        runId: "run-child-one",
        childSessionKey: childOneSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 2,
        endedAt: 110,
        cleanupCompletedAt: 120,
      }),
    );
    runs.set(
      "run-child-two",
      makeRun({
        runId: "run-child-two",
        childSessionKey: childTwoSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 3,
        endedAt: 111,
        cleanupCompletedAt: 121,
      }),
    );

    const childThreeSessionKey = `${parentSessionKey}:subagent:child-three`;
    runs.set(
      "run-child-three",
      makeRun({
        runId: "run-child-three",
        childSessionKey: childThreeSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 4,
      }),
    );

    expect(resolveRequesterForChildSessionFromRuns(runs, childThreeSessionKey)).toMatchObject({
      requesterSessionKey: parentSessionKey,
    });
    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, parentSessionKey)).toBe(
      false,
    );

    runs.set(
      "run-child-three",
      makeRun({
        runId: "run-child-three",
        childSessionKey: childThreeSessionKey,
        requesterSessionKey: parentSessionKey,
        createdAt: 4,
        endedAt: 122,
        cleanupCompletedAt: 123,
      }),
    );

    runs.set(
      "run-parent",
      makeRun({
        runId: "run-parent",
        childSessionKey: parentSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 1,
        endedAt: 100,
        cleanupCompletedAt: 130,
        spawnMode: "run",
      }),
    );

    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, parentSessionKey)).toBe(true);
  });

  it("regression post-completion gating, session-mode sessions keep accepting follow-up announces", () => {
    // Regression guard: persistent session-mode orchestrators must continue receiving child completions.
    const childSessionKey = "agent:main:subagent:orchestrator-session";
    const runs = toRunMap([
      makeRun({
        runId: "run-session",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        createdAt: 3,
        endedAt: 30,
        spawnMode: "session",
      }),
    ]);

    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, childSessionKey)).toBe(false);
  });
});

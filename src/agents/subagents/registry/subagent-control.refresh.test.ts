/** A transient discovery failure must survive successful runtime cancellation. */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun, startQueuedSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it("retains a captured child prefix when the next child's parent identity read fails", async () => {
  const owner = "agent:main:main";
  const rootKey = "agent:main:subagent:prefix-root";
  const firstKey = "agent:main:subagent:prefix-first";
  const secondKey = "agent:main:subagent:prefix-second";
  const healthyKey = "agent:main:subagent:prefix-healthy";
  let storePath = "";
  for (const [runId, sessionKey, requesterSessionKey, queued] of [
    ["prefix-root", rootKey, owner, false],
    ["prefix-first", firstKey, rootKey, true],
    ["prefix-second", secondKey, rootKey, true],
    ["prefix-healthy", healthyKey, owner, false],
  ] as const) {
    storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: `${runId}-session`,
    });
    registerSubagentRun({
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey,
      controllerSessionKey: requesterSessionKey,
      requesterAgentId: "main",
      requesterDisplayKey: requesterSessionKey,
      task: runId,
      cleanup: "keep",
      collect: true,
      queued,
      expectsCompletionMessage: false,
    });
  }
  const firstStart = vi.fn(async () => {});
  const secondStart = vi.fn(async () => {});
  const unrelatedStart = vi.fn(async () => {});
  for (const [runId, start] of [
    ["prefix-first", firstStart],
    ["prefix-second", secondStart],
  ] as const) {
    enqueueSwarmRun({
      groupId: "prefix",
      runId,
      maxConcurrent: 1,
      activeRunIds: ["prefix-root"],
      start,
      onStartFailure: () => true,
    });
  }
  enqueueSwarmRun({
    groupId: "unrelated-prefix",
    runId: "unrelated-prefix",
    maxConcurrent: 1,
    activeRunIds: ["unrelated-active"],
    start: unrelatedStart,
    onStartFailure: () => true,
  });
  const exactRead = sessions.loadExactSessionEntryReadOnly;
  let capturedFirst = false;
  let failedReads = 0;
  const failure = "next child parent identity unavailable";
  vi.spyOn(sessions, "loadExactSessionEntryReadOnly").mockImplementation((scope) => {
    if (capturedFirst && scope.sessionKey === rootKey && failedReads === 0) {
      failedReads += 1;
      throw new Error(failure);
    }
    const result = exactRead(scope);
    if (scope.sessionKey === firstKey) {
      capturedFirst = true;
    }
    return result;
  });
  const result = await killAllControlledSubagentRuns({
    cfg: getRuntimeConfig(),
    controller: {
      controllerSessionKey: owner,
      controllerAgentId: "main",
      callerSessionKey: owner,
      callerIsSubagent: false,
      controlScope: "children",
    },
    runs: [subagentRuns.get("prefix-root")!, subagentRuns.get("prefix-healthy")!],
    beforeKill: () => {
      releaseSwarmRun("unrelated-active");
      return true;
    },
  });
  expect(failedReads).toBe(1);
  expect(
    sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: rootKey })?.entry,
  ).toBeDefined();
  expect(result).toMatchObject({
    status: "error",
    failed: 1,
    error: expect.stringContaining(failure),
  });
  expect(
    firstStart,
    "an already captured reservation cannot escape on scope disposal",
  ).not.toHaveBeenCalled();
  expect(findTaskByRunId("prefix-first")?.status).toBe("cancelled");
  expect(findTaskByRunId("prefix-second")?.status).not.toBe("cancelled");
  expect(findTaskByRunId("prefix-healthy")?.status).toBe("cancelled");
  expect(unrelatedStart).toHaveBeenCalledOnce();
});

// Sweep a bounded set of real reads after admission interruption, not a private
// refresh API or a fixed expected read count. Every injected error must be visible.
it.each([
  ...[undefined, 1, 2, 3, 4].map((faultAt) => ({ phase: "ancestor drain", faultAt })),
  ...[undefined, 1].map((faultAt) => ({ phase: "later sibling drain", faultAt })),
])(
  "reports identity read $faultAt failure after $phase without losing descendant accounting",
  async ({ phase, faultAt }) => {
    const owner = "agent:main:main";
    const aKey = "agent:main:subagent:ancestor";
    const dKey = "agent:main:subagent:active-child";
    const gKey = "agent:main:subagent:late-grandchild";
    const healthyKey = "agent:main:subagent:healthy";
    let storePath = "";
    for (const [runId, sessionKey, requesterSessionKey] of [
      ["a", aKey, owner],
      ["d", dKey, aKey],
      ["healthy", healthyKey, owner],
      ["g", gKey, dKey],
    ] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
        lifecycleRevision: `${runId}-revision`,
      });
      if (runId !== "g") {
        registerSubagentRun({
          runId,
          childSessionKey: sessionKey,
          requesterSessionKey,
          controllerSessionKey: requesterSessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: requesterSessionKey,
          task: runId,
          cleanup: "keep",
          expectsCompletionMessage: false,
          collect: true,
        });
      }
    }
    const a = subagentRuns.get("a")!;
    const d = subagentRuns.get("d")!;
    const healthy = subagentRuns.get("healthy")!;
    const entered = createDeferred();
    const admissionA = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [aKey, "a-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const interruptD = vi.fn(() => admissionD.release());
    const admissionD = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [dKey, "d-session"],
      assertAllowed: () => {},
      onInterrupt: interruptD,
    });
    const healthyEntered = createDeferred();
    const admissionHealthy = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [healthyKey, "healthy-session"],
      assertAllowed: () => {},
      onInterrupt: () => {
        healthyEntered.resolve();
        if (phase === "ancestor drain") {
          admissionHealthy.release();
        }
      },
    });
    const abortA = vi.fn();
    const abortD = vi.fn(() => {
      expect(releaseSwarmRun("d")).toBe(true);
    });
    const handleA = createEmbeddedRunHandle({ runId: "a", abort: abortA });
    const handleD = createEmbeddedRunHandle({ runId: "d", abort: abortD });
    setActiveEmbeddedRun("a-session", handleA, aKey);
    setActiveEmbeddedRun("d-session", handleD, dKey);
    const startG = vi.fn(async () => {
      expect(startQueuedSubagentRun("g")).toBe(true);
    });
    const startFailure = vi.fn(() => true);
    const exactRead = sessions.loadExactSessionEntryReadOnly;
    let armed = false;
    let reads = 0;
    let failedReads = 0;
    let recoveredReads = 0;
    const failure = "transient ancestor identity read failure";
    const reader = vi
      .spyOn(sessions, "loadExactSessionEntryReadOnly")
      .mockImplementation((scope) => {
        if (armed && scope.sessionKey === aKey) {
          reads += 1;
          if (reads === faultAt) {
            failedReads += 1;
            throw new Error(failure);
          }
          const result = exactRead(scope);
          if (failedReads > 0 && result?.entry.sessionId === "a-session") {
            recoveredReads += 1;
          }
          return result;
        }
        return exactRead(scope);
      });
    const pending = killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller: {
        controllerSessionKey: owner,
        controllerAgentId: "main",
        callerSessionKey: owner,
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [a, healthy],
    });
    try {
      await entered.promise;
      expect(failedReads, "initial binding and iteration entered without a fault").toBe(0);
      expect(abortA).not.toHaveBeenCalled();
      expect(interruptD, "D remains admitted while A drains").not.toHaveBeenCalled();
      expect(d.execution.status).toBe("running");
      expect(subagentRuns.has("g")).toBe(false);
      // D, not the interrupted ancestor A, owns this accepted late registration.
      await admissionD.run(async () => {
        registerSubagentRun({
          runId: "g",
          childSessionKey: gKey,
          requesterSessionKey: dKey,
          controllerSessionKey: dKey,
          requesterAgentId: "main",
          requesterDisplayKey: dKey,
          task: "late grandchild",
          cleanup: "keep",
          expectsCompletionMessage: false,
          collect: true,
          queued: true,
        });
        enqueueSwarmRun({
          groupId: "late-refresh",
          runId: "g",
          maxConcurrent: 1,
          activeRunIds: ["d"],
          start: startG,
          onStartFailure: startFailure,
        });
      });
      expect(startG).not.toHaveBeenCalled();
      armed = phase === "ancestor drain";
      admissionA.release();
      if (phase === "later sibling drain") {
        await healthyEntered.promise;
        await vi.waitFor(() => {
          expect(a.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
          expect(d.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
          expect(findTaskByRunId("g")?.status).toBe("cancelled");
        });
        expect(startG).not.toHaveBeenCalled();
        armed = true;
        admissionHealthy.release();
      }
      const result = await pending;
      expect(healthy.endedReason, "independent healthy sibling still stops").toBe(
        SUBAGENT_ENDED_REASON_KILLED,
      );
      expect(startFailure).not.toHaveBeenCalled();
      if (faultAt === undefined) {
        expect(result).toMatchObject({ status: "ok", killed: 4 });
        expect(findTaskByRunId("g")?.status).toBe("cancelled");
        expect(startG).not.toHaveBeenCalled();
      } else {
        expect(failedReads, "exactly one transient I/O fault").toBe(1);
        expect(
          sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: aKey })?.entry.sessionId,
        ).toBe("a-session");
        expect(recoveredReads, "real accessor succeeds again after the fault").toBeGreaterThan(0);
        const observation = JSON.stringify({
          phase,
          faultAt,
          failedReads,
          recoveredReads,
          aKilled: a.endedReason,
          dKilled: d.endedReason,
          healthyKilled: healthy.endedReason,
          gTask: findTaskByRunId("g")?.status,
          gExecution: subagentRuns.get("g")?.execution.status,
          gDispatches: startG.mock.calls.length,
          result,
        });
        expect(result, observation).toMatchObject({
          status: "error",
          failed: 1,
          error: expect.stringContaining(failure),
        });
      }
    } finally {
      armed = false;
      admissionA.release();
      admissionD.release();
      admissionHealthy.release();
      try {
        await pending;
      } finally {
        reader.mockRestore();
        releaseSwarmRun("d");
        releaseSwarmRun("g");
        clearActiveEmbeddedRun("a-session", handleA, aKey);
        clearActiveEmbeddedRun("d-session", handleD, dKey);
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

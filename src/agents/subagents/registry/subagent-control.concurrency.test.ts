import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it.each(["bulk", "admin"] as const)(
  "%s cancellation interrupts every sibling before waiting for any sibling to drain",
  async (boundary) => {
    const requester = "agent:main:main";
    const sessionKey = (id: string) => `agent:main:subagent:${id}`;
    const owner = boundary === "admin" ? sessionKey("root") : requester;
    const running = Array.from({ length: 8 }, (_, index) => `running-${index}`);
    const queued = ["queued-0", "queued-1"];
    const selected = [...running, ...queued];
    let storePath = "";
    for (const id of boundary === "admin" ? ["root", ...selected] : selected) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: sessionKey(id),
        defaultSessionId: `${id}-session`,
      });
      registerSubagentRun({
        runId: id,
        childSessionKey: sessionKey(id),
        requesterSessionKey: id === "root" ? requester : owner,
        requesterAgentId: "main",
        requesterDisplayKey: requester,
        task: id,
        cleanup: "keep",
        collect: true,
        queued: queued.includes(id),
        expectsCompletionMessage: false,
      });
    }
    const start = vi.fn(async () => {});
    for (const runId of queued) {
      enqueueSwarmRun({
        groupId: "sibling-cancellation",
        runId,
        maxConcurrent: running.length,
        activeRunIds: running,
        start,
        onStartFailure: () => true,
      });
    }
    const interrupted: string[] = [];
    const firstInterrupted = createDeferred();
    const leases: SessionWorkAdmissionLease[] = [];
    const activeRuns = running.map((runId) => ({
      runId,
      handle: createEmbeddedRunHandle({ runId }),
    }));
    for (const { runId, handle } of activeRuns) {
      setActiveEmbeddedRun(`${runId}-session`, handle, sessionKey(runId));
      leases.push(
        await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey(runId), `${runId}-session`],
          assertAllowed: () => {},
          onInterrupt: () => {
            interrupted.push(runId);
            firstInterrupted.resolve();
            // Cancellation releases real scheduler capacity while these admissions
            // remain held. Selected queued children must still never dispatch.
            expect(releaseSwarmRun(runId)).toBe(true);
          },
        }),
      );
    }
    const cfg = getRuntimeConfig();
    const pending =
      boundary === "admin"
        ? killSubagentRunAdmin({ cfg, sessionKey: owner, expectedRunId: "root" })
        : killAllControlledSubagentRuns({
            cfg,
            controller: {
              controllerSessionKey: owner,
              controllerAgentId: "main",
              callerSessionKey: owner,
              callerIsSubagent: false,
              controlScope: "children",
            },
            runs: selected.map((id) => subagentRuns.get(id)!),
          });
    try {
      await firstInterrupted.promise;
      await vi.waitFor(() => expect(interrupted.toSorted()).toEqual(running));
      expect(getActiveSessionWorkAdmissionCount()).toBe(running.length);
      expect(start).not.toHaveBeenCalled();
      for (const lease of leases.toReversed()) {
        lease.release();
      }
      const result = await pending;
      expect(result).toMatchObject(
        boundary === "admin"
          ? { found: true, killed: true, cascadeKilled: selected.length, cascadeLabels: selected }
          : { status: "ok", killed: selected.length, labels: selected },
      );
      for (const id of selected) {
        expect(findTaskByRunId(id)?.status).toBe("cancelled");
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      for (const lease of leases) {
        lease.release();
      }
      await pending;
      for (const { runId, handle } of activeRuns) {
        clearActiveEmbeddedRun(`${runId}-session`, handle, sessionKey(runId));
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

it.each(["after interrupt", "before capacity release"] as const)(
  "keeps a late descendant queued when registered %s on an independent sibling that releases first",
  async (registration) => {
    const owner = "agent:main:main";
    const key = (id: string) => `agent:main:subagent:${id}`;
    const parents = { a: owner, b: owner, d: key("a"), x: key("d"), g: key("d") };
    let storePath = "";
    const register = (id: keyof typeof parents, queued = false) =>
      registerSubagentRun({
        runId: id,
        childSessionKey: key(id),
        requesterSessionKey: parents[id],
        controllerSessionKey: parents[id],
        swarmRequesterSessionKey: parents[id],
        requesterAgentId: "main",
        requesterDisplayKey: parents[id],
        groupId: "shared-name",
        task: id,
        cleanup: "keep",
        collect: true,
        queued,
        expectsCompletionMessage: false,
      });
    for (const id of ["a", "b", "d", "x", "g"] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: key(id),
        defaultSessionId: `${id}-session`,
      });
      if (id !== "g") {
        register(id);
      }
    }
    const unrelatedStart = vi.fn(async () => {});
    const startG = vi.fn(async () => {});
    const startFailure = vi.fn(() => true);
    enqueueSwarmRun({
      groupId: JSON.stringify(["main", owner, "shared-name"]),
      runId: "unrelated",
      maxConcurrent: 2,
      activeRunIds: ["a", "b"],
      start: unrelatedStart,
      onStartFailure: startFailure,
    });
    const aInterrupted = createDeferred();
    const bInterrupted = createDeferred();
    const bReleased = createDeferred();
    const admissionA = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("a"), "a-session"],
      assertAllowed: () => {},
      onInterrupt: () => aInterrupted.resolve(),
    });
    const admissionB = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("b"), "b-session"],
      assertAllowed: () => {},
      onInterrupt: () => bInterrupted.resolve(),
    });
    const interruptD = vi.fn(() => admissionD.release());
    const admissionD = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("d"), "d-session"],
      assertAllowed: () => {},
      onInterrupt: interruptD,
    });
    const registerG = () =>
      admissionD.run(async () => {
        register("g", true);
        enqueueSwarmRun({
          groupId: JSON.stringify(["main", key("d"), "shared-name"]),
          runId: "g",
          maxConcurrent: 1,
          activeRunIds: ["x"],
          start: startG,
          onStartFailure: startFailure,
        });
      });
    let lateRegistration: Promise<void> | undefined;
    const handleB = createEmbeddedRunHandle({
      runId: "b",
      abort: () => {
        if (registration === "before capacity release") {
          lateRegistration = registerG();
        }
        expect(releaseSwarmRun("b")).toBe(true);
        bReleased.resolve();
      },
    });
    const handleX = createEmbeddedRunHandle({
      runId: "x",
      abort: () => expect(releaseSwarmRun("x")).toBe(true),
    });
    setActiveEmbeddedRun("b-session", handleB, key("b"));
    setActiveEmbeddedRun("x-session", handleX, key("x"));
    const pending = killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller: {
        controllerSessionKey: owner,
        controllerAgentId: "main",
        callerSessionKey: owner,
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [subagentRuns.get("a")!, subagentRuns.get("b")!],
    });
    try {
      await Promise.all([aInterrupted.promise, bInterrupted.promise]);
      expect(interruptD).not.toHaveBeenCalled();
      // Register after B's refresh, including immediately before its capacity release.
      // Reusing a group name does not merge different callers' scheduler lanes.
      if (registration === "after interrupt") {
        lateRegistration = registerG();
        await lateRegistration;
      }
      admissionB.release();
      await bReleased.promise;
      expect(lateRegistration).toBeDefined();
      await lateRegistration;
      await vi.waitFor(() => expect(unrelatedStart).toHaveBeenCalledOnce());
      expect(interruptD).not.toHaveBeenCalled();
      expect(startG).not.toHaveBeenCalled();
      admissionA.release();
      expect(await pending).toMatchObject({
        status: "ok",
        killed: 5,
        labels: ["a", "d", "x", "g", "b"],
      });
      expect(findTaskByRunId("g")?.status).toBe("cancelled");
      expect(startG).not.toHaveBeenCalled();
      expect(startFailure).not.toHaveBeenCalled();
    } finally {
      admissionA.release();
      admissionB.release();
      admissionD.release();
      await pending;
      clearActiveEmbeddedRun("b-session", handleB, key("b"));
      clearActiveEmbeddedRun("x-session", handleX, key("x"));
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

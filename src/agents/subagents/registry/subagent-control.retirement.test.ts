/** Cancellation retains selected descendants across committed ancestor retirement. */
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.test-support.js";
import { getTaskById, findTaskByRunId } from "../../../tasks/task-registry.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun, markSubagentRunTerminated } from "./subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { releaseSubagentRun, testing } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();
const { persist, gateway } = fixture;

it.each([
  { transition: "normal retirement", cancel: true },
  { transition: "retirement with retained predecessor", cancel: true },
  { transition: "retirement write rollback", cancel: true },
  { transition: "successor registration write rollback", cancel: true },
  { transition: "successor required-task rollback", cancel: true },
  { transition: "accepted successor released", cancel: false },
  { transition: "accepted successor released without retirement", cancel: false },
  { transition: "retained successor after failed rollback", cancel: false },
  { transition: "session replacement", cancel: false },
  { transition: "lifecycle rotation", cancel: false },
  { transition: "controller replacement", cancel: false },
  { transition: "explicit release without retirement", cancel: false },
  { transition: "new direct child after retirement", cancel: true },
])(
  "preserves captured cancellation ownership through $transition",
  async ({ transition, cancel }) => {
    const controllerSessionKey = "agent:main:main";
    const ancestorKey = "agent:main:subagent:retiring-ancestor";
    const childKey = "agent:main:subagent:captured-child";
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: ancestorKey,
      defaultSessionId: "ancestor-session",
    });
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childKey,
      defaultSessionId: "child-session",
    });
    if (transition === "retirement with retained predecessor") {
      registerSubagentRun({
        runId: "predecessor",
        childSessionKey: ancestorKey,
        requesterSessionKey: controllerSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "older reservation",
        cleanup: "keep",
        expectsCompletionMessage: false,
        collect: true,
        queued: true,
      });
    }
    for (const [runId, childSessionKey, owner, collect] of [
      ["ancestor", ancestorKey, controllerSessionKey, false],
      ["child", childKey, ancestorKey, true],
    ] as const) {
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: owner,
        controllerSessionKey: owner,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: runId,
        cleanup: "keep",
        expectsCompletionMessage: false,
        collect,
        queued: collect,
      });
    }
    const ancestor = subagentRuns.get("ancestor")!;
    const child = subagentRuns.get("child")!;
    const task = findTaskByRunId("child")!;
    expect(markSubagentRunTerminated({ runId: "ancestor", suppressTaskDelivery: true })).toBe(1);
    expect(ancestor.killReconciliation).toMatchObject({
      killedAt: now,
      suppressTaskDelivery: true,
    });
    expect(subagentRuns.get("ancestor")).toBe(ancestor);
    const dispatch = vi.fn(async () => {});
    const lateDispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "lane",
      runId: "child",
      maxConcurrent: 1,
      activeRunIds: ["blocker"],
      start: dispatch,
      onStartFailure: () => true,
    });
    try {
      const result = await killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: {
          controllerSessionKey,
          controllerAgentId: "main",
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [ancestor],
        beforeKill: async () => {
          // The retry already holds the child. Real reconciliation, not a map edit,
          // now retires the aged keep-mode ancestor while partial persistence awaits.
          clock.mockReturnValue(now + PROVISIONAL_KILL_RECONCILIATION_MS);
          if (transition === "explicit release without retirement") {
            releaseSubagentRun("ancestor");
          } else if (transition === "accepted successor released without retirement") {
            expect(subagentRuns.get("ancestor")).toBe(ancestor);
          } else {
            let retirementRejected = false;
            if (transition === "retirement write rollback") {
              persist.mockImplementation((runs, ids) => {
                if (!runs.has("ancestor")) {
                  retirementRejected = true;
                  throw new Error("retirement write rejected");
                }
                persistSubagentRunsToDiskOrThrow(runs, ids);
              });
            }
            await testing.sweepOnceForTests();
            if (transition === "retirement write rollback") {
              await vi.waitFor(() => expect(retirementRejected).toBe(true));
              await settleSubagentRegistryPersistenceWork();
              expect(subagentRuns.get("ancestor")).toBe(ancestor);
              persist.mockImplementation(persistSubagentRunsToDiskOrThrow);
            } else {
              await vi.waitFor(() => expect(subagentRuns.has("ancestor")).toBe(false));
            }
          }
          if (transition.includes("successor")) {
            const taskRuntime = getDetachedTaskLifecycleRuntime();
            const failTask =
              transition.includes("required-task") || transition.includes("failed rollback");
            if (failTask) {
              setDetachedTaskLifecycleRuntime({
                ...taskRuntime,
                createQueuedTaskRun: () => {
                  expect(subagentRuns.has("successor")).toBe(true);
                  expect(loadSubagentRegistryFromSqlite().has("successor")).toBe(true);
                  throw new Error("required task rejected");
                },
              });
            }
            persist.mockImplementation((runs, ids) => {
              if (
                transition === "successor registration write rollback" ||
                (transition === "retained successor after failed rollback" &&
                  !runs.has("successor"))
              ) {
                throw new Error("registration write rejected");
              }
              persistSubagentRunsToDiskOrThrow(runs, ids);
            });
            const register = () =>
              registerSubagentRun({
                runId: "successor",
                childSessionKey: ancestorKey,
                requesterSessionKey: controllerSessionKey,
                requesterAgentId: "main",
                requesterDisplayKey: "main",
                task: "successor",
                cleanup: "keep",
                queued: true,
                expectsCompletionMessage: false,
                taskRowOwnership: "required",
              });
            try {
              if (transition.startsWith("accepted successor")) {
                register();
              } else {
                expect(register).toThrow(/rejected/);
              }
              if (cancel) {
                expect(subagentRuns.has("successor")).toBe(false);
                expect(loadSubagentRegistryFromSqlite().has("successor")).toBe(false);
              } else {
                expect(subagentRuns.get("successor")?.childSessionKey).toBe(ancestorKey);
                persist.mockImplementation(persistSubagentRunsToDiskOrThrow);
                releaseSubagentRun("successor");
              }
            } finally {
              setDetachedTaskLifecycleRuntime(taskRuntime);
              persist.mockImplementation(persistSubagentRunsToDiskOrThrow);
            }
          } else if (transition === "session replacement") {
            await replaceSessionEntry(
              { storePath, sessionKey: ancestorKey },
              {
                sessionId: "replacement-session",
                updatedAt: Date.now(),
              },
            );
          } else if (transition === "lifecycle rotation") {
            rotateAgentEventLifecycleGeneration();
          } else if (transition === "controller replacement") {
            ancestor.controllerSessionKey = "agent:other:main";
          } else if (transition === "new direct child after retirement") {
            registerSubagentRun({
              runId: "late",
              childSessionKey: "agent:main:subagent:late-child",
              requesterSessionKey: ancestorKey,
              requesterAgentId: "main",
              requesterDisplayKey: "main",
              task: "late",
              cleanup: "keep",
              queued: true,
              expectsCompletionMessage: false,
              collect: true,
            });
            enqueueSwarmRun({
              groupId: "late-lane",
              runId: "late",
              maxConcurrent: 1,
              activeRunIds: [],
              start: lateDispatch,
              onStartFailure: () => true,
            });
          }
          expect(loadSessionEntry({ storePath, sessionKey: ancestorKey })).toBeDefined();
          expect(gateway.mock.calls.some(([request]) => request.method === "sessions.delete")).toBe(
            false,
          );
          expect(releaseSwarmRun("blocker")).toBe(true);
          await Promise.resolve();
          expect(dispatch).not.toHaveBeenCalled();
          return true;
        },
      });
      expect(result).toMatchObject({ status: "ok", killed: cancel ? 1 : 0 });
      if (cancel) {
        expect(child.collectorCompletion?.status).toBe("killed");
        expect(getTaskById(task.taskId)?.status).toBe("cancelled");
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(child.killIntent).toBeUndefined();
        expect(child.collectorCompletion).toBeUndefined();
        expect(getTaskById(task.taskId)?.status).toBe("queued");
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      }
      if (transition === "retirement with retained predecessor") {
        expect(subagentRuns.get("predecessor")?.execution.status).toBe("queued");
      }
      if (transition === "new direct child after retirement") {
        expect(lateDispatch).toHaveBeenCalledOnce();
        expect(subagentRuns.get("late")?.killIntent).toBeUndefined();
        expect(findTaskByRunId("late")?.status).toBe("queued");
      }
    } finally {
      releaseSwarmRun("blocker");
      releaseSwarmRun("child");
      releaseSwarmRun("late");
    }
  },
);

it.each(
  (["bulk", "admin"] as const).flatMap((boundary) =>
    ["ordinary retirement", "session replacement", "lifecycle rotation", "owner replacement"].map(
      (transition) => ({ boundary, transition }),
    ),
  ),
)("handles $transition during $boundary admission drain", async ({ boundary, transition }) => {
  const controllerSessionKey = "agent:main:main";
  const ancestorKey = "agent:main:subagent:draining-ancestor";
  const childKey = "agent:main:subagent:draining-child";
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: ancestorKey,
    defaultSessionId: "draining-ancestor-session",
  });
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey,
    defaultSessionId: "draining-child-session",
  });
  for (const [runId, childSessionKey, owner, collect] of [
    ["draining-ancestor", ancestorKey, controllerSessionKey, false],
    ["draining-child", childKey, ancestorKey, true],
  ] as const) {
    registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: owner,
      controllerSessionKey: owner,
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: runId,
      cleanup: "keep",
      expectsCompletionMessage: false,
      collect,
      queued: collect,
    });
  }
  const ancestor = subagentRuns.get("draining-ancestor")!;
  const child = subagentRuns.get("draining-child")!;
  const entered = createDeferred();
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [ancestorKey, "draining-ancestor-session"],
    assertAllowed: () => {},
    onInterrupt: () => entered.resolve(),
  });
  const dispatch = vi.fn(async () => {});
  enqueueSwarmRun({
    groupId: "draining-lane",
    runId: child.runId,
    maxConcurrent: 1,
    activeRunIds: ["draining-blocker"],
    start: dispatch,
    onStartFailure: () => true,
  });
  const cfg = getRuntimeConfig();
  const controller = {
    controllerSessionKey,
    controllerAgentId: "main",
    callerSessionKey: controllerSessionKey,
    callerIsSubagent: false,
    controlScope: "children" as const,
  };
  const pending =
    boundary === "bulk"
      ? killAllControlledSubagentRuns({ cfg, controller, runs: [ancestor] })
      : killSubagentRunAdmin({
          cfg,
          sessionKey: ancestorKey,
          expectedRunId: ancestor.runId,
          expectedGeneration: ancestor.generation,
          expectedOwnerKey: controllerSessionKey,
        });
  try {
    await entered.promise;
    // Independent canonical termination during the drain, followed by modeled
    // reconciliation ageing. A fresh provisional kill must still retain its row.
    expect(markSubagentRunTerminated({ runId: ancestor.runId, suppressTaskDelivery: true })).toBe(
      1,
    );
    expect(subagentRuns.get(ancestor.runId)).toBe(ancestor);
    expect(ancestor.killReconciliation?.killedAt).toBe(now);
    clock.mockReturnValue(now + PROVISIONAL_KILL_RECONCILIATION_MS);
    await testing.sweepOnceForTests();
    await vi.waitFor(() => expect(subagentRuns.has(ancestor.runId)).toBe(false));
    expect(loadSessionEntry({ storePath, sessionKey: ancestorKey })?.sessionId).toBe(
      "draining-ancestor-session",
    );
    if (transition === "session replacement") {
      await replaceSessionEntry(
        { storePath, sessionKey: ancestorKey },
        { sessionId: "replacement-session", updatedAt: Date.now() },
      );
    } else if (transition === "lifecycle rotation") {
      rotateAgentEventLifecycleGeneration();
    } else if (transition === "owner replacement") {
      ancestor.controllerSessionKey = "agent:other:main";
      ancestor.requesterSessionKey = "agent:other:main";
    }
    expect(releaseSwarmRun("draining-blocker")).toBe(true);
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    admission.release();
    const result = await pending;
    expect(subagentRuns.has(ancestor.runId)).toBe(false);
    if (transition !== "ordinary retirement") {
      expect(child.killIntent).toBeUndefined();
      expect(child.collectorCompletion).toBeUndefined();
      expect(findTaskByRunId(child.runId)?.status).toBe("queued");
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      return;
    }
    expect(child.collectorCompletion?.status, JSON.stringify(result)).toBe("killed");
    expect(findTaskByRunId(child.runId)?.status).toBe("cancelled");
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject(
      boundary === "bulk"
        ? { status: "ok", killed: 1 }
        : { found: true, killed: true, cascadeKilled: 1 },
    );
  } finally {
    admission.release();
    await pending;
    releaseSwarmRun("draining-blocker");
    releaseSwarmRun(child.runId);
  }
});

it.each(["default", "template", "fixed JSON-style", "exact SQLite"])(
  "signals the non-main runtime owner in a %s session store",
  async (layout) => {
    const store =
      layout === "default"
        ? undefined
        : layout === "template"
          ? path.join(fixture.stateDir, "stores", "{agentId}", "sessions.json")
          : path.join(
              fixture.stateDir,
              "fixed",
              layout === "exact SQLite" ? "shared.sqlite" : "sessions.json",
            );
    const storePath = resolveSessionStorePathCore(store, { agentId: "other" });
    const mainStorePath = resolveSessionStorePathCore(store, { agentId: "main" });
    const childSessionKey = "agent:other:subagent:fixed-store-child";
    const sessionId = "fixed-store-child-session";
    await replaceSessionEntry(
      { storePath: mainStorePath, sessionKey: "agent:main:main" },
      { sessionId: "main-session", updatedAt: Date.now() },
    );
    await replaceSessionEntry(
      { storePath, sessionKey: childSessionKey },
      { sessionId, updatedAt: Date.now() },
    );
    registerSubagentRun({
      runId: "fixed-store-child",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "cross-agent child",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, runId: "fixed-store-child" });
    setActiveEmbeddedRun(sessionId, handle, childSessionKey);
    try {
      const result = await killAllControlledSubagentRuns({
        cfg: { ...getRuntimeConfig(), session: { store } },
        controller: {
          controllerSessionKey: "agent:main:main",
          controllerAgentId: "main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [subagentRuns.get("fixed-store-child")!],
      });
      expect(abort, JSON.stringify(result)).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ status: "ok", killed: 1 });
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })?.abortedLastRun).toBe(
        true,
      );
      expect(
        loadSessionEntry({ storePath: mainStorePath, sessionKey: "agent:main:main" })
          ?.abortedLastRun,
      ).toBeUndefined();
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, childSessionKey);
    }
  },
);

it("does not create a missing child database while binding cancellation", async () => {
  const childSessionKey = "agent:missing:subagent:unprepared";
  const databasePath = path.join(fixture.stateDir, "agents/missing/agent/openclaw-agent.sqlite");
  registerSubagentRun({
    runId: "unprepared",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "missing session",
    cleanup: "keep",
    collect: true,
    queued: true,
    expectsCompletionMessage: false,
  });
  const dispatch = vi.fn(async () => {});
  enqueueSwarmRun({
    groupId: "missing-lane",
    runId: "unprepared",
    maxConcurrent: 1,
    activeRunIds: ["missing-blocker"],
    start: dispatch,
    onStartFailure: () => true,
  });
  expect(existsSync(databasePath)).toBe(false);
  try {
    await expect(
      killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: {
          controllerSessionKey: "agent:main:main",
          controllerAgentId: "main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [subagentRuns.get("unprepared")!],
        beforeKill: async () => {
          expect(existsSync(databasePath)).toBe(false);
          releaseSwarmRun("missing-blocker");
          await Promise.resolve();
          expect(dispatch).not.toHaveBeenCalled();
          throw new Error("partial persistence refused");
        },
      }),
    ).rejects.toThrow("partial persistence refused");
    expect(existsSync(databasePath)).toBe(false);
    expect(subagentRuns.get("unprepared")?.killIntent).toBeUndefined();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  } finally {
    releaseSwarmRun("missing-blocker");
    releaseSwarmRun("unprepared");
  }
});

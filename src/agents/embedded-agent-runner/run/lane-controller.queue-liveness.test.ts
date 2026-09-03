import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  isAgentRunWaitingForCapacity,
  registerAgentRunCapacityWait,
} from "../../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  readAgentRunIndexVersion,
  registerAgentRunContext,
  sweepStaleRunContexts,
} from "../../../infra/agent-run-registry.js";
import {
  clearCommandLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { installSessionPlacementAdmissionProvider } from "../../session-placement-admission.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const CONTEXT_TTL_MS = 30 * 60 * 1000;
const SESSION_LANE = "queued-run-context-session";
const GLOBAL_LANE = "queued-run-context-global";

function createRunResult(): EmbeddedAgentRunResult {
  return { meta: { durationMs: 1 } };
}

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during queue liveness test");
}

function createRunController(overrides: Partial<RunEmbeddedAgentParams> = {}) {
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  const runId = overrides.runId ?? "healthy-queued-run";
  let params: RunEmbeddedAgentParams & { sessionFile: string } = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    lifecycleGeneration,
    prompt: "queued run",
    runId,
    sessionFile: "/tmp/queued-run.jsonl",
    sessionId: "queued-session",
    timeoutMs: 60_000,
    workspaceDir: "/tmp",
    ...overrides,
  };
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane: GLOBAL_LANE,
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: SESSION_LANE,
    setLifecycleGeneration: (updated) => {
      lifecycleGeneration = updated;
    },
    setParams: (updated) => {
      params = updated;
    },
  });
  return { controller, params };
}

async function waitForQueuedLane(lane: string): Promise<void> {
  for (let turn = 0; turn < 10 && getCommandLaneSnapshot(lane).queuedCount === 0; turn++) {
    await Promise.resolve();
  }
  expect(getCommandLaneSnapshot(lane).queuedCount).toBe(1);
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  vi.restoreAllMocks();
});

describe("queued embedded run context liveness", () => {
  test.each([
    { blockedLane: SESSION_LANE, queue: "session" },
    { blockedLane: GLOBAL_LANE, queue: "global" },
  ])(
    "retains a healthy run past the context TTL while the $queue lane is full",
    async ({ blockedLane }) => {
      const registeredAt = 1_000;
      const admissionAt = registeredAt + CONTEXT_TTL_MS + 1;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const { controller, params } = createRunController();

      registerAgentRunContext(params.runId, {
        agentId: "main",
        isControlUiVisible: false,
        lifecycleGeneration,
        registeredAt,
        sessionKey: "agent:main:subagent:queued",
      });
      registerAgentRunContext("abandoned-run", {
        lifecycleGeneration,
        registeredAt,
        sessionKey: "agent:main:subagent:abandoned",
      });
      setCommandLaneConcurrency(blockedLane, 0);

      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => createRunResult()),
      );

      try {
        await waitForQueuedLane(blockedLane);

        clock.mockReturnValue(admissionAt);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext("abandoned-run")).toBeUndefined();
        expect(getAgentRunContext(params.runId)).toMatchObject({ lifecycleGeneration });

        setCommandLaneConcurrency(blockedLane, 1);
        await run;
        expect(getAgentRunContext(params.runId)).toMatchObject({
          agentId: "main",
          isControlUiVisible: false,
          lastActiveAt: admissionAt,
          registeredAt,
          sessionKey: "agent:main:subagent:queued",
        });

        clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS);
        expect(sweepStaleRunContexts()).toBe(0);

        clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS + 1);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();
      } finally {
        setCommandLaneConcurrency(blockedLane, 1);
        await run.catch(() => {});
      }
    },
  );

  test("retains context past the TTL while worker placement admission is pending", async () => {
    const registeredAt = 1_000;
    const admissionAt = registeredAt + CONTEXT_TTL_MS + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const { controller, params } = createRunController();
    registerAgentRunContext(params.runId, {
      agentId: "main",
      isControlUiVisible: false,
      lifecycleGeneration: params.lifecycleGeneration,
      registeredAt,
      sessionKey: "agent:main:subagent:queued",
    });

    let admitPlacement: (() => void) | undefined;
    let markPlacementEntered: (() => void) | undefined;
    const placementAdmission = new Promise<void>((resolve) => {
      admitPlacement = resolve;
    });
    const placementEntered = new Promise<void>((resolve) => {
      markPlacementEntered = resolve;
    });
    const uninstallPlacement = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => await runLocal(),
      executeTurn: async (_claim, _params, runLocal) => {
        markPlacementEntered?.();
        await placementAdmission;
        return await runLocal();
      },
    });
    const run = controller.enqueueSession(() =>
      controller.enqueueGlobal(async () => createRunResult()),
    );

    try {
      await placementEntered;
      expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);

      clock.mockReturnValue(admissionAt);
      expect(sweepStaleRunContexts()).toBe(0);
      expect(getAgentRunContext(params.runId)).toMatchObject({
        agentId: "main",
        isControlUiVisible: false,
        registeredAt,
        sessionKey: "agent:main:subagent:queued",
      });

      admitPlacement?.();
      await run;
      expect(getAgentRunContext(params.runId)).toMatchObject({
        agentId: "main",
        isControlUiVisible: false,
        lastActiveAt: admissionAt,
        registeredAt,
        sessionKey: "agent:main:subagent:queued",
      });

      clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(params.runId)).toBeUndefined();
    } finally {
      admitPlacement?.();
      uninstallPlacement();
      await run.catch(() => {});
    }
  });

  test("releases remote queue ownership at worker admission, not after worker completion", async () => {
    const registeredAt = 1_000;
    const admissionAt = registeredAt + CONTEXT_TTL_MS + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const onLaneWait = vi.fn();
    const { controller, params } = createRunController({ onLaneWait });
    registerAgentRunContext(params.runId, {
      lifecycleGeneration: params.lifecycleGeneration,
      registeredAt,
      sessionKey: "agent:main:subagent:queued",
    });
    const versionBeforeQueue = readAgentRunIndexVersion();

    const placementEntered = createDeferred();
    const placementAdmitted = createDeferred();
    const remoteStarted = createDeferred();
    const remoteFinished = createDeferred();
    const localTurn = vi.fn(async () => createRunResult());
    const uninstallPlacement = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
      executeLocalTurn: async (_claim, runLocal) => await runLocal(),
      executeTurn: async (_claim, _params, _runLocal, onAdmitted) => {
        placementEntered.resolve();
        await placementAdmitted.promise;
        onAdmitted?.();
        remoteStarted.resolve();
        await remoteFinished.promise;
        return { meta: { durationMs: 1 } };
      },
    });
    const run = controller.enqueueSession(() => controller.enqueueGlobal(localTurn));

    try {
      await placementEntered.promise;
      expect(onLaneWait).not.toHaveBeenCalledWith(expect.objectContaining({ waiting: false }));
      expect(readAgentRunIndexVersion()).toBe(versionBeforeQueue);
      clock.mockReturnValue(admissionAt);
      expect(sweepStaleRunContexts()).toBe(0);
      expect(getAgentRunContext(params.runId)).toBeDefined();

      placementAdmitted.resolve();
      await remoteStarted.promise;
      expect(onLaneWait).toHaveBeenCalledExactlyOnceWith({
        waitMs: 0,
        queuedAhead: 0,
        waiting: false,
      });
      expect(getAgentRunContext(params.runId)?.lastActiveAt).toBe(admissionAt);
      expect(readAgentRunIndexVersion()).toBe(versionBeforeQueue + 1);
      expect(localTurn).not.toHaveBeenCalled();

      clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(params.runId)).toBeUndefined();
      expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);

      remoteFinished.resolve();
      await run;
    } finally {
      placementAdmitted.resolve();
      remoteFinished.resolve();
      uninstallPlacement();
      await run.catch(() => {});
    }
  });

  test.each([
    { blockedLane: SESSION_LANE, queue: "session" },
    { blockedLane: GLOBAL_LANE, queue: "global" },
  ])(
    "releases $queue queue ownership immediately when a waiting run is aborted",
    async ({ blockedLane }) => {
      const registeredAt = 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const abort = new AbortController();
      const { controller, params } = createRunController({ abortSignal: abort.signal });
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
      });
      setCommandLaneConcurrency(blockedLane, 0);
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => createRunResult()),
      );

      try {
        await waitForQueuedLane(blockedLane);
        clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
        expect(sweepStaleRunContexts()).toBe(0);
        expect(isAgentRunWaitingForCapacity(params.runId)).toBe(true);

        abort.abort(new Error("queued run canceled"));
        expect(isAgentRunWaitingForCapacity(params.runId)).toBe(false);
        expect(getCommandLaneSnapshot(blockedLane).queuedCount).toBe(0);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();

        await expect(run).rejects.toThrow("queued run canceled");
      } finally {
        setCommandLaneConcurrency(blockedLane, 1);
        await run.catch(() => {});
      }
    },
  );

  test.each([
    { blockedLane: SESSION_LANE, queue: "session" },
    { blockedLane: GLOBAL_LANE, queue: "global" },
  ])(
    "releases $queue queue ownership when pending lane work is cleared",
    async ({ blockedLane }) => {
      const registeredAt = 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const { controller, params } = createRunController();
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
      });
      setCommandLaneConcurrency(blockedLane, 0);
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => createRunResult()),
      );

      await waitForQueuedLane(blockedLane);
      clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(0);

      expect(clearCommandLane(blockedLane)).toBe(1);
      await expect(run).rejects.toThrow();
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(params.runId)).toBeUndefined();
    },
  );

  test("releases ownership when a custom queue rejects admission synchronously", () => {
    const registeredAt = 1_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const { controller, params } = createRunController({
      enqueue: () => {
        throw new Error("custom lane rejected admission");
      },
    });
    registerAgentRunContext(params.runId, {
      lifecycleGeneration: params.lifecycleGeneration,
      registeredAt,
    });

    expect(() =>
      controller.enqueueSession(() => controller.enqueueGlobal(async () => createRunResult())),
    ).toThrow("custom lane rejected admission");

    clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
    expect(sweepStaleRunContexts()).toBe(1);
    expect(getAgentRunContext(params.runId)).toBeUndefined();
  });

  test.each(["local", "remote"] as const)(
    "rebinds queued foreground %s work after its retired context expires",
    async (execution) => {
      const registeredAt = 1_000;
      const admissionAt = registeredAt + CONTEXT_TTL_MS + 1;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const { controller, params } = createRunController({ trigger: "user" });
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
      });
      const localTurn = vi.fn(async () => createRunResult());
      const uninstallPlacement =
        execution === "remote"
          ? installSessionPlacementAdmissionProvider({
              assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
              executeLocalTurn: async (_claim, runLocal) => await runLocal(),
              executeTurn: async (_claim, _params, _runLocal, onAdmitted) => {
                onAdmitted?.();
                return { meta: { durationMs: 1 } };
              },
            })
          : undefined;
      setCommandLaneConcurrency(GLOBAL_LANE, 0);
      const run = controller.enqueueSession(() => controller.enqueueGlobal(localTurn));

      try {
        await waitForQueuedLane(GLOBAL_LANE);
        clock.mockReturnValue(admissionAt);
        expect(sweepStaleRunContexts()).toBe(0);

        const replacementGeneration = rotateAgentEventLifecycleGeneration();
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();
        const versionBeforeAdmission = readAgentRunIndexVersion();

        setCommandLaneConcurrency(GLOBAL_LANE, 1);
        await run;
        expect(getAgentRunContext(params.runId)).toMatchObject({
          lifecycleGeneration: replacementGeneration,
          lastActiveAt: admissionAt,
          sessionId: params.sessionId,
        });
        expect(readAgentRunIndexVersion()).toBe(versionBeforeAdmission + 1);
        expect(localTurn).toHaveBeenCalledTimes(execution === "local" ? 1 : 0);

        clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS);
        expect(sweepStaleRunContexts()).toBe(0);
      } finally {
        setCommandLaneConcurrency(GLOBAL_LANE, 1);
        uninstallPlacement?.();
        await run.catch(() => {});
      }
    },
  );

  test.each(["local", "remote"] as const)(
    "rejects %s execution when its lifecycle rotates during placement admission",
    async (execution) => {
      const registeredAt = 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const { controller, params } = createRunController({ trigger: "user" });
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
        sessionKey: "agent:main:original",
      });
      const placementEntered = createDeferred();
      const resumePlacement = createDeferred();
      const localTurn = vi.fn(async () => createRunResult());
      const uninstallPlacement = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
        executeLocalTurn: async (_claim, runLocal) => await runLocal(),
        executeTurn: async (_claim, _params, runLocal, onAdmitted) => {
          placementEntered.resolve();
          await resumePlacement.promise;
          if (execution === "remote") {
            onAdmitted?.();
            return { meta: { durationMs: 1 } };
          }
          return await runLocal();
        },
      });
      const run = controller.enqueueSession(() => controller.enqueueGlobal(localTurn));

      try {
        await placementEntered.promise;
        clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
        const replacementGeneration = rotateAgentEventLifecycleGeneration();
        expect(sweepStaleRunContexts()).toBe(1);
        registerAgentRunContext(params.runId, {
          lifecycleGeneration: replacementGeneration,
          registeredAt: Date.now(),
          sessionId: "replacement-session",
          sessionKey: "agent:main:replacement",
        });
        const versionBeforeRejectedAdmission = readAgentRunIndexVersion();

        resumePlacement.resolve();
        await expect(run).rejects.toThrow("stale gateway lifecycle");
        expect(getAgentRunContext(params.runId)).toMatchObject({
          lifecycleGeneration: replacementGeneration,
          sessionId: "replacement-session",
          sessionKey: "agent:main:replacement",
        });
        expect(readAgentRunIndexVersion()).toBe(versionBeforeRejectedAdmission);
        expect(localTurn).not.toHaveBeenCalled();
      } finally {
        resumePlacement.resolve();
        uninstallPlacement();
        await run.catch(() => {});
      }
    },
  );

  test("rejects queued background work from a retired lifecycle", async () => {
    const registeredAt = 1_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const { controller, params } = createRunController({ trigger: "cron" });
    registerAgentRunContext(params.runId, {
      lifecycleGeneration: params.lifecycleGeneration,
      registeredAt,
    });
    setCommandLaneConcurrency(GLOBAL_LANE, 0);
    const run = controller.enqueueSession(() =>
      controller.enqueueGlobal(async () => createRunResult()),
    );

    try {
      await waitForQueuedLane(GLOBAL_LANE);
      rotateAgentEventLifecycleGeneration();
      clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(1);

      setCommandLaneConcurrency(GLOBAL_LANE, 1);
      await expect(run).rejects.toThrow("stale gateway lifecycle");
      expect(getAgentRunContext(params.runId)).toBeUndefined();
    } finally {
      setCommandLaneConcurrency(GLOBAL_LANE, 1);
      await run.catch(() => {});
    }
  });
});

describe("scheduler capacity wait projection", () => {
  test.each([SESSION_LANE, GLOBAL_LANE, undefined])(
    "publishes only actual %s queue waits and clears before placement setup",
    async (blockedLane) => {
      const sessionKey = "agent:main:capacity";
      const { controller, params } = createRunController({ sessionKey });
      registerAgentRunContext(params.runId, {
        sessionKey,
        sessionId: params.sessionId,
        lifecycleGeneration: params.lifecycleGeneration,
      });
      const events: boolean[] = [];
      const unsubscribe = onSessionLifecycleEvent((event) => {
        if (event.sessionKey === sessionKey && event.reason === "run-capacity") {
          events.push(isAgentRunWaitingForCapacity(params.runId));
        }
      });
      const placementEntered = createDeferred();
      const resumePlacement = createDeferred();
      const uninstallPlacement = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
        executeLocalTurn: async (_claim, runLocal) => await runLocal(),
        executeTurn: async (_claim, _params, runLocal) => {
          placementEntered.resolve();
          await resumePlacement.promise;
          return await runLocal();
        },
      });
      if (blockedLane) {
        setCommandLaneConcurrency(blockedLane, 0);
      }
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => createRunResult()),
      );
      try {
        if (blockedLane) {
          await waitForQueuedLane(blockedLane);
          expect(events).toEqual([true]);
          setCommandLaneConcurrency(blockedLane, 1);
        }
        await placementEntered.promise;
        expect(isAgentRunWaitingForCapacity(params.runId)).toBe(false);
        expect(events).toEqual(blockedLane ? [true, false] : []);
      } finally {
        if (blockedLane) {
          setCommandLaneConcurrency(blockedLane, 1);
        }
        resumePlacement.resolve();
        try {
          await run;
        } finally {
          uninstallPlacement();
          unsubscribe();
        }
      }
    },
  );

  test("keeps custom queue setup spinning when it supplies no capacity evidence", async () => {
    const customQueue = createDeferred();
    const { controller, params } = createRunController({
      enqueue: async (task) => {
        await customQueue.promise;
        return await task();
      },
    });
    registerAgentRunContext(params.runId, { lifecycleGeneration: params.lifecycleGeneration });
    const run = controller.enqueueSession(() =>
      controller.enqueueGlobal(async () => createRunResult()),
    );
    try {
      expect(isAgentRunWaitingForCapacity(params.runId)).toBe(false);
    } finally {
      customQueue.resolve();
      await run;
    }
  });

  test.each([
    { name: "registration", replace: registerAgentRunContext },
    { name: "claim", replace: claimAgentRunContext },
  ])("old wait releases cannot clear a recycled run after $name", ({ replace }) => {
    const runId = "recycled-capacity-run";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, { lifecycleGeneration });
    const releaseOld = registerAgentRunCapacityWait(runId, lifecycleGeneration);
    const oldContext = getAgentRunContext(runId);
    clearAgentRunContext(runId);
    replace(runId, { ...oldContext, lifecycleGeneration });
    expect(isAgentRunWaitingForCapacity(runId)).toBe(false);
    const releaseNew = registerAgentRunCapacityWait(runId, lifecycleGeneration);
    releaseOld?.();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(true);
    releaseNew?.();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(false);
  });
});

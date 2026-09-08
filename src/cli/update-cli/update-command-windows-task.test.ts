import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

vi.mock("../../daemon/schtasks.js", () => ({
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn(),
  suspendScheduledTaskAutoStartForUpdate: vi.fn(),
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

it("revokes restoration while its ownership inspection is pending", async () => {
  const inspected = createDeferred();
  const releaseInspection = createDeferred();
  const dispatched: string[] = [];
  vi.mocked(resumeScheduledTaskAutoStartAfterUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      dispatched.push("enable");
      return true;
    },
  );
  const recovery = createWindowsTaskAutoStartRecovery({
    serviceEnv: {},
    alreadySuspended: true,
    assertCurrentService: async () => {
      inspected.resolve();
      await releaseInspection.promise;
    },
  });
  const restored = expect(recovery.restore(true)).rejects.toThrow(
    "restoration authority has closed",
  );
  await inspected.promise;
  const settled = recovery.complete(false);
  releaseInspection.resolve();
  await restored;
  await settled;
  await recovery.restore(true);
  expect(dispatched).toEqual([]);
  expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
});

it("drains a dispatched enable before compensating failed verification", async () => {
  const dispatched = createDeferred();
  const finishEnable = createDeferred();
  const actions: string[] = [];
  vi.mocked(resumeScheduledTaskAutoStartAfterUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      actions.push("enable");
      dispatched.resolve();
      await finishEnable.promise;
      return true;
    },
  );
  vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockImplementationOnce(
    async (_env, options) => {
      expect(options?.restoreOnFailure).toBe(false);
      await options?.beforeMutation?.();
      actions.push("disable");
      return true;
    },
  );
  const recovery = createWindowsTaskAutoStartRecovery({
    serviceEnv: {},
    alreadySuspended: true,
  });
  const restored = recovery.restore(true);
  await dispatched.promise;
  const settled = recovery.complete(false);
  await Promise.resolve();
  expect(actions).toEqual(["enable"]);
  finishEnable.resolve();
  await restored;
  await settled;
  expect(actions).toEqual(["enable", "disable"]);
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("refuses native compensation after its original live executor changes during inspection", async () => {
  const root = dirs.make("windows-compensation-owner-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    path.join(root, "private-tmp"),
  );
  const actions: string[] = [];
  const store = createManagedHandoffLeaseStore();
  vi.mocked(resumeScheduledTaskAutoStartAfterUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      actions.push("enable");
      return true;
    },
  );
  vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      actions.push("disable");
      return true;
    },
  );
  let failure: unknown;
  await expect(
    withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      let compensating = false;
      const recovery = createWindowsTaskAutoStartRecovery({
        serviceEnv: {},
        alreadySuspended: true,
        assertCurrent: fence.assertCurrent,
        assertCurrentService: async () => {
          if (!compensating) {
            return;
          }
          const original = store.read(root);
          if (original.kind !== "current") {
            throw new Error("missing actual executor");
          }
          await Promise.resolve();
          expect(store.bind(original.lease, process.pid)).not.toBeNull();
        },
      });
      try {
        await recovery.restore(true);
        compensating = true;
        try {
          await recovery.complete(false);
        } catch (error) {
          failure = error;
        }
      } finally {
        await recovery.complete(false);
      }
    }),
  ).rejects.toThrow(/executor/);
  expect(String(failure)).toMatch(/executor/);
  expect(actions).toEqual(["enable"]);
});

it("retains the native failure when interrupted cleanup also loses its executor", async () => {
  const root = dirs.make("windows-interrupted-owner-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    path.join(root, "private-tmp"),
  );
  const exited = vi.fn<typeof process.exit>();
  vi.spyOn(process, "exit").mockImplementation(exited);
  const listeners = process.listeners("SIGINT");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  const store = createManagedHandoffLeaseStore();
  const nativeFailure = new Error("native disable failed after dispatch");
  vi.mocked(resumeScheduledTaskAutoStartAfterUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      return true;
    },
  );
  vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      const original = store.read(root);
      if (original.kind !== "current") {
        throw new Error("missing actual executor");
      }
      await Promise.resolve();
      expect(store.bind(original.lease, process.pid)).not.toBeNull();
      throw nativeFailure;
    },
  );
  let failure: unknown;
  await expect(
    withUpdateCommandExecutor(run.runId, async (executor) => {
      const executorFence = await executor.enter(root);
      const recovery = createWindowsTaskAutoStartRecovery({
        serviceEnv: env,
        alreadySuspended: true,
        assertCurrent: executorFence.assertCurrent,
        updateRun: { runId: run.runId, env, executorFence },
      });
      try {
        await recovery.restore(true);
        const onSignal = process
          .listeners("SIGINT")
          .find((listener) => !listeners.includes(listener));
        if (!onSignal) {
          throw new Error("missing owned signal handler");
        }
        onSignal("SIGINT");
        try {
          await recovery.complete(false);
        } catch (error) {
          failure = error;
        }
      } finally {
        await recovery.complete(false);
      }
    }),
  ).rejects.toThrow(/executor/);
  await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(130));
  expect(failure).toMatchObject({ errors: expect.arrayContaining([nativeFailure]) });
  expect(getUpdateRun(run.runId, { env })).toEqual(run);
  expect(process.listeners("SIGINT")).toEqual(listeners);
});

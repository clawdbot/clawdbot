import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
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

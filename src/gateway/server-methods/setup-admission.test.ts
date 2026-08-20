import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withSetupMigrationTargetLock } from "../../wizard/setup.migration-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({ stateDir: "" }));

vi.mock("../../config/paths.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/paths.js")>("../../config/paths.js")),
  resolveStateDir: () => mocks.stateDir,
}));

import {
  createAdmittedWizardSession,
  runExclusiveSystemAgentSetupActivation,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";

describe("setup admission", () => {
  beforeEach(() => {
    mocks.stateDir = tempDirs.make("openclaw-setup-admission-");
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
    resetGatewayWorkAdmission();
  });

  it("rejects concurrent work instead of queueing it", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];
    const first = runExclusiveSystemAgentSetupActivation(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstStarted.promise;

    const secondTask = vi.fn(async () => events.push("second:start"));
    await expect(runExclusiveSystemAgentSetupActivation(secondTask)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    await runExclusiveSystemAgentSetupActivation(async () => events.push("third:start"));
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });

  it("releases the admission lease when work fails", async () => {
    await expect(
      runExclusiveSystemAgentSetupActivation(async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    await expect(runExclusiveSystemAgentSetupActivation(async () => "ok")).resolves.toBe("ok");
  });

  it("does not misclassify a task's own file-lock timeout as setup contention", async () => {
    const taskError = Object.assign(new Error("config lock timed out"), {
      code: "file_lock_timeout",
    });

    await expect(
      runExclusiveSystemAgentSetupActivation(async () => {
        throw taskError;
      }),
    ).rejects.toBe(taskError);
  });

  it("holds an admitted session lease until its runner settles", async () => {
    const settled = createDeferred();
    const session = await createAdmittedWizardSession(() => ({
      whenSettled: () => settled.promise,
    }));

    await expect(
      createAdmittedWizardSession(() => ({ whenSettled: () => Promise.resolve() })),
    ).resolves.toBeUndefined();
    settled.resolve();
    await whenAdmittedWizardSessionSettled(session!);
    const next = await createAdmittedWizardSession(() => ({
      whenSettled: () => Promise.resolve(),
    }));
    expect(next).toBeDefined();
    await whenAdmittedWizardSessionSettled(next!);
  });

  it("retains root work for post-start session continuations", async () => {
    const continueAfterStart = createDeferred();
    let runner: Promise<void> | undefined;

    await runWithGatewayIndependentRootWorkAdmission(async () => {
      await createAdmittedWizardSession(() => {
        runner = (async () => {
          await continueAfterStart.promise;
          await enqueueCommandInLane("setup-post-start-proof", async () => undefined);
        })();
        return { whenSettled: () => runner! };
      });
    });

    const activeAfterStart = getActiveGatewayRootWorkCount();
    continueAfterStart.resolve();
    await expect(runner).resolves.toBeUndefined();
    expect(activeAfterStart).toBe(1);
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("releases an admitted session lease when construction fails", async () => {
    await expect(
      createAdmittedWizardSession(() => {
        throw new Error("construction failed");
      }),
    ).rejects.toThrow("construction failed");
    const recovered = await createAdmittedWizardSession(() => ({
      whenSettled: () => Promise.resolve(),
    }));
    expect(recovered).toBeDefined();
    await whenAdmittedWizardSessionSettled(recovered!);
  });

  it("reserves wizard admission while setup waits to acquire its target lock", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = withSetupMigrationTargetLock(mocks.stateDir, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const setupAttempt = createAdmittedWizardSession(() => ({
      whenSettled: () => Promise.resolve(),
    }));
    const channelFactory = vi.fn(() => ({ whenSettled: () => Promise.resolve() }));
    await expect(createAdmittedWizardSession(channelFactory, false)).resolves.toBeUndefined();
    expect(channelFactory).not.toHaveBeenCalled();
    await expect(setupAttempt).resolves.toBeUndefined();

    releaseLock.resolve();
    await lockOwner;
  });

  it("rejects Gateway setup while the canonical onboarding target lock is held", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = withSetupMigrationTargetLock(mocks.stateDir, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const task = vi.fn(async () => "unexpected");
    await expect(runExclusiveSystemAgentSetupActivation(task)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(task).not.toHaveBeenCalled();

    releaseLock.resolve();
    await lockOwner;
    await expect(runExclusiveSystemAgentSetupActivation(async () => "ok")).resolves.toBe("ok");
  });
});

import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enqueueCommandInLane, getTotalQueueSize } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  getGatewayRestartDrainSignal,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { WizardSession } from "../../wizard/session.js";
import * as setupMigration from "../../wizard/setup.migration-snapshot.js";
import { GatewayConnectionWork } from "../server-connection-work.js";

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
    const session = await createAdmittedWizardSession(
      () => new WizardSession(() => settled.promise),
    );

    await expect(
      createAdmittedWizardSession(() => new WizardSession(async () => {})),
    ).resolves.toBeUndefined();
    settled.resolve();
    await whenAdmittedWizardSessionSettled(session!);
    const next = await createAdmittedWizardSession(() => new WizardSession(async () => {}));
    expect(next).toBeDefined();
    await whenAdmittedWizardSessionSettled(next!);
  });

  it("retains root work for post-start session continuations", async () => {
    const continueAfterStart = createDeferred();
    let runner: Promise<void> | undefined;

    const session = await runWithGatewayIndependentRootWorkAdmission(async () =>
      createAdmittedWizardSession(() => {
        runner = (async () => {
          await continueAfterStart.promise;
          await enqueueCommandInLane("setup-post-start-proof", async () => undefined);
        })();
        return new WizardSession(() => runner!);
      }),
    );

    const activeAfterStart = getActiveGatewayRootWorkCount();
    continueAfterStart.resolve();
    await expect(runner).resolves.toBeUndefined();
    expect(activeAfterStart).toBe(1);
    await whenAdmittedWizardSessionSettled(session!);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["process drain", "server close"])(
    "settles an abandoned prompt before %s releases its runtime",
    async (closing) => {
      const work = new GatewayConnectionWork();
      const disconnected = work.registerConnection(() => {});
      const cleanupStarted = createDeferred();
      const finishCleanup = createDeferred();
      const session = await work.track(() =>
        runWithGatewayIndependentRootWorkAdmission(() =>
          createAdmittedWizardSession(
            () =>
              new WizardSession(async (prompter) => {
                await enqueueCommandInLane("setup-shutdown-proof", async () => {
                  try {
                    await prompter.text({ message: "Local model base URL" });
                  } finally {
                    cleanupStarted.resolve();
                    await finishCleanup.promise;
                  }
                });
              }),
          ),
        ),
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        expect((await session.next()).step?.type).toBe("text");
        disconnected();
        expect(session.getStatus()).toBe("running");
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(getTotalQueueSize()).toBe(1);

        if (closing === "process drain") {
          markGatewayRestartDraining();
        } else {
          work.beginClose();
        }
        expect(session.signal.aborted).toBe(true);
        await cleanupStarted.promise;
        expect(session.getStatus()).not.toBe("cancelled");
        expect(session.cancel()).toBe(false);
        expect(session.isSettled()).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(getTotalQueueSize()).toBe(1);
        await expect(runExclusiveSystemAgentSetupActivation(async () => {})).rejects.toThrow(
          "setup is already in progress",
        );
        let drained = false;
        const drain = work.drain().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);

        finishCleanup.resolve();
        await whenAdmittedWizardSessionSettled(session);
        await drain;
        expect(await session.next()).toMatchObject({ done: true, status: "error" });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(getTotalQueueSize()).toBe(0);
        await expect(runExclusiveSystemAgentSetupActivation(async () => "released")).resolves.toBe(
          "released",
        );
      } finally {
        disconnected();
        session.cancel();
        finishCleanup.resolve();
        await whenAdmittedWizardSessionSettled(session);
        await work.drain();
      }
    },
  );

  it.each([
    ["already waiting", "outro"],
    ["after write", "outro"],
    ["already waiting", "confirm"],
    ["after write", "confirm"],
  ] as const)(
    "preserves committed work and ends unavailable %s %s at shutdown",
    async (when, prompt) => {
      const finishWrite = createDeferred();
      const prompting = createDeferred();
      let written = false;
      let answered = false;
      const session = await runWithGatewayIndependentRootWorkAdmission(() =>
        createAdmittedWizardSession(
          () =>
            new WizardSession(async (prompter, _signal, owner) => {
              owner.lockCancellation();
              await finishWrite.promise;
              written = true;
              prompting.resolve();
              if (prompt === "outro") {
                await prompter.outro("Channels updated.");
              } else {
                await prompter.confirm({
                  message: "Configure another account?",
                  initialValue: true,
                });
              }
              answered = true;
            }),
        ),
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        if (when === "already waiting") {
          finishWrite.resolve();
          await prompting.promise;
        }
        markGatewayRestartDraining();
        expect(session.signal.aborted).toBe(false);
        expect(session.getStatus()).not.toBe("cancelled");
        if (when === "after write") {
          expect(written).toBe(false);
          expect(session.isSettled()).toBe(false);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          finishWrite.resolve();
          await prompting.promise;
        }
        expect(session.getCurrentStep()).toBeUndefined();
        await whenAdmittedWizardSessionSettled(session);
        expect(written).toBe(true);
        expect(answered).toBe(false);
        expect(await session.next()).toMatchObject({ done: true, status: "error" });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        finishWrite.resolve();
        await prompting.promise;
        const pending = session.getCurrentStep();
        if (pending) {
          await session.answer(pending.id, undefined);
        }
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it("keeps a prompt resumable across disconnect and reversible admission fences", async () => {
    const work = new GatewayConnectionWork();
    const disconnect = work.registerConnection(() => {});
    let submitted: string | undefined;
    const session = await work.track(() =>
      createAdmittedWizardSession(
        () =>
          new WizardSession(async (prompter) => {
            submitted = await prompter.text({ message: "Local model base URL" });
          }),
      ),
    );
    if (!session) {
      throw new Error("expected an admitted wizard");
    }
    try {
      const step = (await session.next()).step;
      if (!step) {
        throw new Error("expected a pending prompt");
      }
      disconnect();
      expect(beginGatewayRestartSignalAdmission()?.rollback()).toBe(true);
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      expect(suspension?.release()).toBe(true);
      expect(session.signal.aborted).toBe(false);
      expect((await session.next()).step?.id).toBe(step.id);
      await session.answer(step.id, "http://127.0.0.1:11434");
      await whenAdmittedWizardSessionSettled(session);
      expect(submitted).toBe("http://127.0.0.1:11434");
      expect(session.getStatus()).toBe("done");
    } finally {
      disconnect();
      session.cancel();
      await whenAdmittedWizardSessionSettled(session);
      await work.drain();
    }
  });

  it.each([false, true])(
    "does not construct a wizard after drain wins target-lock acquisition (reset=%s)",
    async (reset) => {
      const create = vi.fn(() => new WizardSession(async () => {}));
      const pending = createAdmittedWizardSession(create);
      const rejected = expect(pending).rejects.toThrow("draining");
      markGatewayRestartDraining();
      if (reset) {
        resetGatewayWorkAdmission();
      }
      await rejected;
      expect(create).not.toHaveBeenCalled();
      resetGatewayWorkAdmission();
      const fresh = await createAdmittedWizardSession(create);
      expect(fresh).toBeDefined();
      await whenAdmittedWizardSessionSettled(fresh!);
    },
  );

  it.each([false, true])(
    "closes a wizard when construction races drain (target lock=%s)",
    async (lockSetupTarget) => {
      const session = await createAdmittedWizardSession(
        () =>
          new WizardSession(async (prompter) => {
            markGatewayRestartDraining();
            await prompter.text({ message: "Local model base URL" });
          }),
        lockSetupTarget,
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        await whenAdmittedWizardSessionSettled(session);
        expect(session.getStatus()).toBe("error");
      } finally {
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it.each([false, true])(
    "preserves committed work's result without further input (failure=%s)",
    async (failWrite) => {
      const finishWrite = createDeferred();
      const session = await createAdmittedWizardSession(
        () =>
          new WizardSession(async (_prompter, _signal, owner) => {
            owner.lockCancellation();
            await finishWrite.promise;
            if (failWrite) {
              throw new Error("settings write failed");
            }
            owner.setModelActivation({ modelRef: "ollama/local-model" });
          }),
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        markGatewayRestartDraining();
        expect(session.signal.aborted).toBe(false);
        finishWrite.resolve();
        await whenAdmittedWizardSessionSettled(session);
        expect(await session.next()).toMatchObject({
          done: true,
          ...(failWrite
            ? { status: "error", error: "Error: settings write failed" }
            : { status: "done", modelActivation: { modelRef: "ollama/local-model" } }),
        });
      } finally {
        finishWrite.resolve();
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it("does not report classic setup's saved settings as user cancellation", async () => {
    const configPath = path.join(mocks.stateDir, "openclaw.json");
    const saved = '{"gateway":{"mode":"remote"}}';
    const session = await createAdmittedWizardSession(
      () =>
        new WizardSession(async (prompter) => {
          await fs.writeFile(configPath, saved);
          await prompter.outro("Remote Gateway configured.");
        }),
    );
    if (!session) {
      throw new Error("expected an admitted wizard");
    }
    try {
      expect((await session.next()).step?.type).toBe("note");
      markGatewayRestartDraining();
      await whenAdmittedWizardSessionSettled(session);
      expect(await fs.readFile(configPath, "utf8")).toBe(saved);
      expect(await session.next()).toMatchObject({ done: true, status: "error" });
    } finally {
      session.cancel();
      await whenAdmittedWizardSessionSettled(session);
    }
  });

  it("keeps shutdown error provenance when a provider maps closed input to cancellation", async () => {
    const session = await createAdmittedWizardSession(
      () =>
        new WizardSession(async (prompter, _signal, owner) => {
          owner.lockCancellation();
          try {
            await prompter.text({ message: "Provider sign-in code" });
          } catch {
            throw new WizardCancelledError("provider input cancelled");
          }
        }),
    );
    if (!session) {
      throw new Error("expected an admitted wizard");
    }
    try {
      await session.next();
      markGatewayRestartDraining();
      await whenAdmittedWizardSessionSettled(session);
      expect(await session.next()).toMatchObject({
        done: true,
        status: "error",
        error: expect.stringContaining("Gateway is shutting down"),
      });
    } finally {
      const pending = session.getCurrentStep();
      if (pending) {
        await session.answer(pending.id, undefined);
      }
      await whenAdmittedWizardSessionSettled(session);
    }
  });

  it.each([false, true])(
    "releases its drain listener and root even when target-lock cleanup fails (%s)",
    async (failCleanup) => {
      const finish = createDeferred();
      const drainSignal = getGatewayRestartDrainSignal();
      const priorListeners = getEventListeners(drainSignal, "abort").length;
      const releaseError = new Error("target-lock release failed");
      const lock = failCleanup
        ? vi
            .spyOn(setupMigration, "withSetupMigrationTargetLock")
            .mockImplementationOnce(async (_stateDir, run) => {
              await run();
              throw releaseError;
            })
        : undefined;
      let session: WizardSession | undefined;
      try {
        session = await runWithGatewayIndependentRootWorkAdmission(() =>
          createAdmittedWizardSession(() => new WizardSession(() => finish.promise)),
        );
        if (!session) {
          throw new Error("expected an admitted wizard");
        }
        expect(getEventListeners(drainSignal, "abort")).toHaveLength(priorListeners + 1);
        finish.resolve();
        const settlement = whenAdmittedWizardSessionSettled(session);
        if (failCleanup) {
          await expect(settlement).rejects.toBe(releaseError);
        } else {
          await settlement;
        }
        expect(getEventListeners(drainSignal, "abort")).toHaveLength(priorListeners);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        const fresh = await createAdmittedWizardSession(() => new WizardSession(async () => {}));
        expect(fresh).toBeDefined();
        await whenAdmittedWizardSessionSettled(fresh!);
      } finally {
        finish.resolve();
        if (session) {
          await whenAdmittedWizardSessionSettled(session).catch(() => {});
        }
        lock?.mockRestore();
      }
    },
  );

  it("releases an admitted session lease when construction fails", async () => {
    await expect(
      createAdmittedWizardSession(() => {
        throw new Error("construction failed");
      }),
    ).rejects.toThrow("construction failed");
    const recovered = await createAdmittedWizardSession(() => new WizardSession(async () => {}));
    expect(recovered).toBeDefined();
    await whenAdmittedWizardSessionSettled(recovered!);
  });

  it("reserves wizard admission while setup waits to acquire its target lock", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = setupMigration.withSetupMigrationTargetLock(mocks.stateDir, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const setupAttempt = createAdmittedWizardSession(() => new WizardSession(async () => {}));
    const channelFactory = vi.fn(() => new WizardSession(async () => {}));
    await expect(createAdmittedWizardSession(channelFactory, false)).resolves.toBeUndefined();
    expect(channelFactory).not.toHaveBeenCalled();
    await expect(setupAttempt).resolves.toBeUndefined();

    releaseLock.resolve();
    await lockOwner;
  });

  it("rejects Gateway setup while the canonical onboarding target lock is held", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = setupMigration.withSetupMigrationTargetLock(mocks.stateDir, async () => {
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

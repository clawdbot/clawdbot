import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withSetupMigrationTargetLock } from "./setup.migration-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("setup migration target lock", () => {
  it("rejects a concurrent profile operation with the active holder", async () => {
    await withEnvAsync({ OPENCLAW_PROFILE: "lock-test" }, async () => {
      const stateDir = tempDirs.make("openclaw-setup-target-lock-");
      const firstAcquired = createDeferred();
      const releaseFirst = createDeferred();
      const first = withSetupMigrationTargetLock(stateDir, async () => {
        firstAcquired.resolve();
        await releaseFirst.promise;
      });
      await firstAcquired.promise;

      let secondRan = false;
      const second = withSetupMigrationTargetLock(stateDir, async () => {
        secondRan = true;
      });
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        second.then(
          () => ({ kind: "acquired" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "waiting" }>((resolve) => {
          waitTimer = setTimeout(() => resolve({ kind: "waiting" }), 1_000);
        }),
      ]);
      clearTimeout(waitTimer);

      releaseFirst.resolve();
      await first;
      if (outcome.kind === "waiting") {
        await second;
      }

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") {
        return;
      }
      expect(outcome.error).toMatchObject({
        name: "SetupTargetLockedError",
        code: "setup_target_locked",
        holderPid: process.pid,
      });
      expect((outcome.error as Error).message).toBe(
        `Another onboarding/config operation is running for profile lock-test (pid ${process.pid}). Finish or abort it, then re-run.`,
      );
      expect(secondRan).toBe(false);

      await expect(withSetupMigrationTargetLock(stateDir, async () => "ok")).resolves.toBe("ok");
    });
  });
});

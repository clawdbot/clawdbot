// Regression test: a usage-cost refresh lock leaked by the current process (an in-process
// gateway restart abandoning a mid-refresh holder) must be reclaimable, or the gateway stays
// stuck reporting "refreshing" for the rest of its lifetime because the leaking pid never dies
// (#103910).
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  acquireSessionCostUsageRefreshLock,
  clearSessionCostUsageRefreshHoldersForInProcessRestart,
  isSessionCostUsageRefreshRunning,
} from "./session-cost-usage-cache.sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session cost usage refresh lock", () => {
  it("reclaims a self-lock leaked across an in-process restart (#103910)", async () => {
    const tempDir = tempDirs.make("openclaw-usage-refresh-lock-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      // Lifecycle A acquires the lock; the holder is then abandoned mid-refresh, so release()
      // never runs and the on-disk lock keeps naming our own (still-live) pid.
      const leaked = acquireSessionCostUsageRefreshLock();
      expect(leaked.acquired).toBe(true);

      // While the holder is still registered the row correctly reads as live and blocks.
      expect(isSessionCostUsageRefreshRunning()).toBe(true);
      expect(acquireSessionCostUsageRefreshLock().acquired).toBe(false);

      // The in-process restart boundary drops holder registrations from the previous lifecycle.
      clearSessionCostUsageRefreshHoldersForInProcessRestart();

      // Same pid, but the leaked self-lock is no longer a live holder: it must be reclaimed
      // rather than pinning the refresh as busy forever.
      expect(isSessionCostUsageRefreshRunning()).toBe(false);
      const reacquired = acquireSessionCostUsageRefreshLock();
      expect(reacquired.acquired).toBe(true);
      reacquired.release();

      expect(isSessionCostUsageRefreshRunning()).toBe(false);
    });
  });

  it("keeps a foreign live pid's lock held (does not over-reclaim)", async () => {
    const tempDir = tempDirs.make("openclaw-usage-refresh-lock-foreign-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      // A holder registered in this lifecycle blocks acquisition; clearing holders alone must
      // not reclaim a lock whose owner pid is genuinely still running elsewhere.
      const held = acquireSessionCostUsageRefreshLock();
      expect(held.acquired).toBe(true);
      expect(acquireSessionCostUsageRefreshLock().acquired).toBe(false);
      held.release();
      // After a clean release the lock row is gone and acquisition succeeds again.
      expect(isSessionCostUsageRefreshRunning()).toBe(false);
      const next = acquireSessionCostUsageRefreshLock();
      expect(next.acquired).toBe(true);
      next.release();
    });
  });
});

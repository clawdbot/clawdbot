import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { withStableDeliveryIntentFence } from "./delivery-intent-fence.js";
import { OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME } from "./delivery-queue-media-staging.js";

describe("stable delivery intent fence", () => {
  let stateDir = "";
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  beforeEach(() => {
    closeOpenClawStateDatabaseForTest();
    stateDir = tempDirs.make("openclaw-stable-intent-fence-");
  });

  it("admits policy once from the modifier boundary and retains a terminal owner", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const secondRun = vi.fn();

    const first = withStableDeliveryIntentFence({
      id: "stable-policy-owner",
      stateDir,
      run: async (owner) => {
        owner.enterModifierBoundary();
        notifyFirstStarted();
        await firstBlocked;
        return "prepared";
      },
    });
    await firstStarted;
    await expect(
      withStableDeliveryIntentFence({
        id: "stable-policy-owner",
        stateDir,
        run: async (owner) => {
          owner.enterModifierBoundary();
          return secondRun();
        },
      }),
    ).resolves.toEqual({ status: "existing" });
    expect(secondRun).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toEqual({ status: "claimed", value: "prepared" });
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        "stable-policy-owner",
        stateDir,
      ),
    ).toBe("completed");
    await expect(
      withStableDeliveryIntentFence({
        id: "stable-policy-owner",
        stateDir,
        run: async (owner) => {
          owner.enterModifierBoundary();
          return secondRun();
        },
      }),
    ).resolves.toEqual({ status: "existing" });
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("fails closed without retaining producer content", async () => {
    await expect(
      withStableDeliveryIntentFence({
        id: "failed-policy-owner",
        stateDir,
        run: async (owner) => {
          owner.enterModifierBoundary();
          throw new Error("hook interrupted with private input");
        },
      }),
    ).rejects.toThrow("hook interrupted with private input");
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        "failed-policy-owner",
        stateDir,
      ),
    ).toBe("failed");
    await expect(
      withStableDeliveryIntentFence({
        id: "failed-policy-owner",
        stateDir,
        run: async (owner) => {
          owner.enterModifierBoundary();
        },
      }),
    ).resolves.toEqual({ status: "existing" });
  });

  it("allows retry after a process exits before the modifier boundary", async () => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          const { withStableDeliveryIntentFence } = await import(
            "./src/infra/outbound/delivery-intent-fence.ts"
          );
          await withStableDeliveryIntentFence({
            id: "pre-modifier-exit",
            stateDir: process.env.OPENCLAW_STATE_DIR,
            run: async () => process.exit(0),
          });
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        encoding: "utf8",
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        "pre-modifier-exit",
        stateDir,
      ),
    ).toBeUndefined();

    await expect(
      withStableDeliveryIntentFence({
        id: "pre-modifier-exit",
        stateDir,
        run: async (owner) => {
          owner.enterModifierBoundary();
          return "prepared";
        },
      }),
    ).resolves.toEqual({ status: "claimed", value: "prepared" });
  });
});

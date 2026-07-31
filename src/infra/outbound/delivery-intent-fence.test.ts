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

  it("admits policy once and retains a payload-free terminal owner", async () => {
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
      run: async () => {
        notifyFirstStarted();
        await firstBlocked;
        return "prepared";
      },
    });
    await firstStarted;
    await expect(
      withStableDeliveryIntentFence({ id: "stable-policy-owner", stateDir, run: secondRun }),
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
      withStableDeliveryIntentFence({ id: "stable-policy-owner", stateDir, run: secondRun }),
    ).resolves.toEqual({ status: "existing" });
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("fails closed without retaining producer content", async () => {
    await expect(
      withStableDeliveryIntentFence({
        id: "failed-policy-owner",
        stateDir,
        run: async () => {
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
        run: vi.fn(),
      }),
    ).resolves.toEqual({ status: "existing" });
  });
});

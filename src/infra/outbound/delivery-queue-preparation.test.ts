import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { withStableDeliveryPreparation } from "./delivery-queue-preparation.js";

describe("stable delivery preparation", () => {
  let stateDir = "";
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  beforeEach(() => {
    closeOpenClawStateDatabaseForTest();
    stateDir = tempDirs.make("openclaw-stable-preparation-");
  });

  it("admits only one modifier owner for a stable intent", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const secondRun = vi.fn();

    const first = withStableDeliveryPreparation({
      id: "stable-policy-owner",
      stateDir,
      run: async (owner) => {
        owner.beforeFirstModifier();
        notifyFirstStarted();
        await firstBlocked;
        owner.markPrepared();
        return "prepared";
      },
    });
    await firstStarted;
    await expect(
      withStableDeliveryPreparation({
        id: "stable-policy-owner",
        stateDir,
        run: secondRun,
      }),
    ).resolves.toEqual({ status: "existing" });
    expect(secondRun).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toEqual({ status: "claimed", value: "prepared" });
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        "stable-policy-owner",
        stateDir,
      ),
    ).toBe("completed");
  });

  it("releases pre-policy failures but fails closed after modifiers start", async () => {
    await expect(
      withStableDeliveryPreparation({
        id: "retry-before-policy",
        stateDir,
        run: async () => {
          throw new Error("normalization failed");
        },
      }),
    ).rejects.toThrow("normalization failed");
    await expect(
      withStableDeliveryPreparation({
        id: "retry-before-policy",
        stateDir,
        run: async (owner) => {
          owner.markPrepared();
          return "retried";
        },
      }),
    ).resolves.toEqual({ status: "claimed", value: "retried" });

    await expect(
      withStableDeliveryPreparation({
        id: "fail-after-policy",
        stateDir,
        run: async (owner) => {
          owner.beforeFirstModifier();
          throw new Error("hook interrupted");
        },
      }),
    ).rejects.toThrow("hook interrupted");
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        "fail-after-policy",
        stateDir,
      ),
    ).toBe("failed");
  });
});

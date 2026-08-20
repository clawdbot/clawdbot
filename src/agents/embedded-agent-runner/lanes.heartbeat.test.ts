import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveEmbeddedRunGlobalLane } from "./lanes.js";

async function settleQueue(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("heartbeat embedded-run global lane", () => {
  beforeEach(() => {
    resetAllLanes();
    setCommandLaneConcurrency(CommandLane.Main, 1);
    setCommandLaneConcurrency(CommandLane.CronNested, 1);
  });

  afterEach(() => {
    resetAllLanes();
  });

  it("lets visible work start while a heartbeat run is still active", async () => {
    const heartbeatGate = createDeferredCore();
    const visibleGate = createDeferredCore();
    const events: string[] = [];
    const heartbeat = enqueueCommandInLane(
      resolveEmbeddedRunGlobalLane({ isHeartbeat: true }),
      async () => {
        events.push("heartbeat-start");
        await heartbeatGate.promise;
        events.push("heartbeat-end");
      },
    );
    await settleQueue();

    const visible = enqueueCommandInLane(
      resolveEmbeddedRunGlobalLane({ isHeartbeat: false }),
      async () => {
        events.push("visible-start");
        await visibleGate.promise;
      },
    );
    await settleQueue();

    expect(events).toEqual(["heartbeat-start", "visible-start"]);
    expect(getCommandLaneSnapshot(CommandLane.Main)).toMatchObject({
      activeCount: 1,
      queuedCount: 0,
    });
    expect(getCommandLaneSnapshot(CommandLane.CronNested)).toMatchObject({
      activeCount: 1,
      queuedCount: 0,
    });

    heartbeatGate.resolve();
    visibleGate.resolve();
    await Promise.all([heartbeat, visible]);
    expect(events).toEqual(["heartbeat-start", "visible-start", "heartbeat-end"]);
  });
});

import { describe, expect, it } from "vitest";
import { resolveActiveRunQueueAction } from "./queue-policy.js";

describe("resolveActiveRunQueueAction", () => {
  it("runs immediately when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("run-now");
  });

  it("drops heartbeat runs while another run is active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("drop");
  });

  it("enqueues followups for non-heartbeat active runs", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("enqueue-followup");
  });

  it("enqueues steer mode runs while active", () => {
    for (const queueMode of ["steer", "queue"] as const) {
      expect(
        resolveActiveRunQueueAction({
          isActive: true,
          isHeartbeat: false,
          shouldFollowup: false,
          queueMode,
        }),
      ).toBe("enqueue-followup");
    }
  });

  it("runs reset-triggered turns immediately while another run is active", () => {
    for (const queueMode of ["steer", "queue", "collect", "followup"] as const) {
      expect(
        resolveActiveRunQueueAction({
          isActive: true,
          isHeartbeat: false,
          shouldFollowup: true,
          queueMode,
          resetTriggered: true,
        }),
      ).toBe("run-now");
    }
  });

  it("keeps heartbeat drops ahead of reset-triggered turns", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        queueMode: "steer",
        resetTriggered: true,
      }),
    ).toBe("drop");
  });

  it("ignores reset-triggered policy when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
        resetTriggered: true,
      }),
    ).toBe("run-now");
  });
});

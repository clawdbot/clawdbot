import { describe, expect, it } from "vitest";
import {
  inferHeartbeatWakeSourceFromReason,
  resolveHeartbeatWakePayloadFlags,
} from "./heartbeat-wake-policy.js";

describe("session-state heartbeat wakes", () => {
  it("infers the source and marks the wake as payload-bearing", () => {
    expect(inferHeartbeatWakeSourceFromReason("session-state:agent:main:child")).toBe(
      "session-state",
    );
    expect(
      resolveHeartbeatWakePayloadFlags({
        reason: "session-state:agent:main:child",
      }),
    ).toMatchObject({ isWakePayload: true });
    expect(
      resolveHeartbeatWakePayloadFlags({
        source: "session-state",
      }),
    ).toMatchObject({ isWakePayload: true });
  });
});

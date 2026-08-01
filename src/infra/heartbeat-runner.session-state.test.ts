import { describe, expect, it } from "vitest";
import { testing } from "./heartbeat-runner.js";

describe("session-state heartbeat wakes", () => {
  it("infers the source and marks the wake as payload-bearing", () => {
    expect(testing.inferHeartbeatWakeSourceFromReason("session-state:agent:main:child")).toBe(
      "session-state",
    );
    expect(
      testing.resolveHeartbeatWakePayloadFlags({
        reason: "session-state:agent:main:child",
      }),
    ).toMatchObject({ isWakePayload: true });
    expect(
      testing.resolveHeartbeatWakePayloadFlags({
        source: "session-state",
      }),
    ).toMatchObject({ isWakePayload: true });
  });
});

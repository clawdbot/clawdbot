import { describe, expect, it } from "vitest";
import { __testing } from "./cli.js";

describe("voice-call CLI gateway fallback", () => {
  it("treats abnormal local gateway closes as standalone-runtime fallback candidates", () => {
    expect(
      __testing.isGatewayUnavailableForLocalFallback(
        new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
      ),
    ).toBe(true);
  });
});

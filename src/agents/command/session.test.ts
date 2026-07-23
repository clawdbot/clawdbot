import { describe, expect, it } from "vitest";
import { clearRotatedSessionMetadata } from "./session.js";

describe("clearRotatedSessionMetadata", () => {
  it("clears restart-recovery request correlation on session rotation", () => {
    const rotated = clearRotatedSessionMetadata({
      sessionId: "session-1",
      updatedAt: Date.now(),
      restartRecoveryDeliveryRequestMessageId: "request-1",
    });

    expect(rotated.restartRecoveryDeliveryRequestMessageId).toBeUndefined();
  });
});

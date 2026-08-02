import { describe, expect, it } from "vitest";
import { clearRotatedSessionMetadata } from "./session.js";

describe("clearRotatedSessionMetadata", () => {
  it("clears restart-recovery request correlation on session rotation", () => {
    const rotated = clearRotatedSessionMetadata({
      sessionId: "session-1",
      updatedAt: Date.now(),
      restartRecoveryDeliveryRequestMessageId: "request-1",
      restartRecoveryInterruptionReason: "gateway_timeout",
      restartRecoveryResumingNoticeRunId: "recovery-1",
      restartRecoveryTimeoutAttemptCount: 1,
      restartRecoveryTimeoutExhausted: true,
    });

    expect(rotated.restartRecoveryDeliveryRequestMessageId).toBeUndefined();
    expect(rotated.restartRecoveryInterruptionReason).toBeUndefined();
    expect(rotated.restartRecoveryResumingNoticeRunId).toBeUndefined();
    expect(rotated.restartRecoveryTimeoutAttemptCount).toBeUndefined();
    expect(rotated.restartRecoveryTimeoutExhausted).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { recoverTerminalSessionEntryForVisibleTurn } from "./terminal-status.js";

describe("recoverTerminalSessionEntryForVisibleTurn", () => {
  it("clears restart-recovery request correlation before reusing a terminal session", () => {
    const recovered = recoverTerminalSessionEntryForVisibleTurn({
      sessionId: "session-1",
      updatedAt: Date.now(),
      status: "failed",
      restartRecoveryDeliveryRequestMessageId: "request-1",
    });

    expect(recovered.restartRecoveryDeliveryRequestMessageId).toBeUndefined();
  });
});

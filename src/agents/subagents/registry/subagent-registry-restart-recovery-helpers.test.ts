import { describe, expect, it } from "vitest";
import { buildRestartRecoveryResumeMessage } from "./subagent-registry-restart-recovery-helpers.js";

describe("buildRestartRecoveryResumeMessage", () => {
  it("uses the canonical system prefix and gateway restart wording", () => {
    expect(buildRestartRecoveryResumeMessage("Finish the report", "Use the latest figures")).toBe(
      "[System] Your previous turn was interrupted by a gateway restart. " +
        "Your original task was:\n\nFinish the report\n\n" +
        "The last message from the user before the interruption was:\n\n" +
        "Use the latest figures\n\nPlease continue where you left off.",
    );
  });
});

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

  it.each([
    ["original task", (value: string) => buildRestartRecoveryResumeMessage(value)],
    [
      "latest user direction",
      (value: string) => buildRestartRecoveryResumeMessage("Finish the report", value),
    ],
  ])("bounds the %s without splitting UTF-16 surrogate pairs", (_label, buildMessage) => {
    const retained = `${"x".repeat(1_997)}🦞`;
    const message = buildMessage(`${retained}🚀discarded direction`);

    expect(message).toContain(`${retained}...\n\n`);
    expect(message).not.toContain("🚀");
    expect(message).not.toContain("discarded direction");
  });
});

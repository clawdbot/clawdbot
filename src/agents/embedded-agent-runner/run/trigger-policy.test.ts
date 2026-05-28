import { describe, expect, it } from "vitest";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";

describe("shouldInjectHeartbeatPromptForTrigger", () => {
  it("injects the heartbeat prompt on heartbeat-triggered runs", () => {
    expect(shouldInjectHeartbeatPromptForTrigger("heartbeat")).toBe(true);
  });

  it.each([
    ["user"] as const,
    ["manual"] as const,
    ["cron"] as const,
    ["memory"] as const,
    ["overflow"] as const,
  ])("does not inject the heartbeat prompt on %s-triggered runs", (trigger) => {
    expect(shouldInjectHeartbeatPromptForTrigger(trigger)).toBe(false);
  });

  it("does not inject the heartbeat prompt when no trigger is supplied", () => {
    expect(shouldInjectHeartbeatPromptForTrigger(undefined)).toBe(false);
  });
});

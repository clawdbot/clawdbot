import { describe, expect, it } from "vitest";
import { createRestoredFollowupDrainOpts } from "./restored-drain.js";

describe("createRestoredFollowupDrainOpts", () => {
  it("does not carry heartbeat-only execution policy into restored user follow-ups", () => {
    const opts = createRestoredFollowupDrainOpts();
    expect(opts.isHeartbeat).toBe(false);
    expect(opts).not.toHaveProperty("forceHeartbeatTool");
    expect(opts).not.toHaveProperty("enableHeartbeatTool");
    expect(opts).not.toHaveProperty("timeoutOverrideSeconds");
    expect(opts).not.toHaveProperty("bootstrapContextMode");
    expect(opts).not.toHaveProperty("abortSignal");
    expect(opts).not.toHaveProperty("heartbeatModelOverride");
    expect(opts).not.toHaveProperty("sourceReplyDeliveryMode");
    expect(opts).not.toHaveProperty("typingPolicy");
  });
});

import { describe, expect, it } from "vitest";
import { copyAttemptDeliveryState } from "./terminal-resolution.js";

describe("copyAttemptDeliveryState", () => {
  it("keeps only the bounded latest MCP App view identity", () => {
    expect(
      copyAttemptDeliveryState({
        latestMcpAppChannelView: { viewId: "view-latest" },
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
      } as never).latestMcpAppChannelView,
    ).toEqual({ viewId: "view-latest" });
  });

  it("carries the sessions_yield acknowledgment message into the run result", () => {
    expect(
      copyAttemptDeliveryState({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        yieldMessage: "On it — spawned a subagent, will report back.",
      } as never).yieldMessage,
    ).toBe("On it — spawned a subagent, will report back.");
    expect(
      copyAttemptDeliveryState({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
      } as never).yieldMessage,
    ).toBeUndefined();
  });
});

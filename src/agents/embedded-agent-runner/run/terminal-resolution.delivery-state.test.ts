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
});

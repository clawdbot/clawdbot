import { describe, expect, it } from "vitest";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { copyAttemptDeliveryState } from "./attempt-delivery-state.js";
import { createTerminalToolPresentationTracker } from "./terminal-resolution.js";

describe("terminal presentation and delivery state", () => {
  it.each([false, true])("retains actual async tool starts (started=%s)", (asyncStarted) => {
    const attempt = makeEmbeddedRunnerAttempt({
      toolMetas: [{ toolName: "image_generate", asyncStarted }],
    });
    expect(copyAttemptDeliveryState(attempt).asyncWorkStarted).toBe(asyncStarted || undefined);
  });
  it("carries presentation across retries until a newer tool outcome replaces it", () => {
    const tracker = createTerminalToolPresentationTracker();
    const firstOrdinal = tracker.allocateOrdinal();
    tracker.observe({
      toolCallOrdinal: firstOrdinal,
      terminalPresentation: "Fetched https://example.com",
    });

    expect(tracker.read()).toBe("Fetched https://example.com");

    const retryOrdinal = tracker.allocateOrdinal();
    expect(tracker.read()).toBe("Fetched https://example.com");
    tracker.observe({ toolCallOrdinal: retryOrdinal });
    tracker.observe({
      toolCallOrdinal: firstOrdinal,
      terminalPresentation: "stale presentation",
    });

    expect(tracker.read()).toBeUndefined();
  });

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

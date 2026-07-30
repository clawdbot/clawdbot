import { describe, expect, it, vi } from "vitest";
import { createEchoTracker } from "./echo.js";

describe("createEchoTracker", () => {
  it("keeps verbose previews UTF-16 safe without changing the tracked text", () => {
    const logVerbose = vi.fn();
    const tracker = createEchoTracker({ logVerbose });
    const prefix = "x".repeat(49);
    const text = `${prefix}😀tail`;

    tracker.rememberText(text, { logVerboseMessage: true });

    expect(logVerbose).toHaveBeenCalledExactlyOnceWith(
      `Added to echo detection set (size now: 1): ${prefix}...`,
    );
    expect(tracker.has(text)).toBe(true);
  });

  it("keeps identical text isolated to its originating conversation", () => {
    const tracker = createEchoTracker({});

    tracker.rememberText("Done.", { conversationId: "+1000" });

    expect(tracker.has("Done.", "+1000")).toBe(true);
    expect(tracker.has("Done.", "+3000")).toBe(false);

    tracker.forget("Done.", "+1000");

    expect(tracker.has("Done.", "+1000")).toBe(false);
  });

  it("keeps combined-message deduplication independent of conversation-scoped text", () => {
    const tracker = createEchoTracker({});
    const combinedKey = tracker.buildCombinedKey({
      sessionKey: "agent:main:whatsapp:+1000",
      combinedBody: "first\nsecond",
    });

    tracker.rememberText("Done.", {
      conversationId: "+1000",
      combinedBody: "first\nsecond",
      combinedBodySessionKey: "agent:main:whatsapp:+1000",
    });

    expect(tracker.has(combinedKey)).toBe(true);
    expect(tracker.has("Done.", "+1000")).toBe(true);

    tracker.forget(combinedKey);

    expect(tracker.has(combinedKey)).toBe(false);
    expect(tracker.has("Done.", "+1000")).toBe(true);
  });
});

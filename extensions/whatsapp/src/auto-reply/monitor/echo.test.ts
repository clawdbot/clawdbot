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
});

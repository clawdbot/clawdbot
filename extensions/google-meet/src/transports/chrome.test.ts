// Google Meet tests cover chrome plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { testing } from "./chrome.js";

describe("google meet chrome transport", () => {
  it("wraps malformed browser status JSON", () => {
    expect(() =>
      testing.parseMeetBrowserStatusForTest({
        result: "{not json",
      }),
    ).toThrow("Google Meet browser status JSON is malformed.");
  });

  it("caps browser gateway timeout padding", () => {
    expect(testing.resolveBrowserGatewayTimeoutMsForTest(10_000)).toBe(15_000);
    expect(testing.resolveBrowserGatewayTimeoutMsForTest(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

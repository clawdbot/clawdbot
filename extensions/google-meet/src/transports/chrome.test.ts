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
});

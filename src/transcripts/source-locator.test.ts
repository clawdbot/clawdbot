import { describe, expect, it } from "vitest";
import { sanitizeTranscriptSourceLocator } from "./source-locator.js";

describe("sanitizeTranscriptSourceLocator", () => {
  it("removes meeting invitation credentials and drops invalid locators", () => {
    expect(
      sanitizeTranscriptSourceLocator({
        providerId: "zoom",
        meetingUrl: "https://zoom.us/j/123?context=opaque-value#fragment",
      }),
    ).toEqual({ providerId: "zoom", meetingUrl: "https://zoom.us/j/123" });
    expect(
      sanitizeTranscriptSourceLocator({ providerId: "zoom", meetingUrl: "not a URL" }),
    ).toEqual({ providerId: "zoom" });
  });
});

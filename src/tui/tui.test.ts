import { describe, expect, it } from "vitest";

import { resolveFinalAssistantText } from "./tui.js";

describe("resolveFinalAssistantText", () => {
  it("falls back to streamed text when final text is empty", () => {
    expect(
      resolveFinalAssistantText({ finalText: "", streamedText: "Hello" }),
    ).toBe("Hello");
  });

  it("prefers the final text when present", () => {
    expect(
      resolveFinalAssistantText({
        finalText: "All done",
        streamedText: "partial",
      }),
    ).toBe("All done");
  });
});

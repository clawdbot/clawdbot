import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";

describe("sanitizeUserFacingText duplicate block collapsing", () => {
  it("collapses consecutive duplicate prose blocks", () => {
    expect(sanitizeUserFacingText("Done.\n\nDone.\n\nNext step.")).toBe("Done.\n\nNext step.");
  });

  it("keeps repeated blank-separated lines inside a fenced block", () => {
    const text = [
      "Log excerpt:",
      "",
      "```text",
      "[worker] retrying",
      "",
      "[worker] retrying",
      "",
      "[worker] retrying",
      "",
      "[worker] done",
      "```",
    ].join("\n");
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("keeps indentation inside fenced code when a prose duplicate is collapsed", () => {
    const code = [
      "```python",
      "class Worker:",
      "    def run(self):",
      "        self.log()",
      "",
      "    def log(self):",
      "        print(1)",
      "```",
    ].join("\n");
    const text = `Here it is.\n\nHere it is.\n\n${code}`;
    expect(sanitizeUserFacingText(text)).toBe(`Here it is.\n\n${code}`);
  });

  it("keeps a message that opens with indented code intact", () => {
    const text = "    one\n\n    one\n\nDone.\n\nDone.";
    expect(sanitizeUserFacingText(text)).toBe("    one\n\n    one\n\nDone.");
  });

  it("keeps indented code blocks intact when a duplicate is collapsed", () => {
    const text = "Same.\n\nSame.\n\n    indented one\n\n    indented one";
    expect(sanitizeUserFacingText(text)).toBe("Same.\n\n    indented one\n\n    indented one");
  });
});

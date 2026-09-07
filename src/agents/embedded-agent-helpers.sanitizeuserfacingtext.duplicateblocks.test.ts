import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";

describe("sanitizeUserFacingText duplicate-block collapse", () => {
  it("keeps fenced code byte-for-byte when duplicate collapsing fires nearby", () => {
    const reply = [
      "Here is the retry loop and the log it produced:",
      "",
      "```python",
      "class Worker:",
      "    def run(self):",
      '        self.log("retrying")',
      '        replacement = "$&"',
      "",
      "    def log(self, msg):",
      "        print(msg)",
      "```",
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
    expect(sanitizeUserFacingText(reply)).toBe(reply);
  });
});

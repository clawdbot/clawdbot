import { describe, expect, it } from "vitest";
import { formatCliOutputError } from "./cli-output.js";

function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("formatCliOutputError", () => {
  it("keeps truncated session identity UTF-16 safe", () => {
    const sessionId = `${"s".repeat(199)}😀tail`;
    expect(hasDanglingSurrogate(sessionId.slice(0, 200))).toBe(true);

    const error = formatCliOutputError({
      text: "",
      sessionId,
      terminalFailure: { reason: "max_turns" },
    });

    expect(hasDanglingSurrogate(error)).toBe(false);
    expect(error).toContain(`Claude session: ${"s".repeat(199)}.`);
  });
});

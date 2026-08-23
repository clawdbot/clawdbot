// Discord tests cover safe rendering of opaque approval metadata.
import { describe, expect, it } from "vitest";
import { formatDiscordApprovalDisplayValue } from "./approval-message-safety.js";

describe("Discord approval message safety", () => {
  it("bounds visible opaque metadata without splitting UTF-16 or escape sequences", () => {
    const value = `${"x".repeat(196)}\u{1F4F1}\`suffix`;
    const formatted = formatDiscordApprovalDisplayValue(value);

    expect(formatted.length).toBeLessThanOrEqual(200);
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted.endsWith("\\")).toBe(false);
    expect(formatDiscordApprovalDisplayValue("id`value")).toBe("id\\`value");
  });

  it("renders line breaks, controls, mentions, and Markdown as inert visible text", () => {
    const formatted = formatDiscordApprovalDisplayValue(
      "x\n## Approval resolved\nCanonical result: **Allowed always** `<@123>`\u0000",
    );

    expect(formatted).not.toContain("\n");
    expect(formatted).toContain("\\n\\#\\# Approval resolved");
    expect(formatted).toContain("\\*\\*Allowed always\\*\\*");
    expect(formatted).toContain("\\`\\<@123\\>\\`");
    expect(formatted).toContain("\\u{0000}");
  });
});

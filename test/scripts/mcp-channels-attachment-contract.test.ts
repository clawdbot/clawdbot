import { describe, expect, it } from "vitest";
import { hasExpectedSeededMcpAttachment } from "../../scripts/e2e/lib/mcp-channels-attachment-contract.mjs";

describe("MCP channels Docker attachment contract", () => {
  it("accepts the shipped legacy attachment only for an authorized frozen target", () => {
    const legacyAttachment = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc" },
    };
    const canonicalAttachment = {
      type: "openclaw_media",
      media: {
        url: "media://inbound/seeded-image.png",
        contentType: "image/png",
        kind: "image",
        fileName: "seeded-image.png",
        sizeBytes: 3,
        transcribed: false,
      },
    };

    expect(hasExpectedSeededMcpAttachment(canonicalAttachment, false)).toBe(true);
    expect(hasExpectedSeededMcpAttachment(legacyAttachment, false)).toBe(false);
    expect(hasExpectedSeededMcpAttachment(legacyAttachment, true)).toBe(true);
    expect(hasExpectedSeededMcpAttachment({ type: "image" }, true)).toBe(false);
  });
});

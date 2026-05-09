import { describe, expect, it } from "vitest";
import { MarkdownTableModeSchema } from "./zod-schema.core.js";

describe("MarkdownTableModeSchema", () => {
  it("accepts block mode", () => {
    expect(MarkdownTableModeSchema.parse("block")).toBe("block");
  });

  it("rejects unsupported values", () => {
    const result = MarkdownTableModeSchema.safeParse("plain");

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected unsupported markdown table mode to fail schema validation.");
    }
    expect(result.error.issues[0]?.code).toBe("invalid_value");
  });
});

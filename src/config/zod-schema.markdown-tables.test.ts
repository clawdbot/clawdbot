// Verifies markdown table config schema parsing and defaults.
import { describe, expect, it } from "vitest";
import { MarkdownConfigSchema } from "./zod-schema.core.js";

describe("MarkdownConfigSchema tables", () => {
  it("accepts block mode", () => {
    expect(MarkdownConfigSchema.parse({ tables: "block" })).toEqual({ tables: "block" });
  });

  it("rejects unsupported values", () => {
    const result = MarkdownConfigSchema.safeParse({ tables: "plain" });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected unsupported markdown table mode to fail schema validation.");
    }
    expect(result.error.issues[0]?.code).toBe("invalid_value");
  });
});

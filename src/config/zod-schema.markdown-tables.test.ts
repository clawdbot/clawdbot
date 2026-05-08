import { describe, expect, it } from "vitest";
import { MarkdownTableModeSchema } from "./zod-schema.core.js";

describe("MarkdownTableModeSchema", () => {
  it("accepts block mode", () => {
    expect(MarkdownTableModeSchema.parse("block")).toBe("block");
  });

  it("rejects unsupported values", () => {
    expect(() => MarkdownTableModeSchema.parse("plain")).toThrow();
  });
});

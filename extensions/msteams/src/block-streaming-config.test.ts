import { describe, expect, it } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";

describe("MSTeamsConfigSchema blockStreaming", () => {
  const baseConfig = {
    enabled: true,
    dmPolicy: "open" as const,
    allowFrom: ["*"],
  };

  it("accepts blockStreaming: true", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBe(true);
    }
  });

  it("accepts blockStreaming: false", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBe(false);
    }
  });

  it("accepts config without blockStreaming (optional)", () => {
    const result = MSTeamsConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBeUndefined();
    }
  });

  it("accepts blockStreaming alongside blockStreamingCoalesce", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: true,
      blockStreamingCoalesce: { minChars: 100, idleMs: 500 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBe(true);
      expect(result.data.blockStreamingCoalesce).toEqual({ minChars: 100, idleMs: 500 });
    }
  });

  it("rejects non-boolean blockStreaming", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: "yes",
    });
    expect(result.success).toBe(false);
  });
});

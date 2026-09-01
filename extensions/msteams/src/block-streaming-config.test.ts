// Msteams tests cover block streaming config plugin behavior.
import { describe, expect, it } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";

describe("MSTeamsConfigSchema block streaming", () => {
  const baseConfig = {
    enabled: true,
    dmPolicy: "open" as const,
    allowFrom: ["*"],
  };

  it("accepts nested streaming block config", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      streaming: {
        block: {
          enabled: true,
          coalesce: { minChars: 100, idleMs: 500 },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streaming?.block?.enabled).toBe(true);
      expect(result.data.streaming?.block?.coalesce).toEqual({ minChars: 100, idleMs: 500 });
    }
  });

  it("accepts config without streaming (optional)", () => {
    const result = MSTeamsConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streaming).toBeUndefined();
    }
  });

  it("rejects non-boolean streaming.block.enabled", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      streaming: { block: { enabled: "yes" } },
    });
    expect(result.success).toBe(false);
  });

  // Legacy flat keys are doctor-migrated (`openclaw doctor --fix`), not
  // schema-accepted; runtime consumes only the nested streaming shape.
  it.each(["blockStreaming", "chunkMode", "blockStreamingCoalesce"])(
    "rejects legacy flat %s",
    (key) => {
      const value =
        key === "blockStreaming" ? true : key === "chunkMode" ? "newline" : { minChars: 100 };
      const result = MSTeamsConfigSchema.safeParse({
        ...baseConfig,
        [key]: value,
      });
      expect(result.success).toBe(false);
    },
  );
});

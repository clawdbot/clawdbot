import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveToolsConfig } from "./tools-config.js";

describe("feishu tools config", () => {
  it("enables chat tool by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.chat).toBe(true);
  });

  it("accepts tools.chat in config schema", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      tools: {
        chat: false,
      },
    });

    expect(parsed.tools?.chat).toBe(false);
  });
});

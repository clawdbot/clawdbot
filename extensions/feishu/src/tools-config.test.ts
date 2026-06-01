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

  it("enables bitable tool by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.bitable).toBe(true);
    expect(resolved.base).toBe(true);
  });

  it("accepts tools.bitable and tools.base in config schema", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      tools: {
        bitable: false,
        base: false,
      },
    });

    expect(parsed.tools?.bitable).toBe(false);
    expect(parsed.tools?.base).toBe(false);
  });

  it("uses base as a backward-compatible bitable alias", () => {
    expect(resolveToolsConfig({ base: false }).bitable).toBe(false);
    expect(resolveToolsConfig({ base: false }).base).toBe(false);
  });

  it("prefers explicit bitable over base alias", () => {
    const resolved = resolveToolsConfig({ bitable: true, base: false });
    expect(resolved.bitable).toBe(true);
    expect(resolved.base).toBe(true);
  });
});

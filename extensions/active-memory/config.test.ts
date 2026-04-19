import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: Record<string, unknown> };

describe("active-memory manifest config schema", () => {
  it("accepts modelFallback for CLI and config.patch flows", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.model-fallback",
      value: {
        enabled: true,
        agents: ["main"],
        modelFallback: "google/gemini-3-flash",
        modelFallbackPolicy: "resolved-only",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts timeoutMs values at the runtime ceiling", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.timeout-ceiling",
      value: {
        enabled: true,
        agents: ["main"],
        timeoutMs: 120_000,
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects timeoutMs values above the runtime ceiling", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "active-memory.manifest.timeout-above-ceiling",
      value: {
        enabled: true,
        agents: ["main"],
        timeoutMs: 120_001,
      },
    });

    expect(result.ok).toBe(false);
  });
});

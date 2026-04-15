import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: Record<string, unknown> };

describe("memory-lancedb config", () => {
  it("accepts dreaming in the manifest schema and preserves it in runtime parsing", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.dreaming",
      value: {
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: {
          enabled: true,
        },
      },
    });

    const parsed = memoryConfigSchema.parse({
      embedding: {
        apiKey: "sk-test",
      },
      dreaming: {
        enabled: true,
      },
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.dreaming).toEqual({
      enabled: true,
    });
  });

  it("still rejects unrelated unknown top-level config keys", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: {
          enabled: true,
        },
        unexpected: true,
      });
    }).toThrow("memory config has unknown keys: unexpected");
  });

  it("rejects non-object dreaming values in runtime parsing", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: true,
      });
    }).toThrow("dreaming config must be an object");
  });
});

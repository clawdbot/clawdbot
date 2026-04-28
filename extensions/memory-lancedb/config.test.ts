import fs from "node:fs";
import { type JsonSchemaObject, validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it } from "vitest";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

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

  it("accepts provider-backed embedding config without a plugin apiKey", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.provider-auth",
      value: {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    });

    const parsed = memoryConfigSchema.parse({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
      },
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.embedding.apiKey).toBeUndefined();
    expect(parsed.embedding.provider).toBe("openai");
  });

  it("rejects empty embedding config in the manifest schema and runtime parser", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.empty-embedding",
      value: {
        embedding: {},
      },
    });

    expect(manifestResult.ok).toBe(false);
    if (!manifestResult.ok) {
      expect(manifestResult.errors.map((error) => error.text)).toContain(
        "embedding: must NOT have fewer than 1 properties",
      );
    }

    expect(() => {
      memoryConfigSchema.parse({
        embedding: {},
      });
    }).toThrow("embedding config must include at least one setting");
  });

  it("rejects empty embedding providers", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          provider: "",
          model: "text-embedding-3-small",
        },
      });
    }).toThrow("embedding.provider must not be empty");
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

import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: Record<string, unknown> };
const manifestConfigSchemaCacheKey = "qqbot.manifest.config-schema";

describe("qqbot manifest schema", () => {
  it("accepts top-level speech overrides", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: manifestConfigSchemaCacheKey,
      value: {
        tts: {
          provider: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "tts-key",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          authStyle: "api-key",
          queryParams: {
            format: "wav",
          },
          speed: 1.1,
        },
        stt: {
          provider: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "stt-key",
          model: "whisper-1",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts defaultAccount", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: manifestConfigSchemaCacheKey,
      value: {
        defaultAccount: "bot2",
        accounts: {
          bot2: {
            appId: "654321",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});

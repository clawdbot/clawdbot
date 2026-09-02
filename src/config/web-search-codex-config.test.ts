// Verifies web-search config behavior for Codex provider settings.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { mergeScopedSearchConfig } from "../agents/tools/web-search-provider-config.js";
import { validateConfigObjectRaw } from "./validation.js";

describe("web search Codex native config validation", () => {
  it("accepts tools.web.search.openaiCodex", async () => {
    const { OpenClawSchema: freshOpenClawSchema } = await importFreshModule<
      typeof import("./zod-schema.js")
    >(import.meta.url, "./zod-schema.js?scope=web-search-codex");
    const result = freshOpenClawSchema.safeParse({
      tools: {
        web: {
          search: {
            enabled: true,
            openaiCodex: {
              enabled: true,
              mode: "cached",
              allowedDomains: ["example.com"],
              contextSize: "medium",
              userLocation: {
                country: "US",
                city: "New York",
                timezone: "America/New_York",
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("preserves extension-owned tools.web.search entries", () => {
    const result = validateConfigObjectRaw({
      tools: {
        web: {
          search: {
            customSearch: {
              endpoint: "https://search.example.test",
              mode: "strict",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const search = result.config.tools?.web?.search as Record<string, unknown> | undefined;
      expect(search?.customSearch).toEqual({
        endpoint: "https://search.example.test",
        mode: "strict",
      });
    }
  });

  it("accepts runtime-only legacy provider entries injected by web search merge", () => {
    const search = mergeScopedSearchConfig({ enabled: true, provider: "gemini" }, "perplexity", {
      apiKey: "perplexity-test-key",
    });
    const result = validateConfigObjectRaw({
      tools: {
        web: {
          search,
        },
      },
    });

    expect(search?.perplexity).toEqual({ apiKey: "perplexity-test-key" });
    expect(Object.keys(search ?? {})).toEqual(["enabled", "provider"]);
    expect(result.ok).toBe(true);
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects blocked tools.web.search key %s",
    (key) => {
      const result = validateConfigObjectRaw(
        JSON.parse(`{"tools":{"web":{"search":{${JSON.stringify(key)}:{"polluted":true}}}}}`),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: `tools.web.search.${key}`,
              message: "tools.web.search must not contain blocked object keys",
            }),
          ]),
        );
      }
    },
  );

  it("rejects invalid openaiCodex.mode", () => {
    const result = validateConfigObjectRaw({
      tools: {
        web: {
          search: {
            openaiCodex: {
              enabled: true,
              mode: "realtime",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "tools.web.search.openaiCodex.mode",
      );
      expect(issue?.allowedValues).toEqual(["cached", "live"]);
    }
  });

  it("rejects invalid openaiCodex.contextSize", () => {
    const result = validateConfigObjectRaw({
      tools: {
        web: {
          search: {
            openaiCodex: {
              enabled: true,
              contextSize: "huge",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "tools.web.search.openaiCodex.contextSize",
      );
      expect(issue?.allowedValues).toEqual(["low", "medium", "high"]);
    }
  });
});

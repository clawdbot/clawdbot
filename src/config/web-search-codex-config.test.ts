import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
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

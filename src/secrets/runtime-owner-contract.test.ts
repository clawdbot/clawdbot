import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestRuntimeWebOwnerContract } from "./runtime-owner-contract.js";

function digestWebContract(sourceConfig: OpenClawConfig): string {
  return digestRuntimeWebOwnerContract({
    scopePath: "plugins.entries.web-search.config.webSearch.apiKey",
    configuredProvider: "brave",
    toolConfig: sourceConfig.tools?.web?.search,
    providers: [{ id: "brave", pluginId: "web-search" }],
    providerId: "brave",
    sourceConfig,
  });
}

describe("runtime owner contracts", () => {
  it("canonicalizes equivalent web-owner SecretRef input forms", () => {
    const shorthand = {
      plugins: {
        entries: {
          "web-search": { config: { webSearch: { apiKey: "$BRAVE_API_KEY" } } },
        },
      },
    } satisfies OpenClawConfig;
    const canonical = {
      plugins: {
        entries: {
          "web-search": {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(digestWebContract(shorthand)).toBe(digestWebContract(canonical));
  });

  it("binds only the selected provider's canonical owner contribution", () => {
    const digest = (sourceConfig: OpenClawConfig) =>
      digestRuntimeWebOwnerContract({
        scopePath: "tools.web.search",
        configuredProvider: "first",
        toolConfig: sourceConfig.tools?.web?.search,
        providers: ["first", "other"].map((id) => ({
          id,
          getSecretOwnerContract: (config?: OpenClawConfig) => config?.models?.providers?.[id],
        })),
        providerId: "first",
        sourceConfig,
      });
    const config = (firstUrl: string, otherUrl: string, apiKey: unknown): OpenClawConfig =>
      ({
        models: {
          providers: {
            first: { baseUrl: firstUrl, models: [], apiKey },
            other: { baseUrl: otherUrl, models: [] },
          },
        },
      }) as OpenClawConfig;
    const first = config("https://first.invalid/v1", "https://other.invalid/v1", "$FIRST_KEY");
    const equivalent = config("https://first.invalid/v1", "https://changed.invalid/v1", {
      source: "env",
      provider: "default",
      id: "FIRST_KEY",
    });

    expect(digest(first)).toBe(digest(equivalent));
    expect(digest(first)).not.toBe(
      digest(config("https://changed.invalid/v1", "https://other.invalid/v1", "$FIRST_KEY")),
    );
  });
});

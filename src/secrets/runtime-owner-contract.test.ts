import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestRuntimeWebOwnerContract } from "./runtime-owner-contract.js";

function digestWebContract(sourceConfig: OpenClawConfig): string {
  return digestRuntimeWebOwnerContract({
    scopePath: "tools.web.search.apiKey",
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
      tools: { web: { search: { provider: "brave", apiKey: "$BRAVE_API_KEY" } } },
      plugins: {
        entries: {
          "web-search": { config: { apiKey: "$BRAVE_API_KEY" } },
        },
      },
    } satisfies OpenClawConfig;
    const canonical = {
      tools: {
        web: {
          search: {
            provider: "brave",
            apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
          },
        },
      },
      plugins: {
        entries: {
          "web-search": {
            config: {
              apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(digestWebContract(shorthand)).toBe(digestWebContract(canonical));
  });
});

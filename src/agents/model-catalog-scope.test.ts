// Verifies model catalog lookup scope for custom and manifest-owned models.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelCatalogScope } from "./model-catalog-scope.js";

describe("resolveModelCatalogScope", () => {
  it("keeps explicit custom provider models scoped to that provider", () => {
    // Custom provider model ids may collide with built-ins, so lookup should
    // not fall through to bare manifest refs.
    const cfg = {
      models: {
        providers: {
          "tui-pty-mock": {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:64087/v1",
            models: [
              {
                id: "gpt-5.5",
                name: "gpt-5.5",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelCatalogScope({
        cfg,
        provider: "tui-pty-mock",
        model: "gpt-5.5",
      }).modelRefs,
    ).toEqual(["tui-pty-mock/gpt-5.5"]);
  });

  it("keeps bare model refs for manifest-owned model lookup", () => {
    expect(
      resolveModelCatalogScope({
        cfg: {},
        provider: "openai",
        model: "gpt-5.4",
      }).modelRefs,
    ).toEqual(["openai/gpt-5.4", "gpt-5.4"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildModelCatalogMergeKey,
  buildModelCatalogRef,
  normalizeModelCatalog,
  normalizeModelCatalogRows,
} from "./index.js";

describe("model catalog normalization", () => {
  it("normalizes catalog ownership, aliases, suppressions, and row fields", () => {
    const catalog = normalizeModelCatalog(
      {
        providers: {
          OpenAI: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            headers: {
              "x-provider": "openai",
            },
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                api: "openai-completions",
                baseUrl: "https://proxy.example/v1",
                headers: {
                  "x-model": "gpt-5.4",
                },
                input: ["text", "image", "document", "audio"],
                reasoning: true,
                contextWindow: 256000,
                contextTokens: 200000,
                maxTokens: 128000,
                cost: {
                  input: 1.25,
                  output: 10,
                  cacheRead: 0.125,
                  tieredPricing: [
                    {
                      input: 1.25,
                      output: 10,
                      cacheRead: 0.125,
                      cacheWrite: 1.25,
                      range: [0, 256000],
                    },
                    {
                      input: 1,
                      output: 2,
                      range: [0, 1000],
                    },
                  ],
                },
                compat: {
                  supportsTools: true,
                  supportsStore: "yes",
                  unknownFlag: true,
                },
                status: "preview",
                statusReason: "rolling out",
                replaces: ["gpt-5.3"],
                replacedBy: "gpt-5.5",
                tags: ["default"],
              },
              {
                id: "",
              },
            ],
          },
          anthropic: {
            models: [{ id: "claude-sonnet-4.6" }],
          },
        },
        aliases: {
          "Azure-OpenAI-Responses": {
            provider: "OpenAI",
            api: "azure-openai-responses",
          },
          "anthropic-alias": {
            provider: "anthropic",
          },
        },
        suppressions: [
          {
            provider: "Azure-OpenAI-Responses",
            model: "gpt-5.3-codex-spark",
            reason: "not available",
          },
        ],
        discovery: {
          OpenAI: "static",
          anthropic: "static",
          bad: "unknown",
        },
      },
      { ownedProviders: new Set(["OpenAI"]) },
    );

    expect(catalog).toEqual({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          headers: {
            "x-provider": "openai",
          },
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              api: "openai-completions",
              baseUrl: "https://proxy.example/v1",
              headers: {
                "x-model": "gpt-5.4",
              },
              input: ["text", "image", "document"],
              reasoning: true,
              contextWindow: 256000,
              contextTokens: 200000,
              maxTokens: 128000,
              cost: {
                input: 1.25,
                output: 10,
                cacheRead: 0.125,
                tieredPricing: [
                  {
                    input: 1.25,
                    output: 10,
                    cacheRead: 0.125,
                    cacheWrite: 1.25,
                    range: [0, 256000],
                  },
                ],
              },
              compat: {
                supportsTools: true,
              },
              status: "preview",
              statusReason: "rolling out",
              replaces: ["gpt-5.3"],
              replacedBy: "gpt-5.5",
              tags: ["default"],
            },
          ],
        },
      },
      aliases: {
        "azure-openai-responses": {
          provider: "openai",
          api: "azure-openai-responses",
        },
      },
      suppressions: [
        {
          provider: "azure-openai-responses",
          model: "gpt-5.3-codex-spark",
          reason: "not available",
        },
      ],
      discovery: {
        openai: "static",
      },
    });
  });

  it("builds normalized rows with provider defaults and stable refs", () => {
    const rows = normalizeModelCatalogRows({
      source: "manifest",
      providers: {
        OpenAI: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          headers: {
            "x-provider": "openai",
          },
          models: [
            {
              id: "GPT-5.4",
              headers: {
                "x-model": "gpt-5.4",
              },
              input: ["image"],
            },
          ],
        },
      },
    });

    expect(rows).toEqual([
      {
        provider: "openai",
        id: "GPT-5.4",
        ref: "openai/GPT-5.4",
        mergeKey: "openai::gpt-5.4",
        name: "GPT-5.4",
        source: "manifest",
        input: ["image"],
        reasoning: false,
        status: "available",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        headers: {
          "x-provider": "openai",
          "x-model": "gpt-5.4",
        },
      },
    ]);
    expect(buildModelCatalogRef("OpenAI", "GPT-5.4")).toBe("openai/GPT-5.4");
    expect(buildModelCatalogMergeKey("OpenAI", "GPT-5.4")).toBe("openai::gpt-5.4");
  });
});

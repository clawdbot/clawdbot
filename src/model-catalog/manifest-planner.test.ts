import { describe, expect, it } from "vitest";
import { planManifestModelCatalogRows } from "./index.js";

describe("manifest model catalog planner", () => {
  it("builds manifest rows from plugin-owned catalog providers", () => {
    const plan = planManifestModelCatalogRows({
      registry: {
        plugins: [
          {
            id: "moonshot",
            modelCatalog: {
              discovery: {
                moonshot: "static",
              },
              providers: {
                Moonshot: {
                  api: "openai-responses",
                  baseUrl: "https://api.moonshot.ai/v1",
                  models: [
                    {
                      id: "kimi-k2.6",
                      input: ["text", "image"],
                      contextWindow: 256000,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.entries).toEqual([
      {
        pluginId: "moonshot",
        provider: "moonshot",
        discovery: "static",
        rows: [
          {
            provider: "moonshot",
            id: "kimi-k2.6",
            ref: "moonshot/kimi-k2.6",
            mergeKey: "moonshot::kimi-k2.6",
            name: "kimi-k2.6",
            source: "manifest",
            input: ["text", "image"],
            reasoning: false,
            status: "available",
            api: "openai-responses",
            baseUrl: "https://api.moonshot.ai/v1",
            contextWindow: 256000,
          },
        ],
      },
    ]);
    expect(plan.rows.map((row) => row.ref)).toEqual(["moonshot/kimi-k2.6"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("filters providers before row planning", () => {
    const plan = planManifestModelCatalogRows({
      providerFilter: "openrouter",
      registry: {
        plugins: [
          {
            id: "moonshot",
            modelCatalog: {
              providers: {
                moonshot: {
                  models: [{ id: "kimi-k2.6" }],
                },
              },
            },
          },
          {
            id: "openrouter",
            modelCatalog: {
              providers: {
                openrouter: {
                  models: [{ id: "anthropic/claude-sonnet-4.6" }],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.entries.map((entry) => entry.pluginId)).toEqual(["openrouter"]);
    expect(plan.rows.map((row) => row.ref)).toEqual(["openrouter/anthropic/claude-sonnet-4.6"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("reports duplicate provider/model keys and excludes conflicted rows", () => {
    const plan = planManifestModelCatalogRows({
      registry: {
        plugins: [
          {
            id: "z-first",
            modelCatalog: {
              providers: {
                openai: {
                  models: [
                    { id: "gpt-5.4", name: "First GPT-5.4" },
                    { id: "gpt-5.5", name: "GPT-5.5" },
                  ],
                },
              },
            },
          },
          {
            id: "a-second",
            modelCatalog: {
              providers: {
                openai: {
                  models: [{ id: "GPT-5.4", name: "Second GPT-5.4" }],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.entries).toHaveLength(2);
    expect(plan.conflicts).toEqual([
      {
        mergeKey: "openai::gpt-5.4",
        ref: "openai/gpt-5.4",
        provider: "openai",
        modelId: "gpt-5.4",
        firstPluginId: "z-first",
        secondPluginId: "a-second",
      },
    ]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      mergeKey: "openai::gpt-5.5",
      name: "GPT-5.5",
    });
  });
});

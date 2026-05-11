import { describe, expect, it } from "vitest";
import { planManifestModelCatalogRows, planManifestModelCatalogSuppressions } from "./index.js";

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
    expect(plan.conflicts).toStrictEqual([]);
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
    expect(plan.conflicts).toStrictEqual([]);
  });

  it("plans alias-filtered rows from owned provider catalogs", () => {
    const plan = planManifestModelCatalogRows({
      providerFilter: "azure-openai-responses",
      registry: {
        plugins: [
          {
            id: "openai",
            providers: ["openai"],
            modelCatalog: {
              aliases: {
                "azure-openai-responses": {
                  provider: "openai",
                  api: "azure-openai-responses",
                  baseUrl: "https://example.openai.azure.com/openai/v1",
                },
              },
              discovery: {
                openai: "static",
              },
              providers: {
                openai: {
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.pluginId).toBe("openai");
    expect(plan.entries[0]?.provider).toBe("azure-openai-responses");
    expect(plan.entries[0]?.discovery).toBe("static");
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]?.provider).toBe("azure-openai-responses");
    expect(plan.rows[0]?.id).toBe("gpt-5.4");
    expect(plan.rows[0]?.ref).toBe("azure-openai-responses/gpt-5.4");
    expect(plan.rows[0]?.mergeKey).toBe("azure-openai-responses::gpt-5.4");
    expect(plan.rows[0]?.api).toBe("azure-openai-responses");
    expect(plan.rows[0]?.baseUrl).toBe("https://example.openai.azure.com/openai/v1");
  });

  // Regression for https://github.com/openclaw/openclaw/issues/73876.
  // The user-facing complaint is that copying a model id from OpenRouter
  // (which uses "moonshotai/kimi-k2.6" as the org slug) and dropping the
  // "openrouter/" prefix to hit the direct API failed with "Unknown
  // model: moonshotai/kimi-k2.6". The OpenAI plugin already shipped the
  // alias pattern (azure-openai-responses → openai); applying it to the
  // moonshot manifest lets the org-slug name resolve to moonshot's
  // existing catalog without renaming the canonical provider id (which
  // would break operators whose configs already say "moonshot/...").
  it("plans moonshotai alias rows from the moonshot provider catalog", () => {
    const plan = planManifestModelCatalogRows({
      providerFilter: "moonshotai",
      registry: {
        plugins: [
          {
            id: "moonshot",
            providers: ["moonshot"],
            modelCatalog: {
              aliases: {
                moonshotai: {
                  provider: "moonshot",
                },
                "moonshot-ai": {
                  provider: "moonshot",
                },
              },
              discovery: {
                moonshot: "static",
              },
              providers: {
                moonshot: {
                  api: "openai-completions",
                  baseUrl: "https://api.moonshot.ai/v1",
                  models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
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
        provider: "moonshotai",
        discovery: "static",
        rows: [
          {
            provider: "moonshotai",
            id: "kimi-k2.6",
            ref: "moonshotai/kimi-k2.6",
            mergeKey: "moonshotai::kimi-k2.6",
            name: "Kimi K2.6",
            source: "manifest",
            input: ["text"],
            reasoning: false,
            status: "available",
            api: "openai-completions",
            baseUrl: "https://api.moonshot.ai/v1",
          },
        ],
      },
    ]);
    expect(plan.rows).toEqual([
      {
        provider: "moonshotai",
        id: "kimi-k2.6",
        ref: "moonshotai/kimi-k2.6",
        mergeKey: "moonshotai::kimi-k2.6",
        name: "Kimi K2.6",
        source: "manifest",
        input: ["text"],
        reasoning: false,
        status: "available",
        api: "openai-completions",
        baseUrl: "https://api.moonshot.ai/v1",
      },
    ]);
  });

  it("plans moonshot-ai alias rows from the moonshot provider catalog", () => {
    const plan = planManifestModelCatalogRows({
      providerFilter: "moonshot-ai",
      registry: {
        plugins: [
          {
            id: "moonshot",
            providers: ["moonshot"],
            modelCatalog: {
              aliases: {
                "moonshot-ai": {
                  provider: "moonshot",
                },
              },
              providers: {
                moonshot: {
                  api: "openai-completions",
                  baseUrl: "https://api.moonshot.ai/v1",
                  models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.rows).toEqual([
      {
        provider: "moonshot-ai",
        id: "kimi-k2.6",
        ref: "moonshot-ai/kimi-k2.6",
        mergeKey: "moonshot-ai::kimi-k2.6",
        name: "Kimi K2.6",
        source: "manifest",
        input: ["text"],
        reasoning: false,
        status: "available",
        api: "openai-completions",
        baseUrl: "https://api.moonshot.ai/v1",
      },
    ]);
  });

  it("keeps alias provider rows out of unfiltered broad planning", () => {
    const plan = planManifestModelCatalogRows({
      registry: {
        plugins: [
          {
            id: "openai",
            providers: ["openai"],
            modelCatalog: {
              aliases: {
                "azure-openai-responses": {
                  provider: "openai",
                  api: "azure-openai-responses",
                  baseUrl: "https://example.openai.azure.com/openai/v1",
                },
              },
              providers: {
                openai: {
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.entries.map((entry) => entry.provider)).toEqual(["openai"]);
    expect(plan.rows.map((row) => row.ref)).toEqual(["openai/gpt-5.4"]);
    expect(plan.rows.some((row) => row.provider === "azure-openai-responses")).toBe(false);
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
    expect(plan.rows[0]?.mergeKey).toBe("openai::gpt-5.5");
    expect(plan.rows[0]?.name).toBe("GPT-5.5");
  });
});

describe("manifest model catalog suppression planner", () => {
  it("plans suppressions for owned providers and declared provider aliases", () => {
    const plan = planManifestModelCatalogSuppressions({
      registry: {
        plugins: [
          {
            id: "openai",
            providers: ["openai", "openai-codex"],
            modelCatalog: {
              aliases: {
                "azure-openai-responses": {
                  provider: "openai",
                },
              },
              suppressions: [
                {
                  provider: "openai",
                  model: "gpt-5.3-codex-spark",
                  reason: "Use openai/gpt-5.5.",
                  when: {
                    baseUrlHosts: ["api.openai.com"],
                  },
                },
                {
                  provider: "azure-openai-responses",
                  model: "GPT-5.3-Codex-Spark",
                  reason: "Use openai/gpt-5.5.",
                },
                {
                  provider: "openrouter",
                  model: "foreign-row",
                },
              ],
            },
          },
        ],
      },
    });

    expect(plan.suppressions).toEqual([
      {
        pluginId: "openai",
        provider: "azure-openai-responses",
        model: "gpt-5.3-codex-spark",
        mergeKey: "azure-openai-responses::gpt-5.3-codex-spark",
        reason: "Use openai/gpt-5.5.",
      },
      {
        pluginId: "openai",
        provider: "openai",
        model: "gpt-5.3-codex-spark",
        mergeKey: "openai::gpt-5.3-codex-spark",
        reason: "Use openai/gpt-5.5.",
        when: {
          baseUrlHosts: ["api.openai.com"],
        },
      },
    ]);
  });
});

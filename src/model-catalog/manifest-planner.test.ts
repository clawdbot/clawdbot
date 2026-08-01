// Manifest model-catalog planner tests cover plugin-owned row planning, filters, conflicts, and suppressions.
import { describe, expect, it } from "vitest";
import {
  planManifestModelCatalogRows,
  planManifestModelCatalogSuppressions,
} from "./manifest-planner.js";

describe("manifest model catalog planner", () => {
  it("overlays only declared providers and keeps remote transport fields inert", () => {
    const plan = planManifestModelCatalogRows({
      registry: {
        plugins: [
          {
            id: "anthropic",
            providers: ["anthropic"],
            modelCatalog: {
              aliases: {
                "anthropic-alias": { provider: "anthropic", api: "anthropic-messages" },
              },
              providers: {
                anthropic: {
                  api: "anthropic-messages",
                  baseUrl: "https://api.anthropic.com",
                  models: [
                    {
                      id: "old",
                      name: "Bundled",
                      baseUrl: "https://model.api.anthropic.com",
                      headers: { "X-Trusted": "yes" },
                    },
                    { id: "kept" },
                  ],
                },
              },
            },
          },
        ],
      },
      remoteOverlay: {
        anthropic: {
          api: "anthropic-messages",
          models: [{ id: "old", name: "Remote" }, { id: "new" }],
        },
        undeclared: { models: [{ id: "ignored" }] },
      },
    });
    expect(
      plan.rows.map((row) => [row.id, row.name, row.source, row.baseUrl, row.headers]),
    ).toEqual([
      ["kept", "kept", "manifest", "https://api.anthropic.com", undefined],
      ["new", "new", "runtime-refresh", "https://api.anthropic.com", undefined],
      [
        "old",
        "Remote",
        "runtime-refresh",
        "https://model.api.anthropic.com",
        { "X-Trusted": "yes" },
      ],
    ]);
    const aliasPlan = planManifestModelCatalogRows({
      registry: {
        plugins: [
          {
            id: "anthropic",
            providers: ["anthropic"],
            modelCatalog: {
              aliases: { "anthropic-alias": { provider: "anthropic" } },
              providers: { anthropic: { models: [{ id: "old" }] } },
            },
          },
        ],
      },
      providerFilter: "anthropic-alias",
      remoteOverlay: { anthropic: { models: [{ id: "old", name: "Remote alias" }] } },
    });
    expect(aliasPlan.rows).toMatchObject([
      { provider: "anthropic-alias", id: "old", name: "Remote alias", source: "runtime-refresh" },
    ]);
  });

  it("selects static and supplemental rows at their owning catalog boundary", () => {
    const providers = [
      ["static-provider", "static"],
      ["refreshable-provider", "refreshable"],
      ["runtime-provider", "runtime"],
    ] as const;
    const registry = {
      plugins: providers.map(([provider, discovery]) => ({
        id: provider,
        providers: [provider],
        modelCatalog: {
          providers: { [provider]: { models: [{ id: "known" }] } },
          discovery: { [provider]: discovery },
        },
      })),
    };
    const remoteOverlay = Object.fromEntries(
      providers.map(([provider]) => [provider, { models: [{ id: "refreshed" }] }]),
    );
    const refsFor = (selection?: Parameters<typeof planManifestModelCatalogRows>[0]["selection"]) =>
      planManifestModelCatalogRows({
        registry,
        remoteOverlay,
        ...(selection ? { selection } : {}),
      }).rows.map((row) => row.ref);

    expect(refsFor()).toEqual([
      "refreshable-provider/known",
      "refreshable-provider/refreshed",
      "runtime-provider/known",
      "runtime-provider/refreshed",
      "static-provider/known",
      "static-provider/refreshed",
    ]);
    expect(refsFor("static")).toEqual(["static-provider/known", "static-provider/refreshed"]);
    expect(refsFor("supplemental")).toEqual([
      "refreshable-provider/known",
      "refreshable-provider/refreshed",
      "runtime-provider/refreshed",
      "static-provider/known",
      "static-provider/refreshed",
    ]);
  });

  it("keeps conflicting model rows excluded from every catalog selection", () => {
    const registry = {
      plugins: [
        {
          id: "first-owner",
          modelCatalog: {
            providers: { shared: { models: [{ id: "conflicted" }] } },
            discovery: { shared: "static" as const },
          },
        },
        {
          id: "second-owner",
          modelCatalog: {
            providers: { shared: { models: [{ id: "conflicted" }] } },
            discovery: { shared: "runtime" as const },
          },
        },
      ],
    };

    for (const selection of [undefined, "static", "supplemental"] as const) {
      const plan = planManifestModelCatalogRows({
        registry,
        ...(selection ? { selection } : {}),
      });
      expect(plan.rows, selection).toEqual([]);
      expect(plan.conflicts, selection).toHaveLength(1);
    }
  });

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
            providers: ["openai", "openai"],
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

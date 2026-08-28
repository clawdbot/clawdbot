// Verifies manifest-driven model suppression behavior.
import fs from "node:fs";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderRows,
} from "@openclaw/model-catalog-core/model-catalog-normalize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

import { buildManifestBuiltInModelSuppressionResolver } from "./manifest-model-suppression.js";

function createMetadataSnapshot(plugins: Record<string, unknown>[]) {
  return {
    index: { plugins: [] },
    diagnostics: [],
    plugins: plugins.map((plugin) => ({ origin: "bundled", ...plugin })),
  };
}

describe("manifest model suppression", () => {
  beforeEach(() => {
    mocks.loadPluginMetadataSnapshot.mockReset();
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "openai",
          providers: ["openai"],
          modelCatalog: {
            aliases: {
              "azure-openai-responses": {
                provider: "openai",
              },
            },
            suppressions: [
              {
                provider: "azure-openai-responses",
                model: "gpt-5.3-codex-spark",
                reason: "Use openai/gpt-5.5.",
              },
              {
                provider: "openrouter",
                model: "foreign-row",
              },
            ],
          },
        },
      ]),
    );
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: Parameters<typeof mocks.loadPluginMetadataSnapshot>[0]) =>
        mocks.loadPluginMetadataSnapshot(params),
    );
  });

  describe("buildManifestBuiltInModelSuppressionResolver", () => {
    it("reads planned manifest suppressions once per resolver creation", () => {
      const config = { plugins: { entries: { openai: { enabled: true } } } };

      const resolver = buildManifestBuiltInModelSuppressionResolver({
        config,
        env: process.env,
      });

      expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);

      resolver({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      });
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      });

      expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  it("resolves manifest suppressions for declared provider aliases", () => {
    const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });

    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "GPT-5.3-Codex-Spark",
      }),
    ).toEqual({
      suppress: true,
      errorMessage:
        "Unknown model: azure-openai-responses/gpt-5.3-codex-spark. Use openai/gpt-5.5.",
    });
  });

  it("ignores suppressions for providers the plugin does not own", () => {
    const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });

    expect(
      resolver({
        provider: "openrouter",
        id: "foreign-row",
      }),
    ).toBeUndefined();
  });

  it("reuses planned manifest suppressions inside a resolver instance", () => {
    const config = { plugins: { entries: { openai: { enabled: true } } } };

    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config,
      env: process.env,
    });

    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-4.1",
      }),
    ).toBeUndefined();
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
  });

  it("matches conditional suppressions by base URL host", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "qwen",
          providers: ["qwen", "modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "qwen",
                model: "qwen3.6-plus",
                reason: "Use qwen/qwen3.5-plus.",
                when: {
                  baseUrlHosts: [
                    "coding.dashscope.aliyuncs.com",
                    "coding-intl.dashscope.aliyuncs.com",
                  ],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ]),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });

    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 ",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      }),
    ).toBeUndefined();
  });

  it("does not apply conditional suppressions to custom providers with a foreign api owner", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "qwen",
          providers: ["modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "modelstudio",
                model: "qwen3.6-plus",
                when: {
                  baseUrlHosts: ["coding-intl.dashscope.aliyuncs.com"],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ]),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config: {
        models: {
          providers: {
            modelstudio: {
              api: "openai-completions",
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [],
            },
          },
        },
      },
      env: process.env,
    });

    expect(
      resolver({
        provider: "modelstudio",
        id: "qwen3.6-plus",
      }),
    ).toBeUndefined();
  });

  it("does not apply provider api conditional suppressions when a configured provider omits api", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "qwen",
          providers: ["modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "modelstudio",
                model: "qwen3.6-plus",
                when: {
                  baseUrlHosts: ["coding-intl.dashscope.aliyuncs.com"],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ]),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config: {
        models: {
          providers: {
            modelstudio: {
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [],
            },
          },
        },
      },
      env: process.env,
    });

    expect(
      resolver({
        provider: "modelstudio",
        id: "qwen3.6-plus",
      }),
    ).toBeUndefined();
  });

  describe.each(["qwen", "modelstudio"])("%s plan availability", (provider) => {
    describe.each(["openai-completions", undefined] as const)("api=%s", (api) => {
      it.each([
        ["https://coding.dashscope.aliyuncs.com/v1", true],
        ["https://coding-intl.dashscope.aliyuncs.com/v1", true],
        ["https://dashscope.aliyuncs.com/compatible-mode/v1", false],
        ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", false],
        ["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", false],
        ["https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", false],
        ["https://proxy.example/v1", false],
      ] as const)("matches the plan at %s", (baseUrl, suppressed) => {
        // Public metadata is fixture data; core's type graph must not compile plugin files.
        const qwenManifest: Record<string, unknown> = JSON.parse(
          fs.readFileSync(
            new URL("../../extensions/qwen/openclaw.plugin.json", import.meta.url),
            "utf8",
          ),
        );
        mocks.loadPluginMetadataSnapshot.mockReturnValue(createMetadataSnapshot([qwenManifest]));
        const providerCatalog = normalizeModelCatalog(qwenManifest.modelCatalog, {
          ownedProviders: new Set(["qwen"]),
        })?.providers?.qwen;
        if (!providerCatalog) {
          throw new Error("Qwen manifest catalog is missing");
        }
        const rows = normalizeModelCatalogProviderRows({
          provider,
          providerCatalog,
          source: "manifest",
        });
        const resolver = buildManifestBuiltInModelSuppressionResolver({
          config: {
            models: {
              providers: { [provider]: { baseUrl, ...(api ? { api } : {}), models: [] } },
            },
          },
          env: process.env,
        });

        for (const id of ["qwen3.6-flash", "qwen3.7-max", "qwen3.8-max", "qwen3.8-flash"]) {
          const row = rows.find((entry) => entry.id === id);
          expect(row, id).toBeDefined();
          expect(Boolean(resolver({ provider, id, baseUrl: row?.baseUrl })?.suppress), id).toBe(
            suppressed,
          );
        }
        expect(resolver({ provider, id: "qwen3.7-plus" })).toBeUndefined();
      });
    });
  });
});

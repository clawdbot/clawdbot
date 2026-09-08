// Verifies configured model selection uses manifest policy only in scoped contexts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  resolveConfiguredModelRef,
} from "./model-selection-shared.js";

const loadManifestMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryWorkspaceDirFromStateMock = vi.hoisted(() => vi.fn());
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: loadManifestMetadataSnapshotMock,
}));

vi.mock("../plugins/runtime-state.js", () => ({
  getActivePluginRegistryWorkspaceDirFromState: getActivePluginRegistryWorkspaceDirFromStateMock,
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeProviderModelIdWithRuntimeMock,
}));

describe("configured model manifest workspace scope", () => {
  beforeEach(() => {
    loadManifestMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getActivePluginRegistryWorkspaceDirFromStateMock.mockReset();
    normalizeProviderModelIdWithRuntimeMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadManifestMetadataSnapshotMock.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "workspace-model-normalizer",
            modelIdNormalization: {
              providers: {
                custom: {
                  prefixWhenBare: "workspace-custom",
                },
              },
            },
          },
        ],
      }),
    );
  });

  it("does not reuse workspace manifest policies without a workspace context", () => {
    // Workspace plugin normalization must not leak into unscoped callers; they
    // can only use the current global metadata snapshot.
    const cfg = {
      models: {
        providers: {
          custom: {
            models: [{ id: "fast-model" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(buildConfiguredModelCatalog({ cfg })).toMatchObject([
      {
        provider: "custom",
        id: "fast-model",
      },
    ]);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses manifest policies when the workspace context is explicit", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            models: [{ id: "fast-model" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(buildConfiguredModelCatalog({ cfg, workspaceDir: "/workspace/a" })).toMatchObject([
      {
        provider: "custom",
        id: "workspace-custom/fast-model",
      },
    ]);
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      workspaceDir: "/workspace/a",
      env: process.env,
    });
    expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses an unscoped current snapshot without falling back to a metadata scan", () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "workspace-model-normalizer",
            modelIdNormalization: {
              providers: {
                custom: {
                  prefixWhenBare: "global-custom",
                },
              },
            },
          },
        ],
      }),
    );
    const cfg = {
      models: {
        providers: {
          custom: {
            models: [{ id: "fast-model" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(buildConfiguredModelCatalog({ cfg })).toMatchObject([
      {
        provider: "custom",
        id: "global-custom/fast-model",
      },
    ]);
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("builds configured catalog facts once when resolving allowed models", () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(createPluginMetadataSnapshotFixture());
    const cfg = {
      models: {
        providers: {
          custom: { models: [{ id: "fast-model" }] },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider: "custom",
      }).allowedCatalog,
    ).toMatchObject([{ provider: "custom", id: "fast-model" }]);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not load manifest metadata for empty configured model aliases", () => {
    // Alias indexing is a hot config path. Empty inputs should avoid manifest
    // scans entirely.
    const cfg = {} as unknown as OpenClawConfig;

    const aliases = buildModelAliasIndex({ cfg, defaultProvider: "anthropic" });

    expect(aliases.byAlias.size).toBe(0);
    expect(aliases.byKey.size).toBe(0);
    expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not load manifest metadata for wildcard-only configured model aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/*": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const aliases = buildModelAliasIndex({ cfg, defaultProvider: "anthropic" });

    expect(aliases.byAlias.size).toBe(0);
    expect(aliases.byKey.size).toBe(0);
    expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not load manifest metadata for configured model entries without aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/sonnet-4.6": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const aliases = buildModelAliasIndex({ cfg, defaultProvider: "anthropic" });

    expect(aliases.byAlias.size).toBe(0);
    expect(aliases.byKey.size).toBe(0);
    expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("indexes selected-agent default-provider aliases without cold manifest discovery", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          ops: {
            models: {
              "openai/ops": { alias: "Operations" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const aliases = buildModelAliasIndex({ cfg, defaultProvider: "openai", agentId: "ops" });

    expect(aliases.byAlias.get("operations")).toEqual({
      alias: "Operations",
      ref: { provider: "openai", model: "ops" },
    });
    expect(aliases.byKey.get("openai/ops")).toEqual(["Operations"]);
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
    expect(normalizeProviderModelIdWithRuntimeMock.mock.calls.length).toBe(0);
  });

  it("resolves selected-agent default-provider aliases without cold manifest discovery", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          ops: {
            model: { primary: "Operations" },
            models: { "openai/ops": { alias: "Operations" } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        agentId: "ops",
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-sol",
      }),
    ).toEqual({ provider: "openai", model: "ops" });
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
    expect(normalizeProviderModelIdWithRuntimeMock.mock.calls.length).toBe(0);
  });

  it.each(["current", "supplied"] as const)(
    "preserves %s prepared manifest policy for default-provider aliases",
    (source) => {
      const manifestPlugins = [
        {
          modelIdNormalization: {
            providers: {
              openai: { aliases: { legacy: "normalized" } },
            },
          },
        },
      ];
      if (source === "current") {
        getCurrentPluginMetadataSnapshotMock.mockReturnValue(
          createPluginMetadataSnapshotFixture({
            plugins: [{ id: "prepared-model-normalizer", ...manifestPlugins[0] }],
          }),
        );
      }
      const cfg = {
        agents: { defaults: { models: { "openai/legacy": { alias: "Legacy" } } } },
      } as unknown as OpenClawConfig;

      const aliases = buildModelAliasIndex({
        cfg,
        defaultProvider: "openai",
        ...(source === "supplied" ? { manifestPlugins } : {}),
      });

      expect(aliases.byAlias.get("legacy")?.ref).toEqual({
        provider: "openai",
        model: "normalized",
      });
      expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
      expect(normalizeProviderModelIdWithRuntimeMock.mock.calls.length).toBe(1);
    },
  );

  it("preserves workspace manifest policy for default-provider aliases", () => {
    getActivePluginRegistryWorkspaceDirFromStateMock.mockReturnValue("/workspace/a");
    loadManifestMetadataSnapshotMock.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "workspace-model-normalizer",
            modelIdNormalization: { providers: { openai: { aliases: { ops: "workspace-ops" } } } },
          },
        ],
      }),
    );
    const cfg = {
      agents: { defaults: { models: { "openai/ops": { alias: "Operations" } } } },
    } as unknown as OpenClawConfig;

    expect(
      buildModelAliasIndex({ cfg, defaultProvider: "openai" }).byAlias.get("operations")?.ref,
    ).toEqual({ provider: "openai", model: "workspace-ops" });
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(1);
    expect(loadManifestMetadataSnapshotMock.mock.calls[0]?.[0]?.workspaceDir).toBe("/workspace/a");
  });

  it("preserves provider-owned manifest discovery for non-default aliases", () => {
    const cfg = {
      agents: { defaults: { models: { "custom/ops": { alias: "Operations" } } } },
    } as unknown as OpenClawConfig;

    expect(
      buildModelAliasIndex({ cfg, defaultProvider: "openai" }).byAlias.get("operations")?.ref,
    ).toEqual({ provider: "custom", model: "workspace-custom/ops" });
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(1);
    expect(normalizeProviderModelIdWithRuntimeMock.mock.calls.length).toBe(1);
  });

  it.each([
    {
      name: "default-provider first",
      models: [
        ["openai/legacy", { alias: "Legacy" }],
        ["custom/ops", { alias: "Operations" }],
      ],
    },
    {
      name: "provider-owned first",
      models: [
        ["custom/ops", { alias: "Operations" }],
        ["openai/legacy", { alias: "Legacy" }],
      ],
    },
  ])("normalizes mixed aliases consistently with $name", ({ models }) => {
    loadManifestMetadataSnapshotMock.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "workspace-model-normalizer",
            modelIdNormalization: {
              providers: {
                custom: { prefixWhenBare: "workspace-custom" },
                openai: { aliases: { legacy: "normalized" } },
              },
            },
          },
        ],
      }),
    );
    const cfg = {
      agents: { defaults: { models: Object.fromEntries(models) } },
    } as unknown as OpenClawConfig;

    const aliases = buildModelAliasIndex({ cfg, defaultProvider: "openai" });

    expect(aliases.byAlias.get("legacy")?.ref).toEqual({
      provider: "openai",
      model: "normalized",
    });
    expect(aliases.byAlias.get("operations")?.ref).toEqual({
      provider: "custom",
      model: "workspace-custom/ops",
    });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("preserves manifest discovery for default-provider configured API-owner mappings", () => {
    const cfg = {
      agents: { defaults: { models: { "openai/ops": { alias: "Operations" } } } },
      models: { providers: { openai: { api: "custom-owner", models: [] } } },
    } as unknown as OpenClawConfig;

    expect(
      buildModelAliasIndex({ cfg, defaultProvider: "openai" }).byAlias.get("operations")?.ref,
    ).toEqual({ provider: "openai", model: "ops" });
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(1);
  });

  it("does not load manifest metadata for statically resolved primary models", () => {
    const cases: Array<{ cfg: OpenClawConfig; expected: { provider: string; model: string } }> = [
      {
        cfg: {
          agents: { defaults: { model: { primary: "sonnet-4.6" } } },
        } as unknown as OpenClawConfig,
        expected: { provider: "anthropic", model: "sonnet-4.6" },
      },
      {
        cfg: {
          agents: { defaults: { model: { primary: "gpt-5.5" } } },
          models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } },
        } as unknown as OpenClawConfig,
        expected: { provider: "openai", model: "gpt-5.5" },
      },
    ];

    for (const { cfg, expected } of cases) {
      getCurrentPluginMetadataSnapshotMock.mockClear();
      loadManifestMetadataSnapshotMock.mockClear();
      expect(
        resolveConfiguredModelRef({
          cfg,
          defaultProvider: "anthropic",
          defaultModel: "claude-sonnet-4-6",
        }),
      ).toEqual(expected);
      expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
      expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
    }
  });

  it("does not load manifest metadata for non-alias primary models with configured aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "haiku-4.6" },
          models: {
            "anthropic/sonnet-4.6": { alias: "sonnet" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      }),
    ).toEqual({ provider: "anthropic", model: "haiku-4.6" });
    expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses manifest-normalized configured refs to infer providers for bare defaults", () => {
    loadManifestMetadataSnapshotMock.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "workspace-model-normalizer",
            modelIdNormalization: {
              providers: {
                anthropic: {
                  aliases: {
                    "sonnet-4.6": "claude-sonnet-4-6",
                  },
                },
              },
            },
          },
        ],
      }),
    );
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "claude-sonnet-4-6" },
          models: {
            "anthropic/sonnet-4.6": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("reuses resolved manifest plugins while resolving configured model aliases", () => {
    loadManifestMetadataSnapshotMock.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "workspace-model-normalizer",
            modelIdNormalization: {
              providers: {
                anthropic: {
                  aliases: {
                    "sonnet-4.6": "claude-sonnet-4-6",
                  },
                },
                openrouter: {
                  prefixWhenBare: "openrouter",
                },
              },
            },
          },
        ],
      }),
    );
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "router-auto" },
          models: {
            "anthropic/sonnet-4.6": { alias: "sonnet" },
            "openrouter:auto": { alias: "router-auto" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      }),
    ).toEqual({ provider: "openrouter", model: "openrouter/auto" });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("reuses resolved manifest plugins while resolving direct primary models", () => {
    loadManifestMetadataSnapshotMock.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "workspace-model-normalizer",
            modelIdNormalization: {
              providers: {
                anthropic: {
                  aliases: {
                    "sonnet-4.6": "claude-sonnet-4-6",
                  },
                },
                openrouter: {
                  prefixWhenBare: "openrouter",
                },
              },
            },
          },
        ],
      }),
    );
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openrouter:auto" },
          models: {
            "anthropic/sonnet-4.6": { alias: "sonnet" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      }),
    ).toEqual({ provider: "openrouter", model: "openrouter/auto" });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });
});

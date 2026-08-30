import fs from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installPluginMetadataOwner } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import {
  createPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  type PluginMetadataOwner,
  type PreparedPluginMetadata,
  withPluginMetadataCollectionScope,
} from "../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildAllowedModelSet, buildModelAliasIndex } from "./model-selection.js";
import { resolveSessionModelIdentityRef, resolveSessionModelRef } from "./session-model-ref.js";

function modelConfig(primary: string, models?: Record<string, object>): OpenClawConfig {
  return {
    // Precedence-only fixtures do not need executable bundled providers.
    plugins: { enabled: false },
    agents: {
      defaults: { model: { primary }, ...(models ? { models } : {}) },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

async function withPreparedSessionMetadata(
  run: (
    config: OpenClawConfig,
    metadata: PreparedPluginMetadata,
    owner: PluginMetadataOwner,
  ) => void,
  workspacePolicies = false,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pluginDir = state.path("normalizer");
    await fs.mkdir(pluginDir);
    const fixture = createColdPluginFixture({
      rootDir: pluginDir,
      pluginId: "session-model-normalizer",
      manifest: {
        providers: ["custom"],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        modelIdNormalization: {
          providers: { custom: { aliases: { legacy: "current" } } },
        },
      },
    });
    const workspaceDirs = new Map([
      ["main", state.workspaceDir],
      ["work", state.path("work")],
    ]);
    const fixtures = [fixture];
    if (workspacePolicies) {
      for (const [agentId, workspaceDir] of workspaceDirs) {
        const rootDir = `${workspaceDir}/.openclaw/extensions/${agentId}-normalizer`;
        await fs.mkdir(rootDir, { recursive: true });
        fixtures.push(
          createColdPluginFixture({
            rootDir,
            pluginId: `${agentId}-normalizer`,
            manifest: {
              providers: ["workspace-custom", "openai"],
              channels: [],
              channelConfigs: {},
              providerAuthChoices: [],
              modelIdNormalization: {
                providers: {
                  "workspace-custom": { aliases: { legacy: `${agentId}-current` } },
                  openai: { aliases: { legacy: `${agentId}-openai` } },
                },
              },
            },
          }),
        );
      }
    }
    const baseConfig = createColdPluginConfig(pluginDir, fixture.pluginId);
    const config: OpenClawConfig = {
      ...baseConfig,
      plugins: {
        ...baseConfig.plugins,
        entries: Object.fromEntries(fixtures.map(({ pluginId }) => [pluginId, { enabled: true }])),
      },
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "main" },
          ...(workspacePolicies
            ? {
                models: { "openai/legacy": { alias: "Owned" } },
                modelPolicy: { allow: ["workspace-custom/legacy"] },
              }
            : {}),
        },
        entries: {
          main: { workspace: state.workspaceDir },
          work: { workspace: state.path("work") },
        },
      },
      ...(workspacePolicies
        ? {
            models: {
              providers: {
                "workspace-custom": {
                  baseUrl: "https://example.test",
                  models: [
                    {
                      id: "legacy",
                      name: "Workspace model",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            },
          }
        : {}),
    };
    const pluginCache = createPluginCache();
    const owner = createPluginMetadataOwner(pluginCache);
    const dispose = installPluginMetadataOwner(owner, pluginCache);
    try {
      const metadata = owner.prepare({ config });
      owner.publish(metadata, { config });
      run(config, metadata, owner);
      expect(fixtures.some(isColdPluginRuntimeLoaded)).toBe(false);
    } finally {
      dispose();
      clearPluginMetadataLifecycleCaches();
    }
  });
}

function createWorkspaceNormalizerRegistry(metadata: PreparedPluginMetadata, agentId: string) {
  const snapshot = getPluginMetadataWorkspaceSnapshot(metadata, {
    workspaceDir: metadata.agentWorkspaceDirs.get(agentId),
  });
  const manifest = snapshot.byPluginId.get(`${agentId}-normalizer`)!;
  const registry = createEmptyPluginRegistry();
  const normalizedModelIds: string[] = [];
  registry.plugins.push(
    createPluginRecord({
      id: manifest.id,
      source: manifest.source,
      rootDir: manifest.rootDir,
      workspaceDir: manifest.workspaceDir,
      origin: manifest.origin,
      providerIds: ["workspace-custom"],
    }),
  );
  registry.providers.push({
    pluginId: manifest.id,
    source: manifest.source,
    rootDir: manifest.rootDir,
    provider: {
      id: "workspace-custom",
      label: "Workspace normalizer",
      auth: [],
      normalizeModelId: ({ modelId }) => {
        normalizedModelIds.push(modelId);
        return `${agentId}-runtime-${modelId}`;
      },
    },
  });
  return { registry, normalizedModelIds, workspaceDir: snapshot.workspaceDir };
}

describe("resolveSessionModelRef", () => {
  test.each(["main", "work", "removed"])(
    "uses prepared load-path policies for persisted overrides owned by %s",
    async (agentId) => {
      await withPreparedSessionMetadata((config) => {
        expect(
          resolveSessionModelRef(
            config,
            { providerOverride: "custom", modelOverride: "legacy" },
            agentId,
            { allowPluginNormalization: false },
          ),
        ).toEqual({ provider: "custom", model: "current" });
      });
    },
  );

  test.each([
    { pluginIds: ["session-model-normalizer"], model: "current" },
    { pluginIds: [], model: "legacy" },
  ])("keeps retained manifest scope $pluginIds exact", async ({ pluginIds, model }) => {
    await withPreparedSessionMetadata((config, metadata) => {
      const workspaceSnapshot = getPluginMetadataWorkspaceSnapshot(metadata, {
        workspaceDir: metadata.agentWorkspaceDirs.get("work"),
      });
      const metadataSnapshot = projectPluginMetadataSnapshot(workspaceSnapshot, pluginIds);
      const resolve = (
        currentConfig: OpenClawConfig,
        workspace = { workspaceDir: metadata.selectedSnapshot.workspaceDir },
      ) =>
        resolveSessionModelRef(
          currentConfig,
          { providerOverride: "custom", modelOverride: "legacy" },
          "work",
          {
            config,
            workspaceDir: workspace.workspaceDir,
            allowPluginNormalization: false,
            manifestPlugins: metadata.plugins,
          },
        );
      const runtimeConfig = { ...config, plugins: { ...config.plugins, load: { paths: [] } } };
      const resolved = withPluginRuntimeGenerationScope({ config, metadataSnapshot }, () => [
        resolve(runtimeConfig),
        withPluginMetadataCollectionScope(metadata, () => resolve(config), { config }),
        resolve(runtimeConfig),
        resolve(runtimeConfig, { workspaceDir: undefined }),
      ]);
      expect(resolved).toEqual([
        { provider: "custom", model },
        { provider: "custom", model: "current" },
        { provider: "custom", model },
        { provider: "custom", model },
      ]);
    });
  });

  test("uses each prepared agent workspace and the control plane for retired owners", async () => {
    await withPreparedSessionMetadata((config, metadata) => {
      const models = ["main", "work", "removed"].map(
        (agentId) =>
          resolveSessionModelRef(
            config,
            { providerOverride: "workspace-custom", modelOverride: "legacy" },
            agentId,
            { allowPluginNormalization: false },
          ).model,
      );
      expect(models).toEqual(["main-current", "work-current", "main-current"]);
      expect(
        resolveSessionModelRef(
          config,
          { providerOverride: "workspace-custom", modelOverride: "legacy" },
          "work",
          { workspaceDir: undefined, allowPluginNormalization: false },
        ),
      ).toEqual({ provider: "workspace-custom", model: "work-current" });
      const sharedSnapshot = getPluginMetadataWorkspaceSnapshot(metadata, {
        workspaceDir: undefined,
      });
      expect(
        resolveSessionModelRef(
          config,
          { providerOverride: "workspace-custom", modelOverride: "legacy" },
          "work",
          { pluginMetadataSnapshot: sharedSnapshot, allowPluginNormalization: false },
        ),
      ).toEqual({ provider: "workspace-custom", model: "legacy" });
    }, true);
  });

  test.each([
    { scope: "process", model: "legacy" },
    { scope: "request", model: "legacy" },
    { scope: "retained generation", model: "main-runtime-main-current" },
  ])(
    "keeps $scope model hooks within their owner after removing the system agent",
    async ({ scope, model }) => {
      const previousRegistry = captureActivePluginRegistrySnapshot();
      try {
        await withPreparedSessionMetadata((config, metadata, owner) => {
          const main = createWorkspaceNormalizerRegistry(metadata, "main");
          setActivePluginRegistry(
            main.registry,
            "main-normalizer",
            "gateway-bindable",
            main.workspaceDir,
          );
          // A legacy wrapper still exercises hooks; an exact configured id must not be rewritten.
          const entry = {
            providerOverride: "workspace-custom",
            modelOverride: "workspace-custom/legacy",
          };
          expect(resolveSessionModelRef(config, entry)).toEqual({
            provider: "workspace-custom",
            model: "main-runtime-main-current",
          });
          main.normalizedModelIds.length = 0;

          const sharedConfig = structuredClone(config);
          delete sharedConfig.agents!.defaults!.systemAgent;
          const sharedMetadata = owner.prepare({ config: sharedConfig });
          owner.publish(sharedMetadata, { config: sharedConfig });
          const resolve = () => resolveSessionModelRef(sharedConfig, entry);
          const resolved =
            scope === "request"
              ? withPluginRuntimeRegistryScope(main.registry, resolve)
              : scope === "retained generation"
                ? (() => {
                    const work = createWorkspaceNormalizerRegistry(metadata, "work");
                    setActivePluginRegistry(
                      work.registry,
                      "work-normalizer",
                      "gateway-bindable",
                      work.workspaceDir,
                    );
                    return withPluginRuntimeGenerationScope(
                      {
                        config,
                        metadataSnapshot: metadata.selectedSnapshot,
                        pluginRegistry: main.registry,
                      },
                      resolve,
                    );
                  })()
                : resolve();
          expect(resolved).toEqual({ provider: "workspace-custom", model });
          if (scope === "retained generation") {
            expect(main.normalizedModelIds).toContain("main-current");
          }
        }, true);
      } finally {
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );

  test("uses prepared workspace policy for default-provider aliases and configured catalog rows", async () => {
    await withPreparedSessionMetadata((cfg) => {
      const aliases = buildModelAliasIndex({
        cfg,
        agentId: "work",
        defaultProvider: "openai",
        allowPluginNormalization: false,
      });
      expect(aliases.byAlias.get("owned")?.ref).toEqual({
        provider: "openai",
        model: "work-openai",
      });
      const allowed = buildAllowedModelSet({
        cfg,
        agentId: "work",
        defaultProvider: "workspace-custom",
        catalog: [],
      });
      expect(allowed.allowedCatalog).toMatchObject([
        { provider: "workspace-custom", id: "work-current", name: "Workspace model" },
      ]);
      expect([...allowed.allowedKeys]).toEqual(["workspace-custom/work-current"]);
    }, true);
  });

  test("prefers a complete explicit override over runtime identity and current defaults", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      {
        providerOverride: "openrouter",
        modelOverride: "moonshotai/kimi-k2.5",
        modelProvider: "openai",
        model: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({ provider: "openrouter", model: "moonshotai/kimi-k2.5" });
  });

  test("uses the current agent default instead of stale runtime identity", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      { modelProvider: "openai", model: "gpt-5.4" },
      "main",
    );

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  test("preserves runtime identity for legacy callers without an agent id", () => {
    const resolved = resolveSessionModelRef(modelConfig("anthropic/claude-opus-4-6"), {
      modelProvider: "openai",
      model: "gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  test("prefers a legacy model-only override over runtime identity without an agent id", () => {
    const resolved = resolveSessionModelRef(modelConfig("anthropic/claude-opus-4-6"), {
      modelOverride: "claude-haiku-4-5",
      modelProvider: "openai",
      model: "gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("resolves a legacy model-only override under the current default provider", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      {
        modelOverride: "claude-haiku-4-5",
        modelProvider: "openai",
        model: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });
});

describe("resolveSessionModelIdentityRef", () => {
  test("uses prepared load-path policies for slash-prefixed runtime identity", async () => {
    await withPreparedSessionMetadata((config) => {
      expect(
        resolveSessionModelIdentityRef(config, { model: "custom/legacy" }, "work", undefined, {
          allowPluginNormalization: false,
        }),
      ).toEqual({ provider: "custom", model: "current" });
    });
  });

  const resolveLegacyIdentityRef = (cfg: OpenClawConfig, modelProvider?: string) =>
    resolveSessionModelIdentityRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider,
    });

  test("does not inherit default provider for unprefixed legacy runtime model", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");

    expect(resolveLegacyIdentityRef(cfg)).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured model allowlist when unambiguous", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview", {
      "anthropic/claude-sonnet-4-6": {},
    });

    expect(resolveLegacyIdentityRef(cfg)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  test("infers provider from configured provider catalogs when allowlist is absent", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "custom-provider-runtime-model",
        updatedAt: Date.now(),
        model: "qwen-max",
        modelProvider: undefined,
      }),
    ).toEqual({ provider: "qwen-dashscope", model: "qwen-max" });
  });

  test("keeps provider unknown when configured models are ambiguous", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview", {
      "anthropic/claude-sonnet-4-6": {},
      "minimax/claude-sonnet-4-6": {},
    });

    expect(resolveLegacyIdentityRef(cfg)).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("keeps provider unknown when configured provider catalog matches are ambiguous", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
        qwen: {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "ambiguous-custom-provider-runtime-model",
        updatedAt: Date.now(),
        model: "qwen-max",
        modelProvider: undefined,
      }),
    ).toEqual({ model: "qwen-max" });
  });

  test("preserves provider from slash-prefixed runtime model", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "slash-model",
        updatedAt: Date.now(),
        model: "anthropic/claude-sonnet-4-6",
        modelProvider: undefined,
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers wrapper provider for slash-prefixed runtime model when allowlist match is unique", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview", {
      "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
    });

    expect(
      resolveSessionModelIdentityRef(cfg, {
        sessionId: "slash-model",
        updatedAt: Date.now(),
        model: "anthropic/claude-sonnet-4-6",
        modelProvider: undefined,
      }),
    ).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4-6",
    });
  });
});

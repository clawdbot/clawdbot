// Model registry tests cover models.json auth modes and plugin-owned model
// catalog shards.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultApiRegistry,
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
} from "@openclaw/ai/internal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import { ModelRegistry, type ProviderConfigInput } from "./model-registry.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

const tempDirs: string[] = [];

function writeModelsJson(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-model-registry-"));
  tempDirs.push(dir);
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify(contents, null, 2), "utf-8");
  return file;
}

function writeModelsJsonWithPluginCatalog(params: {
  root: unknown;
  pluginRelativePath: string;
  pluginCatalog: unknown;
}): string {
  return writeModelsJsonWithPluginCatalogs({
    root: params.root,
    pluginCatalogs: [
      {
        pluginRelativePath: params.pluginRelativePath,
        pluginCatalog: params.pluginCatalog,
      },
    ],
  });
}

function writeModelsJsonWithPluginCatalogs(params: {
  root: unknown;
  pluginCatalogs: Array<{
    pluginRelativePath: string;
    pluginCatalog: unknown;
  }>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-model-registry-"));
  tempDirs.push(dir);
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify(params.root, null, 2), "utf-8");
  for (const pluginCatalog of params.pluginCatalogs) {
    const pluginFile = join(dir, pluginCatalog.pluginRelativePath);
    mkdirSync(dirname(pluginFile), { recursive: true });
    writeFileSync(pluginFile, JSON.stringify(pluginCatalog.pluginCatalog, null, 2), "utf-8");
  }
  return file;
}

function pluginOwnerSnapshot(providerId: string, pluginId: string, enabled = true) {
  return pluginOwnerSnapshotEntries([{ providerId, pluginId, enabled }]);
}

function pluginOwnerSnapshotEntries(
  entries: Array<{ providerId: string; pluginId: string; enabled?: boolean }>,
) {
  // The registry only trusts generated provider shards that are still owned by
  // an enabled plugin in the current metadata snapshot.
  return {
    index: {
      plugins: entries.map((entry) => ({
        pluginId: entry.pluginId,
        enabled: entry.enabled ?? true,
      })),
    },
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(entries.map((entry) => [entry.providerId, [entry.pluginId]])),
      modelCatalogProviders: new Map(entries.map((entry) => [entry.providerId, [entry.pluginId]])),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
  };
}

function oauthProviderConfig(name: string, apiKeyPrefix: string): ProviderConfigInput {
  return {
    oauth: {
      name,
      login: async () => ({
        access: "test-token-placeholder",
        refresh: "test-token-placeholder",
        expires: Date.now() + 60_000,
      }),
      async refreshToken(credentials) {
        return {
          ...credentials,
          access: "test-token-placeholder",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey: (credentials) => `${apiKeyPrefix}:${credentials.access}`,
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ModelRegistry models.json auth", () => {
  it("accepts Bedrock AWS SDK auth without apiKey", async () => {
    // AWS SDK credential resolution is provider-owned; requiring an apiKey here
    // would make Bedrock catalogs impossible to express in models.json.
    const modelsPath = writeModelsJson({
      providers: {
        "amazon-bedrock": {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
          models: [
            {
              id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
              name: "Claude Sonnet 4.5",
            },
          ],
        },
      },
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const model = registry.find("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0");

    expect(registry.getError()).toBeUndefined();
    expect(model).toBeDefined();
    expect(registry.getAvailable()).toEqual([model]);
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
    expect(registry.getProviderAuthStatus("amazon-bedrock")).toEqual({
      configured: true,
      source: "models_json_key",
      label: "aws-sdk",
    });
  });

  it("uses stored auth for custom models without an inline apiKey", async () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          models: [{ id: "example-model" }],
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({
        custom: { type: "api_key", key: "test-token-placeholder" },
      }),
      modelsPath,
    );
    const model = registry.find("custom", "example-model");

    expect(registry.getError()).toBeUndefined();
    expect(registry.getAvailable()).toEqual([model]);
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("test-token-placeholder");
  });

  it("forks a catalog with request-isolated auth and provider mutations", async () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          models: [{ id: "example-model" }],
        },
      },
    });
    const template = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const firstAuth = AuthStorage.inMemory();
    const secondAuth = AuthStorage.inMemory();
    const first = template.fork(firstAuth);
    const second = template.fork(secondAuth);

    firstAuth.setRuntimeApiKey("custom", "first-runtime-key");
    secondAuth.setRuntimeApiKey("custom", "second-runtime-key");
    first.registerProvider("first-only", oauthProviderConfig("First only", "first"));

    await expect(first.getApiKeyForProvider("custom")).resolves.toBe("first-runtime-key");
    await expect(second.getApiKeyForProvider("custom")).resolves.toBe("second-runtime-key");
    expect(secondAuth.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "first-only",
    );
    expect(template.authStorage.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "first-only",
    );

    const firstModel = first.find("custom", "example-model");
    const secondModel = second.find("custom", "example-model");
    expect(firstModel).toBeDefined();
    expect(secondModel).toBeDefined();
    firstModel!.input.push("image");
    firstModel!.cost.input = 42;
    expect(secondModel!.input).toEqual(["text"]);
    expect(secondModel!.cost.input).toBe(0);
    expect(template.find("custom", "example-model")!.input).toEqual(["text"]);
    expect(template.find("custom", "example-model")!.cost.input).toBe(0);

    first.unregisterProvider("first-only");
    expect(first.find("custom", "example-model")).toBeDefined();
  });

  it("preserves models.json provider auth in a catalog fork", async () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          apiKey: "test-token-placeholder",
          models: [{ id: "example-model" }],
        },
      },
    });
    const template = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const fork = template.fork(AuthStorage.inMemory());
    const model = fork.find("custom", "example-model");

    expect(model).toBeDefined();
    await expect(fork.getApiKeyForProvider("custom")).resolves.toBe("test-token-placeholder");
    await expect(fork.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: "test-token-placeholder",
      headers: undefined,
    });
  });

  it("does not restore a source provider after unregistering it from a fork", () => {
    const template = ModelRegistry.inMemory(AuthStorage.inMemory());
    template.registerProvider("template-only", oauthProviderConfig("Template only", "template"));
    const forkAuth = AuthStorage.inMemory();
    const fork = template.fork(forkAuth);

    expect(forkAuth.getOAuthProviders().map((provider) => provider.id)).toContain("template-only");
    fork.unregisterProvider("template-only");
    expect(forkAuth.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "template-only",
    );
  });

  it("forks the latest base catalog after the source reloads", () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          models: [{ id: "before-reload" }],
        },
      },
    });
    const source = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-responses",
            models: [{ id: "after-reload" }],
          },
        },
      }),
      "utf-8",
    );

    source.refresh();
    const fork = source.fork(AuthStorage.inMemory());

    expect(fork.find("custom", "before-reload")).toBeUndefined();
    expect(fork.find("custom", "after-reload")).toBeDefined();
  });

  it("uses stored auth for dynamically registered provider models", () => {
    const authStorage = AuthStorage.inMemory({
      custom: { type: "api_key", key: "test-token-placeholder" },
    });
    const registry = ModelRegistry.inMemory(authStorage);

    registry.registerProvider("custom", {
      baseUrl: "https://models.example/v1",
      api: "openai-responses",
      models: [
        {
          id: "example-model",
          name: "Example Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    });

    expect(registry.getAvailable().map((model) => model.id)).toEqual(["example-model"]);
  });

  it("loads provider models from generated plugin catalog shards", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            apiKey: "ZAI_API_KEY",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
  });

  it("tracks explicit max-token provenance across authored and generated catalogs", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: {
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-completions",
            models: [{ id: "authored-model", maxTokens: 2_048 }],
          },
        },
      },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            models: [{ id: "catalog-model", maxTokens: 32_768 }],
          },
        },
      },
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
      pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai"),
    });

    expect(registry.find("custom", "authored-model")).toMatchObject({
      maxTokens: 2_048,
      maxTokensSource: "configured",
    });
    expect(registry.find("zai", "catalog-model")).toMatchObject({
      maxTokens: 32_768,
      maxTokensSource: "discovered",
    });
  });

  it("preserves response-model temperature compatibility from generated catalogs", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "openai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            apiKey: "test-token-placeholder",
            models: [
              {
                id: "gpt-5.6-luna",
                name: "GPT-5.6 Luna",
                compat: { supportsTemperature: false },
              },
            ],
          },
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ openai: { type: "api_key", key: "test-token-placeholder" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("openai", "openai") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("openai", "gpt-5.6-luna")?.compat).toMatchObject({
      supportsTemperature: false,
    });
  });

  it("loads richer generated catalog metadata without widening runtime inputs", () => {
    // Generated catalogs can report video/audio support. Keep those rows while
    // projecting their metadata to the runtime execution contract.
    const modelsPath = writeModelsJsonWithPluginCatalogs({
      root: { providers: {} },
      pluginCatalogs: [
        {
          pluginRelativePath: join("plugins", "minimax", PLUGIN_MODEL_CATALOG_FILE),
          pluginCatalog: {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              minimax: {
                baseUrl: "https://api.minimaxi.com/v1",
                api: "openai-completions",
                apiKey: "MINIMAX_API_KEY",
                models: [{ id: "MiniMax-M3", input: ["text", "image", "video"] }],
              },
            },
          },
        },
        {
          pluginRelativePath: join("plugins", "nvidia", PLUGIN_MODEL_CATALOG_FILE),
          pluginCatalog: {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              nvidia: {
                baseUrl: "https://integrate.api.nvidia.com/v1",
                api: "openai-completions",
                apiKey: "NVIDIA_API_KEY",
                models: [
                  {
                    id: "microsoft/phi-4-multimodal-instruct",
                    input: ["text", "image", "audio"],
                  },
                  { id: "audio-only", input: ["audio"] },
                  { id: "explicit-empty", input: [] },
                ],
              },
            },
          },
        },
      ],
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({
        minimax: { type: "api_key", key: "sk-minimax" },
        nvidia: { type: "api_key", key: "sk-nvidia" },
      }),
      modelsPath,
      {
        pluginMetadataSnapshot: pluginOwnerSnapshotEntries([
          { providerId: "minimax", pluginId: "minimax" },
          { providerId: "nvidia", pluginId: "nvidia" },
        ]),
      },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("minimax", "MiniMax-M3")?.input).toEqual(["text", "image"]);
    expect(registry.find("nvidia", "microsoft/phi-4-multimodal-instruct")?.input).toEqual([
      "text",
      "image",
    ]);
    expect(registry.find("nvidia", "audio-only")).toBeUndefined();
    expect(registry.find("nvidia", "explicit-empty")?.input).toEqual([]);
    const availableRefs = registry.getAvailable().map((model) => `${model.provider}/${model.id}`);
    expect(availableRefs).not.toContain("nvidia/audio-only");
    expect(availableRefs).toContain("nvidia/explicit-empty");
  });

  it("isolates invalid generated plugin catalog shards from valid models", () => {
    const modelsPath = writeModelsJsonWithPluginCatalogs({
      root: {
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-responses",
            apiKey: "CUSTOM_API_KEY",
            models: [{ id: "root-model", name: "Root Model" }],
          },
        },
      },
      pluginCatalogs: [
        {
          pluginRelativePath: join("plugins", "google", PLUGIN_MODEL_CATALOG_FILE),
          pluginCatalog: {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              "google-vertex": {
                baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
                apiKey: "GOOGLE_API_KEY",
                models: [{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" }],
              },
            },
          },
        },
        {
          pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
          pluginCatalog: {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              zai: {
                baseUrl: "https://api.z.ai/api/paas/v4",
                api: "openai-completions",
                apiKey: "ZAI_API_KEY",
                models: [{ id: "glm-5.1", name: "GLM 5.1" }],
              },
            },
          },
        },
      ],
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
      pluginMetadataSnapshot: pluginOwnerSnapshotEntries([
        { providerId: "google-vertex", pluginId: "google" },
        { providerId: "zai", pluginId: "zai" },
      ]),
    });

    expect(registry.getError()).toContain(
      'Provider google-vertex, model gemini-3.1-pro-preview: no "api" specified',
    );
    expect(registry.find("custom", "root-model")?.name).toBe("Root Model");
    expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
    expect(registry.find("google-vertex", "gemini-3.1-pro-preview")).toBeUndefined();
  });

  it("preserves model params from generated plugin catalog shards", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "amazon-bedrock", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            api: "bedrock-converse-stream",
            auth: "aws-sdk",
            models: [
              {
                id: "company-fable",
                name: "Company Fable",
                params: { canonicalModelId: "claude-fable-5" },
              },
            ],
          },
        },
      },
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
      pluginMetadataSnapshot: pluginOwnerSnapshot("amazon-bedrock", "amazon-bedrock"),
    });

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("amazon-bedrock", "company-fable")?.params).toEqual({
      canonicalModelId: "claude-fable-5",
    });
  });

  it("ignores non-generated plugin catalog files", () => {
    // Plugin catalog shards are codegen artifacts; hand-written lookalikes must
    // not extend the provider registry.
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            apiKey: "ZAI_API_KEY",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });

  it("ignores generated plugin catalog providers without current ownership", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            apiKey: "ZAI_API_KEY",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("other", "other") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });

  it("ignores generated plugin catalog providers owned by disabled plugins", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            apiKey: "ZAI_API_KEY",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai", false) },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });
});

describe("ModelRegistry OAuth provider ownership", () => {
  it("keeps providers isolated when another registry refreshes", async () => {
    const sessionAAuth = AuthStorage.inMemory({
      "corporate-ai": {
        type: "oauth",
        access: "test-token-placeholder",
        refresh: "test-token-placeholder",
        expires: 0,
      },
    });
    const sessionA = ModelRegistry.inMemory(sessionAAuth);
    sessionA.registerProvider("corporate-ai", oauthProviderConfig("Corporate AI", "corporate"));

    const sessionBAuth = AuthStorage.inMemory();
    const sessionB = ModelRegistry.inMemory(sessionBAuth);
    sessionB.registerProvider("team-proxy", oauthProviderConfig("Team Proxy", "team"));

    expect(sessionAAuth.getOAuthProviders().map((provider) => provider.id)).toContain(
      "corporate-ai",
    );
    await expect(sessionA.getApiKeyForProvider("corporate-ai")).resolves.toBe(
      "corporate:test-token-placeholder",
    );

    sessionB.unregisterProvider("team-proxy");

    expect(sessionBAuth.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "team-proxy",
    );
    expect(sessionAAuth.getOAuthProviders().map((provider) => provider.id)).toContain(
      "corporate-ai",
    );
    await expect(sessionA.getApiKeyForProvider("corporate-ai")).resolves.toBe(
      "corporate:test-token-placeholder",
    );
  });

  it("keeps a built-in override local to its registry", () => {
    const sessionAAuth = AuthStorage.inMemory();
    const sessionA = ModelRegistry.inMemory(sessionAAuth);
    sessionA.registerProvider("anthropic", oauthProviderConfig("Corporate Anthropic", "corp"));

    const sessionBAuth = AuthStorage.inMemory();

    expect(
      sessionAAuth.getOAuthProviders().find((provider) => provider.id === "anthropic")?.name,
    ).toBe("Corporate Anthropic");
    expect(
      sessionBAuth.getOAuthProviders().find((provider) => provider.id === "anthropic")?.name,
    ).toBe("Anthropic (Claude Pro/Max)");
  });
});

describe("ModelRegistry API provider ownership", () => {
  it("keeps stream registrations isolated across registry refreshes", () => {
    const sessionA = ModelRegistry.inMemory(AuthStorage.inMemory());
    const sessionB = ModelRegistry.inMemory(AuthStorage.inMemory());
    const streamA = vi.fn(() => ({}) as never);
    const streamB = vi.fn(() => ({}) as never);

    sessionA.registerProvider("session-a", {
      api: "test-session-api",
      streamSimple: streamA,
    });
    sessionB.registerProvider("session-b", {
      api: "test-session-api",
      streamSimple: streamB,
    });
    const runtimeA = getModelRegistryRuntime(sessionA);
    const runtimeB = getModelRegistryRuntime(sessionB);

    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")?.streamSimple).not.toBe(
      runtimeB.apiRegistry.getApiProvider("test-session-api")?.streamSimple,
    );
    expect(getApiProvider("test-session-api")).toBeUndefined();

    sessionB.unregisterProvider("session-b");

    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")).toBeDefined();
    expect(runtimeB.apiRegistry.getApiProvider("test-session-api")).toBeUndefined();
  });

  it("imports published SDK providers without copying request-generated aliases", () => {
    const publishedSource = "plugin:test-published-api";
    const requestSource = "custom-api:test-request-api";
    const stream = vi.fn(() => ({}) as never);
    registerApiProvider(
      { api: "test-published-api", stream, streamSimple: stream },
      publishedSource,
    );
    defaultApiRegistry.registerApiProvider(
      { api: "test-request-api", stream, streamSimple: stream },
      requestSource,
    );

    try {
      const session = ModelRegistry.inMemory(AuthStorage.inMemory());
      const runtime = getModelRegistryRuntime(session);

      expect(runtime.apiRegistry.getApiProvider("test-published-api")).toBeDefined();
      expect(runtime.apiRegistry.getApiProvider("test-request-api")).toBeUndefined();
    } finally {
      unregisterApiProviders(publishedSource);
      defaultApiRegistry.unregisterApiProviders(requestSource);
    }
  });
});

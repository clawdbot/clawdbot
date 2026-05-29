import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_MODEL_CATALOG_FILE,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

let tempDirs: string[] = [];

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
  const dir = mkdtempSync(join(tmpdir(), "openclaw-model-registry-"));
  tempDirs.push(dir);
  const file = join(dir, "models.json");
  const pluginFile = join(dir, params.pluginRelativePath);
  mkdirSync(dirname(pluginFile), { recursive: true });
  writeFileSync(file, JSON.stringify(params.root, null, 2), "utf-8");
  writeFileSync(pluginFile, JSON.stringify(params.pluginCatalog, null, 2), "utf-8");
  return file;
}

function pluginOwnerSnapshot(providerId: string, pluginId: string, enabled = true) {
  return {
    index: {
      plugins: [{ pluginId, enabled }],
    },
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map([[providerId, [pluginId]]]),
      modelCatalogProviders: new Map([[providerId, [pluginId]]]),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
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

  it("still rejects api-key custom models without apiKey", () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          models: [{ id: "example-model" }],
        },
      },
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

    expect(registry.getError()).toContain('Provider custom: "apiKey" is required');
    expect(registry.find("custom", "example-model")).toBeUndefined();
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

  it("ignores non-generated plugin catalog files", () => {
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

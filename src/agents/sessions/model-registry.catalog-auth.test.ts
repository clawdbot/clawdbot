// Catalog auth tests exercise profile selection and credential-free registry boundaries.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { saveAuthProfileStore } from "../auth-profiles/store.js";
import { markAuthStorageCredentialFree } from "./auth-storage-profiles.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

const tempDirs: string[] = [];

function writeCatalog(apiKey: string): string {
  const agentDir = mkdtempSync(join(tmpdir(), "openclaw-model-registry-auth-"));
  tempDirs.push(agentDir);
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          apiKey,
          models: [{ id: "example-model" }],
        },
      },
    }),
  );
  return modelsPath;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ModelRegistry catalog auth", () => {
  it("never treats plaintext catalog auth or another default as outbound auth", async () => {
    const template = ModelRegistry.create(AuthStorage.inMemory(), writeCatalog("plaintext-key"));
    const authStorage = AuthStorage.inMemory({
      custom: { type: "api_key", key: "different-default" },
    });
    authStorage.setFallbackResolver(() => "generic-fallback");
    const registry = template.fork(authStorage);

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    authStorage.setRuntimeApiKey("custom", "runtime-override");
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("runtime-override");
  });

  it("resolves a non-default catalog profile without selecting an occupied default", async () => {
    const modelsPath = writeCatalog("custom:models-json");
    const agentDir = dirname(modelsPath);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "wrong-default" },
          "custom:models-json": { type: "api_key", provider: "custom", key: "catalog-key" },
        },
      },
      agentDir,
    );
    const registry = ModelRegistry.create(AuthStorage.forAgent(agentDir), modelsPath);

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("catalog-key");
    await expect(
      registry
        .fork(AuthStorage.inMemory({ custom: { type: "api_key", key: "wrong-default" } }))
        .getApiKeyForProvider("custom"),
    ).resolves.toBeUndefined();
  });

  it("keeps an exact default authoritative and updates removal state", async () => {
    const modelsPath = writeCatalog("custom:default");
    const agentDir = dirname(modelsPath);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "catalog-key" },
          "custom:backup": { type: "api_key", provider: "custom", key: "ordered-first" },
        },
        order: { custom: ["custom:backup", "custom:default"] },
      },
      agentDir,
    );
    const authStorage = AuthStorage.forAgent(agentDir);
    const registry = ModelRegistry.create(authStorage, modelsPath);

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("catalog-key");
    authStorage.remove("custom");
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    expect(registry.getAvailable()).toEqual([]);
  });

  it("keeps dynamic provider auth out of credential-free forks", async () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider("custom", {
      apiKey: "dynamic-secret",
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

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("dynamic-secret");
    const credentialFree = registry.fork(markAuthStorageCredentialFree(AuthStorage.inMemory()));
    await expect(credentialFree.getApiKeyForProvider("custom")).resolves.toBeUndefined();
  });
});

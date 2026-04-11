import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { ensureAuthProfileStore, type AuthProfileStore } from "../agents/auth-profiles.js";
import { clearConfigCache, clearRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/types.js";
import { __testing as webFetchProvidersTesting } from "../plugins/web-fetch-providers.runtime.js";
import { __testing as webSearchProvidersTesting } from "../plugins/web-search-providers.runtime.js";
import { captureEnv } from "../test-utils/env.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";

export const OPENAI_ENV_KEY_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_API_KEY",
} as const;

export const OPENAI_FILE_KEY_REF = {
  source: "file",
  provider: "default",
  id: "/providers/openai/apiKey",
} as const;

export const SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS = 300_000;
export const EMPTY_LOADABLE_PLUGIN_ORIGINS: ReadonlyMap<string, PluginOrigin> = new Map();
export type SecretsRuntimeEnvSnapshot = ReturnType<typeof captureEnv>;

const allowInsecureTempSecretFile = process.platform === "win32";

export function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

export function loadAuthStoreWithProfiles(
  profiles: AuthProfileStore["profiles"],
): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

export async function createOpenAIFileRuntimeFixture(home: string) {
  const configDir = path.join(home, ".openclaw");
  const secretFile = path.join(configDir, "secrets.json");
  const agentDir = path.join(configDir, "agents", "main", "agent");
  const authStorePath = path.join(agentDir, "auth-profiles.json");

  await fs.mkdir(agentDir, { recursive: true });
  await fs.chmod(configDir, 0o700).catch(() => {});
  await fs.writeFile(
    secretFile,
    `${JSON.stringify({ providers: { openai: { apiKey: "sk-file-runtime" } } }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(
    authStorePath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: OPENAI_FILE_KEY_REF,
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  return {
    configDir,
    secretFile,
    agentDir,
  };
}

export function createOpenAIFileRuntimeConfig(secretFile: string): OpenClawConfig {
  return asConfig({
    secrets: {
      providers: {
        default: {
          source: "file",
          path: secretFile,
          mode: "json",
          ...(allowInsecureTempSecretFile ? { allowInsecurePath: true } : {}),
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: OPENAI_FILE_KEY_REF,
          models: [],
        },
      },
    },
  });
}

export function expectResolvedOpenAIRuntime(agentDir: string) {
  expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-file-runtime");
  expect(ensureAuthProfileStore(agentDir).profiles["openai:default"]).toMatchObject({
    type: "api_key",
    key: "sk-file-runtime",
  });
}

export function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  const envSnapshot = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE",
    "OPENCLAW_VERSION",
  ]);
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
  delete process.env.OPENCLAW_VERSION;
  return envSnapshot;
}

export function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  webSearchProvidersTesting.resetWebSearchProviderSnapshotCacheForTests();
  webFetchProvidersTesting.resetWebFetchProviderSnapshotCacheForTests();
}

import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { captureEnv } from "../test-utils/env.js";
import { getActiveSecretsRuntimeSnapshot } from "./runtime.js";

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
  expect(getRuntimeConfig().models?.providers?.openai?.apiKey).toBe("sk-file-runtime");
  const activeAuthStore = getActiveSecretsRuntimeSnapshot()?.authStores.find(
    (entry) => entry.agentDir === agentDir,
  )?.store;
  expect(activeAuthStore?.profiles["openai:default"]).toMatchObject({
    type: "api_key",
    key: "sk-file-runtime",
  });
}

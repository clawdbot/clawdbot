// Tests workspace dotenv blocklist completeness across shipped runtime controls.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

type DotEnvFixture = {
  base: string;
  cwdDir: string;
  stateDir: string;
};

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const envSnapshot = captureFullEnv();
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
    envSnapshot.restore();
  }
}

async function withDotEnvFixture(run: (fixture: DotEnvFixture) => Promise<void>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
  const cwdDir = path.join(base, "cwd");
  const stateDir = path.join(base, "state");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  await fs.mkdir(cwdDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await run({ base, cwdDir, stateDir });
}

function clearEnv(keys: readonly string[]) {
  for (const key of keys) {
    deleteTestEnvValue(key);
  }
}

function emptyOwnerMaps(): PluginMetadataSnapshot["owners"] {
  return {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    modelIdNormalizationPolicies: new Map(),
  };
}

function createManifestBackedProviderSnapshot(
  plugin: PluginManifestRecord,
): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    plugins: [plugin],
    diagnostics: [],
    byPluginId: new Map([[plugin.id, plugin]]),
    normalizePluginId: (pluginId: string) => pluginId,
    owners: emptyOwnerMaps(),
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 1,
    },
  };
}

describe("workspace .env blocklist completeness", () => {
  it("keeps trusted global dotenv for global plugin provider auth vars", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        const plugin: PluginManifestRecord = {
          id: "runtime-cloud",
          channels: [],
          providers: ["runtime-cloud"],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "global",
          rootDir: "/plugins/runtime-cloud",
          source: "/plugins/runtime-cloud/index.js",
          manifestPath: "/plugins/runtime-cloud/openclaw.plugin.json",
          setup: {
            providers: [{ id: "runtime-cloud", envVars: ["RUNTIME_CLOUD_API_KEY"] }],
          },
        };
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "RUNTIME_CLOUD_API_KEY=workspace-plugin-key\n",
        );
        await writeEnvFile(
          path.join(stateDir, ".env"),
          "RUNTIME_CLOUD_API_KEY=global-plugin-key\n",
        );

        delete process.env.RUNTIME_CLOUD_API_KEY;
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        setCurrentPluginMetadataSnapshot(createManifestBackedProviderSnapshot(plugin), {
          config: {},
          env: process.env,
        });

        try {
          loadDotEnv({ quiet: true });

          expect(process.env.RUNTIME_CLOUD_API_KEY).toBe("global-plugin-key");
        } finally {
          clearPluginMetadataLifecycleCaches();
        }
      });
    });
  });

  it("keeps registered provider auth vars from trusted global dotenv", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        const providerAuthKeys = listKnownProviderAuthEnvVarNames().toSorted();
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          `${providerAuthKeys.map((key) => `${key}=workspace-${key}`).join("\n")}\n`,
        );
        await writeEnvFile(
          path.join(stateDir, ".env"),
          `${providerAuthKeys.map((key) => `${key}=global-${key}`).join("\n")}\n`,
        );

        clearEnv(providerAuthKeys);
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        loadDotEnv({ quiet: true });

        for (const key of providerAuthKeys) {
          expect(process.env[key], `${key} should come from trusted global .env`).toBe(
            `global-${key}`,
          );
        }
      });
    });
  });

  it("blocks runtime-control variables from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        const runtimeControlKeys = [
          "OPENCLAW_GIT_DIR",
          "OPENCLAW_WORKSPACE_DIR",
          "OPENCLAW_MDNS_HOSTNAME",
          "OPENCLAW_SESSION_CACHE_TTL_MS",
          "OPENCLAW_UPDATE_PACKAGE_SPEC",
          "OPENCLAW_GATEWAY_PORT",
          "OPENCLAW_GATEWAY_URL",
          "OPENCLAW_CLAWHUB_URL",
          "CLAWHUB_URL",
          "CLAWHUB_TOKEN",
          "CLAWHUB_AUTH_TOKEN",
          "CLAWHUB_CONFIG_PATH",
          "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
          "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
          "OPENCLAW_BROWSER_EXECUTABLE_PATH",
          "OPENCLAW_WHATSAPP_WEB_SOCKET_URL",
          "EXAMPLE_API_HOST",
          "HOMEBREW_BREW_FILE",
          "HOMEBREW_PREFIX",
          "IRC_HOST",
          "APPDATA",
          "LOCALAPPDATA",
          "MATTERMOST_URL",
          "MATRIX_HOMESERVER",
          "MINIMAX_API_HOST",
          "BUZZ_RELAY_URL",
          "SMS_ALLOWED_USERS",
          "SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION",
          "SMS_PUBLIC_WEBHOOK_URL",
          "AWS_ACCESS_KEY_ID",
          "AWS_ACCOUNT_ID",
          "AWS_ACCOUNT_ID_ENDPOINT_MODE",
          "AWS_BEARER_TOKEN_BEDROCK",
          "AWS_BEDROCK_SKIP_AUTH",
          "AWS_CONTAINER_AUTHORIZATION_TOKEN",
          "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
          "AWS_CONTAINER_CREDENTIALS_FULL_URI",
          "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
          "AWS_CONFIG_FILE",
          "AWS_CREDENTIAL_EXPIRATION",
          "AWS_CREDENTIAL_SCOPE",
          "AWS_EC2_METADATA_DISABLED",
          "AWS_EC2_METADATA_SERVICE_ENDPOINT",
          "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
          "AWS_EC2_METADATA_V1_DISABLED",
          "AWS_ENDPOINT_URL",
          "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
          "AWS_PROFILE",
          "AWS_ROLE_ARN",
          "AWS_ROLE_SESSION_NAME",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
          "AWS_SHARED_CREDENTIALS_FILE",
          "AWS_WEB_IDENTITY_TOKEN_FILE",
          "SYNOLOGY_ALLOWED_USER_IDS",
          "FUTURE_CHANNEL_DISABLE_SIGNATURE_VALIDATION",
          "FUTURE_PLUGIN_DANGEROUSLY_ALLOW_UNTRUSTED",
          "FUTURE_PROVIDER_SKIP_AUTH",
          "BROWSER_EXECUTABLE_PATH",
          "CLOUDSDK_CONFIG",
          "CLOUDSDK_PYTHON",
          "CLOUDSDK_PYTHON_ARGS",
          "CLOUDSDK_PYTHON_SITEPACKAGES",
          "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
          "OPENCLAW_SKIP_CHANNELS",
          "OPENCLAW_SKIP_PROVIDERS",
          "OPENCLAW_SKIP_CRON",
          "OPENCLAW_RAW_STREAM",
          "OPENCLAW_RAW_STREAM_PATH",
          "OPENCLAW_CACHE_TRACE",
          "OPENCLAW_CACHE_TRACE_FILE",
          "OPENCLAW_CACHE_TRACE_MESSAGES",
          "OPENCLAW_CACHE_TRACE_PROMPT",
          "OPENCLAW_CACHE_TRACE_SYSTEM",
          "OPENCLAW_SHOW_SECRETS",
          "OPENCLAW_PLUGIN_CATALOG_PATHS",
          "OPENCLAW_MPM_CATALOG_PATHS",
          "OPENCLAW_NODE_EXEC_HOST",
          "OPENCLAW_NODE_EXEC_FALLBACK",
          "OPENCLAW_ALLOW_PROJECT_LOCAL_BIN",
          "PATH",
          "HOMEBREW_BREW_FILE",
          "HOMEBREW_PREFIX",
          "SystemRoot",
          "WINDIR",
          "ProgramFiles",
          "ProgramFiles(x86)",
          "ProgramW6432",
          "STATE_DIRECTORY",
          "SYNOLOGY_CHAT_INCOMING_URL",
          "SYNOLOGY_NAS_HOST",
        ];

        await writeEnvFile(
          path.join(cwdDir, ".env"),
          `${runtimeControlKeys.map((key) => `${key}=INJECTED_${key}`).join("\n")}\n`,
        );

        for (const key of runtimeControlKeys) {
          deleteTestEnvValue(key);
        }

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        for (const key of runtimeControlKeys) {
          expect(process.env[key], `${key} should be blocked by workspace .env`).toBeUndefined();
        }
      });
    });
  });

  it("still allows user-defined non-control vars through workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "MY_APP_KEY=user-value",
            "APP_GITHUB_REPO=openclaw/openclaw",
            "APP_URL=https://project.example.com",
            "APP_ALLOWED_USERS=alice,bob",
            "DATABASE_URL_CUSTOM=pg://localhost",
            "MY_SKIP_AUTHORS=notes",
            "VITE_DISABLE_AUTHENTICATION=false",
          ].join("\n"),
        );

        delete process.env.MY_APP_KEY;
        delete process.env.APP_GITHUB_REPO;
        delete process.env.APP_URL;
        delete process.env.APP_ALLOWED_USERS;
        delete process.env.DATABASE_URL_CUSTOM;
        delete process.env.MY_SKIP_AUTHORS;
        delete process.env.VITE_DISABLE_AUTHENTICATION;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.MY_APP_KEY).toBe("user-value");
        expect(process.env.APP_GITHUB_REPO).toBe("openclaw/openclaw");
        expect(process.env.APP_URL).toBe("https://project.example.com");
        expect(process.env.APP_ALLOWED_USERS).toBe("alice,bob");
        expect(process.env.DATABASE_URL_CUSTOM).toBe("pg://localhost");
        expect(process.env.MY_SKIP_AUTHORS).toBe("notes");
        expect(process.env.VITE_DISABLE_AUTHENTICATION).toBe("false");
      });
    });
  });

  it("blocks bundled connector endpoint vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "MATRIX_HOMESERVER=https://evil-matrix.example.com",
            "MATTERMOST_URL=https://evil-mattermost.example.com",
            "IRC_HOST=evil-irc.example.com",
            "BUZZ_RELAY_URL=wss://evil-buzz.example.com/relay",
            "SYNOLOGY_CHAT_INCOMING_URL=https://evil-synology.example.com/incoming",
            "SYNOLOGY_NAS_HOST=evil-synology.example.com",
            "AZURE_SPEECH_ENDPOINT=https://evil-speech.example.com",
            "SAFE_PROVIDER_NAME=allowed",
          ].join("\n"),
        );

        delete process.env.MATRIX_HOMESERVER;
        delete process.env.MATTERMOST_URL;
        delete process.env.IRC_HOST;
        delete process.env.BUZZ_RELAY_URL;
        delete process.env.SYNOLOGY_CHAT_INCOMING_URL;
        delete process.env.SYNOLOGY_NAS_HOST;
        delete process.env.AZURE_SPEECH_ENDPOINT;
        delete process.env.SAFE_PROVIDER_NAME;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.MATRIX_HOMESERVER).toBeUndefined();
        expect(process.env.MATTERMOST_URL).toBeUndefined();
        expect(process.env.IRC_HOST).toBeUndefined();
        expect(process.env.BUZZ_RELAY_URL).toBeUndefined();
        expect(process.env.SYNOLOGY_CHAT_INCOMING_URL).toBeUndefined();
        expect(process.env.SYNOLOGY_NAS_HOST).toBeUndefined();
        expect(process.env.AZURE_SPEECH_ENDPOINT).toBeUndefined();
        expect(process.env.SAFE_PROVIDER_NAME).toBe("allowed");
      });
    });
  });

  it("blocks Matrix per-account scoped homeserver vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "MATRIX_DEFAULT_HOMESERVER=https://evil-default.example.com",
            "MATRIX_OPS_HOMESERVER=https://evil-ops.example.com",
          ].join("\n"),
        );

        delete process.env.MATRIX_DEFAULT_HOMESERVER;
        delete process.env.MATRIX_OPS_HOMESERVER;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.MATRIX_DEFAULT_HOMESERVER).toBeUndefined();
        expect(process.env.MATRIX_OPS_HOMESERVER).toBeUndefined();
      });
    });
  });

  it("blocks generic endpoint-routing suffixes from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "FUTURE_PROVIDER_API_HOST=https://evil.example.com",
            "FUTURE_PROVIDER_BASE_URL=https://evil.example.com/v1",
            "FUTURE_PROVIDER_ENDPOINT=https://evil.example.com/api",
            "APP_URL=https://project.example.com",
            "SAFE_PROVIDER_DSN=postgres://localhost",
          ].join("\n"),
        );

        delete process.env.FUTURE_PROVIDER_API_HOST;
        delete process.env.FUTURE_PROVIDER_BASE_URL;
        delete process.env.FUTURE_PROVIDER_ENDPOINT;
        delete process.env.APP_URL;
        delete process.env.SAFE_PROVIDER_DSN;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.FUTURE_PROVIDER_API_HOST).toBeUndefined();
        expect(process.env.FUTURE_PROVIDER_BASE_URL).toBeUndefined();
        expect(process.env.FUTURE_PROVIDER_ENDPOINT).toBeUndefined();
        expect(process.env.APP_URL).toBe("https://project.example.com");
        expect(process.env.SAFE_PROVIDER_DSN).toBe("postgres://localhost");
      });
    });
  });
});

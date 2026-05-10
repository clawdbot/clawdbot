import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import {
  getRuntimeConfig,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";
import {
  asConfig,
  buildTestWebSearchProviders,
  loadAuthStoreWithProfiles,
  resetPluginWebSearchProvidersMock,
} from "./runtime.test-support.ts";

const { resolveExternalAuthProfilesWithPluginsMock, resolvePluginWebSearchProvidersMock } =
  vi.hoisted(() => ({
    resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => []),
    resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
  }));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

const OPENAI_ENV_KEY_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_API_KEY",
} as const;

type SecretsRuntimeEnvSnapshot = ReturnType<typeof captureEnv>;

function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  const envSnapshot = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_VERSION",
  ]);
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_VERSION;
  return envSnapshot;
}

function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

describe("secrets runtime snapshot core lanes", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    resetPluginWebSearchProvidersMock();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  async function prepareOpenAiRuntimeSnapshot(params?: { includeAuthStoreRefs?: boolean }) {
    return withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: undefined,
      },
      async () =>
        prepareSecretsRuntimeSnapshot({
          config: asConfig({
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: OPENAI_ENV_KEY_REF,
                  models: [],
                },
              },
            },
          }),
          env: { OPENAI_API_KEY: "sk-runtime" },
          agentDirs: ["/tmp/openclaw-agent-main"],
          includeAuthStoreRefs: params?.includeAuthStoreRefs,
          loadablePluginOrigins: new Map(),
          loadAuthStore: () =>
            loadAuthStoreWithProfiles({
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: OPENAI_ENV_KEY_REF,
              },
            }),
        }),
    );
  }

  it("resolves config env refs for core config surfaces", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              headers: {
                Authorization: {
                  source: "env",
                  provider: "default",
                  id: "OPENAI_PROVIDER_AUTH_HEADER",
                },
              },
              models: [],
            },
          },
        },
        skills: {
          entries: {
            "review-pr": {
              enabled: true,
              apiKey: { source: "env", provider: "default", id: "REVIEW_SKILL_API_KEY" },
            },
          },
        },
      }),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
        OPENAI_PROVIDER_AUTH_HEADER: "Bearer sk-env-header",
        REVIEW_SKILL_API_KEY: "sk-skill-ref",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-env-openai");
    expect(snapshot.config.models?.providers?.openai?.headers?.Authorization).toBe(
      "Bearer sk-env-header",
    );
    expect(snapshot.config.skills?.entries?.["review-pr"]?.apiKey).toBe("sk-skill-ref");
  });

  it("resolves env refs for memory, talk, and gateway surfaces", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: { source: "env", provider: "default", id: "MEMORY_REMOTE_API_KEY" },
              },
            },
          },
        },
        talk: {
          providers: {
            "acme-speech": {
              apiKey: { source: "env", provider: "default", id: "TALK_PROVIDER_API_KEY" },
            },
          },
        },
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
          },
        },
      }),
      env: {
        MEMORY_REMOTE_API_KEY: "mem-ref-key",
        TALK_PROVIDER_API_KEY: "talk-provider-ref-key",
        REMOTE_GATEWAY_TOKEN: "remote-token-ref",
        REMOTE_GATEWAY_PASSWORD: "remote-password-ref",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("mem-ref-key");
    expect((snapshot.config.talk as { apiKey?: unknown } | undefined)?.apiKey).toBeUndefined();
    expect(snapshot.config.talk?.providers?.["acme-speech"]?.apiKey).toBe("talk-provider-ref-key");
    expect(snapshot.config.gateway?.remote?.token).toBe("remote-token-ref");
    expect(snapshot.config.gateway?.remote?.password).toBe("remote-password-ref");
  });

  it("resolves env-backed auth profile SecretRefs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
        GITHUB_TOKEN: "ghp-env-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "old-openai",
            keyRef: OPENAI_ENV_KEY_REF,
          },
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            token: "old-gh",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
        }),
    });

    const warningPaths = snapshot.warnings.map((warning) => warning.path);
    expect(warningPaths).toContain("/tmp/openclaw-agent-main.auth-profiles.openai:default.key");
    expect(warningPaths).toContain(
      "/tmp/openclaw-agent-main.auth-profiles.github-copilot:default.token",
    );
    const openAiProfile = snapshot.authStores[0]?.store.profiles["openai:default"] as
      | Record<string, unknown>
      | undefined;
    expect(openAiProfile?.type).toBe("api_key");
    expect(openAiProfile?.key).toBe("sk-env-openai");
    const copilotProfile = snapshot.authStores[0]?.store.profiles["github-copilot:default"] as
      | Record<string, unknown>
      | undefined;
    expect(copilotProfile?.type).toBe("token");
    expect(copilotProfile?.token).toBe("ghp-env-token");
  });

  it("resolves inline placeholder auth profiles to env refs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "openai:inline": {
            type: "api_key",
            provider: "openai",
            key: "${OPENAI_API_KEY}",
          },
        }),
    });

    const inlineProfile = snapshot.authStores[0]?.store.profiles["openai:inline"] as
      | Record<string, unknown>
      | undefined;
    expect(inlineProfile?.type).toBe("api_key");
    expect(inlineProfile?.key).toBe("sk-env-openai");
    expect(inlineProfile?.keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("activates runtime snapshots for loadConfig", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot({ includeAuthStoreRefs: false });
    activateSecretsRuntimeSnapshot(prepared);

    expect(getRuntimeConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime");
  });

  it("activates runtime snapshots for ensureAuthProfileStore", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot();
    activateSecretsRuntimeSnapshot(prepared);

    const runtimeProfile = ensureAuthProfileStore("/tmp/openclaw-agent-main").profiles[
      "openai:default"
    ] as Record<string, unknown> | undefined;
    expect(runtimeProfile?.type).toBe("api_key");
    expect(runtimeProfile?.key).toBe("sk-runtime");
  });
});

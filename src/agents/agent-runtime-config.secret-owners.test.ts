import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveQueuedReplyExecutionConfig } from "../auto-reply/reply/agent-runner-utils.js";
import * as configIo from "../config/io.js";
import {
  cloneConfigWithResolutionFacts,
  createConfigResolutionFacts,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";
import { setPathCreateStrict } from "../secrets/path-utils.js";
import * as secretResolver from "../secrets/resolve.js";
import { resolveCommandSecretsFromActiveRuntimeSnapshot } from "../secrets/runtime-command-secrets.js";
import {
  activateSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeConfigSnapshot,
  graftActiveSecretsRuntimeAuthState,
} from "../secrets/runtime-state.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveAgentRuntimeConfig } from "./agent-runtime-config.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";

const { callGatewayMock } = vi.hoisted(() => ({ callGatewayMock: vi.fn() }));
vi.mock("../gateway/call.js", () => ({ callGateway: callGatewayMock }));

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
let state: OpenClawTestState;

function providerConfig(): OpenClawConfig {
  return {
    plugins: { enabled: false },
    models: {
      providers: {
        healthy: {
          baseUrl: "https://healthy.example/v1",
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: "TEST_HEALTHY_PROVIDER_KEY" },
          models: [],
        },
        ollama: {
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
          apiKey: { source: "env", provider: "default", id: "TEST_COLD_PROVIDER_KEY" },
          models: [],
        },
      },
    },
  };
}

async function activateProviderConfig(config = providerConfig()) {
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config,
    env: { TEST_HEALTHY_PROVIDER_KEY: "prepared-fixture-key", TEST_COLD_PROVIDER_KEY: undefined },
    agentDirs: [state.agentDir()],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
    allowUnavailableSecretOwners: true,
  });
  expect(snapshot.degradedOwners).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ownerKind: "provider",
        ownerId: "ollama",
        degradationState: "cold",
      }),
    ]),
  );
  activateSecretsRuntimeSnapshot(snapshot);
  return snapshot;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "agent-secret-owner" });
  clearSecretsRuntimeSnapshot();
  vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", undefined);
  vi.stubEnv("TEST_COLD_PROVIDER_KEY", undefined);
  callGatewayMock.mockReset().mockImplementation(async ({ params }) => ({
    ok: true,
    ...(await resolveCommandSecretsFromActiveRuntimeSnapshot({
      ...params,
      targetIds: new Set(params.targetIds),
      allowedPaths: params.allowedPaths ? new Set(params.allowedPaths) : undefined,
      optionalActivePaths: params.optionalActivePaths
        ? new Set(params.optionalActivePaths)
        : undefined,
    })),
  }));
});

afterEach(async () => {
  clearSecretsRuntimeSnapshot();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await state.cleanup();
});

describe("agent execution respects prepared secret owners", () => {
  it("reads active config without copying reload-only plugin metadata", async () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: "/fixture/workspace" } },
    };
    const facts = createConfigResolutionFacts([]);
    setConfigResolutionFacts(config, facts);
    const manifestRegistry = {
      plugins: [
        {
          id: "refresh-context-fixture",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled" as const,
          rootDir: "/fixture/plugin",
          source: "/fixture/plugin/index.js",
          manifestPath: "/fixture/plugin/openclaw.plugin.json",
        },
      ],
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {},
      includeAuthStoreRefs: false,
      manifestRegistry,
    });
    activateSecretsRuntimeSnapshot(snapshot);
    const active = getActiveSecretsRuntimeConfigSnapshot();
    const revision = getRuntimeConfigSnapshotMetadata()?.revision;
    const clone = vi.spyOn(globalThis, "structuredClone");

    const result = await resolveAgentRuntimeConfig(runtime);

    expect(result.cfg).toBe(active?.config);
    expect(result.loadedRaw).toBe(result.cfg);
    expect(result.sourceConfig).toEqual(config);
    expect(result.sourceConfig).not.toBe(active?.sourceConfig);
    expect(getConfigResolutionFacts(result.sourceConfig)).toBe(facts);
    result.sourceConfig.agents!.defaults!.workspace = "/fixture/changed-by-caller";
    expect(active?.sourceConfig.agents?.defaults?.workspace).toBe("/fixture/workspace");
    expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(revision);
    expect(clone).not.toHaveBeenCalledWith(manifestRegistry);
  });

  it.each(["reply", "agent"] as const)(
    "%s starts with a healthy provider while an unrelated explicit provider ref is cold",
    async (entry) => {
      const snapshot = await activateProviderConfig();
      const revision = getRuntimeConfigSnapshotMetadata()?.revision;
      const resolveRef = vi.spyOn(secretResolver, "resolveSecretRefValue");
      const config =
        entry === "reply"
          ? await resolveQueuedReplyExecutionConfig(snapshot.sourceConfig)
          : (await resolveAgentRuntimeConfig(runtime)).cfg;
      expect(config).toBe(getRuntimeConfigSnapshot());
      expect(config.models?.providers?.healthy?.apiKey).toBe("prepared-fixture-key");
      expect(config.models?.providers?.ollama?.apiKey).toEqual(
        snapshot.sourceConfig.models?.providers?.ollama?.apiKey,
      );
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(resolveRef).not.toHaveBeenCalled();
      expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(revision);
      await expect(
        resolveApiKeyForProviderCore({
          provider: "healthy",
          cfg: config,
          store: { version: 1, profiles: {} },
          agentDir: state.agentDir(),
        }),
      ).resolves.toMatchObject({ apiKey: "prepared-fixture-key" });
      vi.stubEnv("OLLAMA_API_KEY", "ambient-fixture-key");
      await expect(
        resolveApiKeyForProviderCore({
          provider: "ollama",
          cfg: config,
          profileId: "ollama:fallback",
          agentDir: state.agentDir(),
          store: {
            version: 1,
            profiles: {
              "ollama:fallback": {
                type: "api_key",
                provider: "ollama",
                key: "profile-fixture-key",
              },
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "provider",
        ownerId: "ollama",
      });
    },
  );

  it.each([
    "apiKey",
    "headers.Authorization",
    "request.headers.Authorization",
    "request.auth.token",
    "request.auth.value",
    "request.tls.ca",
    "request.tls.cert",
    "request.tls.key",
    "request.tls.passphrase",
    "request.proxy.tls.ca",
    "request.proxy.tls.cert",
    "request.proxy.tls.key",
    "request.proxy.tls.passphrase",
  ])(
    "keeps a cold provider's %s ref authoritative over inline, profile, and ambient auth",
    async (credentialPath) => {
      const source = providerConfig();
      const provider = source.models!.providers!.ollama!;
      provider.apiKey = "inline-fixture-key";
      if (credentialPath === "request.auth.token") {
        provider.request = {
          auth: { mode: "authorization-bearer", token: "inline-fixture-token" },
        };
      } else if (credentialPath === "request.auth.value") {
        provider.request = {
          auth: { mode: "header", headerName: "Authorization", value: "inline-fixture-token" },
        };
      } else if (credentialPath.startsWith("request.proxy.")) {
        provider.request = { proxy: { mode: "explicit-proxy", url: "https://proxy.example" } };
      }
      setPathCreateStrict(source, ["models", "providers", "ollama", ...credentialPath.split(".")], {
        source: "store",
        provider: "default",
        id: "TEST_COLD_PROVIDER_KEY",
      });
      ModelsConfigSchema.parse(source.models);
      const snapshot = await activateProviderConfig(source);
      const resolveRef = vi.spyOn(secretResolver, "resolveSecretRefValue");
      vi.stubEnv("OLLAMA_API_KEY", "ambient-fixture-key");
      for (const config of [
        await resolveQueuedReplyExecutionConfig(snapshot.sourceConfig),
        (await resolveAgentRuntimeConfig(runtime)).cfg,
      ]) {
        await expect(
          resolveApiKeyForProviderCore({
            provider: "ollama",
            cfg: config,
            credentialPrecedence: "env-first",
            agentDir: state.agentDir(),
            store: {
              version: 1,
              profiles: {
                "ollama:fallback": {
                  type: "api_key",
                  provider: "ollama",
                  key: "profile-fixture-key",
                },
              },
            },
          }),
        ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE", ownerId: "ollama" });
      }
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(resolveRef).not.toHaveBeenCalled();
    },
  );

  it.each(["source", "runtime"] as const)(
    "reuses a cloned prepared %s config without re-resolution",
    async (kind) => {
      const snapshot = await activateProviderConfig();
      const input = cloneConfigWithResolutionFacts(
        kind === "source" ? snapshot.sourceConfig : snapshot.config,
      );
      const config = await resolveQueuedReplyExecutionConfig(input);
      expect(config).toEqual(snapshot.config);
      expect(callGatewayMock).not.toHaveBeenCalled();
      await expect(
        resolveApiKeyForProviderCore({
          provider: "ollama",
          cfg: config,
          agentDir: state.agentDir(),
        }),
      ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
    },
  );

  it.each(["provider-auth refresh", "config refresh with auth graft"] as const)(
    "retains config preparation authority after %s",
    async (operation) => {
      const source = providerConfig();
      source.skills = {
        entries: {
          fixture: { apiKey: { source: "env", provider: "default", id: "TEST_COLD_SKILL_KEY" } },
        },
      };
      const snapshot = await activateProviderConfig(source);
      if (operation === "provider-auth refresh") {
        await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      } else {
        const candidate = await prepareSecretsRuntimeSnapshot({
          config: source,
          env: { TEST_HEALTHY_PROVIDER_KEY: "prepared-fixture-key" },
          includeAuthStoreRefs: false,
          allowUnavailableSecretOwners: true,
        });
        graftActiveSecretsRuntimeAuthState(candidate);
        activateSecretsRuntimeSnapshot(candidate);
      }
      expect(getActiveSecretsRuntimeConfigSnapshot()?.configRefsPrepared).toBe(true);
      for (const config of [
        await resolveQueuedReplyExecutionConfig(snapshot.sourceConfig),
        (await resolveAgentRuntimeConfig(runtime)).cfg,
      ]) {
        expect(config.skills).toEqual(source.skills);
        await expect(
          resolveApiKeyForProviderCore({
            provider: "ollama",
            cfg: config,
            agentDir: state.agentDir(),
          }),
        ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
      }
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it.each(["ref", "inline"] as const)(
    "requires the same authored-ref facts token with a healthy %s key",
    async (keyKind) => {
      const source = providerConfig();
      if (keyKind === "inline") {
        source.models!.providers!.healthy!.apiKey = "prepared-fixture-key";
      }
      setConfigResolutionFacts(source, createConfigResolutionFacts([]));
      const snapshot = await activateProviderConfig(source);
      const input = cloneConfigWithResolutionFacts(snapshot.config);
      await expect(resolveQueuedReplyExecutionConfig(input)).resolves.toEqual(snapshot.config);
      expect(callGatewayMock).not.toHaveBeenCalled();
      setConfigResolutionFacts(
        input,
        createConfigResolutionFacts(
          [],
          new Map([["models.providers.healthy.apiKey", "TEST_FOREIGN_PROVIDER_KEY"]]),
        ),
      );
      expect(input).toEqual(snapshot.config);
      expect(getConfigResolutionFacts(input)).toEqual(getConfigResolutionFacts(snapshot.config));
      expect(getConfigResolutionFacts(input)).not.toBe(getConfigResolutionFacts(snapshot.config));
      await expect(resolveQueuedReplyExecutionConfig(input)).rejects.toThrow(
        "is unresolved in the active runtime snapshot",
      );
      expect(callGatewayMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["auth-only", "unrecorded"] as const)(
    "does not treat an %s snapshot as config-ref preparation authority",
    async (kind) => {
      const source = providerConfig();
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: source,
        includeConfigRefs: false,
        agentDirs: [state.agentDir()],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });
      if (kind === "auth-only") {
        activateSecretsRuntimeSnapshot(snapshot);
      } else {
        activateSecretsRuntimeSnapshotState({
          snapshot,
          refreshContext: null,
          refreshHandler: null,
        });
      }
      vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", "local-fixture-key");
      await expect(resolveQueuedReplyExecutionConfig(source)).rejects.toThrow(
        "models.providers.ollama.apiKey is unresolved",
      );
      await expect(resolveAgentRuntimeConfig(runtime)).rejects.toThrow(
        "models.providers.ollama.apiKey is unresolved",
      );
      expect(callGatewayMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["overlay", "foreign-provider"] as const)(
    "keeps %s reply configs on the strict command path",
    async (kind) => {
      const snapshot = await activateProviderConfig();
      const input = cloneConfigWithResolutionFacts(snapshot.config);
      if (kind === "overlay") {
        input.tools = { updatePlan: true };
      } else {
        input.models!.providers!.ollama!.baseUrl = "https://foreign.example/v1";
      }
      await expect(resolveQueuedReplyExecutionConfig(input)).rejects.toThrow(
        "is unresolved in the active runtime snapshot",
      );
      expect(callGatewayMock).toHaveBeenCalledTimes(1);
      expect(getRuntimeConfigSnapshot()).toEqual(snapshot.config);
    },
  );

  it.each(["reply", "agent"] as const)(
    "keeps unprepared %s config strict even if the generic runtime config is pinned",
    async (entry) => {
      const config = providerConfig();
      setRuntimeConfigSnapshot(config, config);
      vi.spyOn(configIo, "readConfigFileSnapshotForWrite").mockRejectedValue(
        new Error("fixture has no source file"),
      );
      callGatewayMock.mockRejectedValue(new Error("fixture gateway offline"));
      vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", "local-fixture-key");
      vi.stubEnv("OLLAMA_API_KEY", "ambient-fixture-key");
      await expect(
        entry === "reply"
          ? resolveQueuedReplyExecutionConfig(config)
          : resolveAgentRuntimeConfig(runtime),
      ).rejects.toThrow("failed to resolve secrets");
      expect(getActiveSecretsRuntimeSnapshot()).toBeNull();
    },
  );

  it("keeps explicit channel/account resolution strict without targeting a cold sibling account", async () => {
    const source = providerConfig();
    source.plugins = { allow: ["telegram"], entries: { telegram: { enabled: true } } };
    source.channels = {
      telegram: {
        accounts: {
          healthy: { botToken: "fixture-channel-token" },
        },
      },
    };
    setPathCreateStrict(source, ["channels", "telegram", "accounts", "cold", "botToken"], {
      source: "env",
      provider: "default",
      id: "TEST_COLD_CHANNEL_KEY",
    });
    vi.stubEnv("TEST_COLD_CHANNEL_KEY", undefined);
    const snapshot = await activateProviderConfig(source);
    expect(snapshot.degradedOwners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerKind: "account", degradationState: "cold" }),
      ]),
    );
    await expect(
      resolveQueuedReplyExecutionConfig(snapshot.sourceConfig, {
        originatingChannel: "telegram",
        originatingAccountId: "healthy",
      }),
    ).resolves.toEqual(snapshot.config);
    await expect(
      resolveAgentRuntimeConfig(runtime, {
        runtimeChannelSecretScope: { channel: "telegram", accountId: "healthy" },
      }),
    ).resolves.toMatchObject({ cfg: snapshot.config });
    expect(callGatewayMock).not.toHaveBeenCalled();
    await expect(
      resolveQueuedReplyExecutionConfig(snapshot.sourceConfig, {
        originatingChannel: "telegram",
        originatingAccountId: "cold",
      }),
    ).rejects.toThrow("channels.telegram.accounts.cold.botToken is unresolved");
    await expect(
      resolveAgentRuntimeConfig(runtime, {
        runtimeChannelSecretScope: { channel: "telegram", accountId: "cold" },
      }),
    ).rejects.toThrow("channels.telegram.accounts.cold.botToken is unresolved");
    await expect(
      resolveAgentRuntimeConfig(runtime, { runtimeTargetsChannelSecrets: true }),
    ).rejects.toThrow("channels.telegram.accounts.cold.botToken is unresolved");
  });

  it("does not resolve unrelated channel, plugin, or Gateway refs for standalone nondelivery", async () => {
    const config = providerConfig();
    delete config.models!.providers!.ollama;
    const unrelatedRef = { source: "exec", provider: "unrelated", id: "key" } as const;
    config.secrets = {
      providers: { unrelated: { source: "exec", command: "/fixture-must-not-execute" } },
    };
    setPathCreateStrict(config, ["channels", "telegram", "botToken"], unrelatedRef);
    config.gateway = { auth: { mode: "token", token: unrelatedRef } };
    config.plugins = {
      enabled: false,
      entries: {
        acpx: {
          config: { mcpServers: { fixture: { command: "fixture", env: { TOKEN: unrelatedRef } } } },
        },
      },
    };
    setRuntimeConfigSnapshot(config, config);
    vi.spyOn(configIo, "readConfigFileSnapshotForWrite").mockRejectedValue(
      new Error("fixture has no source file"),
    );
    callGatewayMock.mockRejectedValue(new Error("fixture gateway offline"));
    vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", "local-fixture-key");
    const resolveRef = vi.spyOn(secretResolver, "resolveSecretRefValue");
    const result = await resolveAgentRuntimeConfig(runtime);
    expect(result.cfg.models?.providers?.healthy?.apiKey).toBe("local-fixture-key");
    expect(result.cfg.channels).toEqual(config.channels);
    expect(result.cfg.gateway).toEqual(config.gateway);
    expect(result.cfg.plugins).toEqual(config.plugins);
    expect(resolveRef.mock.calls.map(([ref]) => ref.id)).toEqual(["TEST_HEALTHY_PROVIDER_KEY"]);
  });
});

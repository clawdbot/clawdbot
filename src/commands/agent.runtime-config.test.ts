// Agent runtime config tests cover agent-specific runtime config resolution from temp homes.
import path from "node:path";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentRuntimeConfig } from "../agents/agent-runtime-config.js";
import { resolveSession } from "../agents/command/session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

type ConfigSnapshotForWrite = {
  snapshot: { valid: boolean; resolved: OpenClawConfig };
  writeOptions: Record<string, never>;
};

type ResolveCommandConfigParams = {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
  optionalActivePaths?: Set<string>;
  runtime: RuntimeEnv;
};

const loadConfigMock = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const readConfigFileSnapshotForWriteMock = vi.hoisted(() =>
  vi.fn<() => Promise<ConfigSnapshotForWrite>>(),
);
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: (params?: { includeChannelTargets?: boolean }) =>
    new Set([
      "models.providers.*.apiKey",
      ...(params?.includeChannelTargets === true ? ["channels.telegram.botToken"] : []),
    ]),
  getAgentRuntimeOptionalCommandSecretPaths: () =>
    new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
  getScopedChannelsCommandSecretTargets: (params: {
    config: OpenClawConfig;
    channel?: string;
    accountId?: string;
    defaultAccountWhenMissing?: boolean;
  }) => {
    const channelConfig = params.config.channels?.[params.channel ?? ""] as
      | { defaultAccount?: string }
      | undefined;
    const accountId =
      params.accountId ??
      (params.defaultAccountWhenMissing ? (channelConfig?.defaultAccount ?? "default") : undefined);
    return {
      targetIds: new Set(
        params.channel === "telegram"
          ? ["channels.telegram.botToken", "channels.telegram.accounts.*.botToken"]
          : params.channel === "discord"
            ? ["channels.discord.token"]
            : [],
      ),
      ...(params.channel === "telegram" && accountId
        ? {
            allowedPaths: new Set([
              "channels.telegram.botToken",
              `channels.telegram.accounts.${accountId}.botToken`,
            ]),
          }
        : {}),
    };
  },
}));

vi.mock("../secrets/target-registry.js", () => ({
  discoverConfigSecretTargetsByIds: (
    config: OpenClawConfig,
    targetIds: Iterable<string>,
  ): Array<{ path: string }> => {
    const ids = new Set(targetIds);
    return ids.has("models.providers.*.apiKey") && config.models?.providers?.openai?.apiKey
      ? [{ path: "models.providers.openai.apiKey" }]
      : [];
  },
}));

const setRuntimeConfigSnapshotMock = vi.hoisted(() =>
  vi.fn<(cfg: OpenClawConfig, sourceConfig: OpenClawConfig) => void>(),
);
vi.mock("../config/runtime-snapshot.js", () => ({
  setRuntimeConfigSnapshot: setRuntimeConfigSnapshotMock,
}));

const getActiveSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn<() => object | null>());
const prepareSecretsRuntimeSnapshotMock = vi.hoisted(() =>
  vi.fn(async (params: { config: OpenClawConfig; assignmentConfig: OpenClawConfig }) => ({
    sourceConfig: params.config,
    config: params.assignmentConfig,
    authStores: [],
    authStoreCredentialsRevision: 0,
    warnings: [],
    webTools: {},
  })),
);
const activateSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock("../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: getActiveSecretsRuntimeSnapshotMock,
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
  activateSecretsRuntimeSnapshot: activateSecretsRuntimeSnapshotMock,
}));

const resolveCommandConfigWithSecretsMock = vi.hoisted(() =>
  vi.fn<
    (params: ResolveCommandConfigParams) => Promise<{
      resolvedConfig: OpenClawConfig;
      effectiveConfig: OpenClawConfig;
      diagnostics: never[];
    }>
  >(),
);
vi.mock("../cli/command-config-resolution.runtime.js", () => ({
  resolveCommandConfigWithSecrets: resolveCommandConfigWithSecretsMock,
}));

const runtime = createThrowingTestRuntime();

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-" });
}

function requireResolveCommandConfigParams(callIndex = 0): ResolveCommandConfigParams {
  const call = resolveCommandConfigWithSecretsMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected command config resolution call ${callIndex}`);
  }
  const [params] = call;
  return params;
}

function mockConfig(home: string, storePath: string): OpenClawConfig {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  loadConfigMock.mockReturnValue(cfg);
  return cfg;
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveSecretsRuntimeSnapshotMock.mockReturnValue({});
  readConfigFileSnapshotForWriteMock.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  });
});

describe("agentCommand runtime config", () => {
  it("materializes auth-profile refs for standalone local runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      const sourceConfig = { ...loadedConfig, secrets: { providers: {} } } as OpenClawConfig;
      readConfigFileSnapshotForWriteMock.mockResolvedValue({
        snapshot: { valid: true, resolved: sourceConfig },
        writeOptions: {},
      });
      getActiveSecretsRuntimeSnapshotMock.mockReturnValue(null);

      await resolveAgentRuntimeConfig(runtime);

      expect(prepareSecretsRuntimeSnapshotMock).toHaveBeenCalledWith({
        config: sourceConfig,
        assignmentConfig: loadedConfig,
        includeConfigRefs: false,
      });
      expect(activateSecretsRuntimeSnapshotMock).toHaveBeenCalledWith(
        expect.objectContaining({ sourceConfig, config: loadedConfig }),
      );
      expect(setRuntimeConfigSnapshotMock).not.toHaveBeenCalled();
    });
  });

  it("sets runtime snapshots from source config before embedded agent run", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
            workspace: path.join(home, "openclaw"),
          },
        },
        session: { store, mainKey: "main" },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const sourceConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const resolvedConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-resolved-runtime", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;

      loadConfigMock.mockReturnValue(loadedConfig);
      readConfigFileSnapshotForWriteMock.mockResolvedValue({
        snapshot: { valid: true, resolved: sourceConfig },
        writeOptions: {},
      });
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig,
        effectiveConfig: resolvedConfig,
        diagnostics: [],
      });

      const prepared = await resolveAgentRuntimeConfig(runtime);

      expect(resolveCommandConfigWithSecretsMock).toHaveBeenCalledWith({
        config: loadedConfig,
        commandName: "agent",
        targetIds: new Set(["models.providers.*.apiKey"]),
        optionalActivePaths: new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
        runtime,
      });
      const targetIds = requireResolveCommandConfigParams().targetIds;
      expect(targetIds.has("models.providers.*.apiKey")).toBe(true);
      expect(targetIds.has("channels.telegram.botToken")).toBe(false);
      expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
      expect(prepared.cfg).toBe(resolvedConfig);
    });
  });

  it("includes channel secret targets when delivery is requested", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      loadedConfig.channels = {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      } as unknown as OpenClawConfig["channels"];
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig: loadedConfig,
        effectiveConfig: loadedConfig,
        diagnostics: [],
      });

      await resolveAgentRuntimeConfig(runtime, {
        runtimeTargetsChannelSecrets: true,
      });

      const targetIds = requireResolveCommandConfigParams().targetIds;
      expect(targetIds.has("channels.telegram.botToken")).toBe(true);
    });
  });

  it("scopes session-only recipient routing secrets to the selected channel", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      loadedConfig.channels = {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      } as unknown as OpenClawConfig["channels"];
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig: loadedConfig,
        effectiveConfig: loadedConfig,
        diagnostics: [],
      });

      await resolveAgentRuntimeConfig(runtime, {
        runtimeChannelSecretScope: { channel: "telegram" },
      });

      const targetIds = requireResolveCommandConfigParams().targetIds;
      expect(targetIds.has("channels.telegram.botToken")).toBe(true);
      expect(targetIds.has("channels.discord.token")).toBe(false);
      expect(requireResolveCommandConfigParams().allowedPaths).toEqual(
        new Set(["channels.telegram.botToken", "channels.telegram.accounts.default.botToken"]),
      );
    });
  });

  it("scopes session-only routing secrets to the channel default account", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      loadedConfig.channels = {
        telegram: {
          defaultAccount: "ops",
          accounts: {
            ops: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_OPS_TOKEN" },
            },
            chat: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_CHAT_TOKEN" },
            },
          },
        },
      } as unknown as OpenClawConfig["channels"];
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig: loadedConfig,
        effectiveConfig: loadedConfig,
        diagnostics: [],
      });

      await resolveAgentRuntimeConfig(runtime, {
        runtimeChannelSecretScope: { channel: "telegram" },
      });

      const resolution = requireResolveCommandConfigParams();
      expect(resolution.allowedPaths).toEqual(
        new Set(["channels.telegram.botToken", "channels.telegram.accounts.ops.botToken"]),
      );
      expect(resolution.allowedPaths?.has("channels.telegram.accounts.chat.botToken")).toBe(false);
    });
  });

  it("scopes session-only recipient routing secrets to the selected account", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      loadedConfig.models = {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
            models: [],
          },
        },
      } as OpenClawConfig["models"];
      loadedConfig.channels = {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
          accounts: {
            ops: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_OPS_TOKEN" },
            },
            chat: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_CHAT_TOKEN" },
            },
          },
        },
      } as unknown as OpenClawConfig["channels"];
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig: loadedConfig,
        effectiveConfig: loadedConfig,
        diagnostics: [],
      });

      await resolveAgentRuntimeConfig(runtime, {
        runtimeChannelSecretScope: { channel: "telegram", accountId: "ops" },
      });

      const resolution = requireResolveCommandConfigParams();
      expect(resolution.allowedPaths).toEqual(
        new Set([
          "models.providers.openai.apiKey",
          "channels.telegram.botToken",
          "channels.telegram.accounts.ops.botToken",
        ]),
      );
      expect(resolution.allowedPaths?.has("channels.telegram.accounts.chat.botToken")).toBe(false);
    });
  });

  it("skips command secret resolution when no relevant SecretRef values exist", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);

      const prepared = await resolveAgentRuntimeConfig(runtime);

      expect(readConfigFileSnapshotForWriteMock).toHaveBeenCalledTimes(1);
      expect(resolveCommandConfigWithSecretsMock).not.toHaveBeenCalled();
      expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(loadedConfig, loadedConfig);
      expect(prepared.cfg).toBe(loadedConfig);
    });
  });

  it.each([
    {
      name: "global memory headers",
      apply: (config: OpenClawConfig) => {
        config.memory = {
          search: {
            remote: {
              headers: {
                Authorization: { source: "env", provider: "default", id: "MEMORY_HEADER" },
              },
            },
          },
        } as unknown as OpenClawConfig["memory"];
      },
    },
    {
      name: "per-agent memory headers",
      apply: (config: OpenClawConfig) => {
        config.agents = {
          ...config.agents,
          entries: {
            personal: {
              memory: {
                search: {
                  remote: {
                    headers: {
                      Authorization: {
                        source: "env",
                        provider: "default",
                        id: "AGENT_MEMORY_HEADER",
                      },
                    },
                  },
                },
              },
            },
          },
        } as unknown as OpenClawConfig["agents"];
      },
    },
    {
      name: "per-agent TTS provider",
      apply: (config: OpenClawConfig) => {
        config.agents = {
          ...config.agents,
          entries: {
            personal: {
              tts: {
                providers: {
                  elevenlabs: {
                    apiKey: { source: "env", provider: "default", id: "AGENT_TTS_KEY" },
                  },
                },
              },
            },
          },
        } as OpenClawConfig["agents"];
      },
    },
  ])("resolves command secrets for $name", async ({ apply }) => {
    await withTempHome(async (home) => {
      const loadedConfig = mockConfig(home, path.join(home, "sessions.json"));
      apply(loadedConfig);
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig: loadedConfig,
        effectiveConfig: loadedConfig,
        diagnostics: [],
      });

      await resolveAgentRuntimeConfig(runtime);

      expect(resolveCommandConfigWithSecretsMock).toHaveBeenCalledTimes(1);
    });
  });

  it("derives a fresh session from --to", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const cfg = mockConfig(home, store);

      const resolved = resolveSession({ cfg, to: "+1555" });

      expect(resolved.storePath).toBe(store);
      expect(resolved.sessionKey).toBeTypeOf("string");
      const sessionKey = resolved.sessionKey;
      if (!sessionKey) {
        throw new Error("expected session key");
      }
      expect(sessionKey.length).toBeGreaterThan(0);
      expect(resolved.sessionId).toBeTypeOf("string");
      expect(resolved.sessionId.length).toBeGreaterThan(0);
      expect(resolved.isNewSession).toBe(true);
    });
  });
});

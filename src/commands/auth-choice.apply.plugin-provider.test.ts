import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAuthChoiceLoadedPluginProvider,
  applyAuthChoicePluginProvider,
  runProviderPluginAuthMethod,
} from "../plugins/provider-auth-choice.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<() => { provider: ProviderPlugin; method: ProviderAuthMethod } | null>(),
);
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
}));

const upsertAuthProfile = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfile,
}));

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "default"));
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

const resolveDefaultAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir,
}));

const resolveOpenClawAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir,
}));

const applyAuthProfileConfig = vi.hoisted(() => vi.fn((config) => config));
vi.mock("../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig,
}));

const isRemoteEnvironment = vi.hoisted(() => vi.fn(() => false));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/setup-browser.js", () => ({
  isRemoteEnvironment,
  openUrl,
}));

const createVpsAwareOAuthHandlers = vi.hoisted(() => vi.fn());
vi.mock("../plugins/provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers,
}));

function buildProvider(): ProviderPlugin {
  return {
    id: "ollama",
    label: "Ollama",
    auth: [
      {
        id: "local",
        label: "Ollama",
        kind: "custom",
        run: async () => ({
          profiles: [
            {
              profileId: "ollama:default",
              credential: {
                type: "api_key",
                provider: "ollama",
                key: "ollama-local",
              },
            },
          ],
          defaultModel: "ollama/qwen3:4b",
        }),
      },
    ],
  };
}

function buildParams(overrides: Partial<ApplyAuthChoiceParams> = {}): ApplyAuthChoiceParams {
  return {
    authChoice: "ollama",
    config: {},
    prompter: {
      note: vi.fn(async () => {}),
    } as unknown as ApplyAuthChoiceParams["prompter"],
    runtime: {} as ApplyAuthChoiceParams["runtime"],
    setDefaultModel: true,
    ...overrides,
  };
}

describe("applyAuthChoiceLoadedPluginProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyAuthProfileConfig.mockImplementation((config) => config);
  });

  it("returns an agent model override when default model application is deferred", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: provider.auth[0],
    });

    const result = await applyAuthChoiceLoadedPluginProvider(
      buildParams({
        setDefaultModel: false,
      }),
    );

    expect(result).toEqual({
      config: {},
      agentModelOverride: "ollama/qwen3:4b",
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
  });

  it("keeps provider config patches when default model application is deferred", async () => {
    const provider: ProviderPlugin = {
      id: "moonshot",
      label: "Moonshot",
      auth: [
        {
          id: "api-key-cn",
          label: "Moonshot API key (.cn)",
          kind: "api_key",
          run: async () => ({
            profiles: [
              {
                profileId: "moonshot:default",
                credential: {
                  type: "api_key",
                  provider: "moonshot",
                  key: "sk-moonshot-cn-test",
                },
              },
            ],
            configPatch: {
              models: {
                providers: {
                  moonshot: {
                    api: "openai-completions",
                    baseUrl: "https://api.moonshot.cn/v1",
                    models: [
                      {
                        id: "kimi-k2.5",
                        name: "kimi-k2.5",
                        input: ["text", "image"],
                        reasoning: true,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 128_000,
                        maxTokens: 8192,
                      },
                    ],
                  },
                },
              },
            },
            defaultModel: "moonshot/kimi-k2.5",
          }),
        },
      ],
    };
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: provider.auth[0],
    });

    const result = await applyAuthChoiceLoadedPluginProvider(
      buildParams({
        config: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-6" },
            },
          },
        },
        setDefaultModel: false,
      }),
    );

    expect(result?.agentModelOverride).toBe("moonshot/kimi-k2.5");
    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
    });
    expect(result?.config.models?.providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(result?.config.models?.providers?.moonshot?.models?.[0]?.input).toContain("image");
    expect(upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "moonshot:default",
      credential: {
        type: "api_key",
        provider: "moonshot",
        key: "sk-moonshot-cn-test",
      },
      agentDir: "/tmp/agent",
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
  });

  it("applies the default model and runs provider post-setup hooks", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: provider.auth[0],
    });

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen3:4b",
    });
    expect(upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "ollama:default",
      credential: {
        type: "api_key",
        provider: "ollama",
        key: "ollama-local",
      },
      agentDir: "/tmp/agent",
    });
    expect(runProviderModelSelectedHook).toHaveBeenCalledWith({
      config: result?.config,
      model: "ollama/qwen3:4b",
      prompter: expect.objectContaining({ note: expect.any(Function) }),
      agentDir: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("merges provider config patches and emits provider notes", async () => {
    applyAuthProfileConfig.mockImplementation(((
      config: {
        auth?: {
          profiles?: Record<string, { provider: string; mode: string }>;
        };
      },
      profile: { profileId: string; provider: string; mode: string },
    ) => ({
      ...config,
      auth: {
        profiles: {
          ...config.auth?.profiles,
          [profile.profileId]: {
            provider: profile.provider,
            mode: profile.mode,
          },
        },
      },
    })) as never);

    const note = vi.fn(async () => {});
    const method: ProviderAuthMethod = {
      id: "local",
      label: "Local",
      kind: "custom",
      run: async () => ({
        profiles: [
          {
            profileId: "ollama:default",
            credential: {
              type: "api_key",
              provider: "ollama",
              key: "ollama-local",
            },
          },
        ],
        configPatch: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                baseUrl: "http://127.0.0.1:11434",
                models: [],
              },
            },
          },
        },
        defaultModel: "ollama/qwen3:4b",
        notes: ["Detected local Ollama runtime.", "Pulled model metadata."],
      }),
    };

    const result = await runProviderPluginAuthMethod({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      },
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note,
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
    });

    expect(result.defaultModel).toBe("ollama/qwen3:4b");
    expect(result.config.models?.providers?.ollama).toEqual({
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [],
    });
    expect(result.config.auth?.profiles?.["ollama:default"]).toEqual({
      provider: "ollama",
      mode: "api_key",
    });
    expect(note).toHaveBeenCalledWith(
      "Detected local Ollama runtime.\nPulled model metadata.",
      "Provider notes",
    );
  });

  it("replaces provider-owned default model maps during auth migrations", async () => {
    const method: ProviderAuthMethod = {
      id: "local",
      label: "Local",
      kind: "custom",
      run: async () => ({
        profiles: [],
        configPatch: {
          agents: {
            defaults: {
              model: {
                primary: "claude-cli/claude-sonnet-4-6",
                fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
              },
              models: {
                "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
                "claude-cli/claude-opus-4-6": { alias: "Opus" },
                "openai/gpt-5.2": {},
              },
            },
          },
        },
        defaultModel: "claude-cli/claude-sonnet-4-6",
      }),
    };

    const result = await runProviderPluginAuthMethod({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
            },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
              "anthropic/claude-opus-4-6": { alias: "Opus" },
              "openai/gpt-5.2": {},
            },
          },
        },
      },
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note: vi.fn(async () => {}),
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
    });

    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "claude-cli/claude-sonnet-4-6",
      fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
      "claude-cli/claude-opus-4-6": { alias: "Opus" },
      "openai/gpt-5.2": {},
    });
  });

  it("returns an agent-scoped override for plugin auth choices when default model application is deferred", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);

    const note = vi.fn(async () => {});
    const result = await applyAuthChoicePluginProvider(
      buildParams({
        authChoice: "provider-plugin:ollama:local",
        agentId: "worker",
        setDefaultModel: false,
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
      }),
      {
        authChoice: "provider-plugin:ollama:local",
        pluginId: "ollama",
        providerId: "ollama",
        methodId: "local",
        label: "Ollama",
      },
    );

    expect(result?.agentModelOverride).toBe("ollama/qwen3:4b");
    expect(result?.config.plugins).toEqual({
      entries: {
        ollama: {
          enabled: true,
        },
      },
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      'Default model set to ollama/qwen3:4b for agent "worker".',
      "Model configured",
    );
  });

  it("stops early when the plugin is disabled in config", async () => {
    const note = vi.fn(async () => {});

    const result = await applyAuthChoicePluginProvider(
      buildParams({
        config: {
          plugins: {
            enabled: false,
          },
        },
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
      }),
      {
        authChoice: "ollama",
        pluginId: "ollama",
        providerId: "ollama",
        label: "Ollama",
      },
    );

    expect(result).toEqual({
      config: {
        plugins: {
          enabled: false,
        },
      },
    });
    expect(resolvePluginProviders).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith("Ollama plugin is disabled (plugins disabled).", "Ollama");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAuthChoiceLoadedPluginProvider,
  applyAuthChoicePluginProvider,
  runProviderPluginAuthMethod,
} from "../plugins/provider-auth-choice.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";

type ResolveProviderInstallCatalogEntry =
  typeof import("../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntry;
type EnsureOnboardingPluginInstalled =
  typeof import("../commands/onboarding-plugin-install.js").ensureOnboardingPluginInstalled;
type ResolveManifestProviderAuthChoice =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoice;
type ResolvePluginSetupProvider =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginSetupProvider;
type RunProviderModelSelectedHook =
  typeof import("../plugins/provider-auth-choice.runtime.js").runProviderModelSelectedHook;

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const resolvePluginSetupProvider = vi.hoisted(() =>
  vi.fn<ResolvePluginSetupProvider>(() => undefined),
);
const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<() => { provider: ProviderPlugin; method: ProviderAuthMethod } | null>(),
);
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
  resolvePluginSetupProvider,
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
}));

const resolveManifestProviderAuthChoice = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoice>(() => undefined),
);
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
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

const resolveProviderInstallCatalogEntry = vi.hoisted(() =>
  vi.fn<ResolveProviderInstallCatalogEntry>(() => undefined),
);
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry,
}));

const ensureOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn<EnsureOnboardingPluginInstalled>(async ({ cfg, entry }) => ({
    cfg,
    installed: false,
    pluginId: entry?.pluginId ?? "missing-plugin",
    status: "skipped",
  })),
);
vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled,
}));

const LOCAL_PROVIDER_ID = "local-provider";
const LOCAL_PROVIDER_LABEL = "Local Provider";
const LOCAL_AUTH_METHOD_ID = "local";
const LOCAL_PROFILE_ID = `${LOCAL_PROVIDER_ID}:default`;
const LOCAL_API_KEY = "local-provider-key";
const LOCAL_DEFAULT_MODEL = `${LOCAL_PROVIDER_ID}/demo-model`;
const EXISTING_DEFAULT_MODEL = "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0";

function buildProvider(): ProviderPlugin {
  return {
    id: LOCAL_PROVIDER_ID,
    label: LOCAL_PROVIDER_LABEL,
    auth: [
      {
        id: LOCAL_AUTH_METHOD_ID,
        label: LOCAL_PROVIDER_LABEL,
        kind: "custom",
        run: async () => ({
          profiles: [
            {
              profileId: LOCAL_PROFILE_ID,
              credential: {
                type: "api_key",
                provider: LOCAL_PROVIDER_ID,
                key: LOCAL_API_KEY,
              },
            },
          ],
          defaultModel: LOCAL_DEFAULT_MODEL,
        }),
      },
    ],
  };
}

function buildProviderWithDefaultModelPatch(): ProviderPlugin {
  return {
    id: LOCAL_PROVIDER_ID,
    label: LOCAL_PROVIDER_LABEL,
    auth: [
      {
        id: LOCAL_AUTH_METHOD_ID,
        label: LOCAL_PROVIDER_LABEL,
        kind: "custom",
        run: async () => ({
          profiles: [
            {
              profileId: LOCAL_PROFILE_ID,
              credential: {
                type: "api_key",
                provider: LOCAL_PROVIDER_ID,
                key: LOCAL_API_KEY,
              },
            },
          ],
          configPatch: {
            agents: {
              defaults: {
                model: { primary: LOCAL_DEFAULT_MODEL },
                models: {
                  [LOCAL_DEFAULT_MODEL]: { alias: "Local default" },
                },
              },
            },
          },
          defaultModel: LOCAL_DEFAULT_MODEL,
        }),
      },
    ],
  };
}

function buildParams(overrides: Partial<ApplyAuthChoiceParams> = {}): ApplyAuthChoiceParams {
  return {
    authChoice: LOCAL_PROVIDER_ID,
    config: {},
    prompter: {
      note: vi.fn(async () => {}),
    } as unknown as ApplyAuthChoiceParams["prompter"],
    runtime: {} as ApplyAuthChoiceParams["runtime"],
    setDefaultModel: true,
    ...overrides,
  };
}

function buildLocalProviderInstallCatalogEntry() {
  return {
    pluginId: "local-provider-plugin",
    providerId: LOCAL_PROVIDER_ID,
    methodId: LOCAL_AUTH_METHOD_ID,
    choiceId: LOCAL_PROVIDER_ID,
    choiceLabel: LOCAL_PROVIDER_LABEL,
    label: LOCAL_PROVIDER_LABEL,
    origin: "bundled" as const,
    install: {
      npmSpec: "@openclaw/local-provider",
    },
  };
}

function buildInstalledLocalProviderPluginResult() {
  return {
    cfg: {
      plugins: {
        entries: {
          "local-provider-plugin": {
            enabled: true,
          },
        },
      },
    },
    installed: true,
    pluginId: "local-provider-plugin",
    status: "installed" as const,
  };
}

describe("applyAuthChoiceLoadedPluginProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyAuthProfileConfig.mockImplementation((config) => config);
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolvePluginSetupProvider.mockReturnValue(undefined);
    resolveProviderInstallCatalogEntry.mockReturnValue(undefined);
    ensureOnboardingPluginInstalled.mockImplementation(async ({ cfg, entry }) => ({
      cfg,
      installed: false,
      pluginId: entry?.pluginId ?? "missing-plugin",
      status: "skipped",
    }));
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
      agentModelOverride: LOCAL_DEFAULT_MODEL,
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
  });

  it("keeps provider config patches when default model application is deferred", async () => {
    const provider: ProviderPlugin = {
      id: "remote-alpha",
      label: "Remote Alpha",
      auth: [
        {
          id: "api-key",
          label: "Remote Alpha API key",
          kind: "api_key",
          run: async () => ({
            profiles: [
              {
                profileId: "remote-alpha:default",
                credential: {
                  type: "api_key",
                  provider: "remote-alpha",
                  key: "sk-remote-alpha-test",
                },
              },
            ],
            configPatch: {
              models: {
                providers: {
                  "remote-alpha": {
                    api: "openai-completions",
                    baseUrl: "https://api.remote-alpha.example/v1",
                    models: [
                      {
                        id: "alpha-large",
                        name: "alpha-large",
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
            defaultModel: "remote-alpha/alpha-large",
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

    expect(result?.agentModelOverride).toBe("remote-alpha/alpha-large");
    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
    });
    expect(result?.config.models?.providers?.["remote-alpha"]?.baseUrl).toBe(
      "https://api.remote-alpha.example/v1",
    );
    expect(result?.config.models?.providers?.["remote-alpha"]?.models?.[0]?.input).toContain(
      "image",
    );
    expect(upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "remote-alpha:default",
      credential: {
        type: "api_key",
        provider: "remote-alpha",
        key: "sk-remote-alpha-test",
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
      primary: LOCAL_DEFAULT_MODEL,
    });
    expect(upsertAuthProfile).toHaveBeenCalledWith({
      profileId: LOCAL_PROFILE_ID,
      credential: {
        type: "api_key",
        provider: LOCAL_PROVIDER_ID,
        key: LOCAL_API_KEY,
      },
      agentDir: "/tmp/agent",
    });
    expect(runProviderModelSelectedHook).toHaveBeenCalledOnce();
    const [hookParams] = runProviderModelSelectedHook.mock
      .calls[0] as unknown as Parameters<RunProviderModelSelectedHook>;
    expect(hookParams.config).toBe(result?.config);
    expect(hookParams.model).toBe(LOCAL_DEFAULT_MODEL);
    expect(typeof hookParams.prompter.note).toBe("function");
    expect(hookParams.agentDir).toBeUndefined();
    expect(hookParams.workspaceDir).toBe("/tmp/workspace");
  });

  it("keeps an existing default when provider auth patches its own primary model", async () => {
    const provider = buildProviderWithDefaultModelPatch();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: provider.auth[0],
    });
    const note = vi.fn(async () => {});

    const result = await applyAuthChoiceLoadedPluginProvider(
      buildParams({
        config: {
          agents: {
            defaults: {
              model: { primary: EXISTING_DEFAULT_MODEL },
              models: {
                [EXISTING_DEFAULT_MODEL]: { alias: "Bedrock" },
              },
            },
          },
        },
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
        preserveExistingDefaultModel: true,
      }),
    );

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: EXISTING_DEFAULT_MODEL,
    });
    expect(result?.config.agents?.defaults?.models).toEqual({
      [EXISTING_DEFAULT_MODEL]: { alias: "Bedrock" },
      [LOCAL_DEFAULT_MODEL]: { alias: "Local default" },
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      `Kept existing default model ${EXISTING_DEFAULT_MODEL}; ${LOCAL_DEFAULT_MODEL} is available.`,
      "Model configured",
    );
  });

  it("uses manifest-owned setup providers without loading the broad provider runtime", async () => {
    const provider = buildProvider();
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "local-provider-plugin",
      providerId: LOCAL_PROVIDER_ID,
      methodId: LOCAL_AUTH_METHOD_ID,
      choiceId: LOCAL_PROVIDER_ID,
      choiceLabel: LOCAL_PROVIDER_LABEL,
    });
    resolvePluginSetupProvider.mockReturnValue(provider);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: provider.auth[0],
    });

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: LOCAL_DEFAULT_MODEL,
    });
    expect(resolvePluginSetupProvider).toHaveBeenCalledWith({
      provider: LOCAL_PROVIDER_ID,
      config: {
        plugins: {
          entries: {
            "local-provider-plugin": {
              enabled: true,
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      env: undefined,
      pluginIds: ["local-provider-plugin"],
    });
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("installs a missing provider plugin and retries setup resolution", async () => {
    const provider = buildProvider();
    resolveProviderInstallCatalogEntry.mockReturnValue(buildLocalProviderInstallCatalogEntry());
    ensureOnboardingPluginInstalled.mockResolvedValue(buildInstalledLocalProviderPluginResult());
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValueOnce(null).mockReturnValueOnce({
      provider,
      method: provider.auth[0],
    });

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
    const [installParams] = ensureOnboardingPluginInstalled.mock.calls.at(0) ?? [];
    if (installParams === undefined) {
      throw new Error("expected plugin install params");
    }
    expect(installParams.entry?.pluginId).toBe("local-provider-plugin");
    expect(installParams.entry?.label).toBe(LOCAL_PROVIDER_LABEL);
    expect(installParams.workspaceDir).toBe("/tmp/workspace");
    expect(resolvePluginProviders).toHaveBeenCalledTimes(2);
    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: LOCAL_DEFAULT_MODEL,
    });
  });

  it("does not persist plugin enablement when install is skipped", async () => {
    resolveProviderInstallCatalogEntry.mockReturnValue(buildLocalProviderInstallCatalogEntry());
    resolveProviderPluginChoice.mockReturnValue(null);

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
    expect(result).toEqual({ config: {}, retrySelection: true });
  });

  it("preserves install config when the chosen provider still cannot resolve after install", async () => {
    resolveProviderInstallCatalogEntry.mockReturnValue(buildLocalProviderInstallCatalogEntry());
    ensureOnboardingPluginInstalled.mockResolvedValue(buildInstalledLocalProviderPluginResult());
    resolveProviderPluginChoice.mockReturnValue(null);

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(result).toEqual({
      config: {
        plugins: {
          entries: {
            "local-provider-plugin": {
              enabled: true,
            },
          },
        },
      },
      retrySelection: true,
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
            profileId: LOCAL_PROFILE_ID,
            credential: {
              type: "api_key",
              provider: LOCAL_PROVIDER_ID,
              key: LOCAL_API_KEY,
            },
          },
        ],
        configPatch: {
          models: {
            providers: {
              [LOCAL_PROVIDER_ID]: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:4000/v1",
                models: [],
              },
            },
          },
        },
        defaultModel: LOCAL_DEFAULT_MODEL,
        notes: ["Detected local provider runtime.", "Pulled model metadata."],
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

    expect(result.defaultModel).toBe(LOCAL_DEFAULT_MODEL);
    expect(result.config.models?.providers?.[LOCAL_PROVIDER_ID]).toEqual({
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:4000/v1",
      models: [],
    });
    expect(result.config.auth?.profiles?.[LOCAL_PROFILE_ID]).toEqual({
      provider: LOCAL_PROVIDER_ID,
      mode: "api_key",
    });
    expect(note).toHaveBeenCalledWith(
      "Detected local provider runtime.\nPulled model metadata.",
      "Provider notes",
    );
  });

  it("normalizes retired Google Gemini default models returned by auth methods", async () => {
    const method: ProviderAuthMethod = {
      id: "google",
      label: "Google",
      kind: "custom",
      run: async () => ({
        profiles: [],
        defaultModel: "google/gemini-3-pro-preview",
      }),
    };

    const result = await runProviderPluginAuthMethod({
      config: {},
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note: vi.fn(async () => {}),
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
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
        replaceDefaultModels: true,
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
        authChoice: `provider-plugin:${LOCAL_PROVIDER_ID}:${LOCAL_AUTH_METHOD_ID}`,
        agentId: "worker",
        setDefaultModel: false,
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
      }),
      {
        authChoice: `provider-plugin:${LOCAL_PROVIDER_ID}:${LOCAL_AUTH_METHOD_ID}`,
        pluginId: LOCAL_PROVIDER_ID,
        providerId: LOCAL_PROVIDER_ID,
        methodId: LOCAL_AUTH_METHOD_ID,
        label: LOCAL_PROVIDER_LABEL,
      },
    );

    expect(result?.agentModelOverride).toBe(LOCAL_DEFAULT_MODEL);
    expect(result?.config.plugins).toEqual({
      entries: {
        [LOCAL_PROVIDER_ID]: {
          enabled: true,
        },
      },
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      `Default model set to ${LOCAL_DEFAULT_MODEL} for agent "worker".`,
      "Model configured",
    );
  });

  it("preserves the existing primary model for plugin auth choices that patch defaults", async () => {
    const provider = buildProviderWithDefaultModelPatch();
    resolvePluginProviders.mockReturnValue([provider]);
    const note = vi.fn(async () => {});

    const result = await applyAuthChoicePluginProvider(
      buildParams({
        authChoice: `provider-plugin:${LOCAL_PROVIDER_ID}:${LOCAL_AUTH_METHOD_ID}`,
        config: {
          agents: {
            defaults: {
              model: { primary: EXISTING_DEFAULT_MODEL },
              models: {
                [EXISTING_DEFAULT_MODEL]: { alias: "Bedrock" },
              },
            },
          },
        },
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
        preserveExistingDefaultModel: true,
      }),
      {
        authChoice: `provider-plugin:${LOCAL_PROVIDER_ID}:${LOCAL_AUTH_METHOD_ID}`,
        pluginId: LOCAL_PROVIDER_ID,
        providerId: LOCAL_PROVIDER_ID,
        methodId: LOCAL_AUTH_METHOD_ID,
        label: LOCAL_PROVIDER_LABEL,
      },
    );

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: EXISTING_DEFAULT_MODEL,
    });
    expect(result?.config.agents?.defaults?.models).toEqual({
      [EXISTING_DEFAULT_MODEL]: { alias: "Bedrock" },
      [LOCAL_DEFAULT_MODEL]: { alias: "Local default" },
    });
    expect(result?.config.plugins).toEqual({
      entries: {
        [LOCAL_PROVIDER_ID]: {
          enabled: true,
        },
      },
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      `Kept existing default model ${EXISTING_DEFAULT_MODEL}; ${LOCAL_DEFAULT_MODEL} is available.`,
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
        authChoice: LOCAL_PROVIDER_ID,
        pluginId: LOCAL_PROVIDER_ID,
        providerId: LOCAL_PROVIDER_ID,
        label: LOCAL_PROVIDER_LABEL,
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
    expect(note).toHaveBeenCalledWith(
      "Local Provider plugin is disabled (plugins disabled).",
      LOCAL_PROVIDER_LABEL,
    );
  });
});

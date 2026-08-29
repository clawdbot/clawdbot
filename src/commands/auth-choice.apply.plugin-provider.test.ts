// Auth-choice plugin provider tests cover loaded provider setup, plugin install, and credential routing.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { buildPluginCapabilityConsentReview } from "../plugins/capability-consent.js";
import * as pluginEnable from "../plugins/enable.js";
import { metadataSnapshot } from "../plugins/management-service.test-helpers.js";
import {
  applyAuthChoiceLoadedPluginProvider,
  prepareAuthChoiceLoadedPluginProvider,
  runProviderPluginAuthMethod,
} from "../plugins/provider-auth-choice.js";
import type { ProviderPlugin, ProviderAuthMethod } from "../plugins/types.js";
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
type ModelSelectionRuntimePluginsResult =
  | { ok: true; cfg: ApplyAuthChoiceParams["config"]; codexInstalled: boolean }
  | { ok: false; message: string };

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

const persistAuthProfileBatch = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/auth-profiles.js", () => ({
  persistAuthProfileBatch,
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
vi.mock("../infra/browser-open.js", () => ({
  openUrl,
}));

vi.mock("../infra/remote-env.js", () => ({
  isRemoteEnvironment,
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

const ensureModelSelectionRuntimePlugins = vi.hoisted(() =>
  vi.fn(
    async ({
      cfg,
    }: {
      cfg: ApplyAuthChoiceParams["config"];
    }): Promise<ModelSelectionRuntimePluginsResult> => ({
      ok: true,
      cfg,
      codexInstalled: false,
    }),
  ),
);
vi.mock("../commands/runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureModelSelectionRuntimePlugins,
}));

const offerPostInstallMigrations = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: ApplyAuthChoiceParams["config"] }) => ({ config })),
);
vi.mock("../wizard/setup.post-install-migration.js", () => ({
  offerPostInstallMigrations,
}));

const LOCAL_PROVIDER_ID = "local-provider";
const LOCAL_PROVIDER_LABEL = "Local Provider";
const LOCAL_AUTH_METHOD_ID = "local";
const LOCAL_PROFILE_ID = `${LOCAL_PROVIDER_ID}:default`;
const LOCAL_API_KEY = "local-provider-key";
const LOCAL_DEFAULT_MODEL = `${LOCAL_PROVIDER_ID}/demo-model`;
const EXISTING_DEFAULT_MODEL = "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0";

function expectPersistedProfile(profileId: string, credential: AuthProfileCredential): void {
  expect(persistAuthProfileBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      profiles: [{ profileId, credential }],
      agentDir: "/tmp/agent",
    }),
  );
}

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
  it("checks the persistent-effect guard before accepting plugin capabilities", async () => {
    const beforePersistentEffect = vi.fn(async () => {
      throw new Error("setup was cancelled");
    });
    const params = { ...buildParams(), beforePersistentEffect };
    params.prompter.confirm = vi.fn(async () => true);
    const entry = buildLocalProviderInstallCatalogEntry();
    resolveProviderInstallCatalogEntry.mockReturnValueOnce(entry);
    const enable = vi
      .spyOn(pluginEnable, "enablePluginWithCapabilityConsent")
      .mockResolvedValueOnce({ config: params.config, enabled: false, pluginId: entry.pluginId });
    try {
      await prepareAuthChoiceLoadedPluginProvider(params);
      const consent = expectDefined(
        enable.mock.calls[0]?.[2]?.onCapabilityConsent,
        "selected provider capability callback",
      );
      const manifest = expectDefined(
        metadataSnapshot({ id: entry.pluginId, enabled: false }).byPluginId.get(entry.pluginId),
        "selected provider manifest",
      );
      const review = buildPluginCapabilityConsentReview({
        pluginId: entry.pluginId,
        manifest,
        record: { source: "npm", spec: entry.install.npmSpec },
        config: params.config,
      });

      await expect(consent(review)).rejects.toThrow("setup was cancelled");
      expect(beforePersistentEffect).toHaveBeenCalledOnce();
      expect(persistAuthProfileBatch).not.toHaveBeenCalled();
      expect(resolvePluginProviders).not.toHaveBeenCalled();
    } finally {
      enable.mockRestore();
    }
  });

  it("does not load a selected provider when capability consent is declined", async () => {
    const params = buildParams();
    const entry = buildLocalProviderInstallCatalogEntry();
    resolveProviderInstallCatalogEntry.mockReturnValueOnce(entry);
    const enable = vi
      .spyOn(pluginEnable, "enablePluginWithCapabilityConsent")
      .mockResolvedValueOnce({
        config: params.config,
        enabled: false,
        pluginId: entry.pluginId,
        reason: "Plugin requires capability consent.",
      });
    try {
      const result = await applyAuthChoiceLoadedPluginProvider(params);
      expect(result?.config).toBe(params.config);
      expect(params.prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("capability consent"),
        entry.label,
      );
      expect(resolvePluginSetupProvider).not.toHaveBeenCalled();
      expect(resolvePluginProviders).not.toHaveBeenCalled();
      expect(persistAuthProfileBatch).not.toHaveBeenCalled();
    } finally {
      enable.mockRestore();
    }
  });

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
    ensureModelSelectionRuntimePlugins.mockImplementation(async ({ cfg }) => ({
      ok: true,
      cfg,
      codexInstalled: false,
    }));
    offerPostInstallMigrations.mockImplementation(async ({ config }) => ({ config }));
  });

  it("stages provider profiles until the caller commits them", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
    });

    const prepared = await prepareAuthChoiceLoadedPluginProvider(buildParams());

    expect(prepared?.authProfiles).toEqual([
      {
        profileId: LOCAL_PROFILE_ID,
        credential: {
          type: "api_key",
          provider: LOCAL_PROVIDER_ID,
          key: LOCAL_API_KEY,
        },
      },
    ]);
    expect(persistAuthProfileBatch).not.toHaveBeenCalled();

    await prepared?.persistAuthProfiles([
      {
        profileId: LOCAL_PROFILE_ID,
        credential: {
          type: "api_key",
          provider: LOCAL_PROVIDER_ID,
          key: "test-key",
        },
      },
    ]);
    await prepared?.persistAuthProfiles();

    expect(persistAuthProfileBatch).toHaveBeenCalledOnce();
    expectPersistedProfile(LOCAL_PROFILE_ID, {
      type: "api_key",
      provider: LOCAL_PROVIDER_ID,
      key: "test-key",
    });
  });

  it("returns an agent model override when default model application is deferred", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
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
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
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
    expectPersistedProfile("remote-alpha:default", {
      type: "api_key",
      provider: "remote-alpha",
      key: "sk-remote-alpha-test",
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
  });

  it("applies the default model and runs provider post-setup hooks", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
    });

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: LOCAL_DEFAULT_MODEL,
    });
    expectPersistedProfile(LOCAL_PROFILE_ID, {
      type: "api_key",
      provider: LOCAL_PROVIDER_ID,
      key: LOCAL_API_KEY,
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

  it.each(["failed", "timed_out"] as const)(
    "restores the previous model and retries when required Codex is %s",
    async (status) => {
      const provider = buildProviderWithDefaultModelPatch();
      resolvePluginProviders.mockReturnValue([provider]);
      resolveProviderPluginChoice.mockReturnValue({
        provider,
        method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
      });
      const note = vi.fn(async () => {});
      const message = `Codex runtime is required but unavailable (status: ${status}). Reason: registry token=***. Retry setup after checking npm and the configured registry.`;
      ensureModelSelectionRuntimePlugins.mockResolvedValue({ ok: false, message });

      const result = await applyAuthChoiceLoadedPluginProvider(
        buildParams({
          config: {
            agents: { defaults: { model: { primary: EXISTING_DEFAULT_MODEL } } },
          },
          prompter: { note } as unknown as ApplyAuthChoiceParams["prompter"],
        }),
      );

      expect(result).toEqual({
        config: {
          agents: { defaults: { model: { primary: EXISTING_DEFAULT_MODEL } } },
        },
        retrySelection: true,
      });
      expect(note).toHaveBeenCalledWith(message, "Runtime unavailable");
      expect(note).toHaveBeenCalledOnce();
      expect(persistAuthProfileBatch).not.toHaveBeenCalled();
      expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
      expect(offerPostInstallMigrations).not.toHaveBeenCalled();
    },
  );

  it("restores the exact entry config after provider install and auth staging", async () => {
    const provider = buildProvider();
    const entryConfig = {
      agents: { defaults: { model: { primary: EXISTING_DEFAULT_MODEL } } },
      wizard: { lastRunVersion: "entry-version" },
    };
    resolveProviderInstallCatalogEntry.mockReturnValue(buildLocalProviderInstallCatalogEntry());
    ensureOnboardingPluginInstalled.mockResolvedValue({
      ...buildInstalledLocalProviderPluginResult(),
      cfg: {
        ...entryConfig,
        plugins: { entries: { "local-provider-plugin": { enabled: true } } },
      },
    });
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValueOnce(null).mockReturnValueOnce({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
    });
    const note = vi.fn(async () => {});
    ensureModelSelectionRuntimePlugins.mockResolvedValue({
      ok: false,
      message: "GitHub Copilot agent runtime is required but unavailable.",
    });

    const result = await applyAuthChoiceLoadedPluginProvider(
      buildParams({
        config: entryConfig,
        prompter: { note } as unknown as ApplyAuthChoiceParams["prompter"],
      }),
    );

    expect(result).toEqual({ config: entryConfig, retrySelection: true });
    expect(result?.config).toBe(entryConfig);
    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledOnce();
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(offerPostInstallMigrations).not.toHaveBeenCalled();
    expect(persistAuthProfileBatch).not.toHaveBeenCalled();
  });

  it("keeps an existing default when provider auth patches its own primary model", async () => {
    const provider = buildProviderWithDefaultModelPatch();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
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
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
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
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
    });

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
    const [installParams] = ensureOnboardingPluginInstalled.mock.calls[0] ?? [];
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

    const events: string[] = [];
    const note = vi.fn(async () => {
      events.push("note");
    });
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
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note,
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
      beforePersistentEffect: () => {
        events.push("lock");
      },
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
    expect(persistAuthProfileBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stateDir: "/tmp/openclaw-state" }),
    );
    expect(events).toEqual(["note", "lock"]);
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
});

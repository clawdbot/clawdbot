// Non-interactive plugin provider auth tests cover provider choice setup and runtime plugin install requirements.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

type RuntimePluginInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: "installed" | "skipped" | "failed" | "timed_out";
};

const ensureCodexRuntimePluginForModelSelection = vi.hoisted(() =>
  vi.fn(
    async ({ cfg }: { cfg: OpenClawConfig }): Promise<RuntimePluginInstallResult> => ({
      cfg,
      required: false,
      installed: false,
    }),
  ),
);
vi.mock("../../codex-runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureCodexRuntimePluginForModelSelection,
}));
const ensureCopilotRuntimePluginForModelSelection = vi.hoisted(() =>
  vi.fn(
    async ({ cfg }: { cfg: OpenClawConfig }): Promise<RuntimePluginInstallResult> => ({
      cfg,
      required: false,
      installed: false,
    }),
  ),
);
vi.mock("../../copilot-runtime-plugin-install.js", () => ({
  ensureCopilotRuntimePluginForModelSelection,
}));
const offerPostInstallMigrations = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../wizard/setup.post-install-migration.js", () => ({
  offerPostInstallMigrations,
}));
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice,
}));
const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
}));
const resolveProviderInstallCatalogEntry = vi.hoisted(() => vi.fn(() => undefined));
const resolveDeprecatedProviderInstallCatalogEntry = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry,
  resolveProviderInstallCatalogEntry,
}));
const ensureOnboardingPluginInstalled = vi.hoisted(() => vi.fn());
vi.mock("../../onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() => vi.fn(() => undefined));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCore = vi.hoisted(() => vi.fn(() => []));
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
  authChoicePluginProvidersRuntime: {
    resolveOwningPluginIdsForProviderRef: resolveOwningPluginIdsForProvider,
    resolveProviderPluginChoice,
    resolvePluginProviders: resolvePluginProvidersCore,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
  resolveManifestProviderAuthChoice.mockReturnValue(undefined);
  resolveDeprecatedProviderInstallCatalogEntry.mockReturnValue(undefined);
  resolveProviderInstallCatalogEntry.mockReturnValue(undefined);
  ensureOnboardingPluginInstalled.mockResolvedValue(undefined);
  resolveOwningPluginIdsForProvider.mockReturnValue(undefined as never);
  resolveProviderPluginChoice.mockReturnValue(undefined);
  resolvePluginProvidersCore.mockReturnValue([] as never);
  ensureCodexRuntimePluginForModelSelection.mockImplementation(async ({ cfg }) => ({
    cfg,
    required: false,
    installed: false,
  }));
  ensureCopilotRuntimePluginForModelSelection.mockImplementation(async ({ cfg }) => ({
    cfg,
    required: false,
    installed: false,
  }));
  offerPostInstallMigrations.mockClear();
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

const target = {
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
};

type MockCalls = { mock: { calls: Array<Array<unknown>> } };

function mockCall(mock: MockCalls, callIndex = 0): Array<unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function mockArg(mock: MockCalls, callIndex = 0, argIndex = 0): Record<string, unknown> {
  const arg = mockCall(mock, callIndex)[argIndex];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected mock arg at call ${callIndex}, arg ${argIndex}`);
  }
  return arg as Record<string, unknown>;
}

function expectWorkspaceDir(value: unknown) {
  expect(typeof value).toBe("string");
  expect((value as string).length).toBeGreaterThan(0);
}

function expectConfigDefaults(value: unknown) {
  const config = value as { agents?: unknown };
  expect(config.agents).toEqual({ defaults: {} });
}

function expectRuntimeErrorIncludes(runtime: ReturnType<typeof createRuntime>, text: string) {
  const errorOutput = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
  expect(errorOutput).toContain(text);
}

async function applyProviderModelChoice(params: {
  providerId: string;
  modelRef: string;
  nextConfig?: OpenClawConfig;
  target?: typeof target;
}) {
  const runtime = createRuntime();
  const nextConfig = params.nextConfig ?? { agents: { defaults: {} } };
  const provider = {
    id: params.providerId,
    pluginId: params.providerId,
    label: params.providerId,
  };
  const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        model: { primary: params.modelRef },
      },
    },
  }));
  resolvePluginProvidersCore.mockReturnValue([provider] as never);
  resolveProviderPluginChoice.mockReturnValue({
    provider,
    method: { runNonInteractive },
  });

  return applyNonInteractivePluginProviderChoice({
    nextConfig,
    authChoice: `provider-plugin:${params.providerId}:custom`,
    opts: {} as never,
    runtime: runtime as never,
    baseConfig: nextConfig,
    target: params.target ?? target,
    resolveApiKey: vi.fn(),
    toApiKeyCredential: vi.fn(),
  });
}

describe("applyNonInteractivePluginProviderChoice", () => {
  it.each(["nvidia", "google"])(
    "keeps %s provider model selection on the configured explicit-fleet agent",
    async (providerId) => {
      const modelRef = `${providerId}/selected`;
      const result = await applyProviderModelChoice({
        providerId,
        modelRef,
        target: {
          agentId: "ops",
          agentDir: "/tmp/ops-agent",
          workspaceDir: "/tmp/ops-workspace",
        },
        nextConfig: {
          agents: {
            ownership: "explicit",
            defaults: {
              systemAgent: { agentId: "ops" },
              model: { primary: "anthropic/global" },
              models: { "anthropic/global": { alias: "Global" } },
            },
            entries: {
              main: { model: { primary: "anthropic/main" } },
              ops: {
                model: { primary: "openai/ops" },
                models: { "openai/ops": { alias: "Operations" } },
              },
            },
          },
        },
      });

      expect(result?.agents?.defaults?.model).toEqual({ primary: "anthropic/global" });
      expect(result?.agents?.defaults?.models).toEqual({
        "anthropic/global": { alias: "Global" },
      });
      expect(result?.agents?.entries?.ops?.model).toEqual({ primary: modelRef });
      expect(result?.agents?.entries?.ops?.models).toEqual({
        "openai/ops": { alias: "Operations" },
      });
      expect(result?.agents?.entries?.main?.model).toEqual({ primary: "anthropic/main" });
      expect(ensureCodexRuntimePluginForModelSelection).toHaveBeenCalledWith(
        expect.objectContaining({ model: modelRef }),
      );
    },
  );

  it.each([
    { providerId: "lmstudio", modelRef: "lmstudio/qwen/qwen3-1.7b" },
    { providerId: "ollama", modelRef: "ollama/qwen3:8b" },
  ])("auto-enables lean tools for verified $providerId onboarding", async (params) => {
    const result = await applyProviderModelChoice(params);

    expect(result?.agents?.defaults?.model).toEqual({ primary: params.modelRef });
    expect(result?.agents?.defaults?.experimental?.localModelLean).toBe(true);
    expect(result?.wizard?.localModelLeanAutoModel).toBe(params.modelRef);
  });

  it.each([
    { providerId: "lmstudio", modelRef: "lmstudio/qwen/qwen3-1.7b" },
    { providerId: "ollama", modelRef: "ollama/qwen3:8b" },
  ])("preserves explicit lean-tool opt-out for verified $providerId onboarding", async (params) => {
    const result = await applyProviderModelChoice({
      ...params,
      nextConfig: {
        agents: {
          defaults: {
            experimental: { localModelLean: false },
          },
        },
      },
    });

    expect(result?.agents?.defaults?.model).toEqual({ primary: params.modelRef });
    expect(result?.agents?.defaults?.experimental?.localModelLean).toBe(false);
    expect(result?.wizard?.localModelLeanAutoModel).toBeUndefined();
  });

  it("lifts onboarding-owned lean tools after verified hosted provider selection", async () => {
    const previousModel = "ollama/qwen3:8b";
    const result = await applyProviderModelChoice({
      providerId: "openai",
      modelRef: "openai/gpt-5.6-luna",
      nextConfig: {
        wizard: { localModelLeanAutoModel: previousModel },
        agents: {
          defaults: {
            model: { primary: previousModel },
            experimental: { localModelLean: true },
          },
        },
      },
    });

    expect(result?.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.6-luna" });
    expect(result?.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
    expect(result?.wizard?.localModelLeanAutoModel).toBeUndefined();
  });

  it("preserves explicitly enabled lean tools for verified hosted providers", async () => {
    const result = await applyProviderModelChoice({
      providerId: "openai",
      modelRef: "openai/gpt-5.6-luna",
      nextConfig: {
        agents: {
          defaults: {
            experimental: { localModelLean: true },
          },
        },
      },
    });

    expect(result?.agents?.defaults?.experimental?.localModelLean).toBe(true);
    expect(result?.wizard?.localModelLeanAutoModel).toBeUndefined();
  });

  it("loads plugin providers for provider-plugin auth choices", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["vllm"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["vllm"] as never);
    resolvePluginProvidersCore.mockReturnValue([{ id: "vllm", pluginId: "vllm" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "vllm", pluginId: "vllm", label: "vLLM" },
      method: { runNonInteractive },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "provider-plugin:vllm:custom",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledOnce();
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expect(mockArg(resolveOwningPluginIdsForProvider).provider).toBe("vllm");
    expect(resolvePluginProvidersCore).toHaveBeenCalledOnce();
    const providersInput = mockArg(resolvePluginProvidersCore);
    expect(providersInput.onlyPluginIds).toEqual(["vllm"]);
    expect(providersInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(resolveProviderPluginChoice).toHaveBeenCalledOnce();
    expect(runNonInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: target.agentDir,
        workspaceDir: target.workspaceDir,
      }),
    );
    expect(result).toEqual({ plugins: { allow: ["vllm"] } });
  });

  it.each([false, true])(
    "keeps media setup global without replacing the text model (explicit fleet: %s)",
    async (explicitFleet) => {
      const runtime = createRuntime();
      const provider = { id: "pixverse", pluginId: "pixverse", label: "PixVerse" };
      const initialConfig: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.6" } },
          ...(explicitFleet
            ? { ownership: "explicit", entries: { main: { model: { primary: "openai/agent" } } } }
            : {}),
        },
      };
      const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            mediaModels: { video: { primary: "pixverse/pixverse-v5.6" } },
          },
        },
      }));
      resolvePreferredProviderForAuthChoice.mockResolvedValue("pixverse" as never);
      resolvePluginProvidersCore.mockImplementation((...args: unknown[]) => {
        const input = args[0] as { providerRefs?: string[] } | undefined;
        return (input?.providerRefs?.includes("pixverse") ? [provider] : []) as never;
      });
      resolveProviderPluginChoice.mockImplementation((...args: unknown[]) => {
        const input = args[0] as { providers?: unknown[] } | undefined;
        return input?.providers?.includes(provider)
          ? { provider, method: { runNonInteractive } }
          : undefined;
      });

      const result = await applyNonInteractivePluginProviderChoice({
        nextConfig: initialConfig,
        authChoice: "pixverse-api-key",
        opts: { pixverseApiKey: "pixverse-test-key" } as never,
        runtime: runtime as never,
        baseConfig: initialConfig,
        target,
        resolveApiKey: vi.fn(),
        toApiKeyCredential: vi.fn(),
      });

      expect(runNonInteractive).toHaveBeenCalledOnce();
      expect(result?.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.6" });
      expect(result?.agents?.defaults?.mediaModels?.video).toEqual({
        primary: "pixverse/pixverse-v5.6",
      });
      if (explicitFleet) {
        expect(result?.agents?.entries?.main?.model).toEqual({ primary: "openai/agent" });
      }
    },
  );

  it("installs an official catalog provider before applying a cold auth choice", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
      ...config,
      agents: {
        defaults: {
          model: { primary: "groq/llama-3.3-70b-versatile" },
        },
      },
    }));
    const provider = { id: "groq", pluginId: "groq", label: "Groq" };
    resolveProviderInstallCatalogEntry.mockReturnValue({
      pluginId: "groq",
      providerId: "groq",
      label: "Groq",
      origin: "bundled",
      install: {
        npmSpec: "@openclaw/groq-provider",
        defaultChoice: "npm",
      },
    } as never);
    ensureOnboardingPluginInstalled.mockResolvedValue({
      cfg: {
        plugins: {
          entries: {
            groq: { enabled: true },
          },
        },
      },
      installed: true,
      pluginId: "groq",
      status: "installed",
    });
    resolvePluginProvidersCore.mockReturnValue([provider] as never);
    resolveProviderPluginChoice.mockReturnValueOnce(undefined).mockReturnValue({
      provider,
      method: { runNonInteractive },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "groq-api-key",
      opts: { groqApiKey: "groq-key" } as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(resolveProviderInstallCatalogEntry).toHaveBeenCalledWith(
      "groq-api-key",
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { agents: { defaults: {} } },
        entry: {
          pluginId: "groq",
          label: "Groq",
          install: {
            npmSpec: "@openclaw/groq-provider",
            defaultChoice: "npm",
          },
          trustedSourceLinkedOfficialInstall: true,
        },
        promptInstall: false,
      }),
    );
    expect(resolvePluginProvidersCore).toHaveBeenCalledTimes(2);
    expect(mockArg(resolvePluginProvidersCore, 1).providerRefs).toEqual(["groq"]);
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      agents: {
        defaults: {
          model: { primary: "groq/llama-3.3-70b-versatile" },
        },
      },
      plugins: {
        entries: {
          groq: { enabled: true },
        },
      },
    });
  });

  it("guides deprecated official auth choices before their plugin is installed", async () => {
    const runtime = createRuntime();
    resolveDeprecatedProviderInstallCatalogEntry.mockReturnValue({
      choiceId: "qwen-api-key",
    } as never);

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "modelstudio-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expectRuntimeErrorIncludes(
      runtime,
      '"modelstudio-api-key" is no longer supported. Use --auth-choice "qwen-api-key" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(resolveProviderInstallCatalogEntry).not.toHaveBeenCalled();
  });

  it("fails explicitly when a provider-plugin auth choice resolves to no trusted setup provider", async () => {
    const runtime = createRuntime();

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "provider-plugin:workspace-provider:api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expectRuntimeErrorIncludes(
      runtime,
      'Auth choice "provider-plugin:workspace-provider:api-key" was not matched to a trusted provider plugin.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails explicitly when a non-prefixed auth choice resolves only with untrusted providers", async () => {
    const runtime = createRuntime();
    resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
    resolveManifestProviderAuthChoice.mockReturnValueOnce(undefined).mockReturnValueOnce({
      pluginId: "workspace-provider",
      providerId: "workspace-provider",
    } as never);

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "workspace-provider-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expectRuntimeErrorIncludes(
      runtime,
      'Auth choice "workspace-provider-api-key" matched a provider plugin that is not trusted or enabled for setup.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mockArg(resolvePluginProvidersCore).includeUntrustedWorkspacePlugins).toBe(false);
    expect(resolveProviderPluginChoice).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
    expect(mockCall(resolveManifestProviderAuthChoice, 0)[0]).toBe("workspace-provider-api-key");
    const trustedManifestInput = mockArg(resolveManifestProviderAuthChoice, 0, 1);
    expect(trustedManifestInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(mockCall(resolveManifestProviderAuthChoice, 1)[0]).toBe("workspace-provider-api-key");
    const untrustedManifestInput = mockArg(resolveManifestProviderAuthChoice, 1, 1);
    expectConfigDefaults(untrustedManifestInput.config);
    expectWorkspaceDir(untrustedManifestInput.workspaceDir);
    expect(untrustedManifestInput.includeUntrustedWorkspacePlugins).toBe(true);
  });

  it("limits setup-provider resolution to owning plugin ids without pre-enabling them", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["demo-plugin"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["demo-plugin"] as never);
    resolvePluginProvidersCore.mockReturnValue([
      { id: "demo-provider", pluginId: "demo-plugin" },
    ] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "demo-provider", pluginId: "demo-plugin", label: "Demo Provider" },
      method: { runNonInteractive },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "provider-plugin:demo-provider:custom",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    const providersInput = mockArg(resolvePluginProvidersCore);
    expectConfigDefaults(providersInput.config);
    expect(providersInput.onlyPluginIds).toEqual(["demo-plugin"]);
    expect(providersInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toEqual({ plugins: { allow: ["demo-plugin"] } });
  });

  it("filters untrusted workspace manifest choices when resolving inferred auth choices", async () => {
    const runtime = createRuntime();
    resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);

    await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "openai-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    const preferenceInput = mockArg(resolvePreferredProviderForAuthChoice);
    expect(preferenceInput.choice).toBe("openai-api-key");
    expect(preferenceInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(mockArg(resolvePluginProvidersCore).includeUntrustedWorkspacePlugins).toBe(false);
  });

  it("ensures Codex after a non-interactive OpenAI provider choice sets the default model", async () => {
    const runtime = createRuntime();
    const selectedConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } as OpenClawConfig;
    const installedConfig = {
      ...selectedConfig,
      plugins: { entries: { codex: { enabled: true } } },
    } as OpenClawConfig;
    const runNonInteractive = vi.fn(async () => selectedConfig);
    ensureCodexRuntimePluginForModelSelection.mockResolvedValue({
      cfg: installedConfig,
      required: true,
      installed: true,
    });
    resolvePluginProvidersCore.mockReturnValue([{ id: "openai", pluginId: "openai" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "openai", pluginId: "openai", label: "OpenAI" },
      method: { runNonInteractive },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "openai-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(runNonInteractive).toHaveBeenCalledOnce();
    const ensureInput = mockArg(ensureCodexRuntimePluginForModelSelection);
    expect(ensureInput.cfg).toBe(selectedConfig);
    expect(ensureInput.model).toBe("openai/gpt-5.5");
    expect(ensureInput.runtime).toBe(runtime);
    expectWorkspaceDir(ensureInput.workspaceDir);
    expect(result).toBe(installedConfig);
    expect(offerPostInstallMigrations).toHaveBeenCalledOnce();
    const migrationInput = mockArg(offerPostInstallMigrations);
    expect(migrationInput.config).toBe(installedConfig);
    expect(migrationInput.installedPluginIds).toEqual(["codex"]);
    expect(migrationInput.nonInteractive).toBe(true);
  });

  it("ensures Copilot after a non-interactive GitHub Copilot choice opts into the runtime", async () => {
    const runtime = createRuntime();
    const selectedConfig = {
      agents: { defaults: { model: { primary: "github-copilot/gpt-5.5" } } },
      models: {
        providers: {
          "github-copilot": { agentRuntime: { id: "copilot" } },
        },
      },
    } as unknown as OpenClawConfig;
    const installedConfig = {
      ...selectedConfig,
      plugins: { entries: { copilot: { enabled: true } } },
    } as unknown as OpenClawConfig;
    const runNonInteractive = vi.fn(async () => selectedConfig);
    ensureCopilotRuntimePluginForModelSelection.mockResolvedValue({
      cfg: installedConfig,
      required: true,
      installed: true,
    });
    resolvePluginProvidersCore.mockReturnValue([
      { id: "github-copilot", pluginId: "github-copilot" },
    ] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "github-copilot", pluginId: "github-copilot", label: "GitHub Copilot" },
      method: { runNonInteractive },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "github-copilot",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    const ensureInput = mockArg(ensureCopilotRuntimePluginForModelSelection);
    expect(ensureInput.cfg).toBe(selectedConfig);
    expect(ensureInput.model).toBe("github-copilot/gpt-5.5");
    expect(ensureInput.runtime).toBe(runtime);
    expectWorkspaceDir(ensureInput.workspaceDir);
    expect(result).toBe(installedConfig);
  });

  it("does not offer post-install migration when Codex is not required for the selected model", async () => {
    const runtime = createRuntime();
    const selectedConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } as OpenClawConfig;
    const runNonInteractive = vi.fn(async () => selectedConfig);
    ensureCodexRuntimePluginForModelSelection.mockResolvedValue({
      cfg: selectedConfig,
      required: false,
      installed: false,
    });
    resolvePluginProvidersCore.mockReturnValue([{ id: "openai", pluginId: "openai" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "openai", pluginId: "openai", label: "OpenAI" },
      method: { runNonInteractive },
    });

    await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "openai-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      target,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(offerPostInstallMigrations).not.toHaveBeenCalled();
  });

  it.each(["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:120b-cloud"])(
    "does not enable local-model lean when Ollama selects hosted model %s",
    async (modelRef) => {
      const result = await applyProviderModelChoice({ providerId: "ollama", modelRef });

      expect(result?.agents?.defaults?.model).toEqual({ primary: modelRef });
      expect(result?.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
      expect(result?.wizard?.localModelLeanAutoModel).toBeUndefined();
    },
  );

  it.each(["ollama/kimi-k2.5:cloud", "ollama/gpt-oss:120b-cloud"])(
    "lifts onboarding-owned lean when Ollama switches to hosted model %s",
    async (modelRef) => {
      const previousModel = "ollama/qwen3:8b";
      const result = await applyProviderModelChoice({
        providerId: "ollama",
        modelRef,
        nextConfig: {
          wizard: { localModelLeanAutoModel: previousModel },
          agents: {
            defaults: {
              model: { primary: previousModel },
              experimental: { localModelLean: true },
            },
          },
        },
      });

      expect(result?.agents?.defaults?.model).toEqual({ primary: modelRef });
      expect(result?.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
      expect(result?.wizard?.localModelLeanAutoModel).toBeUndefined();
    },
  );

  it.each([false, true])(
    "preserves explicit local-model lean=%s when Ollama selects a hosted model",
    async (localModelLean) => {
      const result = await applyProviderModelChoice({
        providerId: "ollama",
        modelRef: "ollama/kimi-k2.5:cloud",
        nextConfig: {
          agents: {
            defaults: {
              experimental: { localModelLean },
            },
          },
        },
      });

      expect(result?.agents?.defaults?.experimental?.localModelLean).toBe(localModelLean);
      expect(result?.wizard?.localModelLeanAutoModel).toBeUndefined();
    },
  );
});

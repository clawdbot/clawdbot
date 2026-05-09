import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { CodexRuntimePluginInstallResult } from "../../codex-runtime-plugin-install.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

const ensureCodexRuntimePluginForModelSelection = vi.hoisted(() =>
  vi.fn(
    async ({ cfg }: { cfg: OpenClawConfig }): Promise<CodexRuntimePluginInstallResult> => ({
      cfg,
      required: false,
      installed: false,
    }),
  ),
);
vi.mock("../../codex-runtime-plugin-install.js", () => ({
  ensureCodexRuntimePluginForModelSelection,
}));
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice,
}));
const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() => vi.fn(() => undefined));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
  authChoicePluginProvidersRuntime: {
    resolveOwningPluginIdsForProvider,
    resolveProviderPluginChoice,
    resolvePluginProviders,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
  resolveManifestProviderAuthChoice.mockReturnValue(undefined);
  resolveOwningPluginIdsForProvider.mockReturnValue(undefined as never);
  resolveProviderPluginChoice.mockReturnValue(undefined);
  resolvePluginProviders.mockReturnValue([] as never);
  ensureCodexRuntimePluginForModelSelection.mockImplementation(async ({ cfg }) => ({
    cfg,
    required: false,
    installed: false,
  }));
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("applyNonInteractivePluginProviderChoice", () => {
  it("loads plugin providers for provider-plugin auth choices", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["vllm"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["vllm"] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm", pluginId: "vllm" }] as never);
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
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledOnce();
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "vllm",
      }),
    );
    expect(resolvePluginProviders).toHaveBeenCalledOnce();
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["vllm"],
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolveProviderPluginChoice).toHaveBeenCalledOnce();
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toEqual({ plugins: { allow: ["vllm"] } });
  });

  it("fails explicitly when a provider-plugin auth choice resolves to no trusted setup provider", async () => {
    const runtime = createRuntime();

    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      authChoice: "provider-plugin:workspace-provider:api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Auth choice "provider-plugin:workspace-provider:api-key" was not matched to a trusted provider plugin.',
      ),
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
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Auth choice "workspace-provider-api-key" matched a provider plugin that is not trusted or enabled for setup.',
      ),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolveProviderPluginChoice).toHaveBeenCalledTimes(1);
    expect(resolvePluginProviders).toHaveBeenCalledTimes(1);
    expect(resolveManifestProviderAuthChoice).toHaveBeenCalledWith(
      "workspace-provider-api-key",
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolveManifestProviderAuthChoice).toHaveBeenCalledWith(
      "workspace-provider-api-key",
      expect.objectContaining({
        config: expect.objectContaining({ agents: { defaults: {} } }),
        workspaceDir: expect.any(String),
        includeUntrustedWorkspacePlugins: true,
      }),
    );
  });

  it("limits setup-provider resolution to owning plugin ids without pre-enabling them", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["demo-plugin"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["demo-plugin"] as never);
    resolvePluginProviders.mockReturnValue([
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
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ agents: { defaults: {} } }),
        onlyPluginIds: ["demo-plugin"],
        includeUntrustedWorkspacePlugins: false,
      }),
    );
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
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(resolvePreferredProviderForAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: "openai-api-key",
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
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
      status: "installed",
    });
    resolvePluginProviders.mockReturnValue([{ id: "openai", pluginId: "openai" }] as never);
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
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(ensureCodexRuntimePluginForModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: selectedConfig,
        model: "openai/gpt-5.5",
        runtime,
        workspaceDir: expect.any(String),
      }),
    );
    expect(result).toBe(installedConfig);
  });
});

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
  expect(runtime.error.mock.calls.some(([message]) => String(message).includes(text))).toBe(true);
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
    expect(mockArg(resolveOwningPluginIdsForProvider).provider).toBe("vllm");
    expect(resolvePluginProviders).toHaveBeenCalledOnce();
    const providersInput = mockArg(resolvePluginProviders);
    expect(providersInput.onlyPluginIds).toEqual(["vllm"]);
    expect(providersInput.includeUntrustedWorkspacePlugins).toBe(false);
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
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expectRuntimeErrorIncludes(
      runtime,
      'Auth choice "workspace-provider-api-key" matched a provider plugin that is not trusted or enabled for setup.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mockArg(resolvePluginProviders).includeUntrustedWorkspacePlugins).toBe(false);
    expect(resolveProviderPluginChoice).toHaveBeenCalledTimes(1);
    expect(resolvePluginProviders).toHaveBeenCalledTimes(1);
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

    const providersInput = mockArg(resolvePluginProviders);
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
      resolveApiKey: vi.fn(),
      toApiKeyCredential: vi.fn(),
    });

    const preferenceInput = mockArg(resolvePreferredProviderForAuthChoice);
    expect(preferenceInput.choice).toBe("openai-api-key");
    expect(preferenceInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(mockArg(resolvePluginProviders).includeUntrustedWorkspacePlugins).toBe(false);
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
    const ensureInput = mockArg(ensureCodexRuntimePluginForModelSelection);
    expect(ensureInput.cfg).toBe(selectedConfig);
    expect(ensureInput.model).toBe("openai/gpt-5.5");
    expect(ensureInput.runtime).toBe(runtime);
    expectWorkspaceDir(ensureInput.workspaceDir);
    expect(result).toBe(installedConfig);
  });
});

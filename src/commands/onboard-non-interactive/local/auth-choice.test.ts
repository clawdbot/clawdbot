// Non-interactive auth-choice tests cover built-in, custom, deprecated, and plugin provider dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import * as apiProviderAuthChoices from "../../auth-choice.apply.api-providers.js";
import { commitNonInteractiveOnboardConfig } from "../config-write.js";
import { applyNonInteractiveAuthChoice } from "./auth-choice.js";

const writeWizardConfigFile = vi.hoisted(() => vi.fn(async (config: OpenClawConfig) => config));
vi.mock("../../../wizard/setup.shared.js", () => ({ writeWizardConfigFile }));

const formatAuthChoiceChoicesForCli = vi.hoisted(() =>
  vi.fn(() => "custom-api-key|skip|demo-provider-api-key"),
);
vi.mock("../../auth-choice-options.js", () => ({
  formatAuthChoiceChoicesForCli,
}));

const applyNonInteractivePluginProviderChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./auth-choice.plugin-providers.js", () => ({
  applyNonInteractivePluginProviderChoice,
}));

const resolveNonInteractiveApiKey = vi.hoisted(() => vi.fn());
vi.mock("../api-keys.js", () => ({
  resolveNonInteractiveApiKey,
}));

const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn(() => undefined));
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
}));
const resolveDeprecatedProviderInstallCatalogEntry = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry,
}));

beforeEach(() => {
  vi.clearAllMocks();
  applyNonInteractivePluginProviderChoice.mockReset();
  applyNonInteractivePluginProviderChoice.mockResolvedValue(undefined);
  resolveNonInteractiveApiKey.mockReset();
  resolveManifestDeprecatedProviderAuthChoice.mockReset();
  resolveManifestDeprecatedProviderAuthChoice.mockReturnValue(undefined);
  resolveManifestProviderAuthChoices.mockReset();
  resolveManifestProviderAuthChoices.mockReturnValue([]);
  resolveDeprecatedProviderInstallCatalogEntry.mockReset();
  resolveDeprecatedProviderInstallCatalogEntry.mockReturnValue(undefined);
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

describe("applyNonInteractiveAuthChoice", () => {
  it("rejects an unknown auth choice and lists the valid choices", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const message =
      'Unknown --auth-choice "definitely-not-a-provider". Valid choices: custom-api-key, skip, demo-provider-api-key.';

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "definitely-not-a-provider",
      opts: { json: true },
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ ok: false, phase: "options", message }, null, 2),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("continues to apply an enumerated provider auth choice", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolvedConfig = { auth: { profiles: { "demo-provider:default": { mode: "api_key" } } } };
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "demo-provider-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result).toBe(resolvedConfig);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledWith(
      expect.objectContaining({ target }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("resolves generic provider auth from the selected agent workspace", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolvedConfig = { auth: { profiles: { "demo-provider:default": { mode: "api_key" } } } };
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);
    const normalize = vi
      .spyOn(apiProviderAuthChoices, "normalizeApiKeyTokenProviderAuthChoice")
      .mockImplementation((params) =>
        params.workspaceDir === target.workspaceDir ? "demo-provider-api-key" : params.authChoice,
      );

    try {
      const result = await applyNonInteractiveAuthChoice({
        nextConfig,
        authChoice: "apiKey",
        opts: { tokenProvider: "demo-provider" },
        runtime: runtime as never,
        baseConfig: nextConfig,
        target,
      });

      expect(result).toBe(resolvedConfig);
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
    }
  });

  it("resolves plugin provider auth before builtin custom-provider handling", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolvedConfig = { auth: { profiles: { "demo-provider:default": { mode: "api_key" } } } };
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "demo-provider-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result).toBe(resolvedConfig);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledOnce();
  });

  it("fails with manifest-owned replacement guidance for deprecated auth choices", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "demo-provider-modern-api",
    } as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "demo-provider-legacy",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"demo-provider-legacy" is no longer supported. Use --auth-choice "demo-provider-modern-api" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).not.toHaveBeenCalled();
  });

  it("escapes deprecated auth choice guidance for terminal output", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValueOnce({
      choiceId: "modern\nchoice",
    } as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "legacy\u001b[31mchoice",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"legacy\\u001b[31mchoice" is no longer supported. Use --auth-choice "modern\\nchoice" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).not.toHaveBeenCalled();
  });

  it("keeps replacement guidance for deprecated install-catalog choices", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveDeprecatedProviderInstallCatalogEntry.mockReturnValueOnce({
      choiceId: "qwen-api-key",
    } as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "modelstudio-api-key",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"modelstudio-api-key" is no longer supported. Use --auth-choice "qwen-api-key" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).not.toHaveBeenCalled();
  });

  it("stores custom provider env refs through the local auth-choice seam", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce({
      key: "custom-env-key",
      source: "env",
      envVarName: "CUSTOM_API_KEY",
    });

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "ref",
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_API_KEY",
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "custom-models-custom-local/local-large",
    );
    expect(resolveNonInteractiveApiKey).toHaveBeenCalledOnce();
    const [apiKeyParams] = resolveNonInteractiveApiKey.mock.calls[0] ?? [];
    expect(apiKeyParams?.provider).toBe("custom-models-custom-local");
    expect(apiKeyParams?.flagName).toBe("--custom-api-key");
    expect(apiKeyParams?.envVar).toBe("CUSTOM_API_KEY");
    expect(apiKeyParams?.envVarName).toBe("CUSTOM_API_KEY");
    expect(apiKeyParams?.agentDir).toBe(target.agentDir);
    expect(apiKeyParams?.secretInputMode).toBe("ref");
  });

  it("keeps a custom provider model on the configured explicit-fleet system agent", async () => {
    const runtime = createRuntime();
    const nextConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "ops" },
          model: { primary: "anthropic/global" },
        },
        entries: {
          main: { model: { primary: "anthropic/main" } },
          ops: { model: { primary: "openai/ops" } },
        },
      },
    };
    resolveNonInteractiveApiKey.mockResolvedValueOnce(null);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target: {
        agentId: "ops",
        agentDir: "/tmp/ops-agent",
        workspaceDir: "/tmp/ops-workspace",
      },
    });

    expect(result?.agents?.defaults?.model).toEqual({ primary: "anthropic/global" });
    expect(result?.agents?.entries?.ops?.model).toEqual({
      primary: "custom-models-custom-local/local-large",
    });
    expect(result?.agents?.entries?.main?.model).toEqual({ primary: "anthropic/main" });
    expect(result?.models?.providers?.["custom-models-custom-local"]).toBeDefined();
  });

  it("never commits an existing profile key as plaintext during custom secret-ref onboarding", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const profileKey = "fixture-custom-profile-secret";
    resolveNonInteractiveApiKey.mockResolvedValueOnce({ key: profileKey, source: "profile" });

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "ref",
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result).not.toBeNull();
    await commitNonInteractiveOnboardConfig({
      nextConfig: result!,
    });

    const persistedConfig = writeWizardConfigFile.mock.calls.at(-1)?.[0];
    expect(
      persistedConfig?.models?.providers?.["custom-models-custom-local"]?.apiKey,
    ).toBeUndefined();
    expect(JSON.stringify(persistedConfig)).not.toContain(profileKey);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { source: "flag", key: "fixture-custom-literal-secret" },
    { source: "env", key: "fixture-custom-anonymous-env-secret" },
  ] as const)(
    "never serializes an unreferenceable custom $source key in secret-ref mode",
    async (resolved) => {
      const runtime = createRuntime();
      const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
      resolveNonInteractiveApiKey.mockResolvedValueOnce(resolved);

      const result = await applyNonInteractiveAuthChoice({
        nextConfig,
        authChoice: "custom-api-key",
        opts: {
          customBaseUrl: "https://models.custom.local/v1",
          customModelId: "local-large",
          secretInputMode: "ref",
        } as never,
        runtime: runtime as never,
        baseConfig: nextConfig,
        target,
      });

      expect(result).toBeNull();
      expect(writeWizardConfigFile).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      const errorText = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
      expect(errorText).toContain("CUSTOM_API_KEY");
      expect(errorText).toContain("--secret-input-mode ref");
      expect(errorText).not.toContain(resolved.key);
    },
  );

  it.each([
    { source: "env", provider: "default", id: "EXISTING_CUSTOM_API_KEY" },
    { source: "file", provider: "local", id: "/providers/custom" },
    { source: "exec", provider: "vault", id: "custom-provider" },
  ] as const)(
    "preserves existing $source custom SecretRefs when reusing an auth profile",
    async (ref) => {
      const runtime = createRuntime();
      const providerId = "custom-models-custom-local";
      const nextConfig = {
        models: {
          providers: {
            [providerId]: {
              baseUrl: "https://models.custom.local/v1",
              apiKey: ref,
              models: [],
            },
          },
        },
      } as OpenClawConfig;
      resolveNonInteractiveApiKey.mockResolvedValueOnce({
        key: "fixture-existing-profile-secret",
        source: "profile",
      });

      const result = await applyNonInteractiveAuthChoice({
        nextConfig,
        authChoice: "custom-api-key",
        opts: {
          customBaseUrl: "https://models.custom.local/v1",
          customModelId: "local-large",
          secretInputMode: "ref",
        } as never,
        runtime: runtime as never,
        baseConfig: nextConfig,
        target,
      });

      expect(result?.models?.providers?.[providerId]?.apiKey).toEqual(ref);
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it("preserves intentionally keyless custom setup in secret-ref mode", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce(null);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "ref",
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.apiKey).toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves existing custom profile serialization in explicit plaintext mode", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce({
      key: "fixture-plaintext-profile-key",
      source: "profile",
    });

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "plaintext",
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.apiKey).toBe(
      "fixture-plaintext-profile-key",
    );
  });

  it.each([
    { source: "profile", key: "fixture-plugin-profile-secret" },
    { source: "flag", key: "fixture-plugin-literal-secret" },
    { source: "env", key: "fixture-plugin-env-secret" },
  ] as const)(
    "rejects non-referenceable $source plugin credentials in secret-ref mode",
    async (resolved) => {
      const runtime = createRuntime();
      const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
      applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(nextConfig as never);

      await applyNonInteractiveAuthChoice({
        nextConfig,
        authChoice: "demo-provider-api-key",
        opts: { secretInputMode: "ref" } as never,
        runtime: runtime as never,
        baseConfig: nextConfig,
        target,
      });

      const [pluginParams] = applyNonInteractivePluginProviderChoice.mock.calls.at(
        -1,
      ) as unknown as [
        {
          toApiKeyCredential: (params: { provider: string; resolved: typeof resolved }) => unknown;
        },
      ];
      const credential = pluginParams.toApiKeyCredential({
        provider: "demo-provider",
        resolved,
      });

      expect(credential).toBeNull();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      const errorText = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
      expect(errorText).toContain("--secret-input-mode ref");
      expect(errorText).toContain("demo-provider");
      expect(errorText).not.toContain(resolved.key);
    },
  );

  it("preserves env-backed plugin credentials and profile metadata in secret-ref mode", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(nextConfig as never);

    await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "demo-provider-api-key",
      opts: { secretInputMode: "ref" } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    const [pluginParams] = applyNonInteractivePluginProviderChoice.mock.calls.at(-1) as unknown as [
      {
        toApiKeyCredential: (params: {
          provider: string;
          resolved: { key: string; source: "env"; envVarName: string };
          email: string;
          metadata: Record<string, string>;
        }) => unknown;
      },
    ];
    expect(
      pluginParams.toApiKeyCredential({
        provider: "demo-provider",
        resolved: {
          key: "fixture-valid-plugin-env-secret",
          source: "env",
          envVarName: "DEMO_PROVIDER_API_KEY",
        },
        email: "operator@example.test",
        metadata: { account: "work" },
      }),
    ).toEqual({
      type: "api_key",
      provider: "demo-provider",
      keyRef: { source: "env", provider: "default", id: "DEMO_PROVIDER_API_KEY" },
      email: "operator@example.test",
      metadata: { account: "work" },
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("stores custom provider OpenAI Responses compatibility", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce(undefined);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "gpt-5.4",
        customCompatibility: "openai-responses",
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.api).toBe("openai-responses");
  });

  it("marks non-interactive custom provider models as image-capable when requested", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce(undefined);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "gpt-4o",
        customImageInput: true,
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.models?.[0]?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("infers image-capable non-interactive custom provider models by known model id", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce(undefined);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "gpt-4o",
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.models?.[0]?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("honors explicit text-only override for known custom vision models", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce(undefined);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "custom-api-key",
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "gpt-4o",
        customImageInput: false,
      } as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
      target,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.models?.[0]?.input).toEqual([
      "text",
    ]);
  });
});

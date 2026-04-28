import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import { applyNonInteractiveAuthChoice } from "./auth-choice.js";

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

beforeEach(() => {
  vi.clearAllMocks();
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

describe("applyNonInteractiveAuthChoice", () => {
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
    });

    expect(result).toBe(resolvedConfig);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledOnce();
  });

  it("fails with manifest-owned replacement guidance for deprecated auth choices", async () => {
    const runtime = createRuntime();
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValueOnce({
      choiceId: "demo-provider-modern-api",
    } as never);

    const result = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice: "demo-provider-legacy",
      opts: {} as never,
      runtime: runtime as never,
      baseConfig: nextConfig,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"demo-provider-legacy" is no longer supported. Use --auth-choice "demo-provider-modern-api" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledOnce();
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
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"legacy\\u001b[31mchoice" is no longer supported. Use --auth-choice "modern\\nchoice" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledOnce();
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
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_API_KEY",
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "custom-models-custom-local/local-large",
    );
    expect(resolveNonInteractiveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom-models-custom-local",
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        secretInputMode: "ref",
      }),
    );
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
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.models?.[0]?.input).toEqual([
      "text",
    ]);
  });
});

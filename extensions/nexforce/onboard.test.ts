import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { applyNexforceConfig, NEXFORCE_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
});

describe("Nexforce onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyNexforceConfig({});

    expect(config.models?.providers?.nexforce?.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.nexforce.models.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      NEXFORCE_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [NEXFORCE_DEFAULT_MODEL_REF]: { alias: "Nexforce Smart Route" },
    });
  });

  it("preserves an existing primary during non-interactive auth setup", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth?.[0];
    if (!method?.runNonInteractive) {
      throw new Error("expected Nexforce non-interactive auth method");
    }

    const result = await method.runNonInteractive({
      authChoice: "nexforce-api-key",
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: { "anthropic/claude-sonnet-4-6": { alias: "Existing" } },
          },
        },
      },
      opts: {},
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      resolveApiKey: vi.fn(async () => ({ key: "fixture-value", source: "profile" })),
      toApiKeyCredential: vi.fn(() => null),
    } as never);

    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(result?.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Existing" },
      [NEXFORCE_DEFAULT_MODEL_REF]: { alias: "Nexforce Smart Route" },
    });
  });

  it("keeps the static catalog without querying the model endpoint", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const staticResult = await provider.staticCatalog?.run({ config: {}, env: {} } as never);
    if (!staticResult || !("provider" in staticResult)) {
      throw new Error("expected static Nexforce provider catalog");
    }

    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(staticResult.provider.baseUrl).toBe("https://router.nexforce.ai/v1");
    expect(staticResult.provider.api).toBe("openai-completions");
    expect(staticResult.provider.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.nexforce.models.map((model) => model.id),
    );
    expect(
      staticResult.provider.models.find((model) => model.id === "openai/gpt-5.4")?.input,
    ).toEqual(["text", "image"]);
  });

  it("discovers the live catalog from the router /v1/models endpoint", async () => {
    ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: jsonResponse({
        object: "list",
        data: [
          {
            id: "openai/gpt-5.4",
            name: "GPT-5.4",
            context_length: 1050000,
            max_output_tokens: 128000,
            architecture: { input_modalities: ["text", "image", "pdf"] },
          },
          {
            id: "anthropic/claude-opus-4-7",
            name: "Claude Opus 4.7",
            context_length: 1000000,
            max_output_tokens: 128000,
            architecture: { input_modalities: ["text", "image", "pdf"] },
          },
          {
            id: "meta-llama/llama-3.1-70b",
            name: "Llama 3.1 70B",
            context_length: 131072,
            max_output_tokens: 8192,
          },
        ],
      }),
      finalUrl: "https://router.nexforce.ai/v1/models",
      release: vi.fn(),
    });
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "fixture-nexforce-key" }),
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected authenticated Nexforce provider catalog");
    }
    expect(result.provider.apiKey).toBe("fixture-nexforce-key");
    expect(result.provider.models.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4-7",
      "meta-llama/llama-3.1-70b",
      "openai/gpt-5.4",
    ]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://router.nexforce.ai/v1/models",
      }),
    );
  });

  it("declares the bundled provider catalog as refreshable", () => {
    expect(manifest.modelCatalog.discovery.nexforce).toBe("refreshable");
  });

  it("keeps the runtime catalog inactive without a Nexforce credential", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({}),
      } as never),
    ).resolves.toBeNull();
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});

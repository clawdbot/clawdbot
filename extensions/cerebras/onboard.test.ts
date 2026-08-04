import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { applyCerebrasConfig, CEREBRAS_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

afterEach(() => {
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
});

describe("Cerebras onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyCerebrasConfig({});

    expect(config.models?.providers?.cerebras?.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      CEREBRAS_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras Gemma 4 31B" },
    });
  });

  it("preserves an existing primary during non-interactive auth setup", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth?.[0];
    if (!method?.runNonInteractive) {
      throw new Error("expected Cerebras non-interactive auth method");
    }

    const result = await method.runNonInteractive({
      authChoice: "cerebras-api-key",
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
      [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras Gemma 4 31B" },
    });
  });

  it("keeps the authenticated runtime catalog static without querying the model endpoint", async () => {
    ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: Response.json({ data: [{ id: "gpt-oss-120b", object: "model" }] }),
      finalUrl: "https://api.cerebras.ai/v1/models",
      release: vi.fn(),
    });
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "fixture-cerebras-key" }),
    } as never);

    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    if (!result || !("provider" in result)) {
      throw new Error("expected authenticated Cerebras provider catalog");
    }
    expect(result.provider.apiKey).toBe("fixture-cerebras-key");
    expect(result.provider.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
    );
    expect(result.provider.models.find((model) => model.id === "gemma-4-31b")?.input).toEqual([
      "text",
      "image",
    ]);
    const staticResult = await provider.staticCatalog?.run({ config: {}, env: {} } as never);
    if (!staticResult || !("provider" in staticResult)) {
      throw new Error("expected static Cerebras provider catalog");
    }
    expect(staticResult.provider.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
    );
  });

  it("declares the bundled provider catalog as static", () => {
    expect(manifest.modelCatalog.discovery.cerebras).toBe("static");
  });

  it("keeps the runtime catalog inactive without a Cerebras credential", async () => {
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

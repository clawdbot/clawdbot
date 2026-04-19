import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { resolveProviderAuthEnvVarCandidates } from "../../src/secrets/provider-env-vars.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import arceePlugin from "./index.js";

describe("arcee provider plugin", () => {
  it("registers Arcee AI with direct and OpenRouter auth choices", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    expect(provider.id).toBe("arcee");
    expect(provider.label).toBe("Arcee AI");
    expect(provider.envVars).toEqual(["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"]);
    expect(provider.auth).toHaveLength(2);

    const directChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "arceeai-api-key",
    });
    expect(directChoice).not.toBeNull();
    expect(directChoice?.provider.id).toBe("arcee");
    expect(directChoice?.method.id).toBe("arcee-platform");

    const orChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "arceeai-openrouter",
    });
    expect(orChoice).not.toBeNull();
    expect(orChoice?.provider.id).toBe("arcee");
    expect(orChoice?.method.id).toBe("openrouter");
  });

  it("stores the OpenRouter onboarding path under the OpenRouter auth profile", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const openRouterMethod = provider.auth?.find((method) => method.id === "openrouter");
    if (!openRouterMethod?.runNonInteractive) {
      throw new Error("expected OpenRouter non-interactive auth");
    }

    const config = await openRouterMethod.runNonInteractive({
      config: {},
      opts: {},
      env: {},
      runtime: {
        error: () => {},
        exit: () => {},
        log: () => {},
      },
      resolveApiKey: async () => ({
        key: "sk-or-test",
        source: "profile",
      }),
      toApiKeyCredential: () => null,
    } as never);

    expect(config?.auth?.profiles?.["openrouter:default"]).toMatchObject({
      provider: "openrouter",
      mode: "api_key",
    });
    expect(config?.models?.providers?.arcee).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
    });
    expect(config?.models?.providers?.arcee?.models?.map((model) => model.id)).toEqual([
      "arcee/trinity-mini",
      "arcee/trinity-large-preview",
      "arcee/trinity-large-thinking",
    ]);
  });

  it("keeps direct Arcee auth env candidates separate from OpenRouter", () => {
    const candidates = resolveProviderAuthEnvVarCandidates();

    expect(candidates.arcee).toEqual(["ARCEEAI_API_KEY"]);
    expect(candidates.openrouter).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("builds the direct Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: (id: string) =>
        id === "arcee" ? { apiKey: "test-key" } : { apiKey: undefined },
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.arcee.ai/api/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "trinity-mini",
      "trinity-large-preview",
      "trinity-large-thinking",
    ]);
  });

  it("builds the OpenRouter-backed Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: (id: string) =>
        id === "openrouter" ? { apiKey: "sk-or-test" } : { apiKey: undefined },
      resolveProviderAuth: () => ({
        apiKey: "sk-or-test",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "arcee/trinity-mini",
      "arcee/trinity-large-preview",
      "arcee/trinity-large-thinking",
    ]);
  });

  it("normalizes Arcee OpenRouter models to vendor-prefixed runtime ids", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "arcee/trinity-large-thinking",
        model: {
          provider: "arcee",
          id: "trinity-large-thinking",
          name: "Trinity Large Thinking",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      } as never),
    ).toMatchObject({
      id: "arcee/trinity-large-thinking",
    });

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "arcee/trinity-large-thinking",
        model: {
          provider: "arcee",
          id: "trinity-large-thinking",
          name: "Trinity Large Thinking",
          api: "openai-completions",
          baseUrl: "https://api.arcee.ai/api/v1",
        },
      } as never),
    ).toBeUndefined();
  });

  it("canonicalizes stale OpenRouter /v1 config and transport metadata", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "arcee",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1/",
          models: [],
        },
      } as never),
    ).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "arcee/trinity-large-thinking",
        model: {
          provider: "arcee",
          id: "trinity-large-thinking",
          name: "Trinity Large Thinking",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1",
        },
      } as never),
    ).toMatchObject({
      id: "arcee/trinity-large-thinking",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "arcee",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });
});

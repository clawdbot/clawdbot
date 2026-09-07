// Arcee tests cover index plugin behavior.
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAuthProfileOrder, type AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveProviderAuthEnvVarCandidates } from "openclaw/plugin-sdk/provider-env-vars";
import type { ModelDefinitionConfig, OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import { applyArceeConfig, applyArceeOpenRouterConfig } from "./api.js";
import arceePlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

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
    if (!directChoice) {
      throw new Error("expected direct Arcee auth choice");
    }
    expect(directChoice.provider.id).toBe("arcee");
    expect(directChoice.method.id).toBe("arcee-platform");

    const orChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "arceeai-openrouter",
    });
    if (!orChoice) {
      throw new Error("expected OpenRouter Arcee auth choice");
    }
    expect(orChoice.provider.id).toBe("arcee");
    expect(orChoice.method.id).toBe("openrouter");

    const openRouterManifestChoice = manifest.providerAuthChoices.find(
      (choice) => choice.choiceId === "arceeai-openrouter",
    );
    expect(openRouterManifestChoice).toMatchObject({ optionKey: "openrouterApiKey" });
    expect(openRouterManifestChoice).not.toHaveProperty("cliFlag");
    expect(openRouterManifestChoice).not.toHaveProperty("cliOption");
  });

  describe.each([
    {
      methodId: "arcee-platform",
      choiceId: "arceeai-api-key",
      optionKey: "arceeaiApiKey",
      credentialProvider: "arcee",
      baseUrl: "https://api.arcee.ai/api/v1",
      alias: "Arcee AI",
      catalogIds: ["trinity-mini", "trinity-large-preview", "trinity-large-thinking"],
      collisionId: "trinity-large-thinking",
      addedIds: ["trinity-mini", "trinity-large-preview"],
      applyPublicConfig: applyArceeConfig,
    },
    {
      methodId: "openrouter",
      choiceId: "arceeai-openrouter",
      optionKey: "openrouterApiKey",
      credentialProvider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      alias: "Arcee AI (OpenRouter)",
      catalogIds: ["arcee-ai/trinity-large-preview", "arcee-ai/trinity-large-thinking"],
      collisionId: "arcee-ai/trinity-large-thinking",
      addedIds: ["arcee-ai/trinity-large-preview"],
      applyPublicConfig: applyArceeOpenRouterConfig,
    },
  ])("$methodId setup", (route) => {
    const modelRef = "arcee/trinity-large-thinking";
    const profileId = `${route.credentialProvider}:default`;

    async function registeredMethod() {
      const provider = await registerSingleProviderPlugin(arceePlugin);
      const method = provider.auth.find((entry) => entry.id === route.methodId);
      if (!method?.runNonInteractive) {
        throw new Error(`Missing registered auth method: ${route.methodId}`);
      }
      return { method, runNonInteractive: method.runNonInteractive };
    }

    async function onboard(config: OpenClawConfig) {
      const { runNonInteractive } = await registeredMethod();
      const result = await runNonInteractive({
        authChoice: route.choiceId,
        config,
        baseConfig: config,
        opts: {},
        runtime: createRuntimeEnv(),
        resolveApiKey: async () => ({ key: "test-arcee-key", source: "profile" }),
        toApiKeyCredential: () => null,
      });
      if (!result) {
        throw new Error("Expected successful registered onboarding");
      }
      return result;
    }

    it("selects stored credentials from registered setup without crossing accounts", async () => {
      const { method } = await registeredMethod();
      const result = await method.run({
        config: {},
        opts: { [route.optionKey]: "selected-route-key" },
        env: {},
        runtime: createRuntimeEnv(),
        prompter: createTestWizardPrompter(),
        secretInputMode: "plaintext",
        isRemote: false,
        openUrl: async () => {
          throw new Error("Unexpected browser auth");
        },
        oauth: {
          createVpsAwareHandlers: () => {
            throw new Error("Unexpected OAuth");
          },
        },
      });
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "arcee:other": { type: "api_key", provider: "arcee", key: "direct-account-key" },
          "openrouter:other": {
            type: "api_key",
            provider: "openrouter",
            key: "router-account-key",
          },
          ...Object.fromEntries(
            result.profiles.map(({ profileId: storedProfileId, credential }) => [
              storedProfileId,
              credential,
            ]),
          ),
        },
      };
      const cfg: OpenClawConfig = result.configPatch ?? {};
      const order = resolveAuthProfileOrder({ cfg, store, provider: "arcee" });
      expect(order).toContain(profileId);
      expect(order).toContain(`${route.credentialProvider}:other`);
      expect(order).not.toContain(
        route.credentialProvider === "arcee" ? "openrouter:other" : "arcee:other",
      );
      expect(result.defaultModel).toBe("arcee/trinity-large-thinking");
    });

    it.each([
      { mode: undefined, expectedIds: [] },
      { mode: "merge" as const, expectedIds: [] },
      { mode: "replace" as const, expectedIds: route.catalogIds },
    ])("keeps the registered row policy in $mode mode", async ({ mode, expectedIds }) => {
      const input: OpenClawConfig = { models: { mode } };
      const nonInteractive = await onboard(input);
      const { method } = await registeredMethod();
      const interactive = await method.run({
        config: input,
        opts: { [route.optionKey]: "test-arcee-key" },
        env: {},
        runtime: createRuntimeEnv(),
        prompter: createTestWizardPrompter(),
        secretInputMode: "plaintext",
        isRemote: false,
        openUrl: async () => {
          throw new Error("Unexpected browser auth");
        },
        oauth: {
          createVpsAwareHandlers: () => {
            throw new Error("Unexpected OAuth");
          },
        },
      });

      expect(interactive.profiles).toEqual([
        {
          profileId,
          credential: {
            type: "api_key",
            provider: route.credentialProvider,
            key: "test-arcee-key",
          },
        },
      ]);
      expect(interactive.defaultModel).toBe(modelRef);
      expect(nonInteractive.auth?.profiles?.[profileId]).toEqual({
        provider: route.credentialProvider,
        mode: "api_key",
      });
      for (const output of [
        nonInteractive,
        interactive.configPatch,
        await onboard(nonInteractive),
      ]) {
        expect(output?.models?.providers?.arcee).toMatchObject({
          baseUrl: route.baseUrl,
          api: "openai-completions",
        });
        expect(output?.models?.providers?.arcee?.models?.map((model) => model.id)).toEqual(
          expectedIds,
        );
        expect(output?.agents?.defaults?.model).toEqual({ primary: modelRef });
        expect(output?.agents?.defaults?.models?.[modelRef]).toEqual({ alias: route.alias });
      }
      expect(input).toEqual({ models: { mode } });
    });

    it.each([
      { mode: undefined, addedIds: [] },
      { mode: "merge" as const, addedIds: [] },
      { mode: "replace" as const, addedIds: route.addedIds },
    ])("preserves authored rows and aliases in $mode mode", async ({ mode, addedIds }) => {
      const collision: ModelDefinitionConfig = {
        id: route.collisionId,
        name: "Authored collision",
        reasoning: false,
        input: ["text"],
        contextWindow: 12345,
        maxTokens: 2345,
        cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
      };
      const authoredOnly = { ...collision, id: "operator-only", name: "Authored only" };
      const input: OpenClawConfig = {
        auth: { profiles: { "other:default": { provider: "other", mode: "api_key" } } },
        agents: {
          defaults: {
            model: { primary: "arcee/operator-only", fallbacks: ["arcee/fallback"] },
            models: { [modelRef]: { alias: "Authored alias", params: { temperature: 0.2 } } },
          },
        },
        models: {
          mode,
          providers: {
            arcee: { baseUrl: route.baseUrl, models: [collision, authoredOnly] },
            other: { baseUrl: "https://other.invalid/v1", models: [] },
          },
        },
      };
      const before = structuredClone(input);
      const output = await onboard(input);
      expect(output.models?.providers?.arcee?.models?.slice(0, 2)).toEqual([
        collision,
        authoredOnly,
      ]);
      expect(output.models?.providers?.arcee?.models?.map((model) => model.id)).toEqual([
        route.collisionId,
        "operator-only",
        ...addedIds,
      ]);
      expect(output.models?.providers?.other).toEqual(input.models?.providers?.other);
      expect(output.auth?.profiles?.["other:default"]).toEqual(
        input.auth?.profiles?.["other:default"],
      );
      expect(output.agents?.defaults?.models?.[modelRef]).toEqual(
        input.agents?.defaults?.models?.[modelRef],
      );
      expect(output.agents?.defaults?.model).toEqual({
        primary: modelRef,
        fallbacks: ["arcee/fallback"],
      });
      expect(await onboard(output)).toEqual(output);
      expect(input).toEqual(before);

      const publicOutput = route.applyPublicConfig(input);
      expect(publicOutput.models?.providers?.arcee?.models?.slice(0, 2)).toEqual([
        collision,
        authoredOnly,
      ]);
      expect(publicOutput.models?.providers?.arcee?.models?.map((model) => model.id)).toEqual([
        route.collisionId,
        "operator-only",
        ...route.addedIds,
      ]);
      expect(publicOutput.agents?.defaults?.model).toEqual(input.agents?.defaults?.model);
      expect(publicOutput.agents?.defaults?.models?.[modelRef]).toEqual(
        input.agents?.defaults?.models?.[modelRef],
      );
    });

    it.each([undefined, "merge", "replace"] as const)(
      "keeps the public catalog helper eager in %s mode",
      (mode) => {
        const output = route.applyPublicConfig({ models: { mode } });
        expect(output.models?.providers?.arcee?.models?.map((model) => model.id)).toEqual(
          route.catalogIds,
        );
        expect(output.models?.providers?.arcee).toMatchObject({
          baseUrl: route.baseUrl,
          api: "openai-completions",
        });
        expect(output.agents?.defaults?.model).toEqual({ primary: modelRef });
        expect(output.agents?.defaults?.models?.[modelRef]).toEqual({ alias: route.alias });
      },
    );
  });

  it("keeps direct Arcee auth env candidates separate from OpenRouter", () => {
    const candidates = resolveProviderAuthEnvVarCandidates();

    expect(candidates.arcee).toEqual(["ARCEEAI_API_KEY"]);
    expect(candidates.openrouter).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("builds the direct Arcee AI model catalog", async () => {
    clearLiveCatalogCacheForTests();
    const release = vi.fn(async () => undefined);
    const fetchGuard = vi
      .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
      .mockImplementation(async ({ url }) => ({
        response: Response.json({
          data: [
            { id: "trinity-mini", object: "model" },
            { id: "trinity-large-preview", object: "model" },
            { id: "trinity-large-thinking", object: "model" },
          ],
        }),
        finalUrl: url,
        release,
      }));
    onTestFinished(() => {
      fetchGuard.mockRestore();
      clearLiveCatalogCacheForTests();
    });
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const catalogProvider = await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: (id?: string) =>
        id === "arcee" ? { apiKey: "test-key" } : { apiKey: undefined },
    });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.arcee.ai/api/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "trinity-large-preview",
      "trinity-large-thinking",
      "trinity-mini",
    ]);
    expect(fetchGuard).toHaveBeenCalledOnce();
    const request = fetchGuard.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://api.arcee.ai/api/v1/models");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(release).toHaveBeenCalledOnce();
    const thinkingCompat = catalogProvider.models?.find(
      (model) => model.id === "trinity-large-thinking",
    )?.compat;
    expect(thinkingCompat?.supportsTools).toBe(false);
    expect(thinkingCompat?.supportsReasoningEffort).toBe(false);
  });

  it("builds the OpenRouter-backed Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const catalogProvider = await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: (id?: string) =>
        id === "openrouter" ? { apiKey: "sk-or-test" } : { apiKey: undefined },
      resolveProviderAuth: () => ({
        apiKey: "sk-or-test",
        mode: "api_key",
        source: "env",
      }),
    });

    expect(catalogProvider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "arcee-ai/trinity-large-preview",
      "arcee-ai/trinity-large-thinking",
    ]);
    const thinkingCompat = catalogProvider.models?.find(
      (model) => model.id === "arcee-ai/trinity-large-thinking",
    )?.compat;
    expect(thinkingCompat?.supportsTools).toBe(false);
    expect(thinkingCompat?.supportsReasoningEffort).toBe(false);
  });

  it("keeps the configured OpenRouter catalog when both credentials exist", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const result = await provider.catalog?.run({
      config: {
        models: { providers: { arcee: { baseUrl: "https://openrouter.ai/api/v1", models: [] } } },
      },
      env: {},
      resolveProviderApiKey: (id) => ({
        apiKey: id === "openrouter" ? "router-account-key" : "direct-account-key",
      }),
      resolveProviderAuth: () => ({
        apiKey: "router-account-key",
        mode: "api_key",
        source: "profile",
      }),
    });
    expect(result).toMatchObject({
      provider: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "router-account-key",
        models: [
          { id: "arcee-ai/trinity-large-preview" },
          { id: "arcee-ai/trinity-large-thinking" },
        ],
      },
    });
  });

  it("normalizes Arcee OpenRouter models to vendor-prefixed runtime ids", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    const openRouterModel = provider.normalizeResolvedModel?.({
      modelId: "arcee/trinity-large-thinking",
      model: {
        provider: "arcee",
        id: "trinity-large-thinking",
        name: "Trinity Large Thinking",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    } as never);
    expect(openRouterModel?.id).toBe("arcee-ai/trinity-large-thinking");

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

    const normalizedConfig = provider.normalizeConfig?.({
      provider: "arcee",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1/",
        models: [],
      },
    } as never);
    expect(normalizedConfig?.baseUrl).toBe("https://openrouter.ai/api/v1");

    const normalizedModel = provider.normalizeResolvedModel?.({
      modelId: "arcee/trinity-large-thinking",
      model: {
        provider: "arcee",
        id: "trinity-large-thinking",
        name: "Trinity Large Thinking",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
      },
    } as never);
    expect(normalizedModel?.id).toBe("arcee-ai/trinity-large-thinking");
    expect(normalizedModel?.baseUrl).toBe("https://openrouter.ai/api/v1");

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

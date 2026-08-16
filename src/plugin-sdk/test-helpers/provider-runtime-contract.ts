// Provider runtime contract helpers define reusable runtime tests for provider plugins.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeModel } from "../plugin-entry.js";
import { registerProviderPlugin, requireRegisteredProvider } from "../plugin-test-runtime.js";
import { buildManifestModelProviderConfig } from "../provider-catalog-shared.js";
import type { ProviderPlugin } from "../provider-model-shared.js";
import { createProviderUsageFetch, makeResponse } from "../test-env.js";

const CONTRACT_SETUP_TIMEOUT_MS = 300_000;

const OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID =
  "../../../extensions/openai/openai-chatgpt-provider.runtime.js";
const refreshOpenAICodexTokenMock = vi.fn();

function installProviderRuntimeContractMocks() {
  vi.doMock(OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID, () => ({
    refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
  }));
}

function removeProviderRuntimeContractMocks() {
  vi.doUnmock(OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID);
}

function createModel(overrides: Partial<ProviderRuntimeModel> & Pick<ProviderRuntimeModel, "id">) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: overrides.api ?? "openai-responses",
    provider: overrides.provider ?? "demo",
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    reasoning: overrides.reasoning ?? true,
    input: overrides.input ?? ["text"],
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 200_000,
    maxTokens: overrides.maxTokens ?? 8_192,
  } satisfies ProviderRuntimeModel;
}

function createManifestModelFactory(providerId: string, catalog: unknown) {
  const provider = buildManifestModelProviderConfig({ providerId, catalog });
  return (modelId: string, overrides: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel => {
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`Missing ${providerId} manifest model ${modelId}`);
    }
    const input = model.input.filter(
      (item): item is "text" | "image" => item === "text" || item === "image",
    );
    if (input.length !== model.input.length) {
      throw new Error(`Unsupported ${providerId} manifest model input for ${modelId}`);
    }
    return createModel({
      ...model,
      id: model.id,
      provider: providerId,
      baseUrl: model.baseUrl ?? provider.baseUrl,
      api: model.api ?? provider.api,
      input,
      ...overrides,
    });
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function expectFields(value: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(value, "record");
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
}

type ProviderRuntimeContractFixture = {
  providerIds: string[];
  pluginId: string;
  name: string;
  load: ProviderRuntimeContractPluginLoader;
};

export type ProviderRuntimeContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
}>;

function installRuntimeHooks(fixtures: readonly ProviderRuntimeContractFixture[]) {
  const providers = new Map<string, ProviderPlugin>();
  let loadPromise: Promise<void> | null = null;

  function requireProviderContractProvider(providerId: string): ProviderPlugin {
    const provider = providers.get(providerId);
    if (!provider) {
      throw new Error(`provider runtime contract fixture missing for ${providerId}`);
    }
    return provider;
  }

  async function ensureProvidersLoaded() {
    if (!loadPromise) {
      loadPromise = (async () => {
        providers.clear();
        const registeredFixtures = await Promise.all(
          fixtures.map(async (fixture) => {
            const plugin = await fixture.load();
            return {
              fixture,
              providers: (
                await registerProviderPlugin({
                  plugin: plugin.default,
                  id: fixture.pluginId,
                  name: fixture.name,
                })
              ).providers,
            };
          }),
        );
        for (const { fixture, providers: registeredProviders } of registeredFixtures) {
          for (const providerId of fixture.providerIds) {
            providers.set(
              providerId,
              requireRegisteredProvider(registeredProviders, providerId, "provider"),
            );
          }
        }
      })();
    }

    await loadPromise;
  }

  beforeAll(async () => {
    installProviderRuntimeContractMocks();
    await ensureProvidersLoaded();
  }, CONTRACT_SETUP_TIMEOUT_MS);

  afterAll(() => {
    removeProviderRuntimeContractMocks();
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
  }, CONTRACT_SETUP_TIMEOUT_MS);

  return requireProviderContractProvider;
}

export function describeAnthropicProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
) {
  describe("anthropic provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const requireProviderContractProvider = installRuntimeHooks([
      { providerIds: ["anthropic"], pluginId: "anthropic", name: "Anthropic", load },
    ]);

    it("owns anthropic 4.6 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("anthropic");
      // The dated 4.6 template has no owning manifest row; keep its remap fixture literal.
      const model = provider.resolveDynamicModel?.({
        provider: "anthropic",
        modelId: "claude-sonnet-4.6-20260219",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "claude-sonnet-4-6-20260219"
              ? createModel({
                  id,
                  api: "anthropic-messages",
                  provider: "anthropic",
                  baseUrl: "https://api.anthropic.com",
                })
              : null,
        } as never,
      });

      expectFields(model, {
        id: "claude-sonnet-4.6-20260219",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      });
    });

    it("owns usage auth resolution", async () => {
      const provider = requireProviderContractProvider("anthropic");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "anthropic",
          resolveApiKeyFromConfigAndStore: () => undefined,
          resolveOAuthToken: async () => ({
            token: "anthropic-oauth-token",
          }),
        }),
      ).resolves.toEqual({
        token: "anthropic-oauth-token",
      });
    });

    it("owns auth doctor hint generation", () => {
      const provider = requireProviderContractProvider("anthropic");
      const hint = provider.buildAuthDoctorHint?.({
        provider: "anthropic",
        profileId: "anthropic:default",
        config: {
          auth: {
            profiles: {
              "anthropic:default": {
                provider: "anthropic",
                mode: "oauth",
              },
            },
          },
        } as never,
        store: {
          version: 1,
          profiles: {
            "anthropic:oauth-user@example.com": {
              type: "oauth",
              provider: "anthropic",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
      });

      expect(hint).toContain("suggested profile: anthropic:oauth-user@example.com");
      expect(hint).toContain("openclaw doctor --yes");
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProviderContractProvider("anthropic");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("api.anthropic.com/api/oauth/usage")) {
          return makeResponse(200, {
            five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
            seven_day: { utilization: 35, resets_at: "2026-01-09T01:00:00Z" },
          });
        }
        return makeResponse(404, "not found");
      });

      await expect(
        provider.fetchUsageSnapshot?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "anthropic",
          token: "anthropic-oauth-token",
          timeoutMs: 5_000,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        provider: "anthropic",
        displayName: "Claude",
        windows: [
          { label: "5h", usedPercent: 20, resetAt: Date.parse("2026-01-07T01:00:00Z") },
          { label: "Week", usedPercent: 35, resetAt: Date.parse("2026-01-09T01:00:00Z") },
        ],
      });
    });
  });
}

export function describeGithubCopilotProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
  manifestCatalog: unknown,
) {
  describe(
    "github-copilot provider runtime contract",
    { timeout: CONTRACT_SETUP_TIMEOUT_MS },
    () => {
      const requireProviderContractProvider = installRuntimeHooks([
        {
          providerIds: ["github-copilot"],
          pluginId: "github-copilot",
          name: "GitHub Copilot",
          load,
        },
      ]);
      const createManifestModel = createManifestModelFactory("github-copilot", manifestCatalog);

      it("owns Copilot-specific forward-compat fallbacks", () => {
        const provider = requireProviderContractProvider("github-copilot");
        const expected = createManifestModel("gpt-5.4");
        const model = provider.resolveDynamicModel?.({
          provider: "github-copilot",
          modelId: "gpt-5.4",
          modelRegistry: {
            find: () => null,
          } as never,
        });

        const { baseUrl: _providerDefault, ...manifestFields } = expected;
        expectFields(model, manifestFields);
      });
    },
  );
}

export function describeGoogleProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader) {
  describe("google provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const requireProviderContractProvider = installRuntimeHooks([
      { providerIds: ["google", "google-gemini-cli"], pluginId: "google", name: "Google", load },
    ]);

    it("owns google direct gemini 3.1 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("google");
      // Google catalog rows are runtime-discovered, so the retired 3.0 template stays literal.
      const model = provider.resolveDynamicModel?.({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gemini-3-pro-preview"
              ? createModel({
                  id,
                  api: "google-generative-ai",
                  provider: "google",
                  baseUrl: "https://generativelanguage.googleapis.com",
                  reasoning: false,
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                })
              : null,
        } as never,
      });

      expectFields(model, {
        id: "gemini-3.1-pro-preview",
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        reasoning: true,
      });
    });

    it("owns gemini cli 3.1 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("google-gemini-cli");
      const model = provider.resolveDynamicModel?.({
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gemini-3-pro-preview"
              ? createModel({
                  id,
                  api: "google-gemini-cli",
                  provider: "google-gemini-cli",
                  baseUrl: "https://cloudcode-pa.googleapis.com",
                  reasoning: false,
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                })
              : null,
        } as never,
      });

      expectFields(model, {
        id: "gemini-3.1-pro-preview",
        provider: "google-gemini-cli",
        reasoning: true,
      });
    });

    it("keeps retired usage telemetry hooks absent", () => {
      const provider = requireProviderContractProvider("google-gemini-cli");

      expect(provider.resolveUsageAuth).toBeUndefined();
      expect(provider.fetchUsageSnapshot).toBeUndefined();
    });

    it("owns OAuth auth-profile formatting", () => {
      const provider = requireProviderContractProvider("google-gemini-cli");

      expect(
        provider.formatApiKey?.({
          type: "oauth",
          provider: "google-gemini-cli",
          access: "google-oauth-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          projectId: "proj-123",
        }),
      ).toBe('{"token":"google-oauth-token","projectId":"proj-123"}');
    });
  });
}

export function describeOpenAIProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
  manifestCatalog: unknown,
) {
  describe("openai provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const createManifestModel = createManifestModelFactory("openai", manifestCatalog);
    const codexProviderConfig = {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as const;
    const requireProviderContractProvider = installRuntimeHooks([
      { providerIds: ["openai", "openai"], pluginId: "openai", name: "OpenAI", load },
    ]);

    it("owns openai gpt-5.4 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("openai");
      // Neither gpt-5.4-pro nor its 5.2 template has an owning manifest row.
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4-pro",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.2-pro"
              ? createModel({
                  id,
                  provider: "openai",
                  baseUrl: "https://api.openai.com/v1",
                  input: ["text", "image"],
                })
              : null,
        } as never,
      });

      expectFields(model, {
        id: "gpt-5.4-pro",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    });

    it("owns openai gpt-5.5 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("openai");
      const expected = createManifestModel("gpt-5.5", { name: "gpt-5.5" });
      // OpenAI has no gpt-5.4 manifest row; distinct literal metadata keeps the upgrade asserted.
      const olderTemplate = createModel({
        id: "gpt-5.4",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        input: ["text", "image"],
      });
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.5",
        modelRegistry: {
          find: (_provider: string, id: string) => (id === olderTemplate.id ? olderTemplate : null),
        } as never,
      });

      expectFields(model, expected);
    });

    it("owns openai gpt-5.4 mini forward-compat resolution", () => {
      const provider = requireProviderContractProvider("openai");
      // The OpenAI manifest has no gpt-5.4-mini row, so its family patch stays literal.
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5-mini"
              ? createModel({
                  id,
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  input: ["text", "image"],
                  reasoning: true,
                  contextWindow: 400_000,
                  maxTokens: 128_000,
                })
              : null,
        } as never,
      });

      expectFields(model, {
        id: "gpt-5.4-mini",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 400_000,
        maxTokens: 128_000,
      });
    });

    it("owns direct openai transport normalization", () => {
      const provider = requireProviderContractProvider("openai");
      // The normalized gpt-5.4 input is intentionally outside the current OpenAI manifest.
      expectFields(
        provider.normalizeResolvedModel?.({
          provider: "openai",
          modelId: "gpt-5.4",
          model: createModel({
            id: "gpt-5.4",
            provider: "openai",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            contextWindow: 1_050_000,
            maxTokens: 128_000,
          }),
        }),
        {
          api: "openai-responses",
        },
      );
    });

    it("owns refresh fallback for accountId extraction failures", async () => {
      const provider = requireProviderContractProvider("openai");
      const credential = {
        type: "oauth" as const,
        provider: "openai",
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };

      refreshOpenAICodexTokenMock.mockRejectedValueOnce(
        new Error("Failed to extract accountId from token"),
      );

      await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
    });

    it("owns forward-compat codex models", () => {
      const provider = requireProviderContractProvider("openai");
      // Codex gpt-5.4 has no OpenAI manifest row; this keeps its transport mapping independent.
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4",
        authProfileMode: "oauth",
        providerConfig: codexProviderConfig,
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "gpt-5.2-codex"
              ? createModel({
                  id,
                  api: "openai-chatgpt-responses",
                  provider: "openai",
                  baseUrl: "https://chatgpt.com/backend-api",
                })
              : null,
        } as never,
      });

      expectFields(model, {
        id: "gpt-5.4",
        provider: "openai",
        api: "openai-chatgpt-responses",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    });

    it("keeps OpenClaw cost metadata but applies Codex context metadata for gpt-5.5 models", () => {
      const provider = requireProviderContractProvider("openai");
      const manifestModel = createManifestModel("gpt-5.5", {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        contextWindow: 272_000,
      });
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.5",
        authProfileMode: "oauth",
        providerConfig: codexProviderConfig,
        modelRegistry: {
          find: (_provider: string, id: string) => (id === "gpt-5.5" ? manifestModel : null),
        } as never,
      });

      expectFields(model, {
        ...manifestModel,
        api: "openai-chatgpt-responses",
        baseUrl: codexProviderConfig.baseUrl,
        contextWindow: 400_000,
      });
    });

    it("claims codex mini models through the Codex OAuth route", () => {
      const provider = requireProviderContractProvider("openai");
      const manifestTemplate = createManifestModel("gpt-5.5", {
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        contextWindow: 272_000,
      });
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        authProfileMode: "oauth",
        providerConfig: codexProviderConfig,
        modelRegistry: {
          find: (_provider: string, id: string) => (id === "gpt-5.4" ? manifestTemplate : null),
        } as never,
      });

      expectFields(model, {
        id: "gpt-5.4-mini",
        provider: "openai",
        api: "openai-chatgpt-responses",
        contextWindow: 400_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
      });
    });

    it("owns codex transport defaults", () => {
      const provider = requireProviderContractProvider("openai");
      expect(
        provider.prepareExtraParams?.({
          provider: "openai",
          modelId: "gpt-5.4",
          model: createModel({
            id: "gpt-5.4",
            provider: "openai",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          }),
          extraParams: { temperature: 0.2 },
        }),
      ).toEqual({
        temperature: 0.2,
        transport: "auto",
      });
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProviderContractProvider("openai");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("chatgpt.com/backend-api/wham/usage")) {
          return makeResponse(200, {
            rate_limit: {
              primary_window: {
                used_percent: 12,
                limit_window_seconds: 10800,
                reset_at: 1_705_000,
              },
            },
            plan_type: "Plus",
          });
        }
        return makeResponse(404, "not found");
      });

      await expect(
        provider.fetchUsageSnapshot?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "openai",
          token: "codex-token",
          accountId: "acc-1",
          timeoutMs: 5_000,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        provider: "openai",
        displayName: "OpenAI",
        windows: [{ label: "3h", usedPercent: 12, resetAt: 1_705_000_000 }],
        plan: "Plus",
      });
    });
  });
}

export function describeOpenRouterProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
) {
  describe("openrouter provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const requireProviderContractProvider = installRuntimeHooks([
      { providerIds: ["openrouter"], pluginId: "openrouter", name: "OpenRouter", load },
    ]);

    it("owns dynamic OpenRouter model defaults", () => {
      const provider = requireProviderContractProvider("openrouter");
      // OpenRouter owns a runtime-discovered catalog, so these synthetic defaults stay literal.
      const model = provider.resolveDynamicModel?.({
        provider: "openrouter",
        modelId: "x-ai/grok-4-1-fast",
        modelRegistry: {
          find: () => null,
        } as never,
      });

      expectFields(model, {
        id: "x-ai/grok-4-1-fast",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        maxTokens: 8192,
      });
    });
  });
}

export function describeVeniceProviderRuntimeContract(
  load: ProviderRuntimeContractPluginLoader,
  manifestCatalog: unknown,
) {
  describe("venice provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const createManifestModel = createManifestModelFactory("venice", manifestCatalog);
    const requireProviderContractProvider = installRuntimeHooks([
      { providerIds: ["venice"], pluginId: "venice", name: "Venice", load },
    ]);

    it("owns xai downstream compat flags for grok-backed Venice models", () => {
      const provider = requireProviderContractProvider("venice");
      const manifestModel = createManifestModel("grok-4-5");
      const model = provider.normalizeResolvedModel?.({
        provider: "venice",
        modelId: manifestModel.id,
        model: manifestModel,
      });
      const { compat: _manifestCompat, ...manifestFields } = manifestModel;
      expectFields(model, manifestFields);
      expect(requireRecord(model?.compat, "compat")).toMatchObject({
        toolSchemaProfile: "xai",
        toolCallArgumentsEncoding: "html-entities",
      });
    });
  });
}

export function describeZAIProviderRuntimeContract(load: ProviderRuntimeContractPluginLoader) {
  describe("zai provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
    const requireProviderContractProvider = installRuntimeHooks([
      { providerIds: ["zai"], pluginId: "zai", name: "Z.AI", load },
    ]);

    it("owns glm-5 forward-compat resolution", () => {
      const provider = requireProviderContractProvider("zai");
      // Neither the synthetic glm-5 id nor its glm-4.7 template has a current manifest row.
      const model = provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: "glm-5",
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "glm-4.7"
              ? createModel({
                  id,
                  api: "openai-completions",
                  provider: "zai",
                  baseUrl: "https://api.z.ai/api/paas/v4",
                  reasoning: false,
                  contextWindow: 202_752,
                  maxTokens: 16_384,
                })
              : null,
        } as never,
      });

      expectFields(model, {
        id: "glm-5",
        provider: "zai",
        api: "openai-completions",
        reasoning: true,
      });
    });

    it("owns Z.AI token-limit overflow classification", () => {
      const provider = requireProviderContractProvider("zai");

      expect(
        provider.matchesContextOverflowError?.({
          errorMessage: "code 1210: tokens in request more than max tokens allowed",
        }),
      ).toBe(true);
      expect(
        provider.matchesContextOverflowError?.({
          errorMessage: "code 1261: Prompt exceeds max length",
        }),
      ).toBe(true);
      expect(
        provider.matchesContextOverflowError?.({
          errorMessage: "code 1210: invalid request parameters",
        }),
      ).toBe(false);
    });

    it("owns usage auth resolution", async () => {
      const provider = requireProviderContractProvider("zai");
      await expect(
        provider.resolveUsageAuth?.({
          config: {} as never,
          env: {
            ZAI_API_KEY: "env-zai-token",
          } as NodeJS.ProcessEnv,
          provider: "zai",
          resolveApiKeyFromConfigAndStore: () => "env-zai-token",
          resolveOAuthToken: async () => null,
        }),
      ).resolves.toEqual({
        token: "env-zai-token",
      });
    });

    it("owns usage snapshot fetching", async () => {
      const provider = requireProviderContractProvider("zai");
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("api.z.ai/api/monitor/usage/quota/limit")) {
          return makeResponse(200, {
            success: true,
            code: 200,
            data: {
              planName: "Pro",
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  percentage: 25,
                  unit: 3,
                  number: 6,
                  nextResetTime: "2026-01-07T06:00:00Z",
                },
              ],
            },
          });
        }
        return makeResponse(404, "not found");
      });

      await expect(
        provider.fetchUsageSnapshot?.({
          config: {} as never,
          env: {} as NodeJS.ProcessEnv,
          provider: "zai",
          token: "env-zai-token",
          timeoutMs: 5_000,
          fetchFn: mockFetch as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        provider: "zai",
        displayName: "z.ai",
        windows: [{ label: "Tokens (6h)", usedPercent: 25, resetAt: 1_767_765_600_000 }],
        plan: "Pro",
      });
    });
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

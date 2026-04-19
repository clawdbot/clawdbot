import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../../src/agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  resolveBundledPluginPublicModulePath,
  resolveRelativeBundledPluginPublicModuleId,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { registerProviders, requireProvider } from "./contracts-testkit.js";

const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());
const buildVllmProviderMock = vi.hoisted(() => vi.fn());
const buildSglangProviderMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
const bundledProviderModules = {
  cloudflareAiGatewayIndexModuleUrl: resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "cloudflare-ai-gateway",
    artifactBasename: "index.js",
  }),
  githubCopilotIndexModuleUrl: resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "github-copilot",
    artifactBasename: "index.js",
  }),
  githubCopilotRegisterRuntimeModuleId: resolveBundledPluginPublicModulePath({
    pluginId: "github-copilot",
    artifactBasename: "register.runtime.js",
  }),
  minimaxIndexModuleUrl: resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "minimax",
    artifactBasename: "index.js",
  }),
  qwenIndexModuleUrl: resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "qwen",
    artifactBasename: "index.js",
  }),
  sglangApiModuleId: resolveBundledPluginPublicModulePath({
    pluginId: "sglang",
    artifactBasename: "api.js",
  }),
  sglangIndexModuleUrl: resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "sglang",
    artifactBasename: "index.js",
  }),
  vllmApiModuleId: resolveBundledPluginPublicModulePath({
    pluginId: "vllm",
    artifactBasename: "api.js",
  }),
  vllmIndexModuleUrl: resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "vllm",
    artifactBasename: "index.js",
  }),
};

type ProviderHandle = Awaited<ReturnType<typeof requireProvider>>;

type DiscoveryState = {
  runProviderCatalog: typeof import("../../../src/plugins/provider-discovery.js").runProviderCatalog;
  githubCopilotProvider?: ProviderHandle;
  vllmProvider?: ProviderHandle;
  sglangProvider?: ProviderHandle;
  minimaxProvider?: ProviderHandle;
  minimaxPortalProvider?: ProviderHandle;
  modelStudioProvider?: ProviderHandle;
  cloudflareAiGatewayProvider?: ProviderHandle;
};

type BundledProviderUnderTest =
  | "github-copilot"
  | "vllm"
  | "sglang"
  | "minimax"
  | "modelstudio"
  | "cloudflare-ai-gateway";

function setRuntimeAuthStore(store?: AuthProfileStore) {
  const resolvedStore = store ?? {
    version: 1,
    profiles: {},
  };
  ensureAuthProfileStoreMock.mockReturnValue(resolvedStore);
  listProfilesForProviderMock.mockImplementation(
    (authStore: AuthProfileStore, providerId: string) =>
      Object.entries(authStore.profiles)
        .filter(([, credential]) => credential.provider === providerId)
        .map(([profileId]) => profileId),
  );
}

function setGithubCopilotProfileSnapshot() {
  setRuntimeAuthStore({
    version: 1,
    profiles: {
      "github-copilot:github": {
        type: "token",
        provider: "github-copilot",
        token: "profile-token",
      },
    },
  });
}

function runCatalog(
  state: DiscoveryState,
  params: {
    provider: ProviderHandle;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    resolveProviderApiKey?: () => { apiKey: string | undefined };
    resolveProviderAuth?: (
      providerId?: string,
      options?: { oauthMarker?: string },
    ) => {
      apiKey: string | undefined;
      discoveryApiKey?: string;
      mode: "api_key" | "oauth" | "token" | "none";
      source: "env" | "profile" | "none";
      profileId?: string;
    };
  },
) {
  return state.runProviderCatalog({
    provider: params.provider,
    config: params.config ?? {},
    env: params.env ?? ({} as NodeJS.ProcessEnv),
    resolveProviderApiKey: params.resolveProviderApiKey ?? (() => ({ apiKey: undefined })),
    resolveProviderAuth:
      params.resolveProviderAuth ??
      ((_, options) => ({
        apiKey: options?.oauthMarker,
        discoveryApiKey: undefined,
        mode: options?.oauthMarker ? "oauth" : "none",
        source: options?.oauthMarker ? "profile" : "none",
      })),
  });
}

async function importBundledProviderPlugin<T>(moduleUrl: string): Promise<T> {
  return (await import(moduleUrl)) as T;
}

function installDiscoveryHooks(
  state: DiscoveryState,
  providerIds: readonly BundledProviderUnderTest[],
) {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("openclaw/plugin-sdk/agent-runtime", () => {
      return {
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
      };
    });
    vi.doMock("openclaw/plugin-sdk/provider-auth", () => {
      return {
        MINIMAX_OAUTH_MARKER: "minimax-oauth",
        applyAuthProfileConfig: (config: OpenClawConfig) => config,
        buildApiKeyCredential: (
          provider: string,
          key: unknown,
          metadata?: Record<string, unknown>,
        ) => ({
          type: "api_key",
          provider,
          ...(typeof key === "string" ? { key } : {}),
          ...(metadata ? { metadata } : {}),
        }),
        buildOauthProviderAuthResult: vi.fn(),
        coerceSecretRef: (value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null,
        ensureApiKeyFromOptionEnvOrPrompt: vi.fn(),
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
        normalizeApiKeyInput: (value: unknown) => (typeof value === "string" ? value.trim() : ""),
        normalizeOptionalSecretInput: (value: unknown) =>
          typeof value === "string" && value.trim() ? value.trim() : undefined,
        resolveNonEnvSecretRefApiKeyMarker: (source: unknown) =>
          typeof source === "string" ? source : "",
        upsertAuthProfile: vi.fn(),
        validateApiKeyInput: () => undefined,
      };
    });
    vi.doMock(bundledProviderModules.githubCopilotRegisterRuntimeModuleId, async () => {
      const actual = await vi.importActual<object>(
        bundledProviderModules.githubCopilotRegisterRuntimeModuleId,
      );
      return {
        ...actual,
        resolveCopilotApiToken: resolveCopilotApiTokenMock,
      };
    });
    vi.doMock(bundledProviderModules.vllmApiModuleId, async () => {
      return {
        VLLM_DEFAULT_API_KEY_ENV_VAR: "VLLM_API_KEY",
        VLLM_DEFAULT_BASE_URL: "http://127.0.0.1:8000/v1",
        VLLM_MODEL_PLACEHOLDER: "meta-llama/Meta-Llama-3-8B-Instruct",
        VLLM_PROVIDER_LABEL: "vLLM",
        buildVllmProvider: (...args: unknown[]) => buildVllmProviderMock(...args),
      };
    });
    vi.doMock(bundledProviderModules.sglangApiModuleId, async () => {
      return {
        SGLANG_DEFAULT_API_KEY_ENV_VAR: "SGLANG_API_KEY",
        SGLANG_DEFAULT_BASE_URL: "http://127.0.0.1:30000/v1",
        SGLANG_MODEL_PLACEHOLDER: "Qwen/Qwen3-8B",
        SGLANG_PROVIDER_LABEL: "SGLang",
        buildSglangProvider: (...args: unknown[]) => buildSglangProviderMock(...args),
      };
    });
    ({ runProviderCatalog: state.runProviderCatalog } =
      await import("../../../src/plugins/provider-discovery.js"));

    if (providerIds.includes("github-copilot")) {
      const { default: githubCopilotPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.githubCopilotIndexModuleUrl);
      state.githubCopilotProvider = requireProvider(
        await registerProviders(githubCopilotPlugin),
        "github-copilot",
      );
    }

    if (providerIds.includes("vllm")) {
      const { default: vllmPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.vllmIndexModuleUrl);
      state.vllmProvider = requireProvider(await registerProviders(vllmPlugin), "vllm");
    }

    if (providerIds.includes("sglang")) {
      const { default: sglangPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.sglangIndexModuleUrl);
      state.sglangProvider = requireProvider(await registerProviders(sglangPlugin), "sglang");
    }

    if (providerIds.includes("minimax")) {
      const { default: minimaxPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.minimaxIndexModuleUrl);
      const registeredProviders = await registerProviders(minimaxPlugin);
      state.minimaxProvider = requireProvider(registeredProviders, "minimax");
      state.minimaxPortalProvider = requireProvider(registeredProviders, "minimax-portal");
    }

    if (providerIds.includes("modelstudio")) {
      const { default: qwenPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.qwenIndexModuleUrl);
      state.modelStudioProvider = requireProvider(await registerProviders(qwenPlugin), "qwen");
    }

    if (providerIds.includes("cloudflare-ai-gateway")) {
      const { default: cloudflareAiGatewayPlugin } = await importBundledProviderPlugin<{
        default: Parameters<typeof registerProviders>[0];
      }>(bundledProviderModules.cloudflareAiGatewayIndexModuleUrl);
      state.cloudflareAiGatewayProvider = requireProvider(
        await registerProviders(cloudflareAiGatewayPlugin),
        "cloudflare-ai-gateway",
      );
    }
  });

  beforeEach(() => {
    setRuntimeAuthStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolveCopilotApiTokenMock.mockReset();
    buildVllmProviderMock.mockReset();
    buildSglangProviderMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    setRuntimeAuthStore();
  });
}

export function describeGithubCopilotProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("github-copilot provider discovery contract", () => {
    installDiscoveryHooks(state, ["github-copilot"]);

    it("keeps catalog disabled without env tokens or profiles", async () => {
      await expect(
        runCatalog(state, { provider: state.githubCopilotProvider! }),
      ).resolves.toBeNull();
    });

    it("keeps profile-only catalog fallback provider-owned", async () => {
      setGithubCopilotProfileSnapshot();

      await expect(
        runCatalog(state, {
          provider: state.githubCopilotProvider!,
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "https://api.individual.githubcopilot.com",
          models: [],
        },
      });
    });

    it("keeps env-token base URL resolution provider-owned", async () => {
      resolveCopilotApiTokenMock.mockResolvedValueOnce({
        token: "copilot-api-token",
        baseUrl: "https://copilot-proxy.example.com",
        expiresAt: Date.now() + 60_000,
      });

      await expect(
        runCatalog(state, {
          provider: state.githubCopilotProvider!,
          env: {
            GITHUB_TOKEN: "github-env-token",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "https://copilot-proxy.example.com",
          models: [],
        },
      });
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith({
        githubToken: "github-env-token",
        env: expect.objectContaining({
          GITHUB_TOKEN: "github-env-token",
        }),
      });
    });
  });
}

export function describeVllmProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("vllm provider discovery contract", () => {
    installDiscoveryHooks(state, ["vllm"]);

    it("keeps self-hosted discovery provider-owned", async () => {
      buildVllmProviderMock.mockResolvedValueOnce({
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
      });

      await expect(
        runCatalog(state, {
          provider: state.vllmProvider!,
          config: {},
          env: {
            VLLM_API_KEY: "env-vllm-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "VLLM_API_KEY",
            discoveryApiKey: "env-vllm-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "http://127.0.0.1:8000/v1",
          api: "openai-completions",
          apiKey: "VLLM_API_KEY",
          models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
        },
      });
      expect(buildVllmProviderMock).toHaveBeenCalledWith({
        apiKey: "env-vllm-key",
      });
    });
  });
}

export function describeSglangProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("sglang provider discovery contract", () => {
    installDiscoveryHooks(state, ["sglang"]);

    it("keeps self-hosted discovery provider-owned", async () => {
      buildSglangProviderMock.mockResolvedValueOnce({
        baseUrl: "http://127.0.0.1:30000/v1",
        api: "openai-completions",
        models: [{ id: "Qwen/Qwen3-8B", name: "Qwen3-8B" }],
      });

      await expect(
        runCatalog(state, {
          provider: state.sglangProvider!,
          config: {},
          env: {
            SGLANG_API_KEY: "env-sglang-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
          }),
          resolveProviderAuth: () => ({
            apiKey: "SGLANG_API_KEY",
            discoveryApiKey: "env-sglang-key",
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "http://127.0.0.1:30000/v1",
          api: "openai-completions",
          apiKey: "SGLANG_API_KEY",
          models: [{ id: "Qwen/Qwen3-8B", name: "Qwen3-8B" }],
        },
      });
      expect(buildSglangProviderMock).toHaveBeenCalledWith({
        apiKey: "env-sglang-key",
      });
    });
  });
}

export function describeMinimaxProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("minimax provider discovery contract", () => {
    installDiscoveryHooks(state, ["minimax"]);

    it("keeps API catalog provider-owned", async () => {
      await expect(
        state.runProviderCatalog({
          provider: state.minimaxProvider!,
          config: {},
          env: {
            MINIMAX_API_KEY: "minimax-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: "minimax-key" }),
          resolveProviderAuth: () => ({
            apiKey: "minimax-key",
            discoveryApiKey: undefined,
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toMatchObject({
        provider: {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages",
          authHeader: true,
          apiKey: "minimax-key",
          models: expect.arrayContaining([
            expect.objectContaining({ id: "MiniMax-M2.7" }),
            expect.objectContaining({ id: "MiniMax-M2.7-highspeed" }),
          ]),
        },
      });
    });

    it("keeps portal oauth marker fallback provider-owned", async () => {
      setRuntimeAuthStore({
        version: 1,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      });

      await expect(
        runCatalog(state, {
          provider: state.minimaxPortalProvider!,
          config: {},
          env: {} as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({
            apiKey: "minimax-oauth",
            discoveryApiKey: "access-token",
            mode: "oauth",
            source: "profile",
            profileId: "minimax-portal:default",
          }),
        }),
      ).resolves.toMatchObject({
        provider: {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages",
          authHeader: true,
          apiKey: "minimax-oauth",
          models: expect.arrayContaining([expect.objectContaining({ id: "MiniMax-M2.7" })]),
        },
      });
    });

    it("keeps portal explicit base URL override provider-owned", async () => {
      await expect(
        state.runProviderCatalog({
          provider: state.minimaxPortalProvider!,
          config: {
            models: {
              providers: {
                "minimax-portal": {
                  baseUrl: "https://portal-proxy.example.com/anthropic",
                  apiKey: "explicit-key",
                  models: [],
                },
              },
            },
          },
          env: {} as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({
            apiKey: undefined,
            discoveryApiKey: undefined,
            mode: "none",
            source: "none",
          }),
        }),
      ).resolves.toMatchObject({
        provider: {
          baseUrl: "https://portal-proxy.example.com/anthropic",
          apiKey: "explicit-key",
        },
      });
    });
  });
}

export function describeModelStudioProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("modelstudio provider discovery contract", () => {
    installDiscoveryHooks(state, ["modelstudio"]);

    it("keeps catalog provider-owned", async () => {
      await expect(
        state.runProviderCatalog({
          provider: state.modelStudioProvider!,
          config: {
            models: {
              providers: {
                modelstudio: {
                  baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
                  models: [],
                },
              },
            },
          },
          env: {
            MODELSTUDIO_API_KEY: "modelstudio-key",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: "modelstudio-key" }),
          resolveProviderAuth: () => ({
            apiKey: "modelstudio-key",
            discoveryApiKey: undefined,
            mode: "api_key",
            source: "env",
          }),
        }),
      ).resolves.toMatchObject({
        provider: {
          baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
          api: "openai-completions",
          apiKey: "modelstudio-key",
          models: expect.arrayContaining([
            expect.objectContaining({ id: "qwen3.5-plus" }),
            expect.objectContaining({ id: "qwen3-max-2026-01-23" }),
            expect.objectContaining({ id: "MiniMax-M2.5" }),
          ]),
        },
      });
    });
  });
}

export function describeCloudflareAiGatewayProviderDiscoveryContract() {
  const state = {} as DiscoveryState;

  describe("cloudflare-ai-gateway provider discovery contract", () => {
    installDiscoveryHooks(state, ["cloudflare-ai-gateway"]);

    it("keeps catalog disabled without stored metadata", async () => {
      await expect(
        runCatalog(state, {
          provider: state.cloudflareAiGatewayProvider!,
          config: {},
          env: {} as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({
            apiKey: undefined,
            discoveryApiKey: undefined,
            mode: "none",
            source: "none",
          }),
        }),
      ).resolves.toBeNull();
    });

    it("keeps env-managed catalog provider-owned", async () => {
      setRuntimeAuthStore({
        version: 1,
        profiles: {
          "cloudflare-ai-gateway:default": {
            type: "api_key",
            provider: "cloudflare-ai-gateway",
            keyRef: {
              source: "env",
              provider: "default",
              id: "CLOUDFLARE_AI_GATEWAY_API_KEY",
            },
            metadata: {
              accountId: "acc-123",
              gatewayId: "gw-456",
            },
          },
        },
      });

      await expect(
        runCatalog(state, {
          provider: state.cloudflareAiGatewayProvider!,
          config: {},
          env: {
            CLOUDFLARE_AI_GATEWAY_API_KEY: "secret-value",
          } as NodeJS.ProcessEnv,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({
            apiKey: undefined,
            discoveryApiKey: undefined,
            mode: "none",
            source: "none",
          }),
        }),
      ).resolves.toEqual({
        provider: {
          baseUrl: "https://gateway.ai.cloudflare.com/v1/acc-123/gw-456/anthropic",
          api: "anthropic-messages",
          apiKey: "CLOUDFLARE_AI_GATEWAY_API_KEY",
          models: [expect.objectContaining({ id: "claude-sonnet-4-5" })],
        },
      });
    });
  });
}

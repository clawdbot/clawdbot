// Github Copilot tests cover index plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { MAX_DATE_TIMESTAMP_MS, MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  ProviderAuthResult,
  ProviderCatalogResult,
  UnifiedModelCatalogEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  runGitHubCopilotDeviceFlow,
  setGitHubCopilotDeviceFlowFetchGuardForTesting,
} from "./login.js";

const mocks = vi.hoisted(() => ({
  githubCopilotLoginCommand: vi.fn(),
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init?: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: vi.fn(async () => {}),
  })),
  resolveCopilotApiToken: vi.fn(),
  configureCopilotTokenCacheStore: vi.fn<(openStore: () => unknown) => void>(),
}));

function requireAuthMethod<T>(methods: readonly T[], index: number): T {
  return expectDefined(methods[index], `GitHub Copilot auth method ${index}`);
}

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: mocks.resolveCopilotApiToken,
  githubCopilotLoginCommand: mocks.githubCopilotLoginCommand,
  fetchCopilotUsage: vi.fn(),
}));

vi.mock("./token.js", () => ({
  configureCopilotTokenCacheStore: mocks.configureCopilotTokenCacheStore,
}));

import plugin from "./index.js";

const tempDirs: string[] = [];
type RegisteredMemoryEmbeddingProvider = Parameters<
  OpenClawPluginApi["registerMemoryEmbeddingProvider"]
>[0];
type RegisteredProvider = Parameters<OpenClawPluginApi["registerProvider"]>[0];
type GithubCopilotTestProvider = RegisteredProvider & {
  auth: Array<{
    run: (ctx: unknown) => Promise<ProviderAuthResult | null>;
    runNonInteractive: (ctx: unknown) => Promise<OpenClawConfig | null>;
  }>;
  catalog: {
    run: (ctx: unknown) => Promise<ProviderCatalogResult>;
  };
  prepareDynamicModel: NonNullable<RegisteredProvider["prepareDynamicModel"]>;
  resolveDynamicModel: NonNullable<RegisteredProvider["resolveDynamicModel"]>;
  preferRuntimeResolvedModel: NonNullable<RegisteredProvider["preferRuntimeResolvedModel"]>;
  resolveThinkingProfile: NonNullable<RegisteredProvider["resolveThinkingProfile"]>;
};
type GithubCopilotTestModelCatalogProvider = {
  liveCatalog: (ctx: unknown) => Promise<readonly UnifiedModelCatalogEntry[] | null | undefined>;
};

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  setGitHubCopilotDeviceFlowFetchGuardForTesting(null);
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

async function createAgentDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-copilot-test-"));
  tempDirs.push(dir);
  return dir;
}

function createModelRegistry() {
  return {
    getAll: vi.fn(() => []),
    getAvailable: vi.fn(() => []),
    find: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn(() => false),
  };
}

function writeExistingCopilotTokenProfile(agentDir: string) {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "github-copilot:github": {
          type: "token",
          provider: "github-copilot",
          token: "existing-token",
        },
      },
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );
}

function requireFirstMockArg<T>(
  mock: { mock: { calls: Array<[T, ...unknown[]]> } },
  label: string,
) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[0];
}

function registerProviderAndCatalogWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn<OpenClawPluginApi["registerProvider"]>();
  const registerModelCatalogProviderMock =
    vi.fn<OpenClawPluginApi["registerModelCatalogProvider"]>();

  plugin.register(
    createTestPluginApi({
      id: "github-copilot",
      name: "GitHub Copilot",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerProvider: registerProviderMock,
      registerModelCatalogProvider: registerModelCatalogProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  expect(registerModelCatalogProviderMock).toHaveBeenCalledTimes(1);
  return {
    provider: requireFirstMockArg(
      registerProviderMock,
      "provider registration",
    ) as GithubCopilotTestProvider,
    modelCatalogProvider: requireFirstMockArg(
      registerModelCatalogProviderMock,
      "model catalog provider registration",
    ) as GithubCopilotTestModelCatalogProvider,
  };
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  return registerProviderAndCatalogWithPluginConfig(pluginConfig).provider;
}

describe("github-copilot plugin", () => {
  it("binds a lazy provider-scoped token store", () => {
    const store = {};
    const openSyncKeyedStore = vi.fn(() => store);
    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        runtime: { state: { openSyncKeyedStore } } as never,
      }),
    );

    const openStore = requireFirstMockArg<() => unknown>(
      mocks.configureCopilotTokenCacheStore,
      "token cache store binding",
    );
    expect(openSyncKeyedStore).not.toHaveBeenCalled();
    expect(openStore()).toBe(store);
    expect(openStore()).toBe(store);
    expect(openSyncKeyedStore).toHaveBeenCalledOnce();
    expect(openSyncKeyedStore).toHaveBeenCalledWith({
      namespace: "token",
      maxEntries: 8,
      overflowPolicy: "evict-oldest",
    });
  });

  it("owns Claude replay thinking cleanup", () => {
    const provider = registerProviderWithPluginConfig({});
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", thinkingSignature: "sig" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "visible" },
        ],
      },
    ];

    expect(provider.buildReplayPolicy?.({ modelId: "claude-haiku-4.5" } as never)).toEqual({
      dropThinkingBlocks: true,
    });
    expect(
      provider.sanitizeReplayHistory?.({
        modelId: "claude-haiku-4.5",
        messages,
      } as never),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }],
      },
    ]);
    expect(
      provider.sanitizeReplayHistory?.({
        modelId: "gpt-5.4",
        messages,
      } as never),
    ).toBe(messages);
  });

  it("registers embedding provider", () => {
    const registerMemoryEmbeddingProviderMock =
      vi.fn<OpenClawPluginApi["registerMemoryEmbeddingProvider"]>();

    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider: vi.fn(),
        registerMemoryEmbeddingProvider: registerMemoryEmbeddingProviderMock,
      }),
    );

    expect(registerMemoryEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    const adapter = requireFirstMockArg<RegisteredMemoryEmbeddingProvider>(
      registerMemoryEmbeddingProviderMock,
      "memory embedding provider registration",
    );
    expect(adapter.id).toBe("github-copilot");
  });

  it("skips catalog discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(result).toBeNull();
    expect(mocks.resolveCopilotApiToken).not.toHaveBeenCalled();
  });

  it("exposes xhigh thinking for catalog-supported Copilot reasoning efforts", () => {
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "claude-opus-4.7-1m-internal",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    });

    expect(profile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("exposes max thinking for catalog-supported Copilot reasoning efforts", () => {
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "claude-fable-5",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
    });

    expect(profile?.levels.map((level) => level.id)).toContain("max");
  });

  it("does not expose max for non-adaptive Claude Copilot models", () => {
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "claude-opus-4-5",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
    });

    expect(profile?.levels.map((level) => level.id)).not.toContain("max");
  });

  it("exposes xhigh thinking for non-Claude Copilot models with catalog xhigh effort", () => {
    // Regression for #59416: mini-family models (e.g. gpt-5.4-mini) are
    // entitled to xhigh per live /models, but the static xhigh allowlist only
    // contains gpt-5.4 and gpt-5.3-codex. When live metadata wins, the
    // resolved compat must drive xhigh for these non-Claude ids as well.
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "gpt-5.4-mini",
      compat: { supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
    });

    expect(profile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("omits xhigh for non-Claude Copilot models whose catalog effort lacks it", () => {
    // Negative half of the #59416 regression: live-first must not over-grant.
    // gpt-5-mini reports only [low, medium, high] live, so xhigh must stay off
    // even though the reporter asked for the whole mini family to gain it.
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "gpt-5-mini",
      compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
    });

    expect(profile?.levels.map((level) => level.id)).not.toContain("xhigh");
  });

  it("uses live plugin config to re-enable discovery after startup disable", async () => {
    mocks.resolveCopilotApiToken.mockResolvedValueOnce({
      token: "copilot_api_token",
      baseUrl: "https://api.githubcopilot.live",
    });
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: true },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(mocks.resolveCopilotApiToken).toHaveBeenCalledWith({
      githubToken: "gh_test_token",
      env: { GH_TOKEN: "gh_test_token" },
      githubDomain: "github.com",
    });
    expect(result).toEqual({
      provider: {
        baseUrl: "https://api.githubcopilot.live",
        models: [],
      },
    });
  });

  it("dual-publishes unified live catalog rows with existing discovery semantics", async () => {
    mocks.resolveCopilotApiToken.mockResolvedValueOnce({
      token: "copilot_api_token",
      baseUrl: "https://api.githubcopilot.live",
    });
    const { modelCatalogProvider } = registerProviderAndCatalogWithPluginConfig({
      discovery: { enabled: false },
    });

    const result = await modelCatalogProvider.liveCatalog({
      config: {
        plugins: {
          entries: {
            "github-copilot": {
              config: {
                discovery: { enabled: true },
              },
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
      resolveProviderAuth: () => ({
        apiKey: "gh_test_token",
        mode: "token",
        source: "env",
      }),
    } as never);

    expect(mocks.resolveCopilotApiToken).toHaveBeenCalledWith({
      githubToken: "gh_test_token",
      env: { GH_TOKEN: "gh_test_token" },
      githubDomain: "github.com",
    });
    expect(result).toEqual([]);
  });

  it("offers to reuse an existing token profile during interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const prompter = {
      confirm: vi.fn(async () => false),
      note: vi.fn(),
    };

    const result = await method.run({
      config: {},
      env: {},
      agentDir,
      workspaceDir: "/tmp/workspace",
      prompter,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      opts: {},
      secretInputMode: "plaintext",
      allowSecretRefPrompt: false,
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as never);

    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "GitHub Copilot auth already exists. Re-run login?",
      initialValue: false,
    });
    expect(mocks.githubCopilotLoginCommand).not.toHaveBeenCalled();
    expect(result).toEqual({
      profiles: [
        {
          profileId: "github-copilot:github",
          credential: {
            type: "token",
            provider: "github-copilot",
            token: "existing-token",
          },
        },
      ],
      defaultModel: "github-copilot/claude-opus-4.7",
    });
  });

  describe("github-copilot dynamic model resolution", () => {
    it("uses live catalog metadata for request-time model resolution", async () => {
      const agentDir = await createAgentDir();
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "github-copilot:first": {
              type: "token",
              provider: "github-copilot",
              token: "first",
            },
            "github-copilot:selected": {
              type: "token",
              provider: "github-copilot",
              token: "chosen",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      mocks.resolveCopilotApiToken
        .mockResolvedValueOnce({
          token: "alpha",
          baseUrl: "https://api.githubcopilot.live",
        })
        .mockResolvedValueOnce({
          token: "beta",
          baseUrl: "https://api.githubcopilot.first",
        });
      const catalogResponse = (contextWindow: number, promptTokens: number) =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                object: "model",
                vendor: "OpenAI",
                capabilities: {
                  type: "chat",
                  limits: {
                    max_context_window_tokens: contextWindow,
                    max_prompt_tokens: promptTokens,
                    max_output_tokens: 128_000,
                  },
                  supports: {
                    vision: true,
                    reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000))
          .mockResolvedValueOnce(catalogResponse(400_000, 272_000)),
      );
      const provider = registerProviderWithPluginConfig({});
      const modelRegistry = createModelRegistry();
      const selectedContext = {
        config: {},
        agentDir,
        provider: "github-copilot",
        modelId: "gpt-5.6-sol",
        modelRegistry,
        authProfileId: "github-copilot:selected",
      } as Parameters<typeof provider.prepareDynamicModel>[0];
      const firstContext = {
        ...selectedContext,
        authProfileId: "github-copilot:first",
      };

      await provider.prepareDynamicModel(selectedContext);
      await provider.prepareDynamicModel(firstContext);

      expect(mocks.resolveCopilotApiToken).toHaveBeenNthCalledWith(1, {
        githubToken: "chosen",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(mocks.resolveCopilotApiToken).toHaveBeenNthCalledWith(2, {
        githubToken: "first",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(provider.preferRuntimeResolvedModel(selectedContext)).toBe(true);
      expect(provider.resolveDynamicModel(selectedContext)).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.live",
        contextWindow: 1_050_000,
        contextTokens: 922_000,
        maxTokens: 128_000,
      });
      expect(provider.resolveDynamicModel(firstContext)).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.first",
        contextWindow: 400_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
      });
    });

    it("rematerializes direct-config metadata after a profile fallback", async () => {
      const agentDir = await createAgentDir();
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "github-copilot:first": {
              type: "token",
              provider: "github-copilot",
              token: "test-auth-token",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      mocks.resolveCopilotApiToken
        .mockResolvedValueOnce({
          token: "test-auth-token",
          baseUrl: "https://api.githubcopilot.profile",
        })
        .mockResolvedValueOnce({
          token: "test-token-placeholder",
          baseUrl: "https://api.githubcopilot.direct",
        });
      const catalogResponse = (contextWindow: number, promptTokens: number) =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                object: "model",
                vendor: "OpenAI",
                capabilities: {
                  type: "chat",
                  limits: {
                    max_context_window_tokens: contextWindow,
                    max_prompt_tokens: promptTokens,
                    max_output_tokens: 128_000,
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(catalogResponse(200_000, 150_000))
          .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000)),
      );
      const provider = registerProviderWithPluginConfig({});
      const modelRegistry = createModelRegistry();
      const config = {
        models: {
          providers: {
            "github-copilot": {
              apiKey: "test-token-placeholder",
              baseUrl: "https://api.githubcopilot.test",
              models: [],
            },
          },
        },
      } as OpenClawConfig;
      const profileContext = {
        config,
        agentDir,
        provider: "github-copilot",
        modelId: "gpt-5.6-sol",
        modelRegistry,
        authProfileId: "github-copilot:first",
      } as Parameters<typeof provider.prepareDynamicModel>[0];
      const directContext = {
        ...profileContext,
        authProfileId: undefined,
        authProfileMode: "api_key" as const,
      };

      // The first profile's credential can fail later during runtime auth. The
      // prepared direct fallback must then replace its account-scoped limits.
      await provider.prepareDynamicModel(profileContext);
      await provider.prepareDynamicModel(directContext);

      expect(mocks.resolveCopilotApiToken).toHaveBeenNthCalledWith(1, {
        githubToken: "test-auth-token",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(mocks.resolveCopilotApiToken).toHaveBeenNthCalledWith(2, {
        githubToken: "test-token-placeholder",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(provider.resolveDynamicModel(profileContext)).toMatchObject({
        baseUrl: "https://api.githubcopilot.profile",
        contextWindow: 200_000,
        contextTokens: 150_000,
      });
      expect(provider.resolveDynamicModel(directContext)).toMatchObject({
        baseUrl: "https://api.githubcopilot.direct",
        contextWindow: 1_050_000,
        contextTokens: 922_000,
      });
    });
  });

  it("can refresh an existing token profile during interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : String(input);
      if (target === "https://github.com/login/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "device-code-stub",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (target === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({ access_token: "refreshed-token", token_type: "bearer" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch in github-copilot refresh test: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async (params) => ({
      response: await fetchMock(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }));
    const prompter = {
      confirm: vi.fn(async () => true),
      note: vi.fn(),
    };
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      const result = await method.run({
        config: {},
        env: {},
        agentDir,
        workspaceDir: "/tmp/workspace",
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        opts: {},
        secretInputMode: "plaintext",
        allowSecretRefPrompt: false,
        isRemote: false,
        openUrl: vi.fn(),
        oauth: { createVpsAwareHandlers: vi.fn() },
      } as never);

      expect(prompter.confirm).toHaveBeenCalledWith({
        message: "GitHub Copilot auth already exists. Re-run login?",
        initialValue: false,
      });
      expect(mocks.githubCopilotLoginCommand).not.toHaveBeenCalled();
      if (!result) {
        throw new Error("Expected GitHub Copilot auth result");
      }
      expect(result.profiles[0]?.credential).toEqual({
        type: "token",
        provider: "github-copilot",
        token: "refreshed-token",
      });
    } finally {
      vi.unstubAllGlobals();
      if (isTtyDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  function buildDeviceFlowFetchMock(domain: string, accessToken: string) {
    return vi.fn(async (input: unknown, _init?: RequestInit) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : String(input);
      if (target === `https://${domain}/login/device/code`) {
        return new Response(
          JSON.stringify({
            device_code: "device-code-stub",
            user_code: "ABCD-1234",
            verification_uri: `https://${domain}/login/device`,
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (target === `https://${domain}/login/oauth/access_token`) {
        return new Response(JSON.stringify({ access_token: accessToken, token_type: "bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch in github-copilot device flow test: ${target}`);
    });
  }

  async function withTty<T>(fn: () => Promise<T>): Promise<T> {
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    try {
      return await fn();
    } finally {
      vi.unstubAllGlobals();
      if (isTtyDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  }

  it("forces re-login and clears the domain when switching from a tenant back to github.com", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const fetchMock = buildDeviceFlowFetchMock("github.com", "public-fresh-token");
    vi.stubGlobal("fetch", fetchMock);
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async (params) => ({
      response: await fetchMock(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }));
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => ""),
      note: vi.fn(),
    };

    const result = await withTty(
      async () =>
        await method.run({
          config: {
            models: {
              providers: { "github-copilot": { params: { githubDomain: "acme.ghe.com" } } },
            },
          },
          env: {},
          agentDir,
          workspaceDir: "/tmp/workspace",
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          opts: {},
          secretInputMode: "plaintext",
          allowSecretRefPrompt: false,
          isRemote: false,
          openUrl: vi.fn(),
          oauth: { createVpsAwareHandlers: vi.fn() },
        } as never),
    );
    if (!result) {
      throw new Error("Expected GitHub Copilot auth result");
    }

    // Domain switch must not offer to reuse the tenant-scoped token.
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalled();
    expect(result.profiles[0]?.credential).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "public-fresh-token",
    });
    const params = (
      result.configPatch as {
        models?: { providers?: Record<string, { params?: Record<string, unknown> }> };
      }
    )?.models?.providers?.["github-copilot"]?.params;
    expect(params && Object.hasOwn(params, "githubDomain")).toBe(true);
    expect(params?.githubDomain).toBeUndefined();
  });

  it("forces re-login when switching from github.com to a tenant domain", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 1);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const fetchMock = buildDeviceFlowFetchMock("acme.ghe.com", "tenant-fresh-token");
    vi.stubGlobal("fetch", fetchMock);
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async (params) => ({
      response: await fetchMock(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }));
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => "acme.ghe.com"),
      note: vi.fn(),
    };

    const result = await withTty(
      async () =>
        await method.run({
          config: {},
          env: {},
          agentDir,
          workspaceDir: "/tmp/workspace",
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          opts: {},
          secretInputMode: "plaintext",
          allowSecretRefPrompt: false,
          isRemote: false,
          openUrl: vi.fn(),
          oauth: { createVpsAwareHandlers: vi.fn() },
        } as never),
    );
    if (!result) {
      throw new Error("Expected GitHub Copilot auth result");
    }

    // Existing public token must not be reused for the tenant endpoint.
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(result.profiles[0]?.credential).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "tenant-fresh-token",
    });
    const params = (
      result.configPatch as {
        models?: { providers?: Record<string, { params?: Record<string, unknown> }> };
      }
    )?.models?.providers?.["github-copilot"]?.params;
    expect(params?.githubDomain).toBe("acme.ghe.com");
  });

  it("forces re-login when an existing public profile meets an env-only tenant domain", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 1);
    const agentDir = await createAgentDir();
    // Stored profile was minted for public github.com; config has no tenant.
    writeExistingCopilotTokenProfile(agentDir);
    // Tenant comes ONLY from the env override. The reuse gate must derive the
    // previous domain from persisted config (github.com), not from the env, so
    // the domain change is detected and the public token is not reused.
    const fetchMock = buildDeviceFlowFetchMock("acme.ghe.com", "tenant-fresh-token");
    vi.stubGlobal("fetch", fetchMock);
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async (params) => ({
      response: await fetchMock(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }));
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => "acme.ghe.com"),
      note: vi.fn(),
    };

    const result = await withTty(
      async () =>
        await method.run({
          config: {},
          env: { COPILOT_GITHUB_DOMAIN: "acme.ghe.com" },
          agentDir,
          workspaceDir: "/tmp/workspace",
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          opts: {},
          secretInputMode: "plaintext",
          allowSecretRefPrompt: false,
          isRemote: false,
          openUrl: vi.fn(),
          oauth: { createVpsAwareHandlers: vi.fn() },
        } as never),
    );
    if (!result) {
      throw new Error("Expected GitHub Copilot auth result");
    }

    // Env is authoritative for the chosen domain, so the interactive prompt is
    // skipped; the stale public token must NOT be reused for the tenant.
    expect(prompter.text).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(result.profiles[0]?.credential).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "tenant-fresh-token",
    });
    const params = (
      result.configPatch as {
        models?: { providers?: Record<string, { params?: Record<string, unknown> }> };
      }
    )?.models?.providers?.["github-copilot"]?.params;
    expect(params?.githubDomain).toBe("acme.ghe.com");
  });

  it("still offers to reuse the token when re-running enterprise login for the same tenant", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 1);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => "acme.ghe.com"),
      note: vi.fn(),
    };

    const result = await method.run({
      config: {
        models: { providers: { "github-copilot": { params: { githubDomain: "acme.ghe.com" } } } },
      },
      env: {},
      agentDir,
      workspaceDir: "/tmp/workspace",
      prompter,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      opts: {},
      secretInputMode: "plaintext",
      allowSecretRefPrompt: false,
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as never);
    if (!result) {
      throw new Error("Expected GitHub Copilot auth result");
    }

    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "GitHub Copilot auth already exists. Re-run login?",
      initialValue: false,
    });
    expect(mocks.githubCopilotLoginCommand).not.toHaveBeenCalled();
    expect(result.profiles[0]?.credential).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "existing-token",
    });
    const params = (
      result.configPatch as {
        models?: { providers?: Record<string, { params?: Record<string, unknown> }> };
      }
    )?.models?.providers?.["github-copilot"]?.params;
    expect(params?.githubDomain).toBe("acme.ghe.com");
  });

  it("honors COPILOT_GITHUB_DOMAIN over a divergent prompt value during enterprise login", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 1);
    const agentDir = await createAgentDir();
    // Device flow is mocked for the env tenant only; if login used the typed
    // prompt value instead, the fetch mock would throw on an unexpected host.
    const fetchMock = buildDeviceFlowFetchMock("env-tenant.ghe.com", "env-tenant-token");
    vi.stubGlobal("fetch", fetchMock);
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async (params) => ({
      response: await fetchMock(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }));
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => "typed-tenant.ghe.com"),
      note: vi.fn(),
    };

    const result = await withTty(
      async () =>
        await method.run({
          config: {},
          env: { COPILOT_GITHUB_DOMAIN: "env-tenant.ghe.com" },
          agentDir,
          workspaceDir: "/tmp/workspace",
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          opts: {},
          secretInputMode: "plaintext",
          allowSecretRefPrompt: false,
          isRemote: false,
          openUrl: vi.fn(),
          oauth: { createVpsAwareHandlers: vi.fn() },
        } as never),
    );
    if (!result) {
      throw new Error("Expected GitHub Copilot auth result");
    }

    // The interactive domain prompt must be skipped entirely when the env
    // override is set, so a typed value can never diverge from it.
    expect(prompter.text).not.toHaveBeenCalled();
    expect(result.profiles[0]?.credential).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "env-tenant-token",
    });
    const params = (
      result.configPatch as {
        models?: { providers?: Record<string, { params?: Record<string, unknown> }> };
      }
    )?.models?.providers?.["github-copilot"]?.params;
    expect(params?.githubDomain).toBe("env-tenant.ghe.com");
  });

  it("rejects unsafe GitHub device code lifetimes before polling", async () => {
    const release = vi.fn(async () => {});
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => ({
      response: new Response(
        '{"device_code":"device-code-stub","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":1e309,"interval":0}',
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      finalUrl: "https://github.com/login/device/code",
      release,
    }));

    const showCode = vi.fn();
    await expect(runGitHubCopilotDeviceFlow({ showCode })).rejects.toThrow(
      "GitHub device code response missing fields",
    );
    expect(showCode).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects GitHub device code expiries outside the Date timestamp range before polling", async () => {
    const release = vi.fn(async () => {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    setGitHubCopilotDeviceFlowFetchGuardForTesting(async () => ({
      response: new Response(
        '{"device_code":"device-code-stub","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":1,"interval":0}',
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      finalUrl: "https://github.com/login/device/code",
      release,
    }));

    const showCode = vi.fn();
    try {
      await expect(runGitHubCopilotDeviceFlow({ showCode })).rejects.toThrow(
        "GitHub device code response missing fields",
      );
    } finally {
      nowSpy.mockRestore();
    }
    expect(showCode).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized GitHub device polling intervals before waiting", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => {});
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      let accessTokenPolls = 0;
      setGitHubCopilotDeviceFlowFetchGuardForTesting(async (params) => {
        if (params.url === "https://github.com/login/device/code") {
          return {
            response: new Response(
              '{"device_code":"device-code-stub","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":3000010,"interval":3000000}',
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
            finalUrl: params.url,
            release,
          };
        }
        accessTokenPolls += 1;
        return {
          response: new Response(
            JSON.stringify(
              accessTokenPolls === 1
                ? { error: "authorization_pending" }
                : { access_token: "refreshed-token", token_type: "bearer" },
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
          finalUrl: params.url,
          release,
        };
      });

      const flow = runGitHubCopilotDeviceFlow({ showCode: vi.fn(async () => {}) });
      await vi.waitFor(() =>
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS),
      );
      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      expect(accessTokenPolls).toBe(1);

      await vi.advanceTimersByTimeAsync(3_000_000_000 - MAX_TIMER_TIMEOUT_MS);
      await expect(flow).resolves.toEqual({
        status: "authorized",
        accessToken: "refreshed-token",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores GitHub Copilot token from non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: { githubCopilotToken: "ghu_test\r\n123" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_test123",
        source: "flag" as const,
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });
    expect(result?.agents?.defaults?.model).toEqual({
      primary: "github-copilot/claude-opus-4.7",
    });
    expect(result?.agents?.defaults?.models?.["github-copilot/claude-opus-4.7"]).toStrictEqual({});

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "ghu_test123",
    });
  });

  it("persists COPILOT_GITHUB_DOMAIN during non-interactive onboarding", async () => {
    vi.stubEnv("COPILOT_GITHUB_DOMAIN", "acme.ghe.com");
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: { githubCopilotToken: "ghu_test123" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_test123",
        source: "flag" as const,
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBe(
      "acme.ghe.com",
    );
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "ghu_test123",
    });
  });

  it("clears a persisted enterprise domain during public non-interactive onboarding", async () => {
    vi.stubEnv("COPILOT_GITHUB_DOMAIN", "github.com");
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {
        models: { providers: { "github-copilot": { params: { githubDomain: "acme.ghe.com" } } } },
      },
      baseConfig: {},
      opts: { githubCopilotToken: "ghu_public" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_public",
        source: "flag" as const,
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBeUndefined();
  });

  it("stores env-backed token refs for non-interactive onboarding ref mode", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: { agents: { defaults: { model: { fallbacks: ["openai/gpt-5.4"] } } } },
      baseConfig: {},
      opts: { secretInputMode: "ref" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_from_env",
        source: "env" as const,
        envVarName: "COPILOT_GITHUB_TOKEN",
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual({
      fallbacks: ["openai/gpt-5.4"],
      primary: "github-copilot/claude-opus-4.7",
    });

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      tokenRef: {
        source: "env",
        provider: "default",
        id: "COPILOT_GITHUB_TOKEN",
      },
    });
  });

  it("falls back to GH_TOKEN during non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };
    const resolveApiKey = vi.fn(async ({ envVar }: { envVar?: string }) =>
      envVar === "GH_TOKEN"
        ? {
            key: "ghu_from_gh_token",
            source: "env" as const,
            envVarName: "GH_TOKEN",
          }
        : null,
    );

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: {},
      runtime,
      agentDir,
      resolveApiKey,
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(resolveApiKey).toHaveBeenCalledTimes(2);
    expect(resolveApiKey.mock.calls.map(([params]) => params)).toEqual([
      {
        provider: "github-copilot",
        flagName: "--github-copilot-token",
        envVar: "COPILOT_GITHUB_TOKEN",
        envVarName: "COPILOT_GITHUB_TOKEN",
        allowProfile: false,
        required: false,
      },
      {
        provider: "github-copilot",
        flagName: "--github-copilot-token",
        envVar: "GH_TOKEN",
        envVarName: "GH_TOKEN",
        allowProfile: false,
        required: false,
      },
    ]);
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "ghu_from_gh_token",
    });
  });

  it("preserves an existing primary model during non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "github-copilot/gpt-5.4",
              fallbacks: ["openai/gpt-5.4"],
            },
            models: {
              "github-copilot/gpt-5.4": { label: "Existing" },
            },
          },
        },
      },
      baseConfig: {},
      opts: { githubCopilotToken: "ghu_test" },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_test",
        source: "flag" as const,
      })),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual({
      primary: "github-copilot/gpt-5.4",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(result?.agents?.defaults?.models).toEqual({
      "github-copilot/gpt-5.4": { label: "Existing" },
    });
  });

  it("reuses an existing token profile during non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };
    writeExistingCopilotTokenProfile(agentDir);

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: {},
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => null),
      toApiKeyCredential: vi.fn(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });
  });

  it("does not emit a second missing-token error after ref-mode flag validation fails", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: {
        githubCopilotToken: "ghu_secret",
        secretInputMode: "ref",
      },
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async () => null),
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "--github-copilot-token cannot be used with --secret-input-mode ref unless COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN is set in env.",
        "Set one of those env vars and omit --github-copilot-token, or use --secret-input-mode plaintext.",
      ].join("\n"),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

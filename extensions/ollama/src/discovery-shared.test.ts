// Ollama tests cover discovery shared plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import {
  isLocalOllamaBaseUrl,
  resolveOllamaDiscoveryResult,
  shouldUseSyntheticOllamaAuth,
} from "./discovery-shared.js";

describe("isLocalOllamaBaseUrl", () => {
  it.each([
    undefined,
    "",
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://0.0.0.0:11434",
    "http://[::1]:11434",
    "http://10.0.0.5:11434",
    "http://172.16.0.10:11434",
    "http://172.31.255.254:11434",
    "http://192.168.1.100:11434",
    "http://gpu-node-1:11434",
    "http://mac-studio.local:11434",
    "http://docker.orb.internal:11434",
    "http://host.docker.internal:11434",
    "http://host.orb.internal:11434",
    "http://[fd00::1]:11434",
    "http://[fe90::1]:11434",
  ])("classifies %s as local", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(true);
  });

  it.each([
    "https://ollama.com",
    "https://api.ollama.com/v1",
    "https://ollama.example.com:11434",
    "http://8.8.8.8:11434",
    "http://172.15.255.254:11434",
    "http://172.32.0.1:11434",
    "http://193.168.1.1:11434",
    "http://[2001:4860:4860::8888]:11434",
    "http://10.example.com:11434",
    "not a url",
  ])("classifies %s as remote", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(false);
  });
});

describe("resolveOllamaDiscoveryResult — hosted Ollama Cloud guard", () => {
  const discoveredModel = {
    id: "discovered-model",
    name: "discovered-model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: { supportsTools: true, supportsUsageInStreaming: true },
    params: { num_ctx: 128000 },
  } satisfies ModelProviderConfig["models"][number];

  const cloudModel = {
    id: "minimax-m3:cloud",
    name: "minimax-m3:cloud",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    contextTokens: 24_000,
    maxTokens: 8192,
    compat: { supportsTools: true, supportsUsageInStreaming: true },
    params: { num_ctx: 48_000 },
  } satisfies ModelProviderConfig["models"][number];

  const buildMockProvider = async (
    _configuredBaseUrl?: string,
    _opts?: { quiet?: boolean },
  ): Promise<ModelProviderConfig> => ({
    baseUrl: "https://ollama.com",
    api: "ollama",
    models: [discoveredModel],
  });

  it.each([
    {
      name: "an unresolved environment SecretRef with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      hasExplicitModels: true,
    },
    {
      name: "an unresolved environment marker with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      resolvedAuth: { apiKey: "MISSING_OLLAMA_TOKEN" },
      hasExplicitModels: true,
    },
    {
      name: "an unresolved file SecretRef with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "file", provider: "default", id: "/missing-ollama-token" } as const,
      hasExplicitModels: true,
    },
    {
      name: "an unresolved managed file marker with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "file", provider: "default", id: "/missing-ollama-token" } as const,
      resolvedAuth: { apiKey: "secretref-managed" },
      hasExplicitModels: true,
    },
    {
      name: "an unresolved exec SecretRef with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "exec", provider: "default", id: "missing-ollama-token" } as const,
      hasExplicitModels: true,
    },
    {
      name: "an unresolved environment template with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "${MISSING_OLLAMA_TOKEN}",
      hasExplicitModels: true,
    },
    {
      name: "an unresolved environment SecretRef at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      hasExplicitModels: false,
    },
    {
      name: "an unresolved environment marker at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      resolvedAuth: { apiKey: "MISSING_OLLAMA_TOKEN" },
      hasExplicitModels: false,
    },
    {
      name: "an unresolved file SecretRef at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: { source: "file", provider: "default", id: "/missing-ollama-token" } as const,
      hasExplicitModels: false,
    },
    {
      name: "an unresolved exec SecretRef at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: { source: "exec", provider: "default", id: "missing-ollama-token" } as const,
      hasExplicitModels: false,
    },
    {
      name: "an unresolved managed exec marker at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: { source: "exec", provider: "default", id: "missing-ollama-token" } as const,
      resolvedAuth: { apiKey: "secretref-managed" },
      hasExplicitModels: false,
    },
    {
      name: "an unresolved environment template at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: "${MISSING_OLLAMA_TOKEN}",
      hasExplicitModels: false,
    },
  ])("does not replace $name with synthetic local auth", async (testCase) => {
    let providerCalled = false;
    const resolvedAuth = "resolvedAuth" in testCase ? testCase.resolvedAuth : {};

    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: testCase.baseUrl,
                api: "ollama",
                apiKey: testCase.apiKey,
                ...(testCase.hasExplicitModels ? { models: [cloudModel] } : {}),
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => resolvedAuth ?? {},
      },
      pluginConfig: {},
      buildProvider: async () => {
        providerCalled = true;
        return await buildMockProvider();
      },
    });

    expect(result).toBeNull();
    expect(providerCalled).toBe(false);
  });

  it.each([
    {
      name: "a resolved environment marker",
      apiKey: { source: "env", provider: "default", id: "RESOLVED_OLLAMA_TOKEN" } as const,
      resolvedAuth: {
        apiKey: "RESOLVED_OLLAMA_TOKEN",
        discoveryApiKey: "resolved-ollama-fixture",
      },
    },
    {
      name: "a resolved managed file marker",
      apiKey: { source: "file", provider: "default", id: "/resolved-ollama-token" } as const,
      resolvedAuth: {
        apiKey: "secretref-managed",
        discoveryApiKey: "resolved-ollama-fixture",
      },
    },
    {
      name: "a resolved managed exec marker",
      apiKey: { source: "exec", provider: "default", id: "resolved-ollama-token" } as const,
      resolvedAuth: {
        apiKey: "secretref-managed",
        discoveryApiKey: "resolved-ollama-fixture",
      },
    },
  ])(
    "preserves an explicit local Ollama SecretRef with $name",
    async ({ apiKey, resolvedAuth }) => {
      const result = await resolveOllamaDiscoveryResult({
        ctx: {
          config: {
            models: {
              providers: {
                ollama: {
                  baseUrl: "http://127.0.0.1:11434",
                  api: "ollama",
                  apiKey,
                  models: [cloudModel],
                },
              },
            },
          },
          env: { RESOLVED_OLLAMA_TOKEN: "resolved-ollama-fixture" },
          resolveProviderApiKey: () => resolvedAuth,
        },
        pluginConfig: {},
        buildProvider: buildMockProvider,
      });

      expect(result?.provider.apiKey).toBe("resolved-ollama-fixture");
      expect(result?.provider.models).toEqual([cloudModel]);
    },
  );

  it.each([
    "https://ollama.com",
    "https://ollama.com:11434",
    "https://api.ollama.com",
    "https://api.ollama.com/v1",
    "https://sub.ollama.com",
  ])("returns null for hosted base URL %s without explicit models", async (baseUrl) => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl,
                apiKey: "test-key",
                api: "ollama",
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    expect(result).toBeNull();
  });

  it("returns explicit models for remote base URL when models are configured", async () => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "https://ollama.com",
                apiKey: "test-key",
                api: "ollama",
                models: [cloudModel],
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    expect(result).not.toBeNull();
    const discoveryResult = expectDefined(result, "Ollama Cloud discovery result");
    expect(discoveryResult.provider.models).toHaveLength(1);
    expect(expectDefined(discoveryResult.provider.models[0], "Ollama Cloud model")).toEqual(
      cloudModel,
    );
  });

  it("preserves explicit local model context overrides without discovery", async () => {
    let providerCalled = false;
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11434",
                api: "ollama",
                models: [cloudModel],
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({}),
      },
      pluginConfig: {},
      buildProvider: async () => {
        providerCalled = true;
        return await buildMockProvider();
      },
    });

    expect(providerCalled).toBe(false);
    expect(result?.provider.models).toEqual([cloudModel]);
  });

  it("does not call buildProvider for remote base URL without explicit models", async () => {
    let providerCalled = false;
    const trackingBuildProvider = async (
      _configuredBaseUrl?: string,
      _opts?: { quiet?: boolean },
    ): Promise<ModelProviderConfig> => {
      providerCalled = true;
      return buildMockProvider();
    };

    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "https://ollama.com",
                apiKey: "test-key",
                api: "ollama",
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: trackingBuildProvider,
    });
    expect(result).toBeNull();
    expect(providerCalled).toBe(false);
  });

  it.each([
    undefined,
    "",
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "https://ollama.mycompany.com",
    "https://ollama.example.com",
    "http://10.0.0.5:11434",
    "not a url",
  ])("still auto-discovers for non-hosted base URL %s", async (baseUrl) => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl,
                apiKey: "test-key",
                api: "ollama",
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    // Remote self-hosted base URL should still reach the discovery path
    expect(result).not.toBeNull();
  });

  it("still auto-discovers for local base URL when no explicit models", async () => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://localhost:11434",
                api: "ollama",
              },
            },
          },
        },
        env: { OLLAMA_API_KEY: "ollama-local" },
        resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    // Local base URL should still reach the discovery path
    expect(result).not.toBeNull();
  });

  it.each([
    {
      name: "a remote endpoint",
      baseUrl: "https://ollama-secure.example/v1",
      discoveredBaseUrl: "https://ollama-secure.example",
    },
    {
      name: "a loopback endpoint",
      baseUrl: "http://127.0.0.1:11434",
      discoveredBaseUrl: "http://127.0.0.1:11434",
    },
    {
      name: "a private-network endpoint",
      baseUrl: "http://192.168.10.8:11434",
      discoveredBaseUrl: "http://192.168.10.8:11434",
    },
  ])(
    "authenticates live discovery at $name with its resolved SecretRef",
    async ({ baseUrl, discoveredBaseUrl }) => {
      const buildProvider = vi.fn(
        async (
          _configuredBaseUrl?: string,
          _opts?: { apiKey?: string; quiet?: boolean },
        ): Promise<ModelProviderConfig> => ({
          baseUrl: discoveredBaseUrl,
          api: "ollama",
          models: [discoveredModel],
        }),
      );

      const result = await resolveOllamaDiscoveryResult({
        ctx: {
          config: {
            models: {
              providers: {
                ollama: {
                  baseUrl,
                  api: "ollama",
                  apiKey: { source: "env", provider: "default", id: "OLLAMA_DISCOVERY_TOKEN" },
                },
              },
            },
          },
          env: {},
          resolveProviderApiKey: () => ({
            apiKey: "OLLAMA_DISCOVERY_TOKEN",
            discoveryApiKey: "resolved-ollama-discovery-token",
          }),
        },
        pluginConfig: {},
        buildProvider,
      });

      expect(buildProvider).toHaveBeenCalledWith(baseUrl, {
        quiet: false,
        apiKey: "resolved-ollama-discovery-token",
      });
      expect(result?.provider.apiKey).toBe("resolved-ollama-discovery-token");
      expect(result?.provider.models).toEqual([discoveredModel]);
    },
  );

  it.each(["OLLAMA_API_KEY", "ollama-local"])(
    "preserves resolved opaque SecretRef credential %s during live discovery",
    async (secretValue) => {
      const baseUrl = `https://opaque-secretref-${secretValue.toLowerCase().replaceAll("_", "-")}.example`;
      const buildProvider = vi.fn(
        async (
          _configuredBaseUrl?: string,
          _opts?: { apiKey?: string; quiet?: boolean },
        ): Promise<ModelProviderConfig> => ({
          baseUrl,
          api: "ollama",
          models: [discoveredModel],
        }),
      );

      const result = await resolveOllamaDiscoveryResult({
        ctx: {
          config: {
            models: {
              providers: {
                ollama: {
                  baseUrl,
                  api: "ollama",
                  apiKey: { source: "file", provider: "default", id: "/ollama/apiKey" },
                },
              },
            },
          },
          env: { OLLAMA_API_KEY: "different-ambient-ollama-credential" },
          resolveProviderApiKey: () => ({
            apiKey: "secretref-managed",
            discoveryApiKey: secretValue,
          }),
        },
        pluginConfig: {},
        buildProvider,
      });

      expect(buildProvider).toHaveBeenCalledWith(baseUrl, {
        quiet: false,
        apiKey: secretValue,
      });
      expect(result?.provider.apiKey).toBe(secretValue);
      expect(result?.provider.models).toEqual([discoveredModel]);
    },
  );

  it("isolates discovered catalogs by their effective authentication credential", async () => {
    const buildProvider = vi.fn(
      async (
        _configuredBaseUrl?: string,
        opts?: { apiKey?: string; quiet?: boolean },
      ): Promise<ModelProviderConfig> => ({
        baseUrl: "https://ollama-cache-scope.example",
        api: "ollama",
        models: [
          {
            ...discoveredModel,
            id: `model-for-${opts?.apiKey}`,
            name: `model-for-${opts?.apiKey}`,
          },
        ],
      }),
    );

    const discoverWithCredential = async (apiKey: string) =>
      await resolveOllamaDiscoveryResult({
        ctx: {
          config: {
            models: {
              providers: {
                ollama: {
                  baseUrl: "https://ollama-cache-scope.example/v1",
                  api: "ollama",
                  apiKey,
                },
              },
            },
          },
          env: {},
          resolveProviderApiKey: () => ({ apiKey }),
        },
        pluginConfig: {},
        buildProvider,
      });

    const first = await discoverWithCredential("ollama-cache-token-a");
    const second = await discoverWithCredential("ollama-cache-token-b");
    const cachedFirst = await discoverWithCredential("ollama-cache-token-a");

    expect(buildProvider).toHaveBeenCalledTimes(2);
    expect(first?.provider.models[0]?.id).toBe("model-for-ollama-cache-token-a");
    expect(second?.provider.models[0]?.id).toBe("model-for-ollama-cache-token-b");
    expect(cachedFirst?.provider.models[0]?.id).toBe("model-for-ollama-cache-token-a");
  });
});

describe("shouldUseSyntheticOllamaAuth", () => {
  it.each([
    { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
    { source: "file", provider: "default", id: "/missing-ollama-token" } as const,
    { source: "exec", provider: "default", id: "missing-ollama-token" } as const,
  ])("does not replace an explicitly configured $source SecretRef", (apiKey) => {
    expect(
      shouldUseSyntheticOllamaAuth({
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey,
        models: [
          {
            id: "local-fixture",
            name: "Local fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          },
        ],
      }),
    ).toBe(false);
  });
});

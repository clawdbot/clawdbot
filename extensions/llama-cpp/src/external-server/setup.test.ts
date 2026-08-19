import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";
import type { LlamaServerDiscoveryResult } from "./discovery.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./setup.js";

const discoverMock = vi.hoisted(() => vi.fn());
const runtimeApiKeyMock = vi.hoisted(() => vi.fn());
const removeProviderAuthProfilesWithLockMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  removeProviderAuthProfilesWithLock: removeProviderAuthProfilesWithLockMock,
}));

vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverLlamaServer: discoverMock,
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  resolveLlamaServerRuntimeApiKey: runtimeApiKeyMock,
}));

function successfulDiscovery(): Extract<LlamaServerDiscoveryResult, { kind: "success" }> {
  return {
    kind: "success" as const,
    endpoint: {
      origin: "http://localhost:8080",
      inferenceBaseUrl: "http://localhost:8080/v1",
    },
    health: "ready" as const,
    fetchedAt: 123,
    models: [
      {
        config: {
          id: "qwen/model:Q4_K_M",
          name: "qwen/model:Q4_K_M",
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          contextTokens: 32768,
          maxTokens: 8192,
        },
        status: "loaded" as const,
        failed: false,
      },
    ],
  };
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as never,
  };
}

function nonInteractiveContext(
  opts: Record<string, unknown> = {},
): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "llama-cpp-existing-server",
    config: {},
    baseConfig: {},
    opts,
    runtime: runtime(),
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => null),
  };
}

describe("llama-server setup", () => {
  beforeEach(() => {
    discoverMock.mockReset();
    runtimeApiKeyMock.mockReset();
    runtimeApiKeyMock.mockResolvedValue(undefined);
    removeProviderAuthProfilesWithLockMock.mockReset();
    removeProviderAuthProfilesWithLockMock.mockResolvedValue({ version: 1, profiles: {} });
  });

  it("detects a running local server without writing config", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());

    await expect(detectLlamaServerSetup({ config: {}, env: {} })).resolves.toEqual({
      modelRef: "llama-cpp/qwen/model:Q4_K_M",
      detail: "qwen/model:Q4_K_M at http://localhost:8080",
    });
  });

  it("does not present a managed localService as an existing-server candidate", async () => {
    const config = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://127.0.0.1:19432/v1",
            localService: { command: "/runtime/llama-server" },
            models: [],
          },
        },
      },
    };

    await expect(detectLlamaServerSetup({ config, env: {} })).resolves.toBeNull();
    await expect(
      prepareLlamaServerSetup({ config, env: {}, modelRef: "llama-cpp/model" }),
    ).resolves.toBeNull();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("does not select a failed router model while a healthy model is available", async () => {
    const discovery = successfulDiscovery();
    const baseModel = discovery.models[0];
    if (!baseModel) {
      throw new Error("expected discovery fixture model");
    }
    discovery.models = [
      {
        ...baseModel,
        config: { ...baseModel.config, id: "qwen-failed", name: "qwen-failed" },
        status: "unloaded",
        failed: true,
      },
      {
        ...baseModel,
        config: { ...baseModel.config, id: "healthy-model", name: "healthy-model" },
        status: "unloaded",
        failed: false,
      },
    ];
    discoverMock.mockResolvedValue(discovery);

    await expect(detectLlamaServerSetup({ config: {}, env: {} })).resolves.toMatchObject({
      modelRef: "llama-cpp/healthy-model",
    });
  });

  it("prefers configured Authorization over ambient auth during guided detection", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    runtimeApiKeyMock.mockResolvedValue("ambient-key");

    await detectLlamaServerSetup({
      config: {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              headers: { Authorization: "Bearer proxy-key" },
              models: [],
            },
          },
        },
      },
      env: {},
    });

    expect(runtimeApiKeyMock).not.toHaveBeenCalled();
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        headers: { Authorization: "Bearer proxy-key" },
      }),
    );
  });

  it("skips guided detection when configured auth cannot be resolved", async () => {
    runtimeApiKeyMock.mockRejectedValue(new Error("unresolved SecretRef"));

    await expect(detectLlamaServerSetup({ config: {}, env: {} })).resolves.toBeNull();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("prepares only the exact discovered model", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());

    await expect(
      prepareLlamaServerSetup({
        config: {},
        env: {},
        modelRef: "llama-cpp/qwen/model:Q4_K_M",
      }),
    ).resolves.toMatchObject({
      profiles: [],
      defaultModel: "llama-cpp/qwen/model:Q4_K_M",
      configPatch: {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              api: "openai-completions",
            },
          },
        },
      },
    });
    await expect(
      prepareLlamaServerSetup({ config: {}, env: {}, modelRef: "llama-cpp/missing" }),
    ).resolves.toBeNull();
  });

  it("configures an unauthenticated server without persisting a fake key", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const prompter = {
      text: vi.fn(async () => "http://localhost:8080"),
      confirm: vi.fn(async () => false),
    };
    const result = await runLlamaServerSetup({
      config: {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              auth: "api-key",
              apiKey: "old-inline-key",
              headers: { "X-Tenant": "one" },
              models: [],
            },
          },
        },
      },
      env: {},
      prompter,
      runtime: runtime(),
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext);

    expect(result.profiles).toEqual([]);
    const provider = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(provider?.auth).toBeUndefined();
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.headers).toEqual({ "X-Tenant": "one" });
    expect(result.defaultModel).toBe("llama-cpp/qwen/model:Q4_K_M");
    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      agentDir: undefined,
      provider: "llama-cpp",
      profileIds: ["llama-cpp:default"],
    });
    expect(result.configPatch?.auth).toBeUndefined();
  });

  it("does not send stored credentials to a replacement endpoint", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    runtimeApiKeyMock.mockResolvedValue("stored-profile-key");
    const prompter = {
      text: vi.fn(async () => "http://replacement.example:8080"),
      confirm: vi.fn(async () => false),
    };
    const result = await runLlamaServerSetup({
      config: {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              apiKey: "stored-provider-key",
              headers: { Authorization: "Bearer stored-header-key", "X-Tenant": "one" },
              models: [],
            },
          },
        },
      },
      env: { LLAMA_SERVER_API_KEY: "ambient-key" },
      prompter,
      runtime: runtime(),
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext);

    expect(runtimeApiKeyMock).not.toHaveBeenCalled();
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://replacement.example:8080/v1",
        apiKey: undefined,
        headers: undefined,
      }),
    );
    const provider = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.headers).toBeUndefined();
  });

  it("removes managed-only state when switching to an existing server", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    runtimeApiKeyMock.mockResolvedValue("managed-profile-key");
    const prompter = {
      text: vi.fn(async () => "http://external.example:8080"),
      confirm: vi.fn(async () => false),
    };
    const result = await runLlamaServerSetup({
      config: {
        auth: {
          profiles: { "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" } },
          order: { "llama-cpp": ["llama-cpp:default"] },
        },
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://127.0.0.1:19432/v1",
              apiKey: "llama-cpp-local",
              headers: { Authorization: "Bearer managed-header" },
              timeoutSeconds: 600,
              params: { modelCacheDir: "/managed/cache" },
              localService: {
                command: "/runtime/llama-server",
                healthUrl: "http://127.0.0.1:19432/health",
              },
              models: [
                {
                  id: "managed-model",
                  name: "Managed model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 2048,
                  params: { modelPath: "/managed/model.gguf" },
                },
              ],
            },
          },
        },
      },
      env: { LLAMA_SERVER_API_KEY: "managed-env-key" },
      prompter,
      runtime: runtime(),
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext);

    expect(runtimeApiKeyMock).not.toHaveBeenCalled();
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://external.example:8080/v1",
        apiKey: undefined,
        headers: undefined,
      }),
    );
    const provider = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(provider).not.toHaveProperty("localService");
    expect(provider).not.toHaveProperty("timeoutSeconds");
    expect(provider).not.toHaveProperty("headers");
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.params).toBeUndefined();
    expect(provider?.models).toEqual([expect.objectContaining({ id: "qwen/model:Q4_K_M" })]);
    expect(result.defaultModel).toBe("llama-cpp/qwen/model:Q4_K_M");
    expect(result.configPatch?.auth).toEqual({
      profiles: { "llama-cpp:default": undefined },
      order: { "llama-cpp": undefined },
    });
  });

  it("preserves explicit Authorization instead of selecting an ambient API key", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const prompter = {
      text: vi.fn(async () => "http://localhost:8080"),
      confirm: vi.fn(async () => false),
    };

    const result = await runLlamaServerSetup({
      config: {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              headers: { Authorization: "Bearer proxy-key", "X-Tenant": "one" },
              models: [],
            },
          },
        },
      },
      env: { LLAMA_SERVER_API_KEY: "ambient-key" },
      prompter,
      runtime: runtime(),
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext);

    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        headers: { Authorization: "Bearer proxy-key", "X-Tenant": "one" },
      }),
    );
    const provider = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(provider?.headers).toEqual({ Authorization: "Bearer proxy-key", "X-Tenant": "one" });
    expect(result.profiles).toEqual([]);
  });

  it("prompts for a new API key when a replacement endpoint needs auth", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://replacement.example:8080")
        .mockResolvedValueOnce("replacement-key"),
      confirm: vi.fn(async () => true),
    };

    const result = await runLlamaServerSetup({
      config: {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              apiKey: "old-config-key",
              headers: { Authorization: "Bearer old-header-key" },
              models: [],
            },
          },
        },
        auth: {
          profiles: {
            "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" },
          },
          order: { "llama-cpp": ["llama-cpp:default"] },
        },
      },
      env: { LLAMA_SERVER_API_KEY: "old-endpoint-key" },
      prompter,
      runtime: runtime(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext);

    expect(prompter.text).toHaveBeenCalledTimes(2);
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://replacement.example:8080/v1",
        apiKey: "replacement-key",
      }),
    );
    expect(result.profiles).toEqual([
      {
        profileId: "llama-cpp:default",
        credential: {
          type: "api_key",
          provider: "llama-cpp",
          key: "replacement-key",
        },
      },
    ]);
  });

  it("returns an API-key profile when the operator enables auth", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:8080")
        .mockResolvedValueOnce("secret-key"),
      confirm: vi.fn(async () => true),
    };
    const result = await runLlamaServerSetup({
      config: {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              auth: "api-key",
              apiKey: "stale-inline-key",
              headers: { authorization: "Bearer stale-key", "X-Tenant": "one" },
              models: [],
            },
          },
        },
      },
      env: {},
      prompter,
      runtime: runtime(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext);

    expect(result.profiles).toEqual([
      {
        profileId: "llama-cpp:default",
        credential: {
          type: "api_key",
          provider: "llama-cpp",
          key: "secret-key",
        },
      },
    ]);
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "secret-key", cacheTtlMs: 0 }),
    );
    const provider = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(provider?.auth).toBeUndefined();
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.headers).toEqual({ "X-Tenant": "one" });
  });

  it("validates and configures non-interactively without requiring an API key", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext({ customBaseUrl: "http://localhost:8080/v1" });
    ctx.config = {
      auth: {
        profiles: {
          "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" },
        },
        order: { "llama-cpp": ["llama-cpp:default"] },
      },
    };

    await expect(validateLlamaServerNonInteractive(ctx)).resolves.toBe(true);
    const configured = await configureLlamaServerNonInteractive(ctx);

    expect(ctx.resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ required: false, envVar: "LLAMA_SERVER_API_KEY" }),
    );
    expect(configured?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]).toMatchObject({
      baseUrl: "http://localhost:8080/v1",
      models: [expect.objectContaining({ id: "qwen/model:Q4_K_M" })],
    });
    expect(configured?.agents?.defaults?.model).toEqual(
      expect.objectContaining({ primary: "llama-cpp/qwen/model:Q4_K_M" }),
    );
    expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
      agentDir: undefined,
      provider: "llama-cpp",
      profileIds: ["llama-cpp:default"],
    });
    expect(configured?.auth).toEqual({ profiles: {} });
  });

  it("does not reuse ambient or configured credentials for a replacement endpoint non-interactively", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext({ customBaseUrl: "http://replacement.example:8080/v1" });
    ctx.config = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://localhost:8080/v1",
            apiKey: "stored-provider-key",
            headers: { Authorization: "Bearer stored-header-key" },
            timeoutSeconds: 600,
            params: { modelCacheDir: "/managed/cache" },
            localService: {
              command: "/runtime/llama-server",
              healthUrl: "http://localhost:8080/health",
            },
            models: [
              {
                id: "managed-model",
                name: "Managed model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 2048,
              },
            ],
          },
        },
      },
    };
    ctx.resolveApiKey = vi.fn(async () => ({ key: "ambient-key", source: "env" as const }));

    const configured = await configureLlamaServerNonInteractive(ctx);

    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://replacement.example:8080/v1",
        apiKey: undefined,
        headers: undefined,
      }),
    );
    const provider = configured?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.headers).toBeUndefined();
    expect(provider).not.toHaveProperty("localService");
    expect(provider).not.toHaveProperty("timeoutSeconds");
    expect(provider?.params).toBeUndefined();
  });

  it("removes stale Authorization when non-interactive setup selects an API key", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext({ llamaServerApiKey: "new-key" });
    ctx.config = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://localhost:8080/v1",
            auth: "api-key",
            apiKey: "stale-inline-key",
            headers: { Authorization: "Bearer stale-key", "X-Tenant": "one" },
            localService: {
              command: "/runtime/llama-server",
              healthUrl: "http://localhost:8080/health",
            },
            models: [],
          },
        },
      },
    };
    ctx.resolveApiKey = vi.fn(async () => ({ key: "new-key", source: "flag" as const }));
    ctx.toApiKeyCredential = vi.fn(() => ({
      type: "api_key" as const,
      provider: LLAMA_CPP_PROVIDER_ID,
      key: "new-key",
    }));

    const configured = await configureLlamaServerNonInteractive(ctx);

    const provider = configured?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(provider?.auth).toBeUndefined();
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.headers).toBeUndefined();
    expect(provider).not.toHaveProperty("localService");
  });

  it("preserves Authorization when non-interactive auth came from the environment", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext();
    ctx.config = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://localhost:8080/v1",
            headers: { Authorization: "Bearer proxy-key" },
            models: [],
          },
        },
      },
    };
    ctx.resolveApiKey = vi.fn(async () => ({ key: "ambient-key", source: "env" as const }));

    const configured = await configureLlamaServerNonInteractive(ctx);

    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        headers: { Authorization: "Bearer proxy-key" },
      }),
    );
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    expect(configured?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.headers).toEqual({
      Authorization: "Bearer proxy-key",
    });
  });

  it("rejects a requested model absent from discovery", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext({ customModelId: "missing" });

    await expect(validateLlamaServerNonInteractive(ctx)).resolves.toBe(false);
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "llama-server model missing was not found. Available models: qwen/model:Q4_K_M",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });
});

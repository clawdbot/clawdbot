import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_SERVER_PROVIDER_ID } from "./defaults.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./setup.js";

const discoverMock = vi.hoisted(() => vi.fn());
const runtimeApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverLlamaServer: discoverMock,
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  resolveLlamaServerRuntimeApiKey: runtimeApiKeyMock,
}));

function successfulDiscovery() {
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
    authChoice: LLAMA_SERVER_PROVIDER_ID,
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
  });

  it("detects a running local server without writing config", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());

    await expect(detectLlamaServerSetup({ config: {}, env: {} })).resolves.toEqual({
      modelRef: "llama-server/qwen/model:Q4_K_M",
      detail: "qwen/model:Q4_K_M at http://localhost:8080",
    });
  });

  it("prefers configured Authorization over ambient auth during guided detection", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    runtimeApiKeyMock.mockResolvedValue("ambient-key");

    await detectLlamaServerSetup({
      config: {
        models: {
          providers: {
            "llama-server": {
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
        modelRef: "llama-server/qwen/model:Q4_K_M",
      }),
    ).resolves.toMatchObject({
      profiles: [],
      defaultModel: "llama-server/qwen/model:Q4_K_M",
      configPatch: {
        models: {
          providers: {
            "llama-server": {
              baseUrl: "http://localhost:8080/v1",
              api: "openai-completions",
            },
          },
        },
      },
    });
    await expect(
      prepareLlamaServerSetup({ config: {}, env: {}, modelRef: "llama-server/missing" }),
    ).resolves.toBeNull();
  });

  it("configures an unauthenticated server without persisting a fake key", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const prompter = {
      text: vi.fn(async () => "http://localhost:8080"),
      confirm: vi.fn(async () => false),
    };
    const result = await runLlamaServerSetup({
      config: {},
      env: {},
      prompter,
      runtime: runtime(),
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext);

    expect(result.profiles).toEqual([]);
    expect(
      result.configPatch?.models?.providers?.[LLAMA_SERVER_PROVIDER_ID]?.apiKey,
    ).toBeUndefined();
    expect(result.defaultModel).toBe("llama-server/qwen/model:Q4_K_M");
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
            "llama-server": {
              baseUrl: "http://localhost:8080/v1",
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
        profileId: "llama-server:default",
        credential: {
          type: "api_key",
          provider: "llama-server",
          key: "secret-key",
        },
      },
    ]);
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "secret-key", cacheTtlMs: 0 }),
    );
    expect(result.configPatch?.models?.providers?.[LLAMA_SERVER_PROVIDER_ID]?.headers).toEqual({
      "X-Tenant": "one",
    });
  });

  it("validates and configures non-interactively without requiring an API key", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext({ customBaseUrl: "http://localhost:8080/v1" });

    await expect(validateLlamaServerNonInteractive(ctx)).resolves.toBe(true);
    const configured = await configureLlamaServerNonInteractive(ctx);

    expect(ctx.resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ required: false, envVar: "LLAMA_SERVER_API_KEY" }),
    );
    expect(configured?.models?.providers?.[LLAMA_SERVER_PROVIDER_ID]).toMatchObject({
      baseUrl: "http://localhost:8080/v1",
      models: [expect.objectContaining({ id: "qwen/model:Q4_K_M" })],
    });
    expect(configured?.agents?.defaults?.model).toEqual(
      expect.objectContaining({ primary: "llama-server/qwen/model:Q4_K_M" }),
    );
  });

  it("removes stale Authorization when non-interactive setup selects an API key", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext({ llamaServerApiKey: "new-key" });
    ctx.config = {
      models: {
        providers: {
          "llama-server": {
            baseUrl: "http://localhost:8080/v1",
            headers: { Authorization: "Bearer stale-key", "X-Tenant": "one" },
            models: [],
          },
        },
      },
    };
    ctx.resolveApiKey = vi.fn(async () => ({ key: "new-key", source: "flag" as const }));
    ctx.toApiKeyCredential = vi.fn(() => ({
      type: "api_key" as const,
      provider: LLAMA_SERVER_PROVIDER_ID,
      key: "new-key",
    }));

    const configured = await configureLlamaServerNonInteractive(ctx);

    expect(configured?.models?.providers?.[LLAMA_SERVER_PROVIDER_ID]?.headers).toEqual({
      "X-Tenant": "one",
    });
  });

  it("preserves Authorization when non-interactive auth came from the environment", async () => {
    discoverMock.mockResolvedValue(successfulDiscovery());
    const ctx = nonInteractiveContext();
    ctx.config = {
      models: {
        providers: {
          "llama-server": {
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
    expect(configured?.models?.providers?.[LLAMA_SERVER_PROVIDER_ID]?.headers).toEqual({
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

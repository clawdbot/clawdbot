// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "../agents/provider-request-config.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";

const API_KEY_FIELD = ["api", "Key"].join("") as "apiKey";
const REQUIRE_API_KEY_FIELD = ["require", "ApiKey"].join("");
const SET_RUNTIME_API_KEY_FIELD = ["setRuntime", "ApiKey"].join("");

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  getApiKeyForModelMock: vi.fn(
    async (): Promise<{
      apiKey: string;
      source: string;
      mode: string;
      profileId?: string;
    }> => ({
      [API_KEY_FIELD]: "test-api-key", // pragma: allowlist secret
      source: "test",
      mode: "oauth",
    }),
  ),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    [API_KEY_FIELD]: "test-api-key", // pragma: allowlist secret
    source: "test",
    mode: "oauth",
  })),
  requireApiKeyMock: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  setRuntimeApiKeyMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  fetchMock: vi.fn(),
  registerProviderStreamForModelMock: vi.fn(),
  prepareProviderDynamicModelMock: vi.fn(async () => {}),
  prepareProviderRuntimeAuthMock: vi.fn(),
  acquireAgentRunPreparedModelRuntimeMock: vi.fn(),
  releasePreparedModelRuntimeMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  resolveModelWithRegistryMock: vi.fn(),
  shouldPreferProviderRuntimeResolvedModelMock: vi.fn(() => false),
  unwrapSecretSentinelsForProviderEgressMock: vi.fn((value: string) => value),
}));
const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
  registerProviderStreamForModelMock,
  prepareProviderDynamicModelMock,
  prepareProviderRuntimeAuthMock,
  acquireAgentRunPreparedModelRuntimeMock,
  releasePreparedModelRuntimeMock,
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
  shouldPreferProviderRuntimeResolvedModelMock,
  unwrapSecretSentinelsForProviderEgressMock,
} = hoisted;
const preparedAuthStorage = { [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock };

type ResolveModelWithRegistryTestParams = {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
};

type AuthRequestCall = {
  profileId?: string;
  preferredProfile?: string;
  store?: unknown;
};

function requireMockCallAt<const Calls extends readonly unknown[][]>(
  mock: { mock: { calls: Calls } },
  index: number,
  label: string,
): Calls[number] {
  // Tests inspect exact dependency calls because image runtime behavior is
  // mostly provider/auth orchestration.
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label} call ${index}`);
  }
  return call as Calls[number];
}

function requireFirstMockCall<const Calls extends readonly unknown[][]>(
  mock: { mock: { calls: Calls } },
  label: string,
): Calls[number] {
  return requireMockCallAt(mock, 0, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

vi.mock("../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/stream.js")>("../llm/stream.js");
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock("../agents/models-config.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/models-config.js")>(
    "../agents/models-config.js",
  )),
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../agents/model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  getApiKeyForModel: getApiKeyForModelMock,
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  [REQUIRE_API_KEY_FIELD]: requireApiKeyMock,
}));

vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

vi.mock("../agents/sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: () => ({ apiRegistry: {}, llmRuntime: {} }),
}));

vi.mock("../agents/provider-secret-egress.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/provider-secret-egress.js")>(
    "../agents/provider-secret-egress.js",
  )),
  unwrapSecretSentinelsForProviderEgress: unwrapSecretSentinelsForProviderEgressMock,
}));

vi.mock("../agents/agent-model-discovery.js", () => ({
  discoverAuthStorage: () => ({
    [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: acquireAgentRunPreparedModelRuntimeMock,
}));

vi.mock("../plugins/provider-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  )),
  prepareProviderDynamicModel: prepareProviderDynamicModelMock,
  shouldPreferProviderRuntimeResolvedModel: shouldPreferProviderRuntimeResolvedModelMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: prepareProviderRuntimeAuthMock,
}));

vi.mock("../agents/embedded-agent-runner/model.js", () => ({
  resolveModelAsync: resolveModelAsyncMock,
}));

vi.mock("../plugin-sdk/provider-auth.js", () => ({
  buildCopilotIdeHeaders: () => ({
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  }),
  COPILOT_INTEGRATION_ID: "vscode-chat",
}));

const imageTestFetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("../infra/net/fetch-guard.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...mod,
    fetchWithSsrFGuard: imageTestFetchWithSsrFGuardMock,
  };
});

const { describeImageWithModel } = await import("./image.js");

describe("describeImageWithModel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Provider endpoint policy comes from manifests. Pin source manifests so a
    // prior local build cannot make this source-checkout test read partial dist output.
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
    acquireAgentRunPreparedModelRuntimeMock.mockImplementation(
      async (input: { agentDir: string; config: object; workspaceDir?: string }) => ({
        snapshot: {
          agentDir: input.agentDir,
          config: input.config,
          workspaceDir: input.workspaceDir,
          createStores: () => ({
            authStorage: preparedAuthStorage,
            modelRegistry: {},
          }),
        },
        release: releasePreparedModelRuntimeMock,
      }),
    );
    fetchMock.mockImplementation(async () =>
      Response.json({
        base_resp: { status_code: 0 },
        content: "portal ok",
      }),
    );
    // Bridge fetchWithSsrFGuard through the globally-stubbed fetch so existing
    // assertions on fetchMock call count and arguments continue to work.
    imageTestFetchWithSsrFGuardMock.mockImplementation(
      async (opts: { url: string; init: RequestInit; timeoutMs?: number }) => {
        const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
        const init = { ...opts.init, signal };
        const response = await globalThis.fetch(opts.url, init);
        return { response, release: vi.fn(), finalUrl: opts.url };
      },
    );
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    resolveModelWithRegistryMock.mockImplementation(
      // Delegate to modelRegistry.find so tests that override discoverModelsMock
      // automatically get the right model through resolveModelWithRegistry.
      ({ modelRegistry, provider, modelId }: ResolveModelWithRegistryTestParams) =>
        modelRegistry.find(provider, modelId),
    );
    resolveModelAsyncMock.mockImplementation(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
        const authStorage = {
          [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
        };
        const modelRegistry = discoverModelsMock(authStorage, agentDir);
        const model = resolveModelWithRegistryMock({
          provider,
          modelId,
          modelRegistry,
          cfg,
          agentDir,
        });
        return { authStorage, model, modelRegistry };
      },
    );
    prepareProviderRuntimeAuthMock.mockImplementation(async (params: { provider: string }) => {
      return params.provider === "github-copilot"
        ? {
            [API_KEY_FIELD]: "test-api-key",
            baseUrl: "https://api.githubcopilot.com",
          }
        : undefined;
    });
  });

  function getApiKeyForModelCall(index = 0): AuthRequestCall {
    const call = (getApiKeyForModelMock.mock.calls as unknown[][]).at(index);
    if (!call) {
      throw new Error(`Expected getApiKeyForModel call ${index}`);
    }
    return call[0] as AuthRequestCall;
  }

  it("routes minimax-portal image models through the MiniMax VLM endpoint", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const authStore = { version: 1, profiles: {} };
    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
      authStore,
    });

    expect(result).toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.store).toBe(authStore);
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "test-api-key");
    const [fetchUrl, fetchOptionsValue] = requireFirstMockCall(fetchMock, "fetch");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(fetchUrl).toBe("https://api.minimax.io/v1/coding_plan/vlm");
    expect(fetchOptions).toEqual({
      method: "POST",
      headers: fetchOptions.headers,
      body: JSON.stringify({
        prompt: "Describe the image.",
        image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
      }),
      signal: fetchOptions.signal,
    });
    expect(Object.fromEntries(new Headers(fetchOptions.headers as HeadersInit))).toEqual({
      authorization: ["Bearer", "test-api-key"].join(" "),
      "content-type": "application/json",
      "mm-api-source": "OpenClaw",
    });
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(1000);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("carries resolved MiniMax model transport policy into the VLM request", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() =>
        attachModelProviderRequestTransport(
          {
            provider: "minimax-portal",
            id: "MiniMax-VL-01",
            input: ["text", "image"],
            baseUrl: "https://custom-minimax.example.com/anthropic",
          },
          {
            proxy: { mode: "explicit-proxy", url: "https://proxy.example.com" },
          },
        ),
      ),
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      timeoutMs: 1000,
    });

    const guardedOptions = requireRecord(
      requireFirstMockCall(imageTestFetchWithSsrFGuardMock, "guarded fetch")[0],
      "guarded fetch options",
    );
    expect(guardedOptions.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "https://proxy.example.com",
    });
  });

  it("unwraps a sentinel only at the direct MiniMax VLM handoff", async () => {
    const sentinelValue = mintSecretSentinel("test-api-key", { label: "test:minimax" });
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: sentinelValue,
      source: "test",
      mode: "api-key",
    });
    unwrapSecretSentinelsForProviderEgressMock.mockReturnValueOnce("test-token");

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      timeoutMs: 1000,
    });

    expect(unwrapSecretSentinelsForProviderEgressMock).toHaveBeenCalledWith(
      sentinelValue,
      "MiniMax VLM request",
    );
    const [, fetchOptionsValue] = requireFirstMockCall(fetchMock, "fetch");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(new Headers(fetchOptions.headers as HeadersInit).get("Authorization")).toBe(
      ["Bearer", "test-token"].join(" "),
    );
  });

  it("uses generic completion for non-canonical minimax-portal image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "custom-vision",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "minimax-portal",
      model: "custom-vision",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "generic ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "custom-vision",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "generic ok",
      model: "custom-vision",
    });
    const [streamRequest] = requireFirstMockCall(
      registerProviderStreamForModelMock,
      "provider stream registration",
    );
    expect(streamRequest).toEqual({
      model: {
        provider: "minimax-portal",
        id: "custom-vision",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      },
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("describes images keyless when amazon-bedrock resolves aws-sdk auth", async () => {
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: "",
      source: "profile:amazon-bedrock:default",
      mode: "aws-sdk",
    });
    // Faithful to runtime: requireApiKey throws on an empty resolved key. The
    // aws-sdk carve-out must return before reaching it.
    requireApiKeyMock.mockImplementation((auth: { apiKey?: string; mode?: string }) => {
      const key = auth.apiKey?.trim();
      if (!key) {
        throw new Error(
          `No API key resolved for provider "amazon-bedrock" (auth mode: ${auth.mode}).`,
        );
      }
      return key;
    });
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-sonnet-4-6-v1",
        input: ["text", "image"],
        api: "bedrock-converse-stream",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6-v1",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "an orange tabby cat" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6-v1",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "an orange tabby cat",
      model: "us.anthropic.claude-sonnet-4-6-v1",
    });
    // The carve-out returns before requireApiKey and skips persisting an
    // empty-string secret; the empty key flows through to the model runtime.
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).not.toHaveBeenCalled();
    const completeCall = requireFirstMockCall(completeMock, "complete");
    expect(requireRecord(completeCall[2], "stream options").apiKey).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes workspaceDir through MiniMax VLM fallback auth", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-portal/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-portal",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses canonical MiniMax CN baseUrl for VLM alias fallback", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModel({
        cfg: {
          models: {
            providers: {
              minimax: {
                [API_KEY_FIELD]: "test-api-key",
                baseUrl: "https://api.minimaxi.com/anthropic",
                models: [],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax",
      }),
    );
    const [fetchUrl] = requireFirstMockCall(fetchMock, "fetch");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("uses MiniMax CN alias auth when the alias apiKey is a SecretRef", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModel({
        cfg: {
          models: {
            providers: {
              "minimax-cn": {
                [API_KEY_FIELD]: {
                  source: "file",
                  provider: "default",
                  id: "/providers/minimax-cn/apiKey",
                },
                baseUrl: "https://api.minimaxi.com/anthropic",
                models: [],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-cn",
      }),
    );
    const [fetchUrl] = requireFirstMockCall(fetchMock, "fetch");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("does not inherit global MiniMax baseUrl for CN VLM aliases", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModel({
        cfg: {
          models: {
            providers: {
              minimax: { baseUrl: "https://api.minimax.io/anthropic", models: [] },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    const [fetchUrl] = requireFirstMockCall(fetchMock, "fetch");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("carries workspaceDir through image model and stream resolution", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "google",
        id: "gemini-2.5-flash",
        api: "google-generative-ai",
        input: ["text", "image"],
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-2.5-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "workspace ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentId: "vision-agent",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result.text).toBe("workspace ok");
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "vision-agent",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce();
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        authStorage: preparedAuthStorage,
        modelRegistry: {},
        skipAgentDiscovery: true,
        skipProviderRuntimeHooks: true,
        workspaceDir: "/tmp/openclaw-workspace",
      },
    );
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: {
        provider: "google",
        id: "gemini-2.5-flash",
        api: "google-generative-ai",
        input: ["text", "image"],
      },
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("applies provider normalization before using a fast image model match", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock
      .mockResolvedValueOnce({
        authStorage,
        model: {
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-completions",
          input: ["text", "image"],
        },
      })
      .mockResolvedValueOnce({
        authStorage,
        model: {
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-responses",
          input: ["text", "image"],
        },
      });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "normalized ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "normalized ok",
      model: "gpt-5.4",
    });
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openai",
      "gpt-5.4",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        authStorage: preparedAuthStorage,
        modelRegistry: {},
        skipAgentDiscovery: true,
        skipProviderRuntimeHooks: true,
      },
    );
    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      2,
      "openai",
      "gpt-5.4",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        authStorage: preparedAuthStorage,
        modelRegistry: {},
        skipAgentDiscovery: true,
      },
    );
    const [completeModel] = requireFirstMockCall(completeMock, "complete");
    expect(requireRecord(completeModel, "complete model").api).toBe("openai-responses");
  });

  it("uses plugin stream hooks when available for image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "ollama",
        id: "llava:latest",
        api: "ollama",
        input: ["text", "image"],
      })),
    });
    const streamResult = {
      result: vi.fn(async () => ({
        role: "assistant",
        api: "ollama",
        provider: "ollama",
        model: "llava:latest",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "text", text: "plugin vision ok" }],
      })),
    };
    const streamFn = vi.fn(() => streamResult);
    registerProviderStreamForModelMock.mockReturnValueOnce(streamFn);

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "ollama",
      model: "llava:latest",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "plugin vision ok",
      model: "llava:latest",
    });
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: {
        provider: "ollama",
        id: "llava:latest",
        api: "ollama",
        input: ["text", "image"],
      },
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("resolves configured image models when discovery has not registered the provider", async () => {
    const registryFind = vi.fn(() => null);
    discoverModelsMock.mockReturnValue({ find: registryFind });
    resolveModelWithRegistryMock.mockImplementation(
      ({ provider, modelId }: ResolveModelWithRegistryTestParams) => ({
        provider,
        id: modelId,
        api: "anthropic-messages",
        input: ["text", "image"],
        baseUrl: "http://127.0.0.1:1234",
      }),
    );
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "lmstudio",
      model: "google/gemma-4-e2b",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "local vision ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {
        models: {
          providers: {
            lmstudio: {
              api: "anthropic-messages",
              baseUrl: "http://127.0.0.1:1234",
              models: [
                {
                  id: "google/gemma-4-e2b",
                  name: "google/gemma-4-e2b",
                  input: ["text", "image"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131_072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      provider: "lmstudio",
      model: "google/gemma-4-e2b",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "local vision ok",
      model: "google/gemma-4-e2b",
    });
    expect(registryFind).not.toHaveBeenCalled();
    const [resolveRequestValue] = requireFirstMockCall(
      resolveModelWithRegistryMock,
      "model registry resolution",
    );
    const resolveRequest = requireRecord(resolveRequestValue, "model registry request");
    expect(resolveRequest.provider).toBe("lmstudio");
    expect(resolveRequest.modelId).toBe("google/gemma-4-e2b");
    expect(resolveRequest.agentDir).toBe("/tmp/openclaw-agent");
    expect(
      requireRecord(
        requireRecord(
          requireRecord(requireRecord(resolveRequest.cfg, "request config").models, "models")
            .providers,
          "model providers",
        ).lmstudio,
        "lmstudio provider",
      ).baseUrl,
    ).toBe("http://127.0.0.1:1234");
    expect(prepareProviderDynamicModelMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledOnce();
  });
});

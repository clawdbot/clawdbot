// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";

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
      apiKey: "oauth-test", // pragma: allowlist secret
      source: "test",
      mode: "oauth",
    }),
  ),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "oauth-test", // pragma: allowlist secret
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
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
  shouldPreferProviderRuntimeResolvedModelMock,
  unwrapSecretSentinelsForProviderEgressMock,
} = hoisted;

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
  requireApiKey: requireApiKeyMock,
}));

vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

vi.mock("../agents/provider-secret-egress.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/provider-secret-egress.js")>(
    "../agents/provider-secret-egress.js",
  )),
  unwrapSecretSentinelsForProviderEgress: unwrapSecretSentinelsForProviderEgressMock,
}));

vi.mock("../agents/agent-model-discovery.js", () => ({
  discoverAuthStorage: () => ({
    setRuntimeApiKey: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
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
    fetchMock.mockImplementation(async () =>
      Response.json({
        base_resp: { status_code: 0 },
        content: "portal ok",
      }),
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
          setRuntimeApiKey: setRuntimeApiKeyMock,
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
            apiKey: "copilot-api-token",
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
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "oauth-test");
    const [fetchUrl, fetchOptionsValue] = requireFirstMockCall(fetchMock, "fetch");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(fetchUrl).toBe("https://api.minimax.io/v1/coding_plan/vlm");
    expect(fetchOptions).toEqual({
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-test",
        "Content-Type": "application/json",
        "MM-API-Source": "OpenClaw",
      },
      body: JSON.stringify({
        prompt: "Describe the image.",
        image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
      }),
      signal: fetchOptions.signal,
    });
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(1000);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("unwraps a sentinel only at the direct MiniMax VLM handoff", async () => {
    getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end",
      source: "test",
      mode: "api-key",
    });
    unwrapSecretSentinelsForProviderEgressMock.mockReturnValueOnce("resolved-minimax-secret");

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
      "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end",
      "MiniMax VLM request",
    );
    const [, fetchOptionsValue] = requireFirstMockCall(fetchMock, "fetch");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(fetchOptions.headers).toMatchObject({
      Authorization: "Bearer resolved-minimax-secret",
    });
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
      apiKey: "",
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
      setRuntimeApiKey: setRuntimeApiKeyMock,
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
      setRuntimeApiKey: setRuntimeApiKeyMock,
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
                apiKey: "minimax-test-key",
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
      setRuntimeApiKey: setRuntimeApiKeyMock,
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
                apiKey: { source: "file", provider: "default", id: "/providers/minimax-cn/apiKey" },
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
      setRuntimeApiKey: setRuntimeApiKeyMock,
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
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
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
      setRuntimeApiKey: setRuntimeApiKeyMock,
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

  it("reports the resolved model input when an image model is text-only", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "lmstudio",
        id: "text-only",
        api: "openai-completions",
        input: ["text"],
        baseUrl: "http://127.0.0.1:1234",
      })),
    });

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "lmstudio",
        model: "text-only",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(
      "Model does not support images: lmstudio/text-only (resolved lmstudio/text-only input: text)",
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("passes image prompt as system instructions for codex image requests", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
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
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    const firstCall = requireFirstMockCall(completeMock, "image completion");
    const [completionModel, context, options] = firstCall;
    expect(completionModel).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      input: ["text", "image"],
      baseUrl: "https://chatgpt.com/backend-api",
    });
    expect(context.systemPrompt).toBe("Describe the image.");
    expect(context.messages).toHaveLength(1);
    expect(Object.keys(options).toSorted()).toEqual(["apiKey", "maxTokens", "signal", "timeoutMs"]);
    expect(options.apiKey).toBe("oauth-test");
    expect(options.maxTokens).toBe(4096);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(1000);
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected image completion user message");
    }
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toHaveLength(1);
    expect(userMessage.content[0]).toEqual({
      type: "image",
      data: Buffer.from("png-bytes").toString("base64"),
      mimeType: "image/png",
    });
  });

  it("clamps oversized image description timeouts before scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
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
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toEqual({
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    const firstCall = requireFirstMockCall(completeMock, "image completion");
    expect(firstCall[2].timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("places OpenRouter image prompts in user content before images", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "openrouter",
        id: "google/gemini-2.5-flash",
        input: ["text", "image"],
        baseUrl: "https://openrouter.ai/api/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "openrouter ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "openrouter ok",
      model: "google/gemini-2.5-flash",
    });
    const firstCall = requireFirstMockCall(completeMock, "OpenRouter image completion");
    const [, context] = firstCall;
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected OpenRouter image completion user message");
    }
    expect(userMessage.content).toEqual([
      { type: "text", text: "Describe the image." },
      {
        type: "image",
        data: Buffer.from("png-bytes").toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("places DashScope image prompts in user content before images", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "qwen",
        id: "qwen-vl-max-latest",
        input: ["text", "image"],
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "qwen",
      model: "qwen-vl-max-latest",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "dashscope ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "qwen",
      model: "qwen-vl-max-latest",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "dashscope ok",
      model: "qwen-vl-max-latest",
    });
    const firstCall = requireFirstMockCall(completeMock, "DashScope image completion");
    const [, context] = firstCall;
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected DashScope image completion user message");
    }
    expect(userMessage.content).toEqual([
      { type: "text", text: "Describe the image." },
      {
        type: "image",
        data: Buffer.from("png-bytes").toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it.each([
    {
      name: "direct OpenAI Responses baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "default OpenAI Responses route without explicit baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "azure-openai provider using openai-responses api",
      provider: "azure-openai",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "proxy-like openai-responses route",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://proxy.example.com/v1",
      },
      expectedRetryPayload: {},
    },
  ])(
    "retries reasoning-only image responses with reasoning disabled for $name",
    async ({ provider, model, expectedRetryPayload }) => {
      discoverModelsMock.mockReturnValue({
        find: vi.fn(() => model),
      });
      completeMock
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "internal image reasoning",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [{ type: "text", text: "retry ok" }],
        });

      const result = await describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider,
        model: model.id,
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      });

      expect(result).toEqual({
        text: "retry ok",
        model: model.id,
      });
      expect(completeMock).toHaveBeenCalledTimes(2);
      const retryCall = requireMockCallAt(completeMock, 1, "retry image completion");
      const [retryModel, , retryOptions] = retryCall;
      if (!retryOptions?.onPayload) {
        throw new Error("expected retry payload mapper");
      }
      const retryPayload = await retryOptions.onPayload(
        {
          reasoning: { effort: "high", summary: "auto" },
          reasoning_effort: "high",
          include: ["reasoning.encrypted_content"],
        },
        retryModel,
      );
      expect(retryPayload).toEqual(expectedRetryPayload);
    },
  );

  it("rejects when a generic image completion ignores the abort signal", async () => {
    vi.useFakeTimers();
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });

    const assertion = expect(result).rejects.toThrow(
      "image description request timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    const firstCall = requireFirstMockCall(completeMock, "timed image completion");
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.signal.aborted).toBe(true);
    expect(options.timeoutMs).toBe(25);
  });

  it("keeps the full configured timeout for provider requests after slow setup", async () => {
    vi.useFakeTimers();
    const slowSetupMs = 400;
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    resolveModelAsyncMock.mockImplementationOnce(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, slowSetupMs);
        });
        const authStorage = {
          setRuntimeApiKey: setRuntimeApiKeyMock,
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
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(slowSetupMs);
    await Promise.resolve();
    expect(completeMock).toHaveBeenCalledTimes(1);
    const firstCall = requireFirstMockCall(completeMock, "slow setup image completion");
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.timeoutMs).toBe(1000);

    const assertion = expect(result).rejects.toThrow(
      `image description request timed out after 1000ms (setup took ${slowSetupMs}ms before provider request started)`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(options.signal.aborted).toBe(true);
  });

  it("rejects when image runtime setup exceeds the request timeout", async () => {
    vi.useFakeTimers();
    resolveModelAsyncMock.mockImplementationOnce(() => new Promise(() => {}));

    const result = describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });

    const assertion = expect(result).rejects.toThrow(
      "image description setup timed out after 25ms before provider request started",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("normalizes deprecated google flash ids and keeps profile model/auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3-flash-preview");
      return {
        provider: "google",
        id: "gemini-3-flash-preview",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3-flash-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      profile: "google:default",
      preferredProfile: "google:preferred",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash ok",
      model: "gemini-3-flash-preview",
    });
    expect(findMock).toHaveBeenCalled();
    for (const call of resolveModelAsyncMock.mock.calls) {
      expect(call[4]).toEqual(
        expect.objectContaining({
          authProfileId: "google:default",
          preferredProfile: "google:preferred",
        }),
      );
    }
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
    expect(authRequest?.preferredProfile).toBe("google:preferred");
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("keeps stable GA gemini 3.1 flash-lite ids during lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3.1-flash-lite");
      return {
        provider: "google",
        id: "gemini-3.1-flash-lite",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3.1-flash-lite",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash lite ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-lite",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash lite ok",
      model: "gemini-3.1-flash-lite",
    });
    expect(findMock).toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("rematerializes profile-scoped image metadata after auth selects a backup profile", async () => {
    const authStorage = { setRuntimeApiKey: setRuntimeApiKeyMock };
    const modelRegistry = {};
    const hintedModel = {
      provider: "github-copilot",
      id: "gpt-5.6-sol",
      api: "openai-responses",
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const authoritativeModel = {
      ...hintedModel,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    };
    resolveModelAsyncMock
      .mockResolvedValueOnce({ model: hintedModel, authStorage, modelRegistry })
      .mockResolvedValueOnce({ model: hintedModel, authStorage, modelRegistry })
      .mockResolvedValueOnce({ model: authoritativeModel, authStorage, modelRegistry });
    getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "backup-profile-token",
      source: "profile:github-copilot:backup",
      mode: "token",
      profileId: "github-copilot:backup",
    });
    shouldPreferProviderRuntimeResolvedModelMock.mockReturnValueOnce(true);
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "github-copilot",
      model: "gpt-5.6-sol",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "profile-scoped image ok" }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "github-copilot",
      model: "gpt-5.6-sol",
      profile: "github-copilot:preferred",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(3);
    expect(resolveModelAsyncMock.mock.calls[2]?.[4]).toEqual(
      expect.objectContaining({
        authStorage,
        modelRegistry,
        authProfileId: "github-copilot:backup",
      }),
    );
    const [completionModel] = requireFirstMockCall(completeMock, "complete");
    expect(completionModel).toEqual(
      expect.objectContaining({
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      }),
    );
  });

  it("places image prompt in user content for github-copilot provider", async () => {
    const providerStreamResult = {
      role: "assistant",
      api: "openai-completions",
      provider: "github-copilot",
      model: "gemini-3.1-pro-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "A solid red square." }],
    };
    const providerStreamFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
      result: vi.fn(async () => providerStreamResult),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(providerStreamFn);
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gemini-3.1-pro-preview",
        input: ["text", "image"],
        api: "openai-completions",
        baseUrl: "https://stale.example.test",
      })),
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "github-copilot",
      model: "gemini-3.1-pro-preview",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(completeMock).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledOnce();
    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({ apiKey: "oauth-test", authMode: "oauth" }),
      }),
    );
    const storedToken = setRuntimeApiKeyMock.mock.calls[0]?.[1] as string;
    expect(setRuntimeApiKeyMock.mock.calls[0]?.[0]).toBe("github-copilot");
    expect(looksLikeSecretSentinel(storedToken)).toBe(true);
    expect(storedToken).not.toBe("copilot-api-token");
    expect(resolveSecretSentinel(storedToken)).toBe("copilot-api-token");
    const [completionModel, context, options] = providerStreamFn.mock.calls[0] as unknown as [
      { baseUrl?: string },
      { systemPrompt?: string; messages?: Array<{ role: string; content: unknown[] }> },
      { apiKey?: string; headers?: Record<string, string> },
    ];
    expect(completionModel.baseUrl).toBe("https://api.githubcopilot.com");
    expect(options.apiKey).toBe(storedToken);
    expect(options.headers).toMatchObject({
      "Copilot-Integration-Id": "vscode-chat",
      "Copilot-Vision-Request": "true",
      "Editor-Version": "vscode/1.107.0",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    });
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const contentTypes = userMessage!.content.map((block) => (block as { type: string }).type);
    expect(contentTypes).toContain("text");
    expect(contentTypes).toContain("image");
  });

  it("keeps an exchanged Copilot image token opaque for sentinel-backed auth", async () => {
    const sourceSecret = "copilot-image-source-secret";
    const sourceSentinel = mintSecretSentinel(sourceSecret, {
      label: "model-auth:github-copilot",
    });
    getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: sourceSentinel,
      source: "test",
      mode: "token",
    });
    unwrapSecretSentinelsForProviderEgressMock.mockReturnValueOnce(sourceSecret);
    const providerStreamFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
      result: vi.fn(async () => ({
        role: "assistant",
        api: "openai-completions",
        provider: "github-copilot",
        model: "gpt-4.1",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "text", text: "ok" }],
      })),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(providerStreamFn);
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gpt-4.1",
        input: ["text", "image"],
        api: "openai-completions",
      })),
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "github-copilot",
      model: "gpt-4.1",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      timeoutMs: 1000,
    });

    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({ apiKey: sourceSentinel, authMode: "token" }),
      }),
    );
    const storedToken = setRuntimeApiKeyMock.mock.calls[0]?.[1] as string;
    expect(looksLikeSecretSentinel(storedToken)).toBe(true);
    expect(resolveSecretSentinel(storedToken)).toBe("copilot-api-token");
    const streamOptions = providerStreamFn.mock.calls[0]?.[2] as { apiKey?: string };
    expect(streamOptions.apiKey).toBe(storedToken);
  });

  it("fails github-copilot image runtime setup when token exchange fails", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gemini-3.1-pro-preview",
        input: ["text", "image"],
        api: "openai-completions",
        baseUrl: "https://api.githubcopilot.com",
      })),
    });
    prepareProviderRuntimeAuthMock.mockRejectedValueOnce(
      new Error("Copilot token exchange failed: HTTP 401"),
    );

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "github-copilot",
        model: "gemini-3.1-pro-preview",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Copilot token exchange failed: HTTP 401");

    expect(setRuntimeApiKeyMock).not.toHaveBeenCalledWith("github-copilot", "oauth-test");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("does not place image prompt in user content for non-copilot providers", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-4o",
        input: ["text", "image"],
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "A solid red square." }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-4o",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(completeMock).toHaveBeenCalledOnce();
    const [, context] = completeMock.mock.calls[0] as [
      unknown,
      { systemPrompt?: string; messages?: Array<{ role: string; content: unknown[] }> },
    ];
    // Non-Copilot providers keep prompt in system message, images in user message
    expect(context.systemPrompt).toBe("Describe the image.");
    const userMessage = context.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const contentTypes = userMessage!.content.map((block) => (block as { type: string }).type);
    expect(contentTypes).not.toContain("text");
    expect(contentTypes).toContain("image");
  });

  it("defaults image-describe maxTokens to 4096 for reasoning-capable VLMs", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "agent-plan",
        id: "doubao-seed-2.0-pro",
        input: ["text", "image"],
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "agent-plan",
      model: "doubao-seed-2.0-pro",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "ok" }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "agent-plan",
      model: "doubao-seed-2.0-pro",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    const options = requireFirstMockCall(completeMock, "image completion")[2];
    expect(options.maxTokens).toBe(4096);
  });

  it("caps image-describe maxTokens by the resolved model's own maxTokens", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "fake",
        id: "small-vlm",
        input: ["text", "image"],
        baseUrl: "https://example.test",
        maxTokens: 1024,
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "fake",
      model: "small-vlm",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "ok" }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "fake",
      model: "small-vlm",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    const options = requireFirstMockCall(completeMock, "image completion")[2];
    expect(options.maxTokens).toBe(1024);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

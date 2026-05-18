import type { Model } from "@earendil-works/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const hoisted = vi.hoisted(() => ({
  resolveModelMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
  prepareProviderRuntimeAuthMock: vi.fn(),
  prepareModelForSimpleCompletionMock: vi.fn((params: { model: unknown }) => params.model),
  completeMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: hoisted.completeMock,
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: hoisted.resolveModelMock,
  resolveModelAsync: hoisted.resolveModelAsyncMock,
}));

vi.mock("./simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion: hoisted.prepareModelForSimpleCompletionMock,
}));

vi.mock("./model-auth.js", () => ({
  formatMissingAuthError: vi.fn(
    (auth: { source: string; mode: string }, provider: string) =>
      `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`,
  ),
  getApiKeyForModel: hoisted.getApiKeyForModelMock,
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
}));

vi.mock("./github-copilot-token.js", () => ({
  resolveCopilotApiToken: hoisted.resolveCopilotApiTokenMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuthMock,
}));

let completeWithPreparedSimpleCompletionModel: typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel;
let prepareSimpleCompletionModel: typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModel;
let prepareSimpleCompletionModelForAgent: typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent;

beforeAll(async () => {
  ({
    completeWithPreparedSimpleCompletionModel,
    prepareSimpleCompletionModel,
    prepareSimpleCompletionModelForAgent,
  } = await import("./simple-completion-runtime.js"));
});

beforeEach(() => {
  hoisted.resolveModelMock.mockReset();
  hoisted.resolveModelAsyncMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.resolveCopilotApiTokenMock.mockReset();
  hoisted.prepareProviderRuntimeAuthMock.mockReset();
  hoisted.prepareModelForSimpleCompletionMock.mockReset();
  hoisted.completeMock.mockReset();

  hoisted.applyLocalNoAuthHeaderOverrideMock.mockImplementation((model: unknown) => model);
  hoisted.prepareModelForSimpleCompletionMock.mockImplementation(
    (params: { model: unknown }) => params.model,
  );
  hoisted.completeMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

  hoisted.resolveModelMock.mockReturnValue({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
    },
    authStorage: {
      setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
    },
    modelRegistry: {},
  });
  hoisted.resolveModelAsyncMock.mockImplementation((...args: unknown[]) =>
    Promise.resolve(hoisted.resolveModelMock(...args)),
  );
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    source: "env:TEST_API_KEY",
    mode: "api-key",
  });
  hoisted.resolveCopilotApiTokenMock.mockResolvedValue({
    token: "copilot-runtime-token",
    expiresAt: Date.now() + 60_000,
    source: "cache:/tmp/copilot-token.json",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
  hoisted.prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
});

function expectPreparedModelResult(
  result: Awaited<ReturnType<typeof prepareSimpleCompletionModel>>,
): asserts result is Exclude<typeof result, { error: string }> {
  expect(result).not.toHaveProperty("error");
  if ("error" in result) {
    throw new Error(result.error);
  }
}

function callArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

describe("prepareSimpleCompletionModel", () => {
  it("resolves model auth and sets runtime api key", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: " sk-test ",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.id).toBe("claude-opus-4-6");
    expect(result.auth.mode).toBe("api-key");
    expect(result.auth.source).toBe("env:TEST_API_KEY");
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
  });

  it("returns error when model resolution fails", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      error: "Unknown model: anthropic/missing-model",
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "missing-model",
    });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(hoisted.getApiKeyForModelMock).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "models.providers.anthropic",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error:
        'No API key resolved for provider "anthropic" (auth mode: api-key, checked: models.providers.anthropic).',
      auth: {
        source: "models.providers.anthropic",
        mode: "api-key",
      },
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock",
        id: "anthropic.claude-sonnet-4-6",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("amazon-bedrock");
    expect(result.model.id).toBe("anthropic.claude-sonnet-4-6");
    expect(result.auth).toEqual({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges github token when provider is github-copilot", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(hoisted.resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "ghu_test",
    });
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "github-copilot",
      "copilot-runtime-token",
    );
  });

  it("returns exchanged copilot token in auth.apiKey for github-copilot provider", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_original_github_token",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }

    // The returned auth.apiKey should be the exchanged runtime token,
    // not the original GitHub token
    expect(result.auth.apiKey).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("applies exchanged copilot baseUrl to returned model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });
    hoisted.resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot-runtime-token",
      expiresAt: Date.now() + 60_000,
      source: "cache:/tmp/copilot-token.json",
      baseUrl: "https://api.copilot.enterprise.example",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.model.baseUrl).toBe("https://api.copilot.enterprise.example");
  });

  it("returns error when getApiKeyForModel throws", async () => {
    hoisted.getApiKeyForModelMock.mockRejectedValueOnce(new Error("Profile not found: copilot"));

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'Auth lookup failed for provider "anthropic": Profile not found: copilot',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("applies local no-auth header override before returning model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "local-openai",
        id: "chat-local",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      source: "models.providers.local-openai (synthetic local key)",
      mode: "api-key",
    });
    hoisted.applyLocalNoAuthHeaderOverrideMock.mockReturnValueOnce({
      provider: "local-openai",
      id: "chat-local",
      api: "openai-completions",
      headers: { Authorization: null },
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "local-openai",
      modelId: "chat-local",
    });

    const overrideCall = hoisted.applyLocalNoAuthHeaderOverrideMock.mock.calls.at(0);
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.provider).toBe(
      "local-openai",
    );
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.id).toBe(
      "chat-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.apiKey).toBe(
      "custom-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.source).toBe(
      "models.providers.local-openai (synthetic local key)",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.mode).toBe(
      "api-key",
    );
    expectPreparedModelResult(result);
    expect(result.model.headers?.Authorization).toBeNull();
  });

  it("applies provider runtime auth before storing simple-completion credentials", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock-mantle",
        id: "anthropic.claude-opus-4-7",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "__amazon_bedrock_mantle_iam__",
      source: "models.providers.amazon-bedrock-mantle.apiKey",
      mode: "api-key",
      profileId: "mantle",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "bedrock-runtime-token",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "amazon-bedrock-mantle",
      modelId: "anthropic.claude-opus-4-7",
      agentDir: "/tmp/openclaw-agent",
    });

    const runtimeAuthInput = callArg(hoisted.prepareProviderRuntimeAuthMock) as {
      provider?: string;
      workspaceDir?: string;
      context?: {
        apiKey?: string;
        authMode?: string;
        modelId?: string;
        profileId?: string;
      };
    };
    expect(runtimeAuthInput.provider).toBe("amazon-bedrock-mantle");
    expect(runtimeAuthInput.workspaceDir).toBe("/tmp/openclaw-agent");
    expect(runtimeAuthInput.context?.apiKey).toBe("__amazon_bedrock_mantle_iam__");
    expect(runtimeAuthInput.context?.authMode).toBe("api-key");
    expect(runtimeAuthInput.context?.modelId).toBe("anthropic.claude-opus-4-7");
    expect(runtimeAuthInput.context?.profileId).toBe("mantle");
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "amazon-bedrock-mantle",
      "bedrock-runtime-token",
    );
    expectPreparedModelResult(result);
    expect(result.model.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    expect(result.auth.apiKey).toBe("bedrock-runtime-token");
  });

  it("can skip Pi model/auth discovery for config-scoped one-shot completions", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "ollama",
        id: "llama3.2:latest",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ollama-local",
      source: "models.json (local marker)",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "ollama",
      modelId: "llama3.2:latest",
      skipPiDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "ollama",
      "llama3.2:latest",
      undefined,
      undefined,
      {
        skipPiDiscovery: true,
      },
    );
  });

  it("passes static catalog fallback opt-in to skip-discovery model resolution", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "mistral",
        id: "mistral-medium-3-5",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      allowBundledStaticCatalogFallback: true,
      skipPiDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "mistral",
      "mistral-medium-3-5",
      undefined,
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        skipPiDiscovery: true,
      },
    );
  });
});

describe("prepareSimpleCompletionModelForAgent", () => {
  it("uses Codex auth provider for OpenAI model refs with Codex runtime policy", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
          models: {
            "openai/gpt-5.4-mini": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "openai-codex",
        id: "gpt-5.4-mini",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      skipPiDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expectPreparedModelResult(result);
    expect(result.selection.provider).toBe("openai");
    expect(result.selection.modelId).toBe("gpt-5.4-mini");
    expect(result.selection.runtimeProvider).toBe("openai-codex");
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai-codex",
      "gpt-5.4-mini",
      expect.any(String),
      cfg,
      {
        skipPiDiscovery: true,
      },
    );
    expect(
      (callArg(hoisted.getApiKeyForModelMock) as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai-codex");
  });
});

describe("completeWithPreparedSimpleCompletionModel", () => {
  it("prepares provider-owned stream APIs before running a completion", async () => {
    const model = {
      provider: "ollama",
      id: "llama3.2:latest",
      name: "llama3.2:latest",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model<"ollama">;
    const preparedModel = {
      ...model,
      api: "openclaw-ollama-simple-test",
    };
    const cfg = {
      models: { providers: { ollama: { baseUrl: "http://remote-ollama:11434", models: [] } } },
    };
    hoisted.prepareModelForSimpleCompletionMock.mockReturnValueOnce(preparedModel);

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "ollama-local",
        source: "models.json (local marker)",
        mode: "api-key",
      },
      cfg,
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
    });

    expect(hoisted.prepareModelForSimpleCompletionMock).toHaveBeenCalledWith({ model, cfg });
    expect(hoisted.completeMock).toHaveBeenCalledWith(
      preparedModel,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        apiKey: "ollama-local",
      },
    );
  });

  it("normalizes OpenClaw-only thinking levels before using pi-ai simple completion", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      options: {
        reasoning: "max",
      },
    });

    expect(hoisted.completeMock).toHaveBeenCalledWith(
      model,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        reasoning: "xhigh",
        apiKey: "sk-test",
      },
    );
  });

  it("omits reasoning for local simple completion when thinking is off", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-responses">;

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
      },
      context: {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      options: {
        reasoning: "off",
      },
    });

    expect(hoisted.completeMock).toHaveBeenCalledWith(
      model,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        apiKey: "sk-test",
      },
    );
  });
});

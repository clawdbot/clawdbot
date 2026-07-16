// Simple completion runtime tests cover model resolution, provider auth, and
// one-shot completion wiring before requests reach the shared LLM stream path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { fingerprintResolvedProviderAuth } from "./execution-auth-binding.js";
import { bindSimpleCompletionModelResolverWorkspace } from "./simple-completion-scope.js";

// Hoisted mocks keep Vitest module replacement stable while the implementation
// under test imports auth, model resolution, and transport helpers at module load.
const hoisted = vi.hoisted(() => ({
  resolveModelMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  prepareProviderRuntimeAuthMock: vi.fn(),
  prepareModelForSimpleCompletionMock: vi.fn((params: { model: unknown }) => params.model),
  completeMock: vi.fn(),
  ensureAuthProfileStoreMock: vi.fn(),
}));

vi.mock("../llm/stream.js", () => ({
  completeSimple: hoisted.completeMock,
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModel: hoisted.resolveModelMock,
  resolveModelAsync: hoisted.resolveModelAsyncMock,
}));

vi.mock("./auth-profiles/store.js", () => ({
  ensureAuthProfileStore: hoisted.ensureAuthProfileStoreMock,
}));

vi.mock("./simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion: hoisted.prepareModelForSimpleCompletionMock,
}));

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  formatMissingAuthError: vi.fn(
    (auth: { source: string; mode: string }, provider: string) =>
      `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`,
  ),
  getApiKeyForModel: hoisted.getApiKeyForModelMock,
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuthMock,
}));

import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

beforeEach(() => {
  hoisted.resolveModelMock.mockReset();
  hoisted.resolveModelAsyncMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.prepareProviderRuntimeAuthMock.mockReset();
  hoisted.prepareModelForSimpleCompletionMock.mockReset();
  hoisted.completeMock.mockReset();
  hoisted.ensureAuthProfileStoreMock.mockReset();

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
  hoisted.prepareProviderRuntimeAuthMock.mockImplementation(
    async (params: { provider: string }) => {
      return params.provider === "github-copilot"
        ? {
            apiKey: "copilot-runtime-token",
            baseUrl: "https://api.individual.githubcopilot.com",
          }
        : undefined;
    },
  );
  hoisted.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
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
      modelResolver: bindSimpleCompletionModelResolverWorkspace(
        hoisted.resolveModelAsyncMock as typeof resolveModelAsync,
        "/tmp/runtime-workspace",
      ),
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.id).toBe("claude-opus-4-6");
    expect(result.auth.mode).toBe("api-key");
    expect(result.auth.source).toBe("env:TEST_API_KEY");
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      workspaceDir: "/tmp/runtime-workspace",
    });
  });

  it("captures the exact locked auth owner used by a bound completion", async () => {
    const credential = {
      type: "api_key" as const,
      provider: "anthropic",
      key: "sk-p2",
    };
    const store = { version: 1, profiles: { "anthropic:p2": credential } };
    hoisted.ensureAuthProfileStoreMock.mockReturnValueOnce(store);
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "sk-p2",
      profileId: "anthropic:p2",
      source: "profile:anthropic:p2",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: {},
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
      profileId: "anthropic:p2",
      bindAuthOwner: true,
    });

    expectPreparedModelResult(result);
    expect(result.sourceAuthFingerprint).toBe(
      fingerprintResolvedProviderAuth({
        apiKey: "sk-p2",
        profileId: "anthropic:p2",
        source: "profile:anthropic:p2",
        mode: "api-key",
      }),
    );
    expect(hoisted.getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:p2",
        lockedProfile: true,
        store,
      }),
    );
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

    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      provider: "github-copilot",
      context: {
        apiKey: "ghu_test",
        authMode: "token",
        modelId: "gpt-4.1",
      },
    });
    const [storedProvider, storedKey] = hoisted.setRuntimeApiKeyMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(storedProvider).toBe("github-copilot");
    expect(looksLikeSecretSentinel(storedKey)).toBe(true);
    expect(storedKey).not.toBe("copilot-runtime-token");
    expect(resolveSecretSentinel(storedKey)).toBe("copilot-runtime-token");
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

    // Callers must only receive the short-lived Copilot runtime token. The
    // original GitHub token is broader auth material and must not leave prep.
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("keeps an exchanged Copilot token opaque when its source is a sentinel", async () => {
    const sourceSecret = "github-source-secret";
    const sourceSentinel = mintSecretSentinel(sourceSecret, {
      label: "model-auth:github-copilot",
    });
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: { provider: "github-copilot", id: "gpt-4.1" },
      authStorage: { setRuntimeApiKey: hoisted.setRuntimeApiKeyMock },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: sourceSentinel,
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      provider: "github-copilot",
      context: { apiKey: sourceSentinel },
    });
    expectPreparedModelResult(result);
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("copilot-runtime-token");
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
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "copilot-runtime-token",
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
    const [storedProvider, storedKey] = hoisted.setRuntimeApiKeyMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(storedProvider).toBe("amazon-bedrock-mantle");
    expect(looksLikeSecretSentinel(storedKey)).toBe(true);
    expect(storedKey).not.toBe("bedrock-runtime-token");
    expect(resolveSecretSentinel(storedKey)).toBe("bedrock-runtime-token");
    expectPreparedModelResult(result);
    expect(result.model.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("bedrock-runtime-token");
  });

  it("can skip agent model/auth discovery for config-scoped one-shot completions", async () => {
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
      skipAgentDiscovery: true,
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
        skipAgentDiscovery: true,
      },
    );
  });

  it("can preserve asynchronous provider model discovery", async () => {
    // Use a standalone mock so the default beforeEach delegation from
    // resolveModelAsyncMock → resolveModelMock does not pollute call
    // history. The point of the test is that when useAsyncModelResolution
    // is true, only the async resolver is invoked.
    const resolveModelAsync = vi.fn().mockResolvedValue({
      model: {
        provider: "anthropic",
        id: "claude-opus-4-6",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    // Reset the hoisted sync mock so any leftover calls from earlier tests
    // or beforeEach setup don't cause a false positive.
    hoisted.resolveModelMock.mockReset();

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      useAsyncModelResolution: true,
      modelResolver: resolveModelAsync,
    });

    expectPreparedModelResult(result);
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "anthropic",
      "claude-opus-4-6",
      undefined,
      undefined,
      {},
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
      skipAgentDiscovery: true,
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
        skipAgentDiscovery: true,
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
        provider: "openai",
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
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expectPreparedModelResult(result);
    expect(result.selection.provider).toBe("openai");
    expect(result.selection.modelId).toBe("gpt-5.4-mini");
    expect(result.selection.runtimeProvider).toBe("openai");
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai",
      "gpt-5.4-mini",
      expect.any(String),
      cfg,
      {
        skipAgentDiscovery: true,
      },
    );
    expect(
      (callArg(hoisted.getApiKeyForModelMock) as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
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

  it.each(["max", "ultra"] as const)(
    "normalizes OpenClaw-only %s before using shared model runtime simple completion",
    async (reasoning) => {
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
        options: { reasoning },
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
    },
  );

  it.each(["max", "ultra"] as const)(
    "uses max for GPT-5.6 simple completions requested with %s",
    async (reasoning) => {
      const model = {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "gpt-5.6-terra",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 372_000,
        maxTokens: 128_000,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
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
        options: { reasoning },
      });

      expect(hoisted.completeMock).toHaveBeenCalledWith(
        model,
        {
          messages: [{ role: "user", content: "pong", timestamp: 1 }],
        },
        {
          reasoning: "max",
          apiKey: "sk-test",
        },
      );
    },
  );

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

  it("preserves explicit off for a prepared Claude Sonnet 5 alias", async () => {
    const model = {
      provider: "anthropic",
      id: "production-sonnet",
      name: "Production Sonnet",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-sonnet-5" },
    } satisfies Model<"anthropic-messages">;
    const preparedModel = {
      ...model,
      api: "openclaw-provider-simple:anthropic:production-sonnet",
    } satisfies Model;
    hoisted.prepareModelForSimpleCompletionMock.mockReturnValueOnce(preparedModel);

    await completeWithPreparedSimpleCompletionModel({
      model,
      auth: {
        apiKey: "sk-test",
        source: "env:ANTHROPIC_API_KEY",
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
      preparedModel,
      {
        messages: [{ role: "user", content: "pong", timestamp: 1 }],
      },
      {
        reasoning: "off",
        apiKey: "sk-test",
      },
    );
  });
});

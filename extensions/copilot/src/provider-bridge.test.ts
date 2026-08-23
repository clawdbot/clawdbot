// Copilot tests cover BYOK provider mapping behavior.
import { describe, expect, it } from "vitest";
import { resolveCopilotProvider, supportsCopilotByokProviderShape } from "./provider-bridge.js";

const COPILOT_BYOK_PROVIDER_ERROR =
  "[copilot-attempt] BYOK requires an OpenAI-compatible or Anthropic model api and a non-empty baseUrl";
const COPILOT_BYOK_TRANSPORT_POLICY_ERROR =
  "[copilot-attempt] BYOK does not support OpenClaw provider request proxy, TLS, or private-network policy overrides";
const COPILOT_BYOK_ENDPOINT_POLICY_ERROR =
  "[copilot-attempt] BYOK endpoint is blocked by OpenClaw SSRF policy";

describe("resolveCopilotProvider", () => {
  it("keeps the subscription provider on the native Copilot auth path", () => {
    expect(
      resolveCopilotProvider({
        model: {
          provider: "github-copilot",
          api: "github-copilot",
          id: "gpt-5",
          baseUrl: "https://ignored.example",
        },
        resolvedApiKey: "ignored",
      }),
    ).toEqual({ mode: "github-copilot" });
  });

  it("maps OpenAI Responses BYOK with a bearer token and stable limits", () => {
    const result = resolveCopilotProvider({
      model: {
        provider: "local-proxy",
        api: "openai-responses",
        id: "proxy-model",
        baseUrl: "https://proxy.example/v1",
        authHeader: true,
        contextTokens: 12_000,
        maxTokens: 512,
        headers: { "X-Trace": "test" },
      },
      resolvedApiKey: "secret-key",
      authProfileId: "local-proxy:main",
    });

    expect(result.mode).toBe("byok");
    expect(result.authProfileId).toBe("local-proxy:main");
    expect(result.authProfileVersion).toMatch(/^sha256:/);
    expect(result.provider).toEqual({
      type: "openai",
      wireApi: "responses",
      baseUrl: "https://proxy.example/v1",
      modelId: "proxy-model",
      wireModel: "proxy-model",
      bearerToken: "secret-key",
      headers: { "X-Trace": "test" },
      maxPromptTokens: 12_000,
      maxOutputTokens: 512,
    });
  });

  it("defaults custom BYOK providers without an api to OpenAI Responses", () => {
    const result = resolveCopilotProvider({
      model: {
        provider: "custom-proxy",
        id: "proxy-model",
        baseUrl: "https://proxy.example/v1",
      },
      resolvedApiKey: "secret-key",
    });

    expect(result.provider).toMatchObject({
      type: "openai",
      wireApi: "responses",
      baseUrl: "https://proxy.example/v1",
    });
    expect(supportsCopilotByokProviderShape({ baseUrl: "https://proxy.example/v1" })).toBe(true);
  });

  it("maps OpenAI Chat Completions BYOK bearer auth with the provider-local model id", () => {
    const result = resolveCopilotProvider({
      model: {
        provider: "tencent-tokenplan",
        api: "openai-completions",
        id: "hy3",
        baseUrl: "https://tokenplan.example/v1",
        authHeader: true,
      },
      resolvedApiKey: "secret-key",
    });

    expect(result.provider).toMatchObject({
      type: "openai",
      wireApi: "completions",
      baseUrl: "https://tokenplan.example/v1",
      modelId: "hy3",
      wireModel: "hy3",
      bearerToken: "secret-key",
    });
  });

  it("changes the BYOK compatibility fingerprint when token limits change", () => {
    const base = {
      provider: "custom-proxy",
      api: "openai-responses",
      id: "proxy-model",
      baseUrl: "https://proxy.example/v1",
    };

    const small = resolveCopilotProvider({
      model: { ...base, contextTokens: 8_000, maxTokens: 512 },
      resolvedApiKey: "secret-key",
    });
    const large = resolveCopilotProvider({
      model: { ...base, contextTokens: 16_000, maxTokens: 1024 },
      resolvedApiKey: "secret-key",
    });

    expect(small.authProfileVersion).not.toBe(large.authProfileVersion);
  });

  it("maps Anthropic and Ollama-compatible APIs", () => {
    expect(
      resolveCopilotProvider({
        model: {
          provider: "anthropic-proxy",
          api: "anthropic-messages",
          id: "claude",
          baseUrl: "https://anthropic.example",
        },
      }).provider,
    ).toMatchObject({ type: "anthropic", baseUrl: "https://anthropic.example" });

    expect(
      resolveCopilotProvider({
        model: {
          provider: "ollama-compatible",
          api: "ollama",
          id: "qwen",
          baseUrl: "https://ollama-compatible.example/v1",
        },
      }).provider,
    ).toMatchObject({ type: "openai", wireApi: "completions" });
  });

  it("normalizes Azure OpenAI Responses config for the Copilot SDK provider contract", () => {
    const result = resolveCopilotProvider({
      model: {
        provider: "custom-azure",
        api: "azure-openai-responses",
        id: "deployment-gpt",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        azureApiVersion: "2025-01-01-preview",
      },
      resolvedApiKey: "azure-key",
    });

    expect(result.provider).toEqual({
      type: "azure",
      wireApi: "responses",
      baseUrl: "https://example.openai.azure.com",
      modelId: "deployment-gpt",
      wireModel: "deployment-gpt",
      apiKey: "azure-key",
      azure: { apiVersion: "2025-01-01-preview" },
    });
    expect(
      resolveCopilotProvider({
        model: {
          provider: "custom-azure",
          api: "azure-openai-responses",
          id: "deployment-gpt",
          baseUrl: "https://example.cognitiveservices.azure.com/openai/v1",
        },
      }).provider,
    ).toMatchObject({
      type: "azure",
      baseUrl: "https://example.cognitiveservices.azure.com",
    });
    expect(
      resolveCopilotProvider({
        model: {
          provider: "custom-azure",
          api: "azure-openai-responses",
          id: "deployment",
          baseUrl: "https://example.cognitiveservices.azure.com/openai/v1",
        },
      }).provider,
    ).not.toHaveProperty("azure");
    expect(
      resolveCopilotProvider({
        model: {
          provider: "custom-azure",
          api: "azure-openai-responses",
          id: "deployment-gpt",
          baseUrl: "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
        },
        resolvedApiKey: "azure-key",
      }).provider,
    ).toEqual({
      type: "openai",
      wireApi: "responses",
      baseUrl: "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
      modelId: "deployment-gpt",
      wireModel: "deployment-gpt",
      apiKey: "azure-key",
    });
  });

  it("does not forward local auth markers or null no-auth headers", () => {
    const result = resolveCopilotProvider({
      model: {
        provider: "local-proxy",
        api: "openai-completions",
        id: "local-model",
        baseUrl: "https://proxy.example/v1",
        authHeader: true,
        headers: {
          Authorization: null,
          "X-Local": "true",
        },
      },
      resolvedApiKey: "custom-local",
    });

    expect(result.provider).toEqual({
      type: "openai",
      wireApi: "completions",
      baseUrl: "https://proxy.example/v1",
      modelId: "local-model",
      wireModel: "local-model",
      headers: { "X-Local": "true" },
    });
  });

  it("does not synthesize SDK apiKey auth when request auth already prepared headers", () => {
    const result = resolveCopilotProvider({
      model: {
        provider: "custom-header-proxy",
        api: "openai-responses",
        id: "proxy-model",
        baseUrl: "https://proxy.example/v1",
        headers: { "x-api-key": "header-secret" },
        requestAuthMode: "header",
      },
      resolvedApiKey: "header-secret",
    });

    expect(result.provider).toEqual({
      type: "openai",
      wireApi: "responses",
      baseUrl: "https://proxy.example/v1",
      modelId: "proxy-model",
      wireModel: "proxy-model",
      headers: { "x-api-key": "header-secret" },
    });
  });

  it("rejects request transport policy the SDK provider config cannot enforce", () => {
    for (const model of [
      { requestProxy: { mode: "env-proxy" } },
      { requestTls: { ca: "ca-pem" } },
      { requestAllowPrivateNetwork: false },
    ]) {
      expect(() =>
        resolveCopilotProvider({
          model: {
            provider: "custom-proxy",
            api: "openai-responses",
            id: "proxy-model",
            baseUrl: "https://proxy.example/v1",
            ...model,
          },
        }),
      ).toThrow(COPILOT_BYOK_TRANSPORT_POLICY_ERROR);
    }
  });

  it("rejects BYOK endpoints blocked by OpenClaw SSRF policy", () => {
    for (const baseUrl of [
      "file://public.example/v1",
      "ftp://public.example/v1",
      "http://proxy.example/v1",
      "https://user:pass@proxy.example/v1",
      "https://proxy.example/v1?api_key=secret",
      "https://proxy.example/v1?x-api-key=secret",
      "https://proxy.example/v1?x-auth-token=secret",
      "https://proxy.example/v1?password=secret",
      "https://proxy.example/v1?client%5Fse%E2%80%8Bcret=secret",
      "http://169.254.169.254/v1",
      "http://metadata.google.internal/v1",
      "http://localhost:11434/v1",
    ]) {
      expect(() =>
        resolveCopilotProvider({
          model: {
            provider: "custom-proxy",
            api: "openai-responses",
            id: "proxy-model",
            baseUrl,
          },
        }),
      ).toThrow(COPILOT_BYOK_ENDPOINT_POLICY_ERROR);
    }
  });

  it("advertises support only for representable BYOK provider shapes", () => {
    expect(
      supportsCopilotByokProviderShape({
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      }),
    ).toBe(true);
    expect(
      supportsCopilotByokProviderShape({
        api: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      }),
    ).toBe(true);
    expect(
      supportsCopilotByokProviderShape({
        api: "azure-openai-responses",
        baseUrl: "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
      }),
    ).toBe(true);
    expect(
      supportsCopilotByokProviderShape({
        api: "azure-openai-responses",
        baseUrl: "https://project.services.ai.azure.com/api/projects/demo",
      }),
    ).toBe(false);
    expect(
      supportsCopilotByokProviderShape({
        api: "google-generative-ai",
        baseUrl: "https://google.example",
      }),
    ).toBe(false);
    expect(
      supportsCopilotByokProviderShape({
        api: "openai-responses",
        baseUrl: "file://public.example/v1",
      }),
    ).toBe(false);
    expect(
      supportsCopilotByokProviderShape({
        api: "openai-responses",
        baseUrl: "http://proxy.example/v1",
      }),
    ).toBe(false);
    expect(
      supportsCopilotByokProviderShape({
        api: "openai-responses",
        baseUrl: "https://user:pass@proxy.example/v1",
      }),
    ).toBe(false);
    expect(
      supportsCopilotByokProviderShape({
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1?api_key=secret",
      }),
    ).toBe(false);
    expect(
      supportsCopilotByokProviderShape({
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1?x-api-key=secret",
      }),
    ).toBe(false);
    expect(supportsCopilotByokProviderShape({ api: "openai-responses" })).toBe(false);
    expect(
      supportsCopilotByokProviderShape({
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
        requestProxy: { mode: "env-proxy" },
      }),
    ).toBe(false);
  });

  it("rejects provider APIs the SDK adapter cannot represent", () => {
    expect(() =>
      resolveCopilotProvider({
        model: {
          provider: "google",
          api: "google-generative-ai",
          id: "gemini",
          baseUrl: "https://google.example",
        },
      }),
    ).toThrow(COPILOT_BYOK_PROVIDER_ERROR);
  });

  it("requires an endpoint for non-subscription providers", () => {
    expect(() =>
      resolveCopilotProvider({
        model: {
          provider: "custom",
          api: "openai-completions",
          id: "model",
        },
      }),
    ).toThrow(COPILOT_BYOK_PROVIDER_ERROR);
  });
});

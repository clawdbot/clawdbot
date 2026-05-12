import { describe, expect, it } from "vitest";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import { makeModel } from "./model.test-harness.js";

describe("buildInlineProviderModels", () => {
  it("attaches provider ids to inline models", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      " alpha ": { baseUrl: "http://alpha.local", models: [makeModel("alpha-model")] },
      beta: { baseUrl: "http://beta.local", models: [makeModel("beta-model")] },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      {
        ...makeModel("alpha-model"),
        provider: "alpha",
        baseUrl: "http://alpha.local",
        api: undefined,
      },
      {
        ...makeModel("beta-model"),
        provider: "beta",
        baseUrl: "http://beta.local",
        api: undefined,
      },
    ]);
  });

  it("inherits baseUrl from provider when model does not specify it", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:8000",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      {
        ...makeModel("custom-model"),
        provider: "custom",
        baseUrl: "http://localhost:8000",
        api: undefined,
      },
    ]);
  });

  it("inherits api from provider when model does not specify it", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "anthropic-messages",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      {
        ...makeModel("custom-model"),
        provider: "custom",
        baseUrl: "http://localhost:8000",
        api: "anthropic-messages",
      },
    ]);
  });

  it("model-level api takes precedence over provider-level api", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "openai-responses",
        models: [{ ...makeModel("custom-model"), api: "anthropic-messages" as const }],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      {
        ...makeModel("custom-model"),
        provider: "custom",
        baseUrl: "http://localhost:8000",
        api: "anthropic-messages",
      },
    ]);
  });

  it("inherits both baseUrl and api from provider config", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        baseUrl: "http://localhost:10000",
        api: "anthropic-messages",
        models: [makeModel("claude-opus-4.5")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("custom");
    expect(result[0].baseUrl).toBe("http://localhost:10000");
    expect(result[0].api).toBe("anthropic-messages");
    expect(result[0].name).toBe("claude-opus-4.5");
  });

  it("normalizes bare Google API hosts for custom Google Generative AI providers", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      "google-paid ": {
        baseUrl: "https://generativelanguage.googleapis.com",
        api: "google-generative-ai",
        models: [makeModel("gemini-2.5-pro")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("google-paid");
    expect(result[0].api).toBe("google-generative-ai");
    expect(result[0].baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("merges provider-level headers into inline models", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      proxy: {
        baseUrl: "https://proxy.example.com",
        api: "anthropic-messages",
        headers: { "User-Agent": "custom-agent/1.0" },
        models: [makeModel("claude-sonnet-4-6")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      {
        ...makeModel("claude-sonnet-4-6"),
        provider: "proxy",
        baseUrl: "https://proxy.example.com",
        api: "anthropic-messages",
        headers: { "User-Agent": "custom-agent/1.0" },
      },
    ]);
  });

  it("merges provider request headers into inline models", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      proxy: {
        baseUrl: "https://proxy.example.com/v1",
        api: "openai-completions",
        request: {
          headers: {
            "X-Tenant": "acme",
          },
        },
        models: [makeModel("proxy-model")],
      },
    };

    const result = buildInlineProviderModels(providers);
    const [
      {
        id,
        name,
        reasoning,
        input,
        cost,
        contextWindow,
        maxTokens,
        provider,
        baseUrl,
        api,
        headers,
      },
    ] = result;

    expect(result).toHaveLength(1);
    expect({
      id,
      name,
      reasoning,
      input,
      cost,
      contextWindow,
      maxTokens,
      provider,
      baseUrl,
      api,
      headers: headers ? { ...headers } : undefined,
    }).toStrictEqual({
      id: "proxy-model",
      name: "proxy-model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
      provider: "proxy",
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-completions",
      headers: { "X-Tenant": "acme" },
    });
  });

  it("keeps inline provider transport overrides once the llm transport adapter is available", () => {
    const result = buildInlineProviderModels({
      proxy: {
        baseUrl: "https://proxy.example.com/v1",
        api: "openai-completions",
        request: {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
        models: [makeModel("proxy-model")],
      },
    } as unknown as Parameters<typeof buildInlineProviderModels>[0]);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("proxy");
    expect(result[0].api).toBe("openai-completions");
    expect(result[0].baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("omits headers when neither provider nor model specifies them", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      plain: {
        baseUrl: "http://localhost:8000",
        models: [makeModel("some-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].headers).toBeUndefined();
  });

  it("drops SecretRef marker headers in inline provider models", () => {
    const providers: Parameters<typeof buildInlineProviderModels>[0] = {
      custom: {
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual({
      "X-Static": "tenant-a",
    });
  });
});

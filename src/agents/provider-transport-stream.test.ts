import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { attachModelProviderLocalService } from "./provider-local-service.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  createOpenClawTransportStreamFnForModel,
  createTransportAwareStreamFnForModel,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

function buildModel<TApi extends Api>(
  api: TApi,
  params: {
    id: string;
    provider: string;
    baseUrl: string;
  },
): Model<TApi> {
  return {
    id: params.id,
    name: params.id,
    api,
    provider: params.provider,
    baseUrl: params.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

describe("provider transport stream contracts", () => {
  it("covers the supported transport api alias matrix", () => {
    const cases = [
      {
        api: "openai-responses" as const,
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        alias: "openclaw-openai-responses-transport",
      },
      {
        api: "openai-codex-responses" as const,
        provider: "openai-codex",
        id: "codex-mini-latest",
        baseUrl: "https://chatgpt.com/backend-api",
        alias: "openclaw-openai-responses-transport",
      },
      {
        api: "openai-completions" as const,
        provider: "xai",
        id: "grok-4",
        baseUrl: "https://api.x.ai/v1",
        alias: "openclaw-openai-completions-transport",
      },
      {
        api: "azure-openai-responses" as const,
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        alias: "openclaw-azure-openai-responses-transport",
      },
      {
        api: "anthropic-messages" as const,
        provider: "anthropic",
        id: "claude-sonnet-4.6",
        baseUrl: "https://api.anthropic.com",
        alias: "openclaw-anthropic-messages-transport",
      },
      {
        api: "google-generative-ai" as const,
        provider: "google",
        id: "gemini-3.1-pro-preview",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        alias: "openclaw-google-generative-ai-transport",
        providerOwnedRuntime: true,
      },
    ];

    for (const testCase of cases) {
      const model = attachModelProviderRequestTransport(
        buildModel(testCase.api, {
          id: testCase.id,
          provider: testCase.provider,
          baseUrl: testCase.baseUrl,
        }),
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      );

      expect(isTransportAwareApiSupported(testCase.api)).toBe(true);
      expect(resolveTransportAwareSimpleApi(testCase.api)).toBe(testCase.alias);
      if (testCase.providerOwnedRuntime) {
        continue;
      }
      expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(createTransportAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
      const preparedModel = prepareTransportAwareSimpleModel(model);
      expect(preparedModel.api).toBe(testCase.alias);
      expect(preparedModel.provider).toBe(testCase.provider);
      expect(preparedModel.id).toBe(testCase.id);
    }
  });

  it("fails closed when unsupported apis carry transport overrides", () => {
    const model = attachModelProviderRequestTransport(
      buildModel("ollama", {
        id: "qwen3:32b",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(isTransportAwareApiSupported(model.api)).toBe(false);
    expect(resolveTransportAwareSimpleApi(model.api)).toBeUndefined();
    expect(createBoundaryAwareStreamFnForModel(model)).toBeUndefined();
    expect(() => createTransportAwareStreamFnForModel(model)).toThrow(
      'Model-provider request.proxy/request.tls/localService is not yet supported for api "ollama"',
    );
    expect(() => buildTransportAwareSimpleStreamFn(model)).toThrow(
      'Model-provider request.proxy/request.tls/localService is not yet supported for api "ollama"',
    );
    expect(() => prepareTransportAwareSimpleModel(model)).toThrow(
      'Model-provider request.proxy/request.tls/localService is not yet supported for api "ollama"',
    );
  });

  it("keeps unsupported apis unchanged when no transport overrides are attached", () => {
    const model = buildModel("ollama", {
      id: "qwen3:32b",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });

    expect(createTransportAwareStreamFnForModel(model)).toBeUndefined();
    expect(buildTransportAwareSimpleStreamFn(model)).toBeUndefined();
    expect(prepareTransportAwareSimpleModel(model)).toBe(model);
  });

  it("keeps OpenAI API-key default streams on OpenClaw transport", () => {
    const cases = [
      buildModel("openai-responses", {
        id: "gpt-5.4",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
      buildModel("openai-completions", {
        id: "gpt-4o",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
    ] as const;

    for (const model of cases) {
      expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(createOpenClawTransportStreamFnForModel(model)).toBeTypeOf("function");
      expect(createTransportAwareStreamFnForModel(model)).toBeUndefined();
      expect(buildTransportAwareSimpleStreamFn(model)).toBeUndefined();
      expect(prepareTransportAwareSimpleModel(model)).toBe(model);
    }
  });

  it("routes localService models through the OpenClaw simple-completion transport", () => {
    const model = attachModelProviderLocalService(
      buildModel("openai-completions", {
        id: "google/gemma-4-E2B-it",
        provider: "inferrs",
        baseUrl: "http://127.0.0.1:8080/v1",
      }),
      {
        command: "/usr/local/bin/inferrs",
        args: ["serve", "google/gemma-4-E2B-it"],
      },
    );

    expect(createTransportAwareStreamFnForModel(model)).toBeTypeOf("function");
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
    const preparedModel = prepareTransportAwareSimpleModel(model);
    expect(preparedModel.api).toBe("openclaw-openai-completions-transport");
    expect(preparedModel.provider).toBe("inferrs");
    expect(preparedModel.id).toBe("google/gemma-4-E2B-it");
  });

  it("keeps Codex defaults on the OpenClaw transport until PI preserves attribution", () => {
    const model = buildModel("openai-codex-responses", {
      id: "gpt-5.4",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    });

    expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
    expect(createTransportAwareStreamFnForModel(model)).toBeUndefined();
    expect(buildTransportAwareSimpleStreamFn(model)).toBeUndefined();
    expect(prepareTransportAwareSimpleModel(model)).toBe(model);
  });
});

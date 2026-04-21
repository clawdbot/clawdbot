import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

function createGlm47Template() {
  return {
    id: "glm-4.7",
    name: "GLM-4.7",
    provider: "zai",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
  };
}

describe("zai provider plugin", () => {
  it("owns replay policy for OpenAI-compatible Z.ai transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-completions",
        modelId: "glm-5.1",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-responses",
        modelId: "glm-5.1",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
  });

  it("resolves persisted GLM-5 family models with provider-owned metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = createGlm47Template();

    const cases = [
      {
        modelId: "glm-5.1",
        expected: {
          input: ["text"],
          reasoning: true,
          contextWindow: 202800,
          maxTokens: 131100,
        },
      },
      {
        modelId: "glm-5v-turbo",
        expected: {
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 202800,
          maxTokens: 131100,
        },
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        provider.resolveDynamicModel?.({
          provider: "zai",
          modelId: testCase.modelId,
          modelRegistry: {
            find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
          },
        } as never),
      ).toMatchObject({
        provider: "zai",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        id: testCase.modelId,
        ...testCase.expected,
      });
    }
  });

  it("returns an already-registered GLM-5 variant as-is", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const registered = {
      id: "glm-5-turbo",
      name: "GLM-5-Turbo",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: false,
      input: ["text"],
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 123456,
      maxTokens: 54321,
    };
    const template = createGlm47Template();

    expect(
      provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: "glm-5-turbo",
        modelRegistry: {
          find: (_provider: string, modelId: string) =>
            modelId === "glm-5-turbo" ? registered : modelId === "glm-4.7" ? template : null,
        },
      } as never),
    ).toEqual(registered);
  });

  it("still synthesizes unknown GLM-5 variants from the GLM-4.7 template", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = createGlm47Template();

    expect(
      provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: "glm-5-turbo",
        modelRegistry: {
          find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
        },
      } as never),
    ).toMatchObject({
      id: "glm-5-turbo",
      name: "GLM-5 Turbo",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
    });
  });

  it("wires tool-stream defaults through the shared stream family hook", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const defaultWrapped = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: {},
      streamFn: baseStreamFn,
    } as never);

    void defaultWrapped?.(
      {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5.1",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).toMatchObject({
      tool_stream: true,
    });

    const disabledWrapped = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: { tool_stream: false },
      streamFn: baseStreamFn,
    } as never);

    void disabledWrapped?.(
      {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5.1",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).not.toHaveProperty("tool_stream");
  });

  it("defaults tool_stream extra params but preserves explicit values", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.prepareExtraParams?.({
        provider: "zai",
        modelId: "glm-4.7",
        extraParams: { endpoint: "global" },
      } as never),
    ).toEqual({
      endpoint: "global",
      tool_stream: true,
    });

    const explicit = { endpoint: "global", tool_stream: false };
    expect(
      provider.prepareExtraParams?.({
        provider: "zai",
        modelId: "glm-4.7",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });
});

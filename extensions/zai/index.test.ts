import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
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

function expectReplayPolicyFields(
  policy: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): void {
  if (!policy) {
    throw new Error("Expected replay policy");
  }
  for (const [key, value] of Object.entries(fields)) {
    expect(policy[key]).toEqual(value);
  }
}

function expectModelFields(
  model: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): void {
  if (!model) {
    throw new Error("Expected provider model");
  }
  for (const [key, value] of Object.entries(fields)) {
    expect(model[key]).toEqual(value);
  }
}

describe("zai provider plugin", () => {
  it("owns replay policy for OpenAI-compatible Z.ai transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expectReplayPolicyFields(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-completions",
        modelId: "glm-5.1",
      } as never) as Record<string, unknown> | undefined,
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        applyAssistantFirstOrderingFix: true,
        validateGeminiTurns: true,
        validateAnthropicTurns: true,
      },
    );

    expectReplayPolicyFields(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-responses",
        modelId: "glm-5.1",
      } as never) as Record<string, unknown> | undefined,
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        applyAssistantFirstOrderingFix: false,
        validateGeminiTurns: false,
        validateAnthropicTurns: false,
      },
    );
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
      const resolved = provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: testCase.modelId,
        modelRegistry: {
          find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
        },
      } as never) as Record<string, unknown> | undefined;
      expectModelFields(resolved, {
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

    const resolved = provider.resolveDynamicModel?.({
      provider: "zai",
      modelId: "glm-5-turbo",
      modelRegistry: {
        find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
      },
    } as never) as Record<string, unknown> | undefined;
    expectModelFields(resolved, {
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

    expect(capturedPayload?.tool_stream).toBe(true);

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

  it("maps thinking off to Z.AI thinking disabled", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: {},
      thinkingLevel: "off",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5.1",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload?.tool_stream).toBe(true);
    expect(capturedPayload?.thinking).toEqual({ type: "disabled" });
  });

  it("enables Z.AI preserved thinking only when requested", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrappedWithoutPreserve = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: {},
      thinkingLevel: "low",
      streamFn: baseStreamFn,
    } as never);

    void wrappedWithoutPreserve?.(
      {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5.1",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload?.tool_stream).toBe(true);
    expect(capturedPayload).not.toHaveProperty("thinking");

    const wrappedWithPreserve = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: { preserveThinking: true },
      thinkingLevel: "low",
      streamFn: baseStreamFn,
    } as never);

    void wrappedWithPreserve?.(
      {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5.1",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload?.tool_stream).toBe(true);
    expect(capturedPayload?.thinking).toEqual({ type: "enabled", clear_thinking: false });
  });

  it("preserves replayed reasoning_content for Z.AI preserved thinking", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const model = {
      provider: "zai",
      id: "glm-5.1",
      name: "GLM 5.1",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 131_072,
    } as Model<"openai-completions">;
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "zai",
          model: "glm-5.1",
          content: [
            {
              type: "thinking",
              thinking: "prior reasoning",
              thinkingSignature: "reasoning_content",
            },
            { type: "text", text: "visible reply" },
          ],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
        { role: "user", content: "continue", timestamp: 3 },
      ],
    } as Context;
    const baseStreamFn: StreamFn = (streamModel, streamContext, options) => {
      const payload = buildOpenAICompletionsParams(streamModel as never, streamContext, {
        reasoning: "high",
      } as never);
      options?.onPayload?.(payload as never, streamModel as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: { preserve_thinking: true },
      thinkingLevel: "low",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(model, context, {});

    expect(capturedPayload?.thinking).toEqual({ type: "enabled", clear_thinking: false });
    const assistantMessage = (capturedPayload!.messages as Array<Record<string, unknown>>)[1];
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.content).toBe("visible reply");
    expect(assistantMessage?.reasoning_content).toBe("prior reasoning");
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

  it("uses deprecated pi agent auth.json for usage auth when modern sources are empty", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zai-legacy-auth-"));
    try {
      const authDir = path.join(home, ".pi", "agent");
      await fs.mkdir(authDir, { recursive: true });
      await fs.writeFile(
        path.join(authDir, "auth.json"),
        `${JSON.stringify({ "z-ai": { access: "legacy-zai-token" } }, null, 2)}\n`,
        "utf-8",
      );
      const provider = await registerSingleProviderPlugin(plugin);

      await expect(
        provider.resolveUsageAuth?.({
          env: { HOME: home },
          resolveApiKeyFromConfigAndStore: () => undefined,
        } as never),
      ).resolves.toEqual({ token: "legacy-zai-token" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

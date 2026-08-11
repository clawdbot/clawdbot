// LongCat tests cover provider registration, onboarding, and wire compatibility.
import { readFileSync } from "node:fs";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { LONGCAT_DEFAULT_MODEL_REF } from "./models.js";
import { applyLongCatConfig } from "./onboard.js";
import { buildLongCatProvider } from "./provider-catalog.js";
import { createLongCatThinkingWrapper } from "./stream.js";

function readManifest() {
  return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8")) as {
    providerAuthChoices?: Array<{ choiceId?: string; optionKey?: string; cliFlag?: string }>;
    setup?: { providers?: Array<{ id?: string; envVars?: string[] }> };
  };
}

function requireLongCatModel(): Model<"openai-completions"> {
  const model = buildLongCatProvider().models?.[0];
  if (!model) {
    throw new Error("LongCat catalog did not provide a model");
  }
  return {
    ...model,
    api: "openai-completions",
    baseUrl: "https://api.longcat.chat/openai",
    provider: "longcat",
    input: ["text"],
    cost: { ...model.cost },
  } as Model<"openai-completions">;
}

describe("LongCat provider plugin", () => {
  it("registers the manifest-owned API key onboarding flow", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider).toMatchObject({
      id: "longcat",
      aliases: ["meituan-longcat"],
      envVars: ["LONGCAT_API_KEY"],
    });
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      kind: "api_key",
      wizard: { choiceId: "longcat-api-key" },
    });
    expect(readManifest().providerAuthChoices).toEqual([
      expect.objectContaining({
        choiceId: "longcat-api-key",
        optionKey: "longcatApiKey",
        cliFlag: "--longcat-api-key",
      }),
    ]);
    expect(readManifest().setup?.providers).toEqual([
      { id: "longcat", envVars: ["LONGCAT_API_KEY"] },
    ]);
  });

  it("exposes the hosted LongCat-2.0 catalog", () => {
    expect(buildLongCatProvider()).toMatchObject({
      baseUrl: "https://api.longcat.chat/openai",
      api: "openai-completions",
      models: [
        expect.objectContaining({
          id: "LongCat-2.0",
          reasoning: true,
          contextWindow: 1_048_576,
          maxTokens: 131_072,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
            requiresReasoningContentOnAssistantMessages: true,
            thinkingFormat: "deepseek",
          },
        }),
      ],
    });
  });

  it("applies the LongCat catalog without replacing an existing primary model", () => {
    const result = applyLongCatConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    });

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5.5");
    expect(result.agents?.defaults?.models?.[LONGCAT_DEFAULT_MODEL_REF]).toEqual({
      alias: "LongCat 2.0",
    });
  });

  it("uses LongCat thinking and replay fields without reasoning_effort", () => {
    const model = requireLongCatModel();
    const context = {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "read it", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "longcat",
          model: "LongCat-2.0",
          content: [
            {
              type: "thinking",
              thinking: "use the read tool",
              thinkingSignature: "reasoning_content",
            },
            { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          ],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read data",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as Context;
    let payload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (streamModel, streamContext, options) => {
      const params = buildOpenAICompletionsParams(
        streamModel as Model<"openai-completions">,
        streamContext,
        { maxTokens: 2048, reasoning: "high" } as never,
      ) as Record<string, unknown>;
      options?.onPayload?.(params, streamModel);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };
    const wrappedStreamFn = createLongCatThinkingWrapper(baseStreamFn, "high");

    void wrappedStreamFn(model, context, {
      onPayload: (nextPayload) => {
        payload = nextPayload as Record<string, unknown>;
      },
    });
    if (!payload) {
      throw new Error("LongCat payload was not captured");
    }

    expect(payload).toMatchObject({
      max_tokens: 2048,
      thinking: { type: "enabled" },
    });
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("stream_options");
    expect(payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: "system" }),
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "use the read tool",
        }),
      ]),
    );
  });
});

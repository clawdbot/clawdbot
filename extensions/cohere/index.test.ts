import { readFileSync } from "node:fs";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { COHERE_COMMAND_A_PLUS_MODEL_ID } from "./models.js";
import { buildCohereProvider } from "./provider-catalog.js";
import { createCohereCompletionsWrapper } from "./stream.js";

const COHERE_COMMAND_A_REASONING_MODEL_ID = "command-a-reasoning-08-2025";
const COHERE_COMMAND_A_VISION_MODEL_ID = "command-a-vision-07-2025";
const COHERE_NORTH_MINI_CODE_MODEL_ID = "north-mini-code-1-0";

function readManifest() {
  return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8")) as {
    providerAuthChoices?: Array<{ choiceId?: string; optionKey?: string; cliFlag?: string }>;
    setup?: { providers?: Array<{ id?: string; envVars?: string[] }> };
  };
}

function requireCohereModel(modelId = COHERE_COMMAND_A_PLUS_MODEL_ID): Model<"openai-completions"> {
  const provider = buildCohereProvider();
  const model = provider.models?.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error("Cohere catalog did not provide a model");
  }
  return {
    ...model,
    provider: "cohere",
    api: "openai-completions",
    baseUrl: provider.baseUrl,
  } as Model<"openai-completions">;
}

function captureCoherePayload(
  context: Context,
  settings?: { modelId?: string; reasoning?: string },
): Record<string, unknown> {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (model, streamContext, streamOptions) => {
    const payload = buildOpenAICompletionsParams(
      model as Model<"openai-completions">,
      streamContext,
      { maxTokens: 2048, reasoning: settings?.reasoning } as never,
    );
    streamOptions?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const wrappedStreamFn = createCohereCompletionsWrapper(baseStreamFn);
  if (!wrappedStreamFn) {
    throw new Error("Cohere wrapper did not return a stream function");
  }
  void wrappedStreamFn(requireCohereModel(settings?.modelId), context, {
    onPayload: (payload) => {
      captured = payload as Record<string, unknown>;
    },
  });
  if (!captured) {
    throw new Error("Cohere payload was not captured");
  }
  return captured;
}

describe("Cohere provider plugin", () => {
  it("registers the manifest-owned API key onboarding flow", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.auth.map((method) => method.wizard?.choiceId)).toEqual(["cohere-api-key"]);
    expect(provider).toMatchObject({
      id: "cohere",
      envVars: ["COHERE_API_KEY"],
    });
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      kind: "api_key",
      wizard: { choiceId: "cohere-api-key" },
    });
    expect(readManifest().providerAuthChoices).toEqual([
      expect.objectContaining({
        choiceId: "cohere-api-key",
        optionKey: "cohereApiKey",
        cliFlag: "--cohere-api-key",
      }),
    ]);
    expect(readManifest().setup?.providers).toEqual([
      { id: "cohere", envVars: ["COHERE_API_KEY"] },
    ]);
  });

  it("exposes the static Cohere catalog", () => {
    expect(buildCohereProvider()).toMatchObject({
      baseUrl: "https://api.cohere.ai/compatibility/v1",
      api: "openai-completions",
      models: [
        expect.objectContaining({
          id: COHERE_COMMAND_A_PLUS_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 64000,
          compat: expect.objectContaining({
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["none", "high"],
          }),
        }),
        expect.objectContaining({
          id: "command-a-03-2025",
          compat: {
            supportsStore: false,
            supportsUsageInStreaming: false,
            maxTokensField: "max_tokens",
          },
        }),
        expect.objectContaining({
          id: COHERE_COMMAND_A_REASONING_MODEL_ID,
          reasoning: true,
          input: ["text"],
          contextWindow: 256000,
          maxTokens: 32000,
        }),
        expect.objectContaining({
          id: COHERE_COMMAND_A_VISION_MODEL_ID,
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 8000,
          compat: expect.objectContaining({ supportsTools: false }),
        }),
        expect.objectContaining({
          id: "north-mini-code-1-0",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 256000,
          maxTokens: 64000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            supportsStore: false,
            supportsUsageInStreaming: false,
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["none", "high"],
            reasoningEffortMap: {
              off: "none",
              none: "none",
              minimal: "high",
              low: "high",
              medium: "high",
              high: "high",
              xhigh: "high",
              adaptive: "high",
              max: "high",
            },
            maxTokensField: "max_tokens",
          },
        }),
      ],
    });
  });

  it("uses Cohere's OpenAI-compatible completions payload fields", () => {
    const params = captureCoherePayload({
      systemPrompt: "system",
      messages: [],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as Context);

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("stream_options");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "developer", content: "system" })]),
    );
    expect(params.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system", content: "system" })]),
    );
  });

  it("maps North Mini Code thinking levels to Cohere's supported reasoning efforts", () => {
    const context = { messages: [] } as Context;

    expect(
      captureCoherePayload(context, {
        modelId: COHERE_NORTH_MINI_CODE_MODEL_ID,
        reasoning: "off",
      }).reasoning_effort,
    ).toBe("none");
    expect(
      captureCoherePayload(context, {
        modelId: COHERE_NORTH_MINI_CODE_MODEL_ID,
        reasoning: "high",
      }).reasoning_effort,
    ).toBe("high");
  });

  it("maps Command A+ and Command A Reasoning to Cohere's supported reasoning efforts", () => {
    const context = { messages: [] } as Context;

    for (const modelId of [COHERE_COMMAND_A_PLUS_MODEL_ID, COHERE_COMMAND_A_REASONING_MODEL_ID]) {
      expect(captureCoherePayload(context, { modelId, reasoning: "off" }).reasoning_effort).toBe(
        "none",
      );
      expect(captureCoherePayload(context, { modelId, reasoning: "medium" }).reasoning_effort).toBe(
        "high",
      );
    }
  });

  it("advertises only tool-capable current Cohere models to modern live sweeps", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.isModernModelRef?.({ provider: "cohere", modelId: COHERE_COMMAND_A_PLUS_MODEL_ID }),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "cohere",
        modelId: COHERE_COMMAND_A_REASONING_MODEL_ID,
      }),
    ).toBe(true);
    expect(provider.isModernModelRef?.({ provider: "cohere", modelId: "command-a-03-2025" })).toBe(
      false,
    );
    expect(
      provider.isModernModelRef?.({
        provider: "cohere",
        modelId: COHERE_COMMAND_A_VISION_MODEL_ID,
      }),
    ).toBe(false);
  });
});

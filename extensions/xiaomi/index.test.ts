// Xiaomi tests cover index plugin behavior.
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
  resolveProviderPluginChoice,
  type RegisteredProviderCollections,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import xiaomiPlugin from "./index.js";
import { createMiMoThinkingWrapper } from "./stream.js";

type OpenAICompletionsModel = Model<"openai-completions">;

type PayloadCapture = {
  payload?: Record<string, unknown>;
};

type ThinkingPayload = {
  type?: unknown;
};

type ReplayToolCall = {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

type RegisteredProvider = RegisteredProviderCollections["providers"][number];
const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function requireThinkingProfileResolver(
  provider: RegisteredProvider,
): NonNullable<RegisteredProvider["resolveThinkingProfile"]> {
  if (!provider.resolveThinkingProfile) {
    throw new Error("Xiaomi provider did not register a thinking profile resolver");
  }
  return provider.resolveThinkingProfile;
}

const readToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
const readToolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 3,
};
const readTool = {
  name: "read",
  description: "Read data",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

const registerXiaomiPlugin = () =>
  registerProviderPlugin({
    plugin: xiaomiPlugin,
    id: "xiaomi",
    name: "Xiaomi Provider",
  });

async function getXiaomiProvider() {
  const { providers } = await registerXiaomiPlugin();
  return requireRegisteredProvider(providers, "xiaomi");
}

async function getXiaomiTokenPlanProvider() {
  const { providers } = await registerXiaomiPlugin();
  return requireRegisteredProvider(providers, "xiaomi-token-plan");
}

function mimoReasoningModel(
  id: "mimo-v2.5" | "mimo-v2.5-pro" | "mimo-v2.6-pro",
  provider: "xiaomi" | "xiaomi-token-plan" = "xiaomi",
): OpenAICompletionsModel {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://api.xiaomimimo.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_000,
    compat: {},
  } as OpenAICompletionsModel;
}

function replayAssistantMessage(params: {
  provider: string;
  model: string;
  content: Array<Record<string, unknown>>;
  stopReason: "stop" | "toolUse";
}) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: params.provider,
    model: params.model,
    content: params.content,
    usage: emptyUsage,
    stopReason: params.stopReason,
    timestamp: 2,
  };
}

function readToolReplayContext(assistantMessage: ReturnType<typeof replayAssistantMessage>) {
  return {
    messages: [{ role: "user", content: "hi", timestamp: 1 }, assistantMessage, readToolResult],
    tools: [readTool],
  } as Context;
}

function mimoReasoningToolReplayContext(provider = "xiaomi") {
  return readToolReplayContext(
    replayAssistantMessage({
      provider,
      model: "mimo-v2.5-pro",
      content: [
        {
          type: "thinking",
          thinking: "call reasoning",
          thinkingSignature: "reasoning_content",
        },
        readToolCall,
      ],
      stopReason: "toolUse",
    }),
  );
}

function createPayloadCapturingStream(capture: PayloadCapture, model: OpenAICompletionsModel) {
  return (
    _streamModel: OpenAICompletionsModel,
    streamContext: Context,
    options?: { onPayload?: (payload: unknown, m: unknown) => unknown },
  ) => {
    capture.payload = buildOpenAICompletionsParams(model, streamContext, {
      reasoning: "high",
    } as never);
    options?.onPayload?.(capture.payload, model);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
}

function requireThinkingWrapper(
  wrapper: ReturnType<typeof createMiMoThinkingWrapper>,
  label: string,
): NonNullable<ReturnType<typeof createMiMoThinkingWrapper>> {
  if (!wrapper) {
    throw new Error(`expected MiMo thinking wrapper for ${label}`);
  }
  return wrapper;
}

function readThinking(payload: Record<string, unknown> | undefined): ThinkingPayload | undefined {
  return payload?.thinking as ThinkingPayload | undefined;
}

function readPayloadMessage(
  capture: PayloadCapture,
  index: number,
): Record<string, unknown> | undefined {
  return (capture.payload?.messages as Array<Record<string, unknown>> | undefined)?.[index];
}

function readFirstToolCall(
  message: Record<string, unknown> | undefined,
): ReplayToolCall | undefined {
  return (message?.tool_calls as ReplayToolCall[] | undefined)?.[0];
}

describe("xiaomi provider plugin", () => {
  it("registers Xiaomi pay-as-you-go auth metadata", async () => {
    const { providers } = await registerXiaomiPlugin();
    const provider = requireRegisteredProvider(providers, "xiaomi");
    const resolved = resolveProviderPluginChoice({
      providers,
      choice: "xiaomi-api-key",
    });

    expect(provider.id).toBe("xiaomi");
    expect(provider.label).toBe("Xiaomi");
    expect(provider.envVars).toEqual(["XIAOMI_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]?.label).toBe("Xiaomi API key (Pay-as-you-go)");
    if (!resolved) {
      throw new Error("expected Xiaomi api-key auth choice");
    }
    expect(resolved.provider.id).toBe("xiaomi");
    expect(resolved.method.id).toBe("api-key");
  });

  it("registers Xiaomi Token Plan regional auth metadata", async () => {
    const { providers } = await registerXiaomiPlugin();
    const provider = requireRegisteredProvider(providers, "xiaomi-token-plan");
    const resolved = resolveProviderPluginChoice({
      providers,
      choice: "xiaomi-token-plan-sgp",
    });

    expect(provider.id).toBe("xiaomi-token-plan");
    expect(provider.label).toBe("Xiaomi Token Plan");
    expect(provider.envVars).toEqual(["XIAOMI_TOKEN_PLAN_API_KEY"]);
    expect(
      provider.auth.map((method) => ({
        id: method.id,
        label: method.label,
        hint: method.hint,
        choiceId: method.wizard?.choiceId,
      })),
    ).toEqual([
      {
        id: "token-plan-ams",
        label: "Xiaomi Token Plan (Europe)",
        hint: "Endpoint preset: token-plan-ams.xiaomimimo.com/v1",
        choiceId: "xiaomi-token-plan-ams",
      },
      {
        id: "token-plan-cn",
        label: "Xiaomi Token Plan (China)",
        hint: "Endpoint preset: token-plan-cn.xiaomimimo.com/v1",
        choiceId: "xiaomi-token-plan-cn",
      },
      {
        id: "token-plan-sgp",
        label: "Xiaomi Token Plan (Singapore)",
        hint: "Endpoint preset: token-plan-sgp.xiaomimimo.com/v1",
        choiceId: "xiaomi-token-plan-sgp",
      },
    ]);
    if (!resolved) {
      throw new Error("expected Xiaomi token-plan auth choice");
    }
    expect(resolved.provider.id).toBe("xiaomi-token-plan");
    expect(resolved.method.id).toBe("token-plan-sgp");
  });

  it("builds the static Xiaomi model catalog with reasoning flags", async () => {
    const provider = await getXiaomiProvider();
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.xiaomimimo.com/v1");

    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "mimo-v2.5",
      "mimo-v2.5-pro",
    ]);
    expect(catalogProvider.models?.find((m) => m.id === "mimo-v2.5")?.input).toEqual([
      "text",
      "image",
    ]);
    expect(catalogProvider.models?.every((model) => model.reasoning)).toBe(true);
  });

  it("exposes Token Plan v2.5 catalog rows only after a provider config selects a region", async () => {
    const provider = await getXiaomiTokenPlanProvider();

    const missingConfig = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "tp-test" }),
      resolveProviderAuth: () => ({
        apiKey: "tp-test",
        mode: "api_key",
        source: "env",
      }),
    } as never);
    expect(missingConfig).toBeNull();

    const configured = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            "xiaomi-token-plan": {
              baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "tp-test" }),
      resolveProviderAuth: () => ({
        apiKey: "tp-test",
        mode: "api_key",
        source: "profile",
        profileId: "xiaomi-token-plan:default",
      }),
    } as never);
    if (!configured || !("provider" in configured)) {
      throw new Error("expected configured Xiaomi Token Plan catalog");
    }
    expect(configured.provider.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1");
    expect(configured.provider.api).toBe("openai-completions");
    expect(configured.provider.models?.map((model) => model.id)).toEqual([
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ]);
    expect(configured.provider.models?.find((model) => model.id === "mimo-v2.5")?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("rejects token-plan keys on the pay-as-you-go auth choice", async () => {
    const provider = await getXiaomiProvider();
    const method = provider.auth[0];
    if (!method?.runNonInteractive) {
      throw new Error("expected Xiaomi pay-as-you-go non-interactive auth");
    }

    await expect(
      method.runNonInteractive({
        authChoice: "xiaomi-api-key",
        config: {},
        baseConfig: {},
        opts: { xiaomiApiKey: "tp-test" },
        runtime: {} as never,
        resolveApiKey: async () => ({
          key: "tp-test",
          source: "flag",
        }),
        toApiKeyCredential: vi.fn(),
      } as never),
    ).rejects.toThrow(
      "This looks like a Xiaomi MiMo Token Plan key (tp-...). " +
        "Re-run onboarding with one of: --auth-choice xiaomi-token-plan-cn, " +
        "--auth-choice xiaomi-token-plan-sgp, or --auth-choice xiaomi-token-plan-ams.",
    );
  });

  it("rejects pay-as-you-go keys on Token Plan auth choices", async () => {
    const provider = await getXiaomiTokenPlanProvider();
    const method = provider.auth.find((entry) => entry.id === "token-plan-ams");
    if (!method?.runNonInteractive) {
      throw new Error("expected Xiaomi Token Plan non-interactive auth");
    }

    await expect(
      method.runNonInteractive({
        authChoice: "xiaomi-token-plan-ams",
        config: {},
        baseConfig: {},
        opts: { xiaomiTokenPlanApiKey: "sk-test" },
        runtime: {} as never,
        resolveApiKey: async () => ({
          key: "sk-test",
          source: "flag",
        }),
        toApiKeyCredential: vi.fn(),
      } as never),
    ).rejects.toThrow(
      "This looks like a Xiaomi MiMo pay-as-you-go key (sk-...). " +
        `Re-run onboarding with --auth-choice xiaomi-api-key or pass --xiaomi-api-key.`,
    );
  });

  it("rejects keys that do not start with sk- on the pay-as-you-go auth choice", async () => {
    const provider = await getXiaomiProvider();
    const method = provider.auth[0];
    if (!method?.runNonInteractive) {
      throw new Error("expected Xiaomi pay-as-you-go non-interactive auth");
    }

    await expect(
      method.runNonInteractive({
        authChoice: "xiaomi-api-key",
        config: {},
        baseConfig: {},
        opts: { xiaomiApiKey: "bad-key" },
        runtime: {} as never,
        resolveApiKey: async () => ({
          key: "bad-key",
          source: "flag",
        }),
        toApiKeyCredential: vi.fn(),
      } as never),
    ).rejects.toThrow(
      'Xiaomi MiMo pay-as-you-go keys must start with "sk-". The entered key does not match the expected format.',
    );
  });

  it("rejects keys that do not start with tp- on Token Plan auth choices", async () => {
    const provider = await getXiaomiTokenPlanProvider();
    const method = provider.auth.find((entry) => entry.id === "token-plan-ams");
    if (!method?.runNonInteractive) {
      throw new Error("expected Xiaomi Token Plan non-interactive auth");
    }

    await expect(
      method.runNonInteractive({
        authChoice: "xiaomi-token-plan-ams",
        config: {},
        baseConfig: {},
        opts: { xiaomiTokenPlanApiKey: "bad-key" },
        runtime: {} as never,
        resolveApiKey: async () => ({
          key: "bad-key",
          source: "flag",
        }),
        toApiKeyCredential: vi.fn(),
      } as never),
    ).rejects.toThrow(
      'Xiaomi MiMo Token Plan keys must start with "tp-". The entered key does not match the expected format.',
    );
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await getXiaomiProvider();

    const replayPolicy = provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never);
    expect(replayPolicy?.sanitizeToolCallIds).toBe(true);
    expect(replayPolicy?.toolCallIdMode).toBe("strict");
    expect(replayPolicy?.validateGeminiTurns).toBe(true);
    expect(replayPolicy?.validateAnthropicTurns).toBe(true);
  });

  it("marks resolved MiMo models for empty array items omission", async () => {
    const provider = await getXiaomiProvider();
    const model = mimoReasoningModel("mimo-v2.5");

    const normalized = provider.normalizeResolvedModel?.({
      provider: "xiaomi",
      modelId: model.id,
      modelApi: model.api,
      model,
    } as never);

    expect(
      (normalized?.compat as { omitEmptyArrayItems?: unknown } | undefined)?.omitEmptyArrayItems,
    ).toBe(true);
  });

  it("advertises thinking profiles for MiMo reasoning models only", async () => {
    const provider = await getXiaomiProvider();
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    const expectedLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    for (const modelId of ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6-pro"]) {
      const profile = resolveThinkingProfile({ provider: "xiaomi", modelId } as never);
      expect(profile?.levels.map((l) => l.id)).toEqual(expectedLevels);
      expect(profile?.defaultLevel).toBe("high");
    }

    expect(resolveThinkingProfile({ provider: "xiaomi", modelId: "custom-model" } as never)).toBe(
      undefined,
    );
  });

  it("isModernModelRef returns true only for MiMo reasoning models", async () => {
    const provider = await getXiaomiProvider();

    expect(
      provider.isModernModelRef?.({ provider: "xiaomi", modelId: "mimo-v2.5-pro" } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({ provider: "xiaomi", modelId: "mimo-v2.6-pro" } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({ provider: "xiaomi", modelId: "custom-model" } as never),
    ).toBe(false);
  });

  it("adds blank reasoning_content for replayed tool calls from non-xiaomi turns", async () => {
    const capture: PayloadCapture = {};
    const model = mimoReasoningModel("mimo-v2.5-pro");
    const context = readToolReplayContext(
      replayAssistantMessage({
        provider: "openai",
        model: "gpt-5.5",
        content: [readToolCall],
        stopReason: "toolUse",
      }),
    );
    const baseStreamFn = createPayloadCapturingStream(capture, model);

    const wrapThinkingHigh = requireThinkingWrapper(
      createMiMoThinkingWrapper(baseStreamFn as never, "high"),
      "high",
    );
    await wrapThinkingHigh(model, context, {});

    const assistantMessage = readPayloadMessage(capture, 1);
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.reasoning_content).toBe("");
    const toolCall = readFirstToolCall(assistantMessage);
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.type).toBe("function");
    expect(toolCall?.function?.name).toBe("read");
    expect(toolCall?.function?.arguments).toBe("{}");
  });

  it("preserves replayed reasoning_content when MiMo thinking is enabled", async () => {
    const capture: PayloadCapture = {};
    const model = mimoReasoningModel("mimo-v2.5-pro", "xiaomi-token-plan");
    const context = mimoReasoningToolReplayContext("xiaomi-token-plan");
    const baseStreamFn = createPayloadCapturingStream(capture, model);

    const wrapThinkingHigh = requireThinkingWrapper(
      createMiMoThinkingWrapper(baseStreamFn as never, "high"),
      "high",
    );
    await wrapThinkingHigh(model, context, {});

    expect(readThinking(capture.payload)?.type).toBe("enabled");
    const assistantMessage = readPayloadMessage(capture, 1);
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.reasoning_content).toBe("call reasoning");
    const toolCall = readFirstToolCall(assistantMessage);
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.type).toBe("function");
    expect(toolCall?.function?.name).toBe("read");
  });

  it("strips reasoning_content when MiMo thinking is disabled", async () => {
    const capture: PayloadCapture = {};
    const model = mimoReasoningModel("mimo-v2.5");
    const context = mimoReasoningToolReplayContext();
    const baseStreamFn = createPayloadCapturingStream(capture, model);

    const wrapThinkingNone = requireThinkingWrapper(
      createMiMoThinkingWrapper(baseStreamFn as never, "none" as never),
      "none",
    );
    await wrapThinkingNone(model, context, {});

    expect(readThinking(capture.payload)?.type).toBe("disabled");
    expect((capture.payload!.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });
});

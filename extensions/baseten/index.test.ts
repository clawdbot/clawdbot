import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import { applyBasetenConfig } from "./api.js";
import basetenPlugin from "./index.js";
import { createBasetenThinkingWrapper } from "./stream.js";

type OpenAICompletionsModel = Model<"openai-completions">;
const TEST_VALUE = "resolved-marker";

function basetenModel(id: string): OpenAICompletionsModel {
  return {
    id,
    name: id,
    provider: "baseten",
    api: "openai-completions",
    baseUrl: "https://inference.baseten.co/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 202_000,
    maxTokens: 202_000,
  };
}

function captureThinkingPayload(modelId: string, thinkingLevel: "off" | "high" | undefined) {
  let captured: Record<string, unknown> | undefined;
  const streamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (
    model,
    _context,
    options,
  ) => {
    const payload: Record<string, unknown> = {
      chat_template_args: { preserve_me: true },
    };
    options?.onPayload?.(payload, model);
    captured = payload;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const wrapperContext: ProviderWrapStreamFnContext = {
    provider: "baseten",
    modelId,
    thinkingLevel,
    streamFn,
  };
  const wrapped = createBasetenThinkingWrapper(wrapperContext);
  if (!wrapped) {
    throw new Error("Baseten thinking wrapper missing");
  }
  void wrapped(basetenModel(modelId), { messages: [] }, {});
  return captured;
}

function captureDeepSeekReplayPayload(thinkingLevel: "off" | "high" | undefined) {
  let captured: Record<string, unknown> | undefined;
  const streamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (
    model,
    _context,
    options,
  ) => {
    const payload: Record<string, unknown> = {
      ...(thinkingLevel === undefined
        ? {}
        : { reasoning_effort: thinkingLevel === "off" ? "none" : "high" }),
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "assistant", content: "done", reasoning_content: "preserve me" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    };
    options?.onPayload?.(payload, model);
    captured = payload;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const modelId = "deepseek-ai/DeepSeek-V4-Pro";
  const wrapped = createBasetenThinkingWrapper({
    provider: "baseten",
    modelId,
    thinkingLevel,
    streamFn,
  });
  if (!wrapped) {
    throw new Error("Baseten thinking wrapper missing");
  }
  void wrapped(basetenModel(modelId), { messages: [] }, {});
  return captured;
}

describe("Baseten provider registration", () => {
  it.each([undefined, "merge", "replace"] as const)(
    "keeps registered %s setup separate from the public catalog preset",
    async (mode) => {
      const provider = await registerSingleProviderPlugin(basetenPlugin);
      const method = resolveProviderPluginChoice({
        providers: [provider],
        choice: "baseten-api-key",
      })?.method;
      if (!method?.runNonInteractive) {
        throw new Error("expected Baseten noninteractive auth method");
      }
      const config: OpenClawConfig = { models: { mode } };
      const interactive = await method.run({
        config,
        env: {},
        opts: { basetenApiKey: TEST_VALUE },
        runtime: createRuntimeEnv(),
        prompter: createTestWizardPrompter(),
        secretInputMode: "plaintext",
        isRemote: false,
        openUrl: vi.fn(),
        oauth: { createVpsAwareHandlers: vi.fn() },
      });
      const noninteractive = await method.runNonInteractive({
        authChoice: "baseten-api-key",
        opts: {},
        config,
        baseConfig: config,
        runtime: createRuntimeEnv(),
        resolveApiKey: async () => ({ key: TEST_VALUE, source: "profile" }),
        toApiKeyCredential: () => null,
      });

      for (const output of [interactive.configPatch, noninteractive]) {
        expect(output?.models?.providers?.baseten).toMatchObject({
          baseUrl: "https://inference.baseten.co/v1",
          api: "openai-completions",
        });
        expect(output?.models?.providers?.baseten?.models).toHaveLength(mode === "replace" ? 9 : 0);
        expect(output?.agents?.defaults?.models).toEqual({
          "baseten/thinkingmachines/inkling": { alias: "Inkling" },
        });
      }
      expect(applyBasetenConfig(config).models?.providers?.baseten?.models).toHaveLength(9);
    },
  );

  it.each(["merge", "replace"] as const)(
    "preserves authored rows and aliases when repeating registered %s setup",
    async (mode) => {
      const provider = await registerSingleProviderPlugin(basetenPlugin);
      const run = resolveProviderPluginChoice({
        providers: [provider],
        choice: "baseten-api-key",
      })?.method.runNonInteractive;
      if (!run) {
        throw new Error("expected Baseten noninteractive auth method");
      }
      const authoredDefault: ModelDefinitionConfig = {
        id: "thinkingmachines/inkling",
        name: "Authored default",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
      };
      const authoredModels = [
        authoredDefault,
        { ...authoredDefault, id: "operator-only", name: "Authored selection" },
      ];
      const input: OpenClawConfig = {
        models: {
          mode,
          providers: {
            baseten: { baseUrl: "https://operator.invalid/v1", models: authoredModels },
          },
        },
        agents: {
          defaults: {
            model: { primary: "fixture/primary", fallbacks: ["fixture/fallback"] },
            models: { "baseten/thinkingmachines/inkling": { alias: "Saved alias" } },
          },
        },
      };
      const original = structuredClone(input);
      const authenticate = (config: OpenClawConfig) =>
        run({
          authChoice: "baseten-api-key",
          opts: {},
          config,
          baseConfig: config,
          runtime: createRuntimeEnv(),
          resolveApiKey: async () => ({ key: TEST_VALUE, source: "profile" }),
          toApiKeyCredential: () => null,
        });
      const first = await authenticate(input);
      if (!first) {
        throw new Error("expected configured Baseten provider");
      }
      const second = await authenticate(first);

      for (const output of [first, second]) {
        expect(output?.models?.providers?.baseten?.models).toEqual(
          expect.arrayContaining(authoredModels),
        );
        expect(output?.models?.providers?.baseten?.models).toHaveLength(
          mode === "replace" ? 10 : 2,
        );
        expect(output?.agents?.defaults?.models).toEqual(original.agents?.defaults?.models);
        expect(resolveAgentModelPrimaryValue(output?.agents?.defaults?.model)).toBe(
          "baseten/thinkingmachines/inkling",
        );
        expect(resolveAgentModelFallbackValues(output?.agents?.defaults?.model)).toEqual([
          "fixture/fallback",
        ]);
      }
      expect(input).toEqual(original);
    },
  );

  it("registers authenticated live and network-free static catalogs", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "baseten-api-key",
    });
    const catalog = await runSingleProviderCatalog(provider, {
      resolveProviderAuth: () => ({
        apiKey: TEST_VALUE,
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "env",
      }),
    });

    expect(provider).toMatchObject({
      id: "baseten",
      label: "Baseten",
      docsPath: "/providers/baseten",
      envVars: ["BASETEN_API_KEY"],
      resolveDynamicModel: expect.any(Function),
      resolveThinkingProfile: expect.any(Function),
      wrapStreamFn: expect.any(Function),
    });
    expect(choice?.provider.id).toBe("baseten");
    expect(choice?.method.id).toBe("api-key");
    expect(resolveAgentModelPrimaryValue(applyBasetenConfig({}).agents?.defaults?.model)).toBe(
      "baseten/thinkingmachines/inkling",
    );
    expect(catalog).toMatchObject({
      apiKey: TEST_VALUE,
      baseUrl: "https://inference.baseten.co/v1",
      api: "openai-completions",
    });
    expect(catalog.models).toHaveLength(9);
    expect(provider.staticCatalog).toBeDefined();
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "deepseek-ai/DeepSeek-V4-Pro",
      } as never)?.dropReasoningFromHistory,
    ).not.toBe(true);
  });

  it("sets and clears chat-template thinking while preserving caller arguments", () => {
    expect(captureThinkingPayload("zai-org/GLM-5.2-Fast", "high")).toMatchObject({
      chat_template_args: { preserve_me: true, enable_thinking: true },
    });
    expect(captureThinkingPayload("moonshotai/Kimi-K2.6", "off")).toMatchObject({
      chat_template_args: { preserve_me: true, enable_thinking: false },
    });
    expect(
      captureThinkingPayload("nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B", undefined),
    ).toMatchObject({
      chat_template_args: { preserve_me: true, enable_thinking: false },
    });
  });

  it("exposes opt-in thinking without duplicate reasoning levels", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "moonshotai/Kimi-K2.6",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "zai-org/GLM-5.2",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "zai-org/GLM-5.2-Fast",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "thinkingmachines/inkling",
        reasoning: true,
      } as never),
    ).toBeUndefined();
  });

  it("leaves default-thinking models untouched", () => {
    expect(captureThinkingPayload("thinkingmachines/inkling", "high")).toEqual({
      chat_template_args: { preserve_me: true },
    });
  });

  it("normalizes DeepSeek V4 replay while preserving Baseten reasoning effort", () => {
    expect(captureDeepSeekReplayPayload(undefined)).toEqual({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
          reasoning_content: "",
        },
        { role: "assistant", content: "done", reasoning_content: "preserve me" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
    expect(captureDeepSeekReplayPayload("high")).toEqual({
      reasoning_effort: "high",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
          reasoning_content: "",
        },
        { role: "assistant", content: "done", reasoning_content: "preserve me" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
    expect(captureDeepSeekReplayPayload("off")).toEqual({
      reasoning_effort: "none",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "assistant", content: "done" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
  });

  it("uses Baseten's supported system role instead of developer", () => {
    const model = {
      ...basetenModel("thinkingmachines/inkling"),
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const },
    };
    const payload = buildOpenAICompletionsParams(
      model,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      },
      { reasoning: "high", maxTokens: 32 },
    );

    const messages = payload.messages;
    expect(Array.isArray(messages)).toBe(true);
    if (!Array.isArray(messages)) {
      throw new Error("expected messages payload");
    }
    expect(messages[0]).toMatchObject({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "developer" })]),
    );
    expect(payload.max_tokens).toBe(32);
  });
});

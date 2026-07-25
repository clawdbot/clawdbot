import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
// Groq tests cover index plugin behavior.
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { resolveGroqReasoningCompatPatch } from "./api.js";
import plugin from "./index.js";

describe("groq provider compat", () => {
  it("recovers only matching implicit-budget rejections without changing normal tools", async () => {
    const [provider] = capturePluginRegistration(plugin).providers;

    const capturePayloads = async (
      extraParams: Record<string, unknown> | undefined,
      firstError?: string,
      initialMaxTokens = 32_768,
      onPayload?: SimpleStreamOptions["onPayload"],
      streamMaxTokens?: number,
      withTools = true,
      modelParams?: Record<string, unknown>,
      maxTokensSource: "configured" | "discovered" | null = "discovered",
    ) => {
      const payloads: Array<Record<string, unknown>> = [];
      const baseStreamFn: StreamFn = async (model, _context, options) => {
        const payload: Record<string, unknown> = {
          max_completion_tokens: initialMaxTokens,
        };
        if (withTools) {
          payload.tools = [{ type: "function", function: { name: "read" } }];
          payload.tool_choice = "auto";
        }
        const replacement = await options?.onPayload?.(payload, model);
        const finalPayload =
          replacement && typeof replacement === "object"
            ? (replacement as Record<string, unknown>)
            : payload;
        payloads.push(finalPayload);
        const stream = createAssistantMessageEventStream();
        if (payloads.length === 1 && firstError) {
          stream.push({
            type: "error",
            reason: "error",
            error: { stopReason: "error", errorMessage: firstError } as never,
          });
        } else {
          stream.push({
            type: "done",
            reason: "stop",
            message: { stopReason: "stop" } as never,
          });
        }
        stream.end();
        return stream;
      };
      const streamFn = provider?.wrapStreamFn?.({
        provider: "groq",
        modelId: "llama-3.3-70b-versatile",
        extraParams,
        model: {
          maxTokens: initialMaxTokens,
          ...(maxTokensSource ? { maxTokensSource } : {}),
          ...(modelParams ? { params: modelParams } : {}),
        } as never,
        streamFn: baseStreamFn,
      } as never);
      const streamOptions: SimpleStreamOptions = {};
      if (onPayload) {
        streamOptions.onPayload = onPayload;
      }
      if (streamMaxTokens !== undefined) {
        streamOptions.maxTokens = streamMaxTokens;
      }
      const stream = streamFn?.(
        {} as never,
        { messages: [], ...(withTools ? { tools: [{ name: "read" }] } : {}) } as never,
        streamOptions,
      );
      if (stream) {
        const resolvedStream = await stream;
        for await (const event of resolvedStream) {
          void event;
          // Drain the wrapper so a matching error can trigger its fallback attempt.
        }
      }
      return payloads;
    };

    const successfulDefault = await capturePayloads(undefined);
    expect(successfulDefault).toHaveLength(1);
    expect(successfulDefault[0]).toMatchObject({
      max_completion_tokens: 32_768,
      tools: [{ type: "function", function: { name: "read" } }],
    });

    const matchingError =
      "413 Request too large for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Requested 30000";
    let payloadHookCalls = 0;
    const recovered = await capturePayloads(undefined, matchingError, 32_768, (payload) => {
      const record = payload as Record<string, unknown>;
      payloadHookCalls += 1;
      return payloadHookCalls === 1
        ? payload
        : {
            ...record,
            max_tokens: 65_536,
            max_completion_tokens: 32_768,
            tools: [{ type: "function", function: { name: "restored" } }],
            tool_choice: "required",
          };
    });
    expect(payloadHookCalls).toBe(2);
    expect(recovered).toHaveLength(2);
    expect(recovered[0]).toMatchObject({
      max_completion_tokens: 32_768,
      tools: [{ type: "function", function: { name: "read" } }],
    });
    expect(recovered[1]).toEqual({ max_completion_tokens: 1_024 });

    const noTools = await capturePayloads(
      undefined,
      matchingError,
      32_768,
      undefined,
      undefined,
      false,
    );
    expect(noTools).toEqual([{ max_completion_tokens: 32_768 }, { max_completion_tokens: 1_024 }]);

    payloadHookCalls = 0;
    const alternateAlias = await capturePayloads(undefined, matchingError, 32_768, (payload) => {
      const record = payload as Record<string, unknown>;
      payloadHookCalls += 1;
      return payloadHookCalls === 1
        ? payload
        : {
            ...record,
            max_tokens: 65_536,
            tools: [{ type: "function", function: { name: "restored" } }],
          };
    });
    expect(alternateAlias[1]).toEqual({ max_completion_tokens: 1_024 });

    payloadHookCalls = 0;
    const parallelToolAliasCollision = await capturePayloads(
      undefined,
      matchingError,
      32_768,
      (payload) => {
        const record = payload as Record<string, unknown>;
        payloadHookCalls += 1;
        return payloadHookCalls === 1
          ? payload
          : {
              ...record,
              parallel_tool_calls: true,
              parallelToolCalls: false,
            };
      },
    );
    expect(payloadHookCalls).toBe(2);
    expect(parallelToolAliasCollision[1]).toEqual({ max_completion_tokens: 1_024 });

    for (const unrelatedMessage of [
      "401 Unauthorized",
      "400 malformed request",
      "413 context length exceeded",
      "429 Rate limit reached on tokens per minute (TPM)",
    ]) {
      const unrelatedError = await capturePayloads(undefined, unrelatedMessage);
      expect(unrelatedError).toHaveLength(1);
      expect(unrelatedError[0]).toHaveProperty("tools");
    }

    const explicit = { max_completion_tokens: 2_048 };
    const explicitPayloads = await capturePayloads(explicit, matchingError, 2_048);
    expect(explicitPayloads).toHaveLength(1);
    expect(explicitPayloads[0]).toMatchObject({
      max_completion_tokens: 2_048,
      tools: [{ type: "function", function: { name: "read" } }],
      tool_choice: "auto",
    });

    for (const modelParams of [
      { maxTokens: 4_096 },
      { max_completion_tokens: 4_096 },
      { max_tokens: 4_096 },
      { extra_body: { max_completion_tokens: 4_096 } },
      { extra_body: { max_tokens: 4_096 } },
      { extraBody: { max_completion_tokens: 4_096 } },
      { extraBody: { max_tokens: 4_096 } },
    ]) {
      const resolvedModel = await capturePayloads(
        undefined,
        matchingError,
        4_096,
        undefined,
        undefined,
        true,
        modelParams,
      );
      expect(resolvedModel).toHaveLength(1);
      expect(resolvedModel[0]).toHaveProperty("max_completion_tokens", 4_096);
    }

    const configuredModelBudget = await capturePayloads(
      undefined,
      matchingError,
      4_096,
      undefined,
      undefined,
      true,
      undefined,
      "configured",
    );
    expect(configuredModelBudget).toHaveLength(1);
    expect(configuredModelBudget[0]).toMatchObject({
      max_completion_tokens: 4_096,
      tools: [{ type: "function", function: { name: "read" } }],
    });

    const unknownModelBudget = await capturePayloads(
      undefined,
      matchingError,
      4_096,
      undefined,
      undefined,
      true,
      undefined,
      null,
    );
    expect(unknownModelBudget).toHaveLength(1);
    expect(unknownModelBudget[0]).toMatchObject({
      max_completion_tokens: 4_096,
      tools: [{ type: "function", function: { name: "read" } }],
    });

    const requestScoped = await capturePayloads(undefined, matchingError, 4_096, undefined, 4_096);
    expect(requestScoped).toHaveLength(1);
    expect(requestScoped[0]).toMatchObject({
      max_completion_tokens: 4_096,
      tools: [{ type: "function", function: { name: "read" } }],
    });
  });

  it("preserves synchronous throws and complete asynchronous error metadata", async () => {
    const [provider] = capturePluginRegistration(plugin).providers;
    if (!provider) {
      throw new Error("expected Groq provider registration");
    }
    const model = {
      api: "openai-completions",
      provider: "groq",
      id: "llama-3.3-70b-versatile",
    } as never;
    const context = { messages: [], tools: [{ name: "read" }] } as never;
    const wrap = (streamFn: StreamFn) =>
      provider.wrapStreamFn?.({
        provider: "groq",
        modelId: "llama-3.3-70b-versatile",
        model: { maxTokensSource: "discovered" } as never,
        streamFn,
      } as never);

    const synchronous = wrap(() => {
      throw new Error("synchronous failure");
    });
    expect(() => synchronous?.(model, context, {})).toThrow("synchronous failure");

    const asynchronous = wrap(async () => {
      throw new Error("asynchronous failure");
    });
    const events = [];
    const stream = asynchronous?.(model, context, {});
    if (stream) {
      const resolvedStream = await stream;
      for await (const event of resolvedStream) {
        events.push(event);
      }
    }
    expect(events).toEqual([
      {
        type: "error",
        reason: "error",
        error: expect.objectContaining({
          api: "openai-completions",
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          stopReason: "error",
          errorMessage: "asynchronous failure",
          timestamp: expect.any(Number),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ]);
  });

  it("maps Groq Qwen 3 reasoning to provider-native none/default values", () => {
    expect(resolveGroqReasoningCompatPatch("qwen/qwen3-32b")).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "default"],
      reasoningEffortMap: {
        adaptive: "default",
        high: "default",
        off: "none",
        none: "none",
        minimal: "default",
        low: "default",
        medium: "default",
        max: "default",
        xhigh: "default",
      },
    });
  });

  it("keeps GPT-OSS reasoning on the Groq low/medium/high contract", () => {
    expect(resolveGroqReasoningCompatPatch("openai/gpt-oss-120b")).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
    });
  });

  it("registers Groq model and media providers", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Groq provider");
    }
    expect(provider).toMatchObject({
      docsPath: "/providers/groq",
      envVars: ["GROQ_API_KEY"],
      id: "groq",
      label: "Groq",
    });
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      kind: "api_key",
      label: "Groq API key",
      wizard: {
        choiceId: "groq-api-key",
        groupId: "groq",
      },
    });
    expect(captured.mediaUnderstandingProviders).toHaveLength(1);
    const [mediaProvider] = captured.mediaUnderstandingProviders;
    if (!mediaProvider) {
      throw new Error("Expected Groq media understanding provider");
    }
    const { transcribeAudio, ...mediaProviderMetadata } = mediaProvider;
    expect(mediaProviderMetadata).toEqual({
      autoPriority: { audio: 20 },
      capabilities: ["audio"],
      defaultModels: { audio: "whisper-large-v3-turbo" },
      id: "groq",
    });
    expect(transcribeAudio).toBeTypeOf("function");
  });
});

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("xai provider plugin", () => {
  it("owns replay policy for xAI OpenAI-compatible transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "xai",
        modelApi: "openai-completions",
        modelId: "grok-3",
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
        provider: "xai",
        modelApi: "openai-responses",
        modelId: "grok-4-fast",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
  });

  it("wires provider stream shaping for fast mode and tool-stream defaults", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedModelId = "";
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      capturedModelId = model.id;
      const payload: Record<string, unknown> = {
        reasoning: { effort: "high" },
        tools: [
          {
            type: "function",
            function: {
              name: "write",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      };
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {
        result: async () => ({}) as never,
        async *[Symbol.asyncIterator]() {},
      } as unknown as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn?.({
      provider: "xai",
      modelId: "grok-4",
      extraParams: { fastMode: true },
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4",
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedModelId).toBe("grok-4-fast");
    expect(capturedPayload).toMatchObject({ tool_stream: true });
    expect(capturedPayload).not.toHaveProperty("reasoning");
    expect(
      (capturedPayload?.tools as Array<{ function?: Record<string, unknown> }>)[0]?.function,
    ).not.toHaveProperty("strict");
  });

  it("defaults tool_stream extra params but preserves explicit values", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: { fastMode: true },
      } as never),
    ).toEqual({
      fastMode: true,
      tool_stream: true,
    });

    const explicit = { fastMode: true, tool_stream: false };
    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });
});

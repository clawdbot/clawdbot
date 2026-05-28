import { describe, expect, it } from "vitest";
import { createDeepInfraAnthropicCacheWrapper } from "./cache-wrapper.js";

type StreamFn = Parameters<typeof createDeepInfraAnthropicCacheWrapper>[0];

function capturePayload(params: { modelId: string; initialPayload: Record<string, unknown> }): {
  captured: Record<string, unknown>;
  baseCalls: number;
} {
  let captured: Record<string, unknown> = {};
  let baseCalls = 0;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    baseCalls += 1;
    const payload = structuredClone(params.initialPayload);
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createDeepInfraAnthropicCacheWrapper(baseStreamFn);
  void wrapped(
    {
      api: "openai-completions",
      provider: "deepinfra",
      id: params.modelId,
      reasoning: false,
    } as Parameters<StreamFn>[0],
    { messages: [] } as Parameters<StreamFn>[1],
    {} as never,
  );

  return { captured, baseCalls };
}

describe("createDeepInfraAnthropicCacheWrapper", () => {
  it("injects ephemeral cache_control markers on the system message for anthropic/* models", () => {
    const { captured, baseCalls } = capturePayload({
      modelId: "anthropic/claude-sonnet-4-6",
      initialPayload: {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hi" },
        ],
      },
    });

    expect(baseCalls).toBe(1);
    expect(captured.messages).toEqual([
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "You are a helpful assistant.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: "Hi" },
    ]);
  });

  it("tags the last block of an array-shaped system message", () => {
    const { captured } = capturePayload({
      modelId: "anthropic/claude-haiku-4-5",
      initialPayload: {
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "Block one" },
              { type: "text", text: "Block two" },
            ],
          },
          { role: "user", content: "Hi" },
        ],
      },
    });

    const messages = captured.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Block one" },
      {
        type: "text",
        text: "Block two",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("matches the anthropic/ prefix case-insensitively", () => {
    const { captured } = capturePayload({
      modelId: "Anthropic/Claude-Sonnet-4-6",
      initialPayload: {
        messages: [{ role: "system", content: "sys" }],
      },
    });

    const messages = captured.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not mutate payloads for non-anthropic model ids", () => {
    const initialPayload = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Hi" },
      ],
    };
    const { captured, baseCalls } = capturePayload({
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      initialPayload,
    });

    expect(baseCalls).toBe(1);
    expect(captured).toEqual(initialPayload);
  });
});

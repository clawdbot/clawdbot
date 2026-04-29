import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("venice provider plugin", () => {
  it("applies the shared xAI compat patch to Grok-backed Venice models only", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "venice/grok-4",
        model: {
          id: "grok-4",
          compat: {
            supportsUsageInStreaming: true,
          },
        },
      } as never),
    ).toMatchObject({
      compat: {
        supportsUsageInStreaming: true,
        toolSchemaProfile: "xai",
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: "html-entities",
      },
    });

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "venice/llama-3.3-70b",
        model: {
          id: "llama-3.3-70b",
          compat: {},
        },
      } as never),
    ).toBeUndefined();
  });

  it("fills missing DeepSeek V4 reasoning_content on Venice replay turns", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "deepseek-v4-pro",
        thinking: { type: "enabled" },
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
          },
          { role: "assistant", content: "done" },
        ],
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };

    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "venice",
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
    } as never);

    expect(streamFn).toBeTypeOf("function");
    await streamFn?.({ provider: "venice", id: "deepseek-v4-pro" } as never, {} as never, {});

    expect(capturedPayloads).toEqual([
      {
        model: "deepseek-v4-pro",
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
          {
            role: "assistant",
            content: "done",
            reasoning_content: "",
          },
        ],
      },
    ]);
  });
});

import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { createCapturedThinkingConfigStream } from "../../test/helpers/plugins/stream-hooks.js";
import plugin from "./index.js";

describe("moonshot provider plugin", () => {
  it("owns replay policy for OpenAI-compatible Moonshot transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "moonshot",
        modelApi: "openai-completions",
        modelId: "kimi-k2.6",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
  });

  it("wires moonshot-thinking stream hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedStream = createCapturedThinkingConfigStream();

    const wrapped = provider.wrapStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "off",
      streamFn: capturedStream.streamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "moonshot",
        id: "kimi-k2.6",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedStream.getCapturedPayload()).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });
  });
});

import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";
import { buildQwenProvider } from "./provider-catalog.js";
import { wrapQwenProviderStream } from "./stream.js";

const apiKey = process.env.QWEN_API_KEY ?? "";
const describeLive = isLiveTestEnabled() && apiKey ? describe : describe.skip;

describeLive.each(["qwen3.8-max", "qwen3.8-flash"])("Qwen Standard live: %s", (id) => {
  let model: Model<"openai-completions">;
  beforeAll(async () => {
    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "qwen",
      providerConfig: buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL }),
      apiKey,
    });
    const discovered = provider.models.find((entry) => entry.id === id);
    if (!discovered) {
      throw new Error(`Qwen discovery did not return ${id}`);
    }
    expect(discovered).toMatchObject({ reasoning: true, input: ["text", "image"] });
    model = {
      ...discovered,
      input: discovered.input.filter((modality) => modality === "text" || modality === "image"),
      provider: "qwen",
      baseUrl: provider.baseUrl,
      api: "openai-completions",
    };
  });

  async function complete(context: Context, thinkingLevel: "off" | "low" | "high") {
    const stream = wrapQwenProviderStream({
      provider: "qwen",
      modelId: id,
      model,
      thinkingLevel,
      streamFn: streamSimple,
    });
    if (!stream) {
      throw new Error("Qwen provider did not wrap the model stream");
    }
    const result = await (
      await stream(model, context, {
        apiKey,
        maxTokens: 2048,
        signal: AbortSignal.timeout(60_000),
      })
    ).result();
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || `Qwen stopped: ${result.stopReason}`);
    }
    return result;
  }

  it("recognizes image input with thinking disabled", async () => {
    const result = await complete(
      {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text: "Name the dominant color in this image. Reply with one color word.",
              },
              {
                type: "image",
                mimeType: "image/png",
                data: createSolidPngBuffer(64, 64, { r: 255, g: 0, b: 0 }).toString("base64"),
              },
            ],
          },
        ],
      },
      "off",
    );
    expect(extractNonEmptyAssistantText(result.content).toLowerCase()).toContain("red");
  }, 70_000);

  it("round-trips a tool call with low and mapped xhigh reasoning", async () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content:
            "Call lookup_secret once, then reply with only its returned word. Do not guess the word.",
          timestamp: Date.now(),
        },
      ],
      tools: [
        {
          name: "lookup_secret",
          description: "Retrieve a fixture word.",
          parameters: Type.Object({}, { additionalProperties: false }),
        },
      ],
    };
    const first = await complete(context, "low");
    const call = first.content.find((block) => block.type === "toolCall");
    expect(call?.name).toBe("lookup_secret");
    if (!call) {
      throw new Error("Qwen did not call the requested tool");
    }
    context.messages.push(first, {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "marigold" }],
      isError: false,
      timestamp: Date.now(),
    });
    const second = await complete(context, "high");
    expect(extractNonEmptyAssistantText(second.content).toLowerCase()).toContain("marigold");
  }, 130_000);
});

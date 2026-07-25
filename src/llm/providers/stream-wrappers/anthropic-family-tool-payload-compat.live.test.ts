import OpenAI from "openai";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../../agents/live-test-helpers.js";
import { createOpenAIAnthropicToolPayloadCompatibilityWrapper } from "./anthropic-family-tool-payload-compat.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["OPENAI_LIVE_TEST"]) && Boolean(OPENAI_KEY);
const describeLive = LIVE ? describe : describe.skip;

describeLive("OpenAI-compatible Anthropic tool payload wrapper live", () => {
  it("projects and sends a custom pinned tool after quarantining an unreadable sibling", async () => {
    const liveModelId = process.env.OPENCLAW_LIVE_OPENAI_CHAT_TOOL_MODEL || "gpt-5.6-luna";
    let projectedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        model: liveModelId,
        messages: [
          {
            role: "user",
            content: "Call live_probe with value exactly OPENAI_WRAPPER_OK.",
          },
        ],
        tools: [
          {
            name: "unreadable_probe",
            parameters: {
              type: "object",
              properties: {
                get value(): never {
                  throw new Error("live unreadable nested schema getter");
                },
              },
            },
          },
          {
            type: "custom",
            custom: {
              name: "live_probe",
              description: "Return the requested probe value.",
              input_schema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          },
        ],
        tool_choice: { type: "custom", custom: { name: "live_probe" } },
        reasoning_effort: "low",
        max_completion_tokens: 128,
      };
      options?.onPayload?.(payload, model);
      projectedPayload = structuredClone(payload);
      return createAssistantMessageEventStream();
    };
    const wrapped = createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);
    const model = {
      api: "anthropic-messages",
      provider: "openai-compatible-anthropic",
      id: liveModelId,
      compat: { requiresOpenAiAnthropicToolPayload: true },
    } as unknown as Model<"anthropic-messages">;

    void wrapped(model, { messages: [] }, {});
    if (!projectedPayload) {
      throw new Error("wrapper did not produce a payload");
    }
    expect(projectedPayload.reasoning_effort).toBe("none");

    const client = new OpenAI({ apiKey: OPENAI_KEY });
    const response = await client.chat.completions.create(
      projectedPayload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );
    const toolCall = response.choices[0]?.message.tool_calls?.[0];

    if (!toolCall || toolCall.type !== "function") {
      throw new Error("OpenAI did not return the expected function tool call");
    }
    expect(toolCall.function.name).toBe("live_probe");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({
      value: "OPENAI_WRAPPER_OK",
    });
  }, 45_000);
});

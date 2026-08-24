// Featherless live tests prove text generation and a complete tool-call round trip.
import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { FEATHERLESS_DEFAULT_MODEL_ID } from "./models.js";
import { buildFeatherlessProvider } from "./provider-catalog.js";

const FEATHERLESS_API_KEY = process.env.FEATHERLESS_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["FEATHERLESS_LIVE_TEST"]) && FEATHERLESS_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function resolveLiveModel(): Model<"openai-completions"> {
  const provider = buildFeatherlessProvider();
  const model = provider.models?.find((entry) => entry.id === FEATHERLESS_DEFAULT_MODEL_ID);
  if (!model) {
    throw new Error(`Featherless catalog does not include ${FEATHERLESS_DEFAULT_MODEL_ID}`);
  }
  return {
    provider: "featherless",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

function liveEchoTool(): Tool {
  return {
    name: "live_echo",
    description: "Return the supplied value.",
    parameters: Type.Object(
      {
        value: Type.String(),
      },
      { additionalProperties: false },
    ),
  };
}

function requireToolCall(message: AssistantMessage) {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  if (toolCall?.type !== "toolCall") {
    throw new Error(`Featherless live model did not call a tool: ${message.stopReason}`);
  }
  return toolCall;
}

describeLive("featherless plugin live", () => {
  it("completes a tool-call round trip with the default model", async () => {
    const model = resolveLiveModel();
    const tool = liveEchoTool();
    const userPrompt = {
      role: "user" as const,
      content: "Call live_echo with value featherless. Do not answer directly.",
      timestamp: Date.now() - 3,
    };
    const first = await completeSimple(
      model,
      {
        messages: [userPrompt],
        tools: [tool],
      },
      {
        apiKey: FEATHERLESS_API_KEY,
        maxTokens: 256,
      },
    );

    if (first.stopReason === "error") {
      throw new Error(first.errorMessage || "Featherless first turn returned an error");
    }
    const toolCall = requireToolCall(first);
    expect(toolCall.name).toBe("live_echo");
    expect(toolCall.arguments).toEqual({ value: "featherless" });

    const second = await completeSimple(
      model,
      {
        messages: [
          userPrompt,
          first,
          {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now() - 1,
          },
          {
            role: "user",
            content: "Reply with exactly: ok",
            timestamp: Date.now(),
          },
        ],
        tools: [tool],
      },
      {
        apiKey: FEATHERLESS_API_KEY,
        maxTokens: 64,
      },
    );

    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "Featherless second turn returned an error");
    }
    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});

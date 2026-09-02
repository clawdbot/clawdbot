import type { Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { captureOpenAIResponses } from "./openai-responses-live-capture.test-support.js";

const apiKey = process.env.OPENAI_API_KEY ?? "";
const describeLive = process.env.OPENCLAW_LIVE_TEST === "1" && apiKey ? describe : describe.skip;
const modelId = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const model = {
  id: modelId,
  name: modelId,
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const tool = {
  name: "record_value",
  description: "Record the supplied integer value.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
};

async function run(messages: Context["messages"]) {
  const options = {
    apiKey,
    sessionId: "live-unsafe-integer-continuation",
    transport: "sse",
    reasoningEffort: "low",
    maxTokens: 256,
    onPayload: (payload) => ({ ...(payload as Record<string, unknown>), store: true }),
  } satisfies OpenAIResponsesOptions;
  const stream = await createOpenAIResponsesTransportStreamFn()(
    model,
    { messages, tools: [tool] },
    options,
  );
  return stream.result();
}

describeLive("native Responses continuation after an unsafe integer tool call", () => {
  afterEach(() => cleanupSessionResources());

  it("reuses the provider response after preserving a bare integer argument", async () => {
    const user = {
      role: "user" as const,
      content:
        "Call record_value with exactly n=9007199254740993. Do not round or alter the number.",
      timestamp: 1,
    };
    const first = await captureOpenAIResponses(() => run([user]));
    expect(first.result.stopReason).toBe("toolUse");
    expect(first.requests).toHaveLength(1);
    const call = first.result.content.find((block) => block.type === "toolCall");
    expect(call?.arguments).toEqual({ n: "9007199254740993" });
    if (!call) {
      throw new Error("Expected a completed tool call");
    }

    // A provider-quoted string already worked before this fix; prove a bare wire literal.
    const rawArguments = first.responseTexts[0]
      ?.split("\n")
      .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
      .map((line) => JSON.parse(line.slice(5)) as { type: string; arguments?: string })
      .find((event) => event.type === "response.function_call_arguments.done")?.arguments;
    expect(rawArguments).toMatch(/"n"\s*:\s*9007199254740993\s*[,}]/);

    const second = await captureOpenAIResponses(() =>
      run([
        user,
        first.result,
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          content: [{ type: "text", text: "recorded" }],
          timestamp: 2,
        },
      ]),
    );
    expect(second.result.stopReason).toBe("stop");
    // A rejected response reference would cause an extra request with full history.
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.previous_response_id).toEqual(expect.any(String));
    expect(second.requests[0]?.input).toEqual([
      { type: "function_call_output", call_id: call.id.split("|")[0], output: "recorded" },
    ]);
  }, 120_000);
});

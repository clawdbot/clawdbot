import {
  completeSimple,
  streamSimple,
  Type,
  type AssistantMessage,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "../../src/agents/live-test-helpers.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";
import { createDeepSeekV4ThinkingWrapper } from "./stream.js";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const DEEPSEEK_LIVE_MODEL = process.env.OPENCLAW_LIVE_DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
const LIVE = isLiveTestEnabled(["DEEPSEEK_LIVE_TEST"]);

const describeLive = LIVE && DEEPSEEK_KEY ? describe : describe.skip;

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function forceDeepSeekNonThinkingPath(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const request = payload as Record<string, unknown>;
  request.thinking = { type: "disabled" };
  delete request.reasoning_effort;
}

function resolveDeepSeekLiveModel(): Model<"openai-completions"> {
  const provider = buildDeepSeekProvider();
  const model = provider.models?.find((entry) => entry.id === DEEPSEEK_LIVE_MODEL);
  if (!model) {
    throw new Error(`DeepSeek bundled catalog does not include ${DEEPSEEK_LIVE_MODEL}`);
  }
  return {
    provider: "deepseek",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

function resolveDeepSeekV4LiveModel(): Model<"openai-completions"> {
  const provider = buildDeepSeekProvider();
  const requestedModel =
    DEEPSEEK_LIVE_MODEL === "deepseek-v4-flash" || DEEPSEEK_LIVE_MODEL === "deepseek-v4-pro"
      ? DEEPSEEK_LIVE_MODEL
      : "deepseek-v4-flash";
  const model = provider.models?.find((entry) => entry.id === requestedModel);
  if (!model) {
    throw new Error(`DeepSeek bundled catalog does not include ${requestedModel}`);
  }
  return {
    provider: "deepseek",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

describeLive("deepseek plugin live", () => {
  it("returns assistant text from the bundled V4 model catalog", async () => {
    const res = await completeSimple(
      resolveDeepSeekLiveModel(),
      {
        messages: createSingleUserPromptMessage(),
      },
      {
        apiKey: DEEPSEEK_KEY,
        maxTokens: 64,
        onPayload: forceDeepSeekNonThinkingPath,
      },
    );

    if (res.stopReason === "error") {
      throw new Error(res.errorMessage || "DeepSeek returned error with no message");
    }

    const text = extractNonEmptyAssistantText(res.content);
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  it("accepts V4 thinking replay after a prior provider tool call", async () => {
    const toolCallId = "call_deepseek_live_replay_1";
    const context: Context = {
      messages: [
        {
          role: "user",
          content: "Use the noop tool.",
          timestamp: Date.now() - 3,
        },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "toolCall", id: toolCallId, name: "noop", arguments: {} }],
          usage: ZERO_USAGE,
          stopReason: "toolUse",
          timestamp: Date.now() - 2,
        },
        {
          role: "toolResult",
          toolCallId,
          toolName: "noop",
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
      tools: [
        {
          name: "noop",
          description: "Return ok.",
          parameters: Type.Object({}, { additionalProperties: false }),
        },
      ],
    };
    let capturedPayload: Record<string, unknown> | undefined;
    const streamFn = createDeepSeekV4ThinkingWrapper(streamSimple, "high");
    expect(streamFn).toBeDefined();

    const stream = streamFn?.(resolveDeepSeekV4LiveModel(), context, {
      apiKey: DEEPSEEK_KEY,
      maxTokens: 64,
      onPayload: (payload) => {
        capturedPayload = payload as Record<string, unknown>;
      },
    });
    expect(stream).toBeDefined();

    const result = await (await stream!).result();
    if (result.stopReason === "error") {
      throw new Error(result.errorMessage || "DeepSeek V4 replay returned error with no message");
    }

    const messages = capturedPayload?.messages;
    expect(Array.isArray(messages)).toBe(true);
    expect((messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "",
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: "noop",
            arguments: "{}",
          },
        },
      ],
    });
    expect(extractNonEmptyAssistantText(result.content).length).toBeGreaterThan(0);
  }, 60_000);
});

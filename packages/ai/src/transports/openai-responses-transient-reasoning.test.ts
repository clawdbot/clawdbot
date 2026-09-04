import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import {
  convertProviderResponsesMessages,
  convertResponsesMessages,
} from "./openai-responses-replay-messages-internal.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

const nativeCodexModel = {
  id: "gpt-5.4",
  name: "Codex",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-chatgpt-responses">;

const proxiedCodexModel = {
  ...nativeCodexModel,
  baseUrl: "https://responses.example.test/v1",
} satisfies Model<"openai-chatgpt-responses">;
const replayConverters = [
  { name: "transport", convert: convertResponsesMessages },
  { name: "provider", convert: convertProviderResponsesMessages },
] as const;

function createOutput(model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* events(
  values: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const value of values) {
    yield value as OpenAIResponsesStreamEvent;
  }
}

function reasoningBlock(id: string) {
  return {
    type: "thinking" as const,
    thinking: "visible summary",
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id,
      encrypted_content: "ciphertext",
      summary: [],
    }),
  };
}

describe("OpenAI Responses transient reasoning", () => {
  it.each([
    { name: "native temporary", model: nativeCodexModel, id: "rs_tmp_123", persists: false },
    { name: "native stable", model: nativeCodexModel, id: "rs_123", persists: true },
    {
      name: "proxied temporary-shaped",
      model: proxiedCodexModel,
      id: "rs_tmp_123",
      persists: true,
    },
  ])("scopes streamed replay state for $name items", async ({ model, id, persists }) => {
    const output = createOutput(model);
    await processResponsesStream(
      events([
        { type: "response.output_item.added", item: { type: "reasoning" } },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id,
            encrypted_content: "ciphertext",
            summary: [{ type: "summary_text", text: "visible summary" }],
          },
        },
        { type: "response.completed", response: { id: "resp_done", status: "completed" } },
      ]),
      output,
      { push: () => undefined },
      model,
      {
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
          sessionId: "session-a",
          authProfileId: "profile-a",
        }),
      },
    );

    const block = output.content[0];
    expect(block).toMatchObject({ type: "thinking", thinking: "visible summary" });
    if (persists) {
      expect(block).toMatchObject({
        thinkingSignature: expect.stringContaining(id),
        openclawReasoningReplay: expect.objectContaining({ provider: "openai" }),
      });
    } else {
      expect(block).not.toHaveProperty("thinkingSignature");
      expect(block).not.toHaveProperty("openclawReasoningReplay");
    }
  });

  it.each(replayConverters)(
    "$name replay clears signed-message pairing when a temporary reasoning item is skipped",
    ({ convert }) => {
      const context: Context = {
        messages: [
          {
            ...createOutput(nativeCodexModel),
            content: [
              reasoningBlock("rs_stable"),
              reasoningBlock("rs_tmp_transient"),
              {
                type: "text",
                text: "final",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_requires_adjacent_reasoning",
                  phase: "final_answer",
                }),
              },
            ],
          },
        ],
      };

      const input = convert(nativeCodexModel, context, new Set(["openai"]));
      const reasoningIds = input
        .filter((item) => item.type === "reasoning")
        .map((item) => ("id" in item ? item.id : undefined));
      const message = input.find((item) => item.type === "message");

      expect(reasoningIds).toEqual(["rs_stable"]);
      expect(message).toMatchObject({ type: "message", role: "assistant" });
      expect(message).not.toHaveProperty("id");
    },
  );
});

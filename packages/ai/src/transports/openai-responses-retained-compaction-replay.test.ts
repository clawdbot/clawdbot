import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import { resolveResponsesContinuationRequest } from "./openai-responses-continuation.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };

function createAssistant(
  content: string | AssistantMessage["content"],
  providerReplay?: ProviderReplayState,
): AssistantMessage {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
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
    ...(providerReplay ? { providerReplay } : {}),
  };
}

function compactionState(
  type: "openai-responses-compaction" | "openai-responses-retained-compaction",
): ProviderReplayState {
  const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
  if (!metadata.baseUrlHash) {
    throw new Error("test model must have a replayable base URL");
  }
  return {
    v: 1,
    type,
    id: type === "openai-responses-compaction" ? "cmp_previous" : "cmp_retained",
    data: type === "openai-responses-compaction" ? "opaque-previous" : "opaque-retained",
    ...(type === "openai-responses-compaction" ? { replayIndex: 1 } : {}),
    provider: metadata.provider,
    api: metadata.api,
    model: metadata.model,
    baseUrlHash: metadata.baseUrlHash,
    sessionHash: metadata.sessionHash,
    authProfileHash: metadata.authProfileHash,
  };
}

const converters = [
  {
    name: "transport-owned",
    convert: (context: Context, replayMode: OpenAIResponsesReplayMode = "checkpoint") =>
      convertResponsesMessages(model, context, new Set(["openai"]), {
        ...replayIdentity,
        replayMode,
      }),
  },
  {
    name: "provider-owned",
    convert: (context: Context, replayMode: OpenAIResponsesReplayMode = "checkpoint") =>
      convertProviderResponsesMessages(model, context, new Set(["openai"]), {
        ...replayIdentity,
        replayMode,
      }),
  },
] as const;

describe("Responses retained-user compaction replay", () => {
  it.each(converters)("$name retains user messages before the checkpoint", ({ convert }) => {
    const input = convert({
      systemPrompt: "current system instructions",
      messages: [
        { role: "user", content: "user absorbed by older checkpoint", timestamp: 0 },
        createAssistant("older checkpoint owner", compactionState("openai-responses-compaction")),
        { role: "user", content: "first retained user", timestamp: 1 },
        createAssistant("discarded assistant"),
        { role: "user", content: "second retained user", timestamp: 2 },
        createAssistant(
          "assistant content absorbed by compaction",
          compactionState("openai-responses-retained-compaction"),
        ),
        { role: "user", content: "new user after compaction", timestamp: 3 },
      ],
    });

    expect(input.slice(0, 4)).toMatchObject([
      { role: "developer" },
      { role: "user", content: [{ text: "first retained user" }] },
      { role: "user", content: [{ text: "second retained user" }] },
      { type: "compaction", encrypted_content: "opaque-retained" },
    ]);
    const encoded = JSON.stringify(input);
    expect(encoded).toContain("new user after compaction");
    expect(encoded).not.toContain("user absorbed by older checkpoint");
    expect(encoded).not.toContain("discarded assistant");
    expect(encoded).not.toContain("assistant content absorbed by compaction");
  });

  it.each(
    converters.flatMap((converter) =>
      [
        {
          scenario: "compacted-prefix",
          retainedUsers: false,
          fullHistory: false,
          laterUser: false,
        },
        { scenario: "retained-users", retainedUsers: true, fullHistory: false, laterUser: false },
        { scenario: "full-history", retainedUsers: false, fullHistory: true, laterUser: false },
        { scenario: "later-user", retainedUsers: false, fullHistory: false, laterUser: true },
      ].map((scenario) => Object.assign({}, converter, scenario)),
    ),
  )(
    "$name preserves the compacted prefix and current context across tool rounds ($scenario)",
    ({ convert, scenario, retainedUsers, fullHistory, laterUser }) => {
      const messages: Context["messages"] = [
        { role: "user", content: "active request before compaction", timestamp: 1 },
        createAssistant(
          [],
          compactionState(
            retainedUsers ? "openai-responses-retained-compaction" : "openai-responses-compaction",
          ),
        ),
      ];
      if (laterUser) {
        messages.push({ role: "user", content: "new request after compaction", timestamp: 2 });
      }
      const carrier = {
        role: "user",
        content: "current request metadata",
        runtimeContextCarrier: true,
        timestamp: 3,
      } satisfies Context["messages"][number];
      const replayMode = fullHistory ? "full-history" : "checkpoint";
      const prefix = convert({ messages }, replayMode);
      let input = convert({ messages: [...messages, carrier] }, replayMode);
      expect(input.slice(0, prefix.length), scenario).toEqual(prefix);
      expect(input.at(-1), scenario).toMatchObject({
        role: "user",
        content: [{ type: "input_text", text: carrier.content }],
      });

      for (const round of [1, 2]) {
        const callId = `call_${round}`;
        const itemId = `fc_${round}`;
        messages.push(
          createAssistant([
            { type: "toolCall", id: `${callId}|${itemId}`, name: "lookup", arguments: {} },
          ]),
          {
            role: "toolResult",
            toolCallId: `${callId}|${itemId}`,
            toolName: "lookup",
            content: [{ type: "text", text: `result ${round}` }],
            isError: false,
            timestamp: round + 3,
          },
        );
        const nextInput = convert({ messages: [...messages, carrier] }, replayMode);
        const continued = resolveResponsesContinuationRequest(
          {
            lastRequest: { model: model.id, store: true, input },
            lastResponseId: `resp_${round}`,
            lastResponseItems: [
              {
                type: "function_call",
                id: itemId,
                call_id: callId,
                name: "lookup",
                arguments: "{}",
                status: "completed",
              },
            ],
          },
          { model: model.id, store: true, input: nextInput },
        );
        expect(continued.continuationStatus, `${scenario} round ${round}`).toBe("continued");
        expect(continued.request.input).toEqual([
          { type: "function_call_output", call_id: callId, output: `result ${round}` },
        ]);
        input = nextInput;
      }
    },
  );
});

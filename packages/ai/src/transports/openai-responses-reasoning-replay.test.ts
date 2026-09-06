import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
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

function createAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

const responseConverters = [
  {
    name: "transport-owned",
    convert: (context: Context) =>
      convertResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
  {
    name: "provider-owned",
    convert: (context: Context) =>
      convertProviderResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
] as const;

describe("OpenAI Responses reasoning replay", () => {
  it.each(responseConverters)(
    "$name preserves encrypted reasoning and removes bare orphan tails after payload preparation",
    ({ convert }) => {
      for (const encryptedContent of [undefined, null, "", "synthetic-completed-reasoning"]) {
        const item = {
          type: "reasoning",
          id: "rs_standalone",
          summary: [],
          ...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
        };
        const block = {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: JSON.stringify(item),
          openclawReasoningReplay: buildOpenAIResponsesReasoningReplayMetadata(
            model,
            replayIdentity,
          ),
        };
        const input = convert({ messages: [createAssistant([block])] });
        expect(input).toEqual(encryptedContent ? [item] : []);

        const paired = convert({
          messages: [createAssistant([block, { type: "text", text: "Following answer" }])],
        });
        expect(paired.map((entry) => entry.type)).toEqual(["reasoning", "message"]);
      }
    },
  );

  it.each(responseConverters)(
    "$name removes standalone reasoning when replay identity strips its ciphertext",
    ({ name, convert }) => {
      const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
      const item = {
        type: "reasoning",
        id: "rs_foreign",
        summary: [],
        encrypted_content: "synthetic-foreign-reasoning",
      };
      for (const replayMetadata of [
        undefined,
        null,
        { ...metadata, v: 2 },
        { ...metadata, provider: "other-provider" },
        { ...metadata, model: "other-model" },
        { ...metadata, baseUrlHash: "other-endpoint" },
        { ...metadata, sessionHash: "other-session" },
        { ...metadata, authProfileHash: "other-auth" },
      ]) {
        const block = {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: JSON.stringify(item),
          ...(replayMetadata === undefined ? {} : { openclawReasoningReplay: replayMetadata }),
        };
        const input = convert({ messages: [createAssistant([block])] });
        const preservesUnattributed = name === "provider-owned" && replayMetadata === undefined;
        expect(input).toEqual(preservesUnattributed ? [item] : []);
      }
    },
  );
});

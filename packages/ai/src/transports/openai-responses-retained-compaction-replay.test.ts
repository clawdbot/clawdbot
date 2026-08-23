import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
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

function createAssistant(text: string, providerReplay?: ProviderReplayState): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    convert: (context: Context) =>
      convertResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
  {
    name: "provider-owned",
    convert: (context: Context) =>
      convertProviderResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
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
});

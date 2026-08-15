import type { AssistantMessage, Model, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";
import { replaceCompactionReplayOwnerContent } from "./provider-compaction-replay.js";

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
  content: AssistantMessage["content"],
  replayIndex: number,
): AssistantMessage {
  const replayContext = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
  return {
    role: "assistant",
    content,
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
    stopReason: "toolUse",
    timestamp: 0,
    providerReplay: {
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp_replay",
      data: "opaque-replay-compaction",
      replayIndex,
      provider: replayContext.provider,
      api: replayContext.api,
      model: replayContext.model,
      baseUrlHash: replayContext.baseUrlHash,
      sessionHash: replayContext.sessionHash,
      authProfileHash: replayContext.authProfileHash,
    } satisfies ProviderReplayState,
  };
}

describe("compaction replay owner rewrites", () => {
  it("keeps a reindexed call paired with its output", () => {
    const toolCall = { type: "toolCall" as const, id: "call_1", name: "read", arguments: {} };
    const owner = createAssistant([{ type: "text", text: "" }, toolCall], 1);
    const reindexed = replaceCompactionReplayOwnerContent(owner, [toolCall]);
    const input = convertResponsesMessages(
      model,
      {
        messages: [
          reindexed,
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 1,
          },
        ],
      },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(reindexed.providerReplay?.replayIndex).toBe(0);
    expect(input.map((item) => item.type)).toEqual([
      "compaction",
      "function_call",
      "function_call_output",
    ]);
  });

  it("falls back to full history when owner content is emptied", () => {
    const stripped = replaceCompactionReplayOwnerContent(
      createAssistant([{ type: "text", text: "removed" }], 0),
      [],
    );
    const input = convertResponsesMessages(
      model,
      {
        messages: [
          { role: "user", content: "full history prefix", timestamp: 1 },
          stripped,
          { role: "user", content: "current turn", timestamp: 2 },
        ],
      },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(stripped.providerReplay).toBeUndefined();
    expect(input.some((item) => item.type === "compaction")).toBe(false);
    expect(JSON.stringify(input)).toContain("full history prefix");
  });
});

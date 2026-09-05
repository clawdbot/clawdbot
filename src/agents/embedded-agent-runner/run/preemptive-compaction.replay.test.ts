import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { testing } from "../../openai-transport-stream.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { estimateLlmBoundaryTokenPressure } from "./preemptive-compaction.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_192,
} satisfies Model;
const identity = { sessionId: "session-a", authProfileId: "profile-a" };

function assistant(totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "covered assistant" }],
    timestamp: 2,
    stopReason: "stop",
    usage: {
      input: totalTokens - 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      contextUsage: { state: "available", promptTokens: totalTokens - 1, totalTokens },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function checkpoint(text: string): AssistantMessage {
  const owner = assistant(90_000);
  const item = { type: "compaction" as const, id: "cmp_pressure", encrypted_content: "opaque" };
  captureOpenAIResponsesCompaction(
    owner,
    item,
    "retained-users",
    model,
    testing.buildOpenAIResponsesReasoningReplayMetadata(model, identity),
    [{ type: "message", role: "user", content: [{ type: "input_text", text }] }, item],
  );
  return owner;
}

function pressure(messages: AgentMessage[]) {
  return estimateLlmBoundaryTokenPressure({
    messages,
    prompt: "new turn",
    replay: { model, ...identity },
  });
}

describe("provider checkpoint prompt pressure", () => {
  it("counts the canonical window once instead of covered text or stale owner usage", () => {
    const owner = checkpoint("small canonical window");
    const tail: AgentMessage[] = [{ role: "user", content: "follow-up", timestamp: 3 }];
    const canonicalPressure = pressure([owner, ...tail]);
    const withCoveredRaw = pressure([
      { role: "user", content: "covered raw text ".repeat(20_000), timestamp: 1 },
      owner,
      ...tail,
    ]);
    expect(canonicalPressure).toBeLessThan(1_000);
    expect(withCoveredRaw).toBe(canonicalPressure);
    expect(pressure([checkpoint("retained content ".repeat(8_000)), ...tail])).toBeGreaterThan(
      20_000,
    );
  });

  it("counts the window once without attributing unbound later usage to its prefix", () => {
    const owner = checkpoint("retained content ".repeat(8_000));
    const response = assistant(100);
    response.timestamp = 4;
    const tail: AgentMessage[] = [{ role: "user", content: "follow-up", timestamp: 3 }, response];
    const measuredPressure = pressure([owner, ...tail]);
    expect(measuredPressure).toBeGreaterThan(20_000);
    delete response.usage.contextUsage;
    expect(pressure([owner, ...tail])).toBe(measuredPressure);
  });
});

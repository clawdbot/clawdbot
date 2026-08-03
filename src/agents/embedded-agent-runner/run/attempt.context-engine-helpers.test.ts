import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../../llm/types.js";
import { findLatestUncompactedAttemptUsageSnapshot } from "./attempt.context-engine-helpers.js";

const ASSISTANT_WITH_USAGE = {
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 12,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
} satisfies AssistantMessage;

describe("findLatestUncompactedAttemptUsageSnapshot", () => {
  it("uses current-attempt transcript usage when no compaction changed the context", () => {
    expect(
      findLatestUncompactedAttemptUsageSnapshot({
        messagesSnapshot: [ASSISTANT_WITH_USAGE],
        prePromptMessageCount: 0,
        compactionOccurred: false,
      })?.usage,
    ).toMatchObject({ input: 12, output: 4, total: 16 });
  });

  it("does not resurrect transcript usage across a compaction retry", () => {
    expect(
      findLatestUncompactedAttemptUsageSnapshot({
        messagesSnapshot: [ASSISTANT_WITH_USAGE],
        prePromptMessageCount: 0,
        compactionOccurred: true,
      }),
    ).toBeUndefined();
  });
});

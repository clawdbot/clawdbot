import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  buildContextEnginePromptCacheInfo,
  buildLoopPromptCacheInfo,
  findLatestUncompactedAttemptUsageSnapshot,
  resolvePromptCacheTouchTimestamp,
} from "./attempt-context-engine-helpers.js";

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

describe("context-engine prompt cache metadata", () => {
  const seedMessage = { role: "user", content: "seed", timestamp: 1 } as AgentMessage;

  it("builds retention, last-call usage, and cache-touch metadata", () => {
    expect(
      buildContextEnginePromptCacheInfo({
        retention: "short",
        lastCallUsage: { input: 10, output: 5, cacheRead: 40, cacheWrite: 2, total: 57 },
        lastCacheTouchAt: 123,
      }),
    ).toEqual({
      retention: "short",
      lastCallUsage: { input: 10, output: 5, cacheRead: 40, cacheWrite: 2, total: 57 },
      lastCacheTouchAt: 123,
    });
  });

  it("omits metadata when no cache data is available", () => {
    expect(buildContextEnginePromptCacheInfo({})).toBeUndefined();
  });

  it("does not reuse a prior turn's usage when the current attempt has no assistant", () => {
    const priorAssistant = {
      role: "assistant",
      content: "prior turn",
      timestamp: 2,
      usage: { input: 99, output: 7, cacheRead: 1234, total: 1340 },
    } as unknown as AgentMessage;

    expect(
      buildLoopPromptCacheInfo({
        messagesSnapshot: [seedMessage, priorAssistant],
        prePromptMessageCount: 2,
        retention: "short",
      }),
    ).toEqual({ retention: "short" });
  });

  it("derives live loop metadata from the current attempt assistant", () => {
    const assistant = {
      role: "assistant",
      content: "tool use",
      timestamp: "2026-04-16T16:49:59.536Z",
      usage: { input: 1, output: 2, cacheRead: 39036, cacheWrite: 59934, total: 98973 },
    } as unknown as AgentMessage;

    const promptCache = buildLoopPromptCacheInfo({
      messagesSnapshot: [seedMessage, assistant],
      prePromptMessageCount: 1,
      retention: "short",
      fallbackLastCacheTouchAt: 123,
    });
    expect(promptCache?.retention).toBe("short");
    expect(promptCache?.lastCallUsage).toMatchObject({
      cacheRead: 39036,
      cacheWrite: 59934,
      total: 98973,
    });
    expect(promptCache?.lastCacheTouchAt).toBe(Date.parse("2026-04-16T16:49:59.536Z"));
  });

  it("keeps the latest nonzero usage when an aborted assistant reports zeros", () => {
    const completedAssistant = {
      role: "assistant",
      content: "tool use",
      timestamp: "2026-04-16T16:49:59.536Z",
      usage: { input: 38_333, output: 66, cacheRead: 120_320, total: 158_719 },
    } as unknown as AgentMessage;
    const abortedAssistant = {
      role: "assistant",
      content: "",
      timestamp: "2026-04-16T16:50:00.000Z",
      stopReason: "aborted",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as AgentMessage;

    const promptCache = buildLoopPromptCacheInfo({
      messagesSnapshot: [seedMessage, completedAssistant, abortedAssistant],
      prePromptMessageCount: 1,
      retention: "short",
    });
    expect(promptCache?.lastCallUsage).toMatchObject({
      input: 38_333,
      cacheRead: 120_320,
      total: 158_719,
    });
    expect(promptCache?.lastCacheTouchAt).toBe(Date.parse("2026-04-16T16:49:59.536Z"));
  });

  it("falls back to the persisted cache touch when loop usage has no cache metrics", () => {
    const assistant = {
      role: "assistant",
      content: "tool use",
      timestamp: "2026-04-16T16:49:59.536Z",
      usage: { input: 1, output: 2, total: 3 },
    } as unknown as AgentMessage;

    const promptCache = buildLoopPromptCacheInfo({
      messagesSnapshot: [seedMessage, assistant],
      prePromptMessageCount: 1,
      retention: "short",
      fallbackLastCacheTouchAt: 123,
    });
    expect(promptCache?.retention).toBe("short");
    expect(promptCache?.lastCallUsage?.total).toBe(3);
    expect(promptCache?.lastCacheTouchAt).toBe(123);
  });

  it("derives a live cache touch timestamp for final afterTurn usage snapshots", () => {
    expect(
      resolvePromptCacheTouchTimestamp({
        lastCallUsage: { input: 1, output: 2, cacheRead: 39036, cacheWrite: 0, total: 39039 },
        assistantTimestamp: "2026-04-16T17:04:46.974Z",
        fallbackLastCacheTouchAt: 123,
      }),
    ).toBe(Date.parse("2026-04-16T17:04:46.974Z"));
  });
});

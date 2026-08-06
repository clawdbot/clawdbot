import { describe, expect, it } from "vitest";
import type { ImageContent } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { estimateTokens, findCutPoint } from "./compaction.js";

const IMAGE_PAYLOAD = "a".repeat(1_500_000);

function imageBlock(): ImageContent {
  return { type: "image", data: IMAGE_PAYLOAD, mimeType: "image/png" };
}

function userImage(timestamp: number): AgentMessage {
  return { role: "user", content: [imageBlock()], timestamp };
}

function userText(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function toolResultImage(timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "screenshot",
    content: [imageBlock()],
    isError: false,
    timestamp,
  };
}

function assistantText(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function messageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function buildTranscript(recentUserTurns: AgentMessage[]): SessionTreeEntry[] {
  const messages: AgentMessage[] = [userText("start of the conversation", 1)];
  let timestamp = 2;
  for (const turn of recentUserTurns) {
    messages.push(assistantText("ok", timestamp++));
    messages.push(turn);
  }
  return messages.map((message, index) => messageEntry(message, index));
}

describe("estimateTokens image accounting", () => {
  it("charges a user-message image block the same as a tool-result image block", () => {
    const userTokens = estimateTokens(userImage(1));
    const toolTokens = estimateTokens(toolResultImage(1));

    expect(userTokens).toBe(toolTokens);
    expect(userTokens).toBeGreaterThanOrEqual(1200);
  });
});

describe("findCutPoint with image-heavy recent turns", () => {
  it("trims image-dominated user turns instead of keeping the whole transcript", () => {
    const entries = buildTranscript([userImage(10), userImage(20), userImage(30)]);

    const result = findCutPoint(entries, 0, entries.length, 1500);

    expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
  });

  it("matches the cut point of an equivalent text-cost control", () => {
    const equivalentText = "x".repeat(4800);
    const imageEntries = buildTranscript([userImage(10), userImage(20), userImage(30)]);
    const textEntries = buildTranscript([
      userText(equivalentText, 10),
      userText(equivalentText, 20),
      userText(equivalentText, 30),
    ]);

    const imageResult = findCutPoint(imageEntries, 0, imageEntries.length, 1500);
    const textResult = findCutPoint(textEntries, 0, textEntries.length, 1500);

    expect(textResult.firstKeptEntryIndex).toBeGreaterThan(0);
    expect(imageResult.firstKeptEntryIndex).toBe(textResult.firstKeptEntryIndex);
  });
});

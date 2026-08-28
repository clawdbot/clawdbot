import { describe, expect, it } from "vitest";
import type { AssistantMessage, ImageContent, Model } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import type { SessionTreeEntry } from "../types.js";
import { compact, estimateTokens, findCutPoint, prepareCompaction } from "./compaction.js";

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

function assistantText(text: string, timestamp: number): AssistantMessage {
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
    expect(userTokens).toBe(2_000);
  });
});

describe("findCutPoint with image-heavy recent turns", () => {
  it("trims image-dominated user turns instead of keeping the whole transcript", () => {
    const entries = buildTranscript([userImage(10), userImage(20), userImage(30)]);

    const result = findCutPoint(entries, 0, entries.length, 1500);

    expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
  });

  it("matches the cut point of an equivalent text-cost control", () => {
    const equivalentText = "x".repeat(8_000);
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

describe.each([false, true])("image omission through compaction (split turn: %s)", (splitTurn) => {
  it.each(["user", "toolResult"] as const)(
    "records an image-only %s message in summary input and rebuilt context",
    async (role) => {
      const messages: AgentMessage[] =
        role === "user"
          ? [userImage(1)]
          : [
              userText("Inspect the screenshot", 1),
              {
                ...assistantText("", 2),
                content: [{ type: "toolCall", id: "call-1", name: "screenshot", arguments: {} }],
                stopReason: "toolUse",
              },
              toolResultImage(3),
            ];
      messages.push(assistantText("The screenshot was inspected", 4));
      if (!splitTurn) {
        messages.push(userText("Continue with the next task", 5));
      }
      const entries = messages.map(messageEntry);
      const originalEntries = structuredClone(entries);
      const lastEntry = entries.at(-1);
      const preparation = prepareCompaction(entries, {
        enabled: true,
        reserveTokens: 1_000,
        keepRecentTokens: 1,
      });
      if (!preparation.ok || !preparation.value || !lastEntry) {
        throw new Error("expected image history to be compactable");
      }
      expect(preparation.value.isSplitTurn).toBe(splitTurn);
      expect(preparation.value.firstKeptEntryId).toBe(lastEntry.id);

      const model: Model = {
        id: "umbreon-latest",
        name: "Umbreon Latest",
        api: "test-api",
        provider: "test-provider",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 8_000,
      };
      const prompts: string[] = [];
      const result = await compact(
        preparation.value,
        model,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          completeSimple: async (_model, context) => {
            const content = context.messages[0]?.content;
            if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
              throw new Error("expected one text-only summarization input");
            }
            prompts.push(content[0].text);
            // Echo only the supplied conversation: the callback cannot invent an omission fact.
            const conversation = content[0].text
              .split("<conversation>\n")[1]
              ?.split("\n</conversation>")[0];
            return assistantText(conversation || "No conversation content", 6);
          },
        },
      );
      if (!result.ok) {
        throw result.error;
      }
      const marker = "[image data removed - already processed by model]";
      expect(prompts).toHaveLength(1);
      expect
        .soft(prompts[0])
        .toContain(`${role === "user" ? "[User]" : "[Tool result]"}: ${marker}`);
      expect(prompts[0]).not.toContain(IMAGE_PAYLOAD);

      const context = buildSessionContext([
        ...entries,
        {
          type: "compaction",
          id: "compaction-1",
          parentId: lastEntry.id,
          timestamp: new Date(7).toISOString(),
          ...result.value,
        },
      ]);
      expect.soft(context.messages[0]).toMatchObject({
        role: "compactionSummary",
        summary: expect.stringContaining(marker),
      });
      expect(context.messages.at(-1)).toEqual(messages.at(-1));
      expect(JSON.stringify(context.messages)).not.toContain(IMAGE_PAYLOAD);
      expect(entries).toEqual(originalEntries);
    },
  );
});

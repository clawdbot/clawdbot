import { describe, expect, it } from "vitest";
import type { AssistantMessage, ImageContent, Model } from "../../llm.js";
import type { AgentCoreCompletionRuntimeDeps } from "../../runtime-deps.js";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import type { SessionTreeEntry } from "../types.js";
import { generateBranchSummary } from "./branch-summarization.js";
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

function summaryModel(contextWindow = 100_000): Model {
  return {
    id: "summary-model",
    name: "Summary Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 2048,
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
    // The 2,000-token image pressure is separate from the summary omission record.
    expect(userTokens).toBe(2_000 + 14);
    expect(
      estimateTokens({
        role: "custom",
        content: [imageBlock()],
        timestamp: 1,
        customType: "image",
        display: true,
      }),
    ).toBe(userTokens);
  });
});

describe("findCutPoint with image-heavy recent turns", () => {
  it("trims image-dominated user turns instead of keeping the whole transcript", () => {
    const entries = buildTranscript([userImage(10), userImage(20), userImage(30)]);

    const result = findCutPoint(entries, 0, entries.length, 1500);

    expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
  });

  it("matches the cut point of an equivalent text-cost control", () => {
    const equivalentText = "x".repeat(8_056);
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

describe.each([
  { splitTurn: false, completed: false },
  { splitTurn: false, completed: true },
  { splitTurn: true, completed: true },
])(
  "image omission through compaction (split: $splitTurn, completed: $completed)",
  ({ splitTurn, completed }) => {
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
        if (completed) {
          messages.push(assistantText("The screenshot was inspected", 4));
        }
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

        const model = summaryModel();
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
        const marker = "[image data omitted from summary input]";
        expect(prompts).toHaveLength(1);
        expect
          .soft(prompts[0])
          .toContain(`${role === "user" ? "[User]" : "[Tool result]"}: ${marker}`);
        expect(prompts[0]).not.toContain(IMAGE_PAYLOAD);
        expect(prompts[0]).not.toContain("already processed by model");

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
  },
);

describe.each(["ordinary", "split", "branch"] as const)("%s summary omission budget", (mode) => {
  it.each(["image", "audio"])(
    "bounds many %s messages at the completion boundary",
    async (type) => {
      const model = summaryModel(type === "image" ? 1_000_000 : 8192);
      const messages: AgentMessage[] = [
        userText("Inspect attachments", 0),
        ...Array.from(
          { length: 200 },
          (_, i) =>
            ({
              role: "toolResult",
              toolCallId: `call-${i}`,
              toolName: "inspect",
              isError: false,
              timestamp: i + 1,
              content: [{ type, data: "PAYLOAD_SENTINEL", mimeType: "image/png" }],
            }) as AgentMessage,
        ),
      ];
      const entries = messages.map(messageEntry);
      const conversations: string[] = [];
      const runtime: AgentCoreCompletionRuntimeDeps = {
        completeSimple: async (_model, context) => {
          const content = context.messages[0]?.content;
          if (!Array.isArray(content) || content[0]?.type !== "text") {
            throw new Error("expected summary prompt");
          }
          const conversation = content[0].text
            .split("<conversation>\n")[1]
            ?.split("\n</conversation>")[0];
          if (!conversation) {
            throw new Error("expected conversation");
          }
          conversations.push(conversation);
          return assistantText("Summary", 202);
        },
      };
      let result;
      if (mode === "branch") {
        result = await generateBranchSummary(entries, {
          model,
          apiKey: "test-key",
          signal: new AbortController().signal,
          runtime,
        });
      } else {
        entries.push(
          messageEntry(
            mode === "split" ? assistantText("Retained answer", 201) : userText("Next task", 201),
            entries.length,
          ),
        );
        const preparation = prepareCompaction(entries, {
          enabled: true,
          reserveTokens: 1000,
          keepRecentTokens: 1,
        });
        if (!preparation.ok || !preparation.value) {
          throw new Error("expected compactable history");
        }
        expect(preparation.value.isSplitTurn).toBe(mode === "split");
        result = await compact(
          preparation.value,
          model,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          runtime,
        );
      }
      expect(result.ok).toBe(true);
      expect(conversations).toHaveLength(1);
      const conversation = conversations[0];
      if (!conversation) {
        throw new Error("expected captured conversation");
      }
      expect(
        Buffer.byteLength(conversation) - Buffer.byteLength("[User]: Inspect attachments"),
      ).toBeLessThanOrEqual(847);
      expect(conversation.match(/\[Tool result\]:/g)).toHaveLength(8);
      expect(
        conversation.split("[More image/non-text data omitted from summary input]"),
      ).toHaveLength(2);
      expect(conversation).not.toMatch(/PAYLOAD_SENTINEL|already processed by model/);
    },
  );
});

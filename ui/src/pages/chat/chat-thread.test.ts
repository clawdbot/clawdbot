// Control UI tests cover build chat items behavior.
import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { extractToolCards } from "../../lib/chat/tool-cards.ts";
import {
  buildCachedChatItems,
  buildChatItems,
  getExpandedToolCards,
  resetChatThreadState,
  syncToolCardExpansionState,
  type BuildChatItemsProps,
} from "./chat-thread.ts";

const SENDER_METADATA_BLOCK =
  'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n```';

function createProps(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    sessionKey: "main",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

function messageGroups(props: Partial<BuildChatItemsProps>): MessageGroup[] {
  return buildChatItems(createProps(props)).filter((item) => item.kind === "group");
}

function firstMessageContent(group: MessageGroup): unknown[] {
  const message = group.messages[0]?.message as { content?: unknown };
  return Array.isArray(message.content) ? message.content : [];
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function requireGroup(value: unknown): MessageGroup {
  const record = requireRecord(value);
  expect(record.kind).toBe("group");
  return value as MessageGroup;
}

function messageRecord(group: MessageGroup, index = 0): Record<string, unknown> {
  return requireRecord(group.messages[index]?.message);
}

describe("buildChatItems working spark", () => {
  const hasReadingIndicator = (props: Partial<BuildChatItemsProps>) =>
    buildChatItems(createProps(props)).some((item) => item.kind === "reading-indicator");
  const liveTool = (resultReceived: boolean) => ({
    role: "assistant",
    toolCallId: "tool-1",
    content: [{ type: "toolcall", name: "exec", arguments: {} }],
    timestamp: 1_000,
    __openclawToolStreamLive: true,
    __openclawToolStreamResultReceived: resultReceived,
  });

  it("shows the spark while a run works with nothing streaming", () => {
    expect(hasReadingIndicator({ runWorking: true })).toBe(true);
  });

  it("keeps the spark during a background reload with visible content", () => {
    expect(
      hasReadingIndicator({
        runWorking: true,
        loading: true,
        messages: [{ role: "assistant", content: "answer", timestamp: 1 }],
      }),
    ).toBe(true);
  });

  it("yields to the initial-load skeleton on an empty thread", () => {
    expect(hasReadingIndicator({ runWorking: true, loading: true })).toBe(false);
  });

  it("does not stack the spark under a visible running tool row", () => {
    expect(hasReadingIndicator({ runWorking: true, toolMessages: [liveTool(false)] })).toBe(false);
  });

  it("returns the spark once the running tool resolves", () => {
    expect(hasReadingIndicator({ runWorking: true, toolMessages: [liveTool(true)] })).toBe(true);
  });

  it("keeps the spark when tool calls are hidden", () => {
    expect(
      hasReadingIndicator({
        runWorking: true,
        showToolCalls: false,
        toolMessages: [liveTool(false)],
      }),
    ).toBe(true);
  });
});

describe("buildChatItems", () => {
  it("keeps consecutive user messages from different senders in separate groups", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: "first",
          senderLabel: "Iris",
          timestamp: 1000,
        },
        {
          role: "user",
          content: "second",
          senderLabel: "Joaquin De Rojas",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual(["Iris", "Joaquin De Rojas"]);
  });

  it("keeps differently cased user roles in one group", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: "first",
          timestamp: 1000,
        },
        {
          role: "User",
          content: "second",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe("user");
    expect(groups[0].messages).toHaveLength(2);
  });

  it("groups and hides top-level tool-use id results consistently", () => {
    const message = {
      role: "assistant",
      toolUseId: "provider-result",
      toolName: "bash",
      content: "Provider output",
      timestamp: 1000,
    };

    const visibleGroups = messageGroups({ messages: [message] });
    expect(visibleGroups).toHaveLength(1);
    expect(visibleGroups[0].role).toBe("tool");

    const hiddenGroups = messageGroups({ messages: [message], showToolCalls: false });
    expect(hiddenGroups).toHaveLength(0);
  });

  it("keeps forwarded assistant display messages separate from local assistant replies", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: "local reply",
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: "forwarded report",
          senderLabel: "Forwarded from main",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual([null, "Forwarded from main"]);
  });

  it("marks earlier tool groups as succeeded when the same turn has an assistant reply", () => {
    const groups = messageGroups({
      messages: [
        { role: "user", content: "search", timestamp: 1000 },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "web_search",
          isError: true,
          content: JSON.stringify({ error: "No matches" }),
          timestamp: 1001,
        },
        { role: "assistant", content: "I found another route.", timestamp: 1002 },
        { role: "user", content: "again", timestamp: 1003 },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "web_search",
          isError: true,
          content: JSON.stringify({ error: "No matches" }),
          timestamp: 1004,
        },
      ],
    });

    const toolGroups = groups.filter((group) => group.role === "tool");
    expect(toolGroups.map((group) => group.turnSucceeded)).toEqual([true, false]);
  });

  it("coalesces adjacent tool calls and results into one activity item", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-shell",
              name: "bash",
              input: { command: "run openclaw doctor" },
            },
          ],
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "call-shell",
          toolName: "bash",
          content: [
            { type: "text", text: "Doctor complete" },
            { type: "image", data: "fixture-image", mimeType: "image/png" },
          ],
          isError: false,
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe("tool");
    expect(groups[0].messages).toHaveLength(1);
    const cards = extractToolCards(groups[0].messages[0]?.message, "coalesced");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "call-shell",
      name: "bash",
      outputText: "Doctor complete",
    });
    expect(firstMessageContent(groups[0])).toContainEqual({
      type: "image",
      data: "fixture-image",
      mimeType: "image/png",
    });
  });

  it("coalesces interleaved parallel call/result pairs by call id", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } }],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } }],
          timestamp: 1001,
        },
        {
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "read",
          content: [{ type: "toolResult", text: "contents of a" }],
          timestamp: 1002,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "read",
          content: [{ type: "toolResult", text: "contents of b" }],
          timestamp: 1003,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe("tool");
    expect(groups[0].messages).toHaveLength(2);
    const cards = groups[0].messages.flatMap((entry, index) =>
      extractToolCards(entry.message, `interleaved-${index}`),
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ callId: "call-a", outputText: "contents of a" });
    expect(cards[1]).toMatchObject({ callId: "call-b", outputText: "contents of b" });
  });

  it("replaces a repeated unresolved single-call snapshot", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-x", name: "read", input: { path: "old.ts" } }],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-x", name: "read", input: { path: "new.ts" } }],
          timestamp: 1001,
        },
        {
          role: "toolResult",
          toolCallId: "call-x",
          toolName: "read",
          content: [{ type: "text", text: "new contents" }],
          timestamp: 1002,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    const cards = extractToolCards(groups[0].messages[0]?.message, "repeated-snapshot");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "call-x",
      args: { path: "new.ts" },
      outputText: "new contents",
    });
  });

  it("keeps more than sixteen parallel calls open by call id", () => {
    const groups = messageGroups({
      messages: [
        ...Array.from({ length: 17 }, (_, index) => ({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `call-${index}`,
              name: "read",
              input: { path: `${index}.ts` },
            },
          ],
          timestamp: 1000 + index,
        })),
        {
          role: "toolResult",
          toolCallId: "call-0",
          toolName: "read",
          content: [{ type: "text", text: "first contents" }],
          timestamp: 1017,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(17);
    const cards = groups[0].messages.flatMap((entry, index) =>
      extractToolCards(entry.message, `many-open-${index}`),
    );
    expect(cards).toHaveLength(17);
    expect(cards.find((card) => card.callId === "call-0")).toMatchObject({
      outputText: "first contents",
    });
  });

  it("distributes one typed multi-result message across separate open calls", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } }],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } }],
          timestamp: 1001,
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
          ],
          timestamp: 1002,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    const cards = groups[0].messages.flatMap((entry, index) =>
      extractToolCards(entry.message, `bundled-results-${index}`),
    );
    expect(cards.map((card) => [card.callId, card.outputText])).toEqual([
      ["call-a", "contents of a"],
      ["call-b", "contents of b"],
    ]);
  });

  it("coalesces a canonical multi-call assistant message with standalone results", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
          ],
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "read",
          content: [{ type: "text", text: "contents of a" }],
          timestamp: 1001,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "read",
          content: [{ type: "text", text: "contents of b" }],
          timestamp: 1002,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe("tool");
    expect(groups[0].messages).toHaveLength(1);
    const cards = extractToolCards(groups[0].messages[0]?.message, "canonical-parallel");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      callId: "call-a",
      args: { path: "a.ts" },
      outputText: "contents of a",
    });
    expect(cards[1]).toMatchObject({
      callId: "call-b",
      args: { path: "b.ts" },
      outputText: "contents of b",
    });
  });

  it("coalesces canonical multi-call results delivered in one provider message", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } },
            { type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } },
          ],
          timestamp: 1000,
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
          ],
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe("tool");
    expect(groups[0].messages).toHaveLength(1);
    const cards = extractToolCards(groups[0].messages[0]?.message, "canonical-provider");
    expect(cards.map((card) => [card.callId, card.outputText])).toEqual([
      ["call-a", "contents of a"],
      ["call-b", "contents of b"],
    ]);
  });

  it("does not pair results across a user message boundary", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-x", name: "read", input: { path: "x.ts" } }],
          timestamp: 1000,
        },
        { role: "user", content: "never mind", timestamp: 1001 },
        {
          role: "toolResult",
          toolCallId: "call-x",
          toolName: "read",
          content: [{ type: "toolResult", text: "late result" }],
          timestamp: 1002,
        },
      ],
    });

    // Call and late result stay separate items around the user turn.
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.role)).toEqual(["tool", "user", "tool"]);
  });

  it("coalesces provider-shaped result blocks by canonical tool-use id", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolUseId: "provider-call",
              name: "bash",
              input: { command: "provider command" },
            },
          ],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_result",
              tool_use_id: "provider-call",
              text: "Provider result",
            },
          ],
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    const cards = extractToolCards(groups[0].messages[0]?.message, "provider-coalesced");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "provider-call",
      name: "bash",
      outputText: "Provider result",
    });
  });

  it("keeps adjacent tool messages separate when their call ids differ", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-a", name: "bash", input: { command: "one" } }],
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "bash",
          content: "Different call",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
  });

  it("keeps empty forwarded assistant display groups", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          senderLabel: "Forwarded from main",
          timestamp: 1000,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe("assistant");
    expect(groups[0].senderLabel).toBe("Forwarded from main");
    expect(groups[0].messages).toHaveLength(1);
  });

  it("collapses consecutive duplicate text messages into one rendered item with a count", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 3 },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    expect(groups[0].messages[0].duplicateCount).toBe(3);
  });

  it("deduplicates relay-labeled assistant copies by source message id", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "reply-1",
          role: "assistant",
          content: [{ type: "text", text: "Parzival There it is." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          id: "reply-1",
          role: "assistant",
          content: [{ type: "text", text: "There it is." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].senderLabel).toBeNull();
    expect(groups[0].messages).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toStrictEqual([
      { type: "text", text: "There it is." },
    ]);
  });

  it("deduplicates relay-labeled assistant copies by event messageId", () => {
    const groups = messageGroups({
      messages: [
        {
          messageId: "reply-2",
          role: "assistant",
          content: [{ type: "text", text: "Parzival Found it." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          messageId: "reply-2",
          role: "assistant",
          content: [{ type: "text", text: "Found it." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].senderLabel).toBeNull();
    expect(groups[0].messages).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toStrictEqual([{ type: "text", text: "Found it." }]);
  });

  it("deduplicates relay-labeled assistant copies by OpenClaw transcript metadata id", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-3" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival On it." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-3" },
          role: "assistant",
          content: [{ type: "text", text: "On it." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].senderLabel).toBeNull();
    expect(groups[0].messages).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toStrictEqual([{ type: "text", text: "On it." }]);
  });

  it("deduplicates relay-labeled assistant copies by OpenClaw metadata before surface ids", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "relay-surface-copy",
          __openclaw: { id: "reply-4" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival Ship it." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          id: "native-surface-copy",
          __openclaw: { id: "reply-4" },
          role: "assistant",
          content: [{ type: "text", text: "Ship it." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].senderLabel).toBeNull();
    expect(groups[0].messages).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toStrictEqual([{ type: "text", text: "Ship it." }]);
  });

  it("keeps native assistant updates separate when source message id repeats with new text", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-5" },
          role: "assistant",
          content: [{ type: "text", text: "Draft one" }],
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-5" },
          role: "assistant",
          content: [{ type: "text", text: "Draft two" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    expect(messageRecord(groups[0], 0).content).toStrictEqual([
      { type: "text", text: "Draft one" },
    ]);
    expect(messageRecord(groups[0], 1).content).toStrictEqual([
      { type: "text", text: "Draft two" },
    ]);
  });

  it("keeps formatting-only assistant updates separate for the same source message", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-formatted" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival first\n\nsecond" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-formatted" },
          role: "assistant",
          content: [{ type: "text", text: "first second" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(messageRecord(groups[0]).content).toStrictEqual([
      { type: "text", text: "Parzival first\n\nsecond" },
    ]);
    expect(messageRecord(groups[1]).content).toStrictEqual([
      { type: "text", text: "first second" },
    ]);
  });

  it("keeps differently cased sender text separate for the same source message", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-case-change" },
          role: "assistant",
          content: [{ type: "text", text: "PARZIVAL answer" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-case-change" },
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(messageRecord(groups[0]).content).toStrictEqual([
      { type: "text", text: "PARZIVAL answer" },
    ]);
    expect(messageRecord(groups[1]).content).toStrictEqual([{ type: "text", text: "answer" }]);
  });

  it("keeps relay-labeled assistant updates separate when source message id repeats with new text", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-6" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival Draft one" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-6" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival Draft two" }],
          senderLabel: "Parzival",
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].senderLabel).toBe("Parzival");
    expect(groups[0].messages).toHaveLength(2);
    expect(messageRecord(groups[0], 0).content).toStrictEqual([
      { type: "text", text: "Parzival Draft one" },
    ]);
    expect(messageRecord(groups[0], 1).content).toStrictEqual([
      { type: "text", text: "Parzival Draft two" },
    ]);
  });

  it("keeps identical assistant text separate when source message ids differ", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "reply-7",
          role: "assistant",
          content: [{ type: "text", text: "Same update" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          id: "reply-8",
          role: "assistant",
          content: [{ type: "text", text: "Same update" }],
          senderLabel: "Parzival",
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    expect(groups[0].messages[0].duplicateCount).toBeUndefined();
    expect(groups[0].messages[1].duplicateCount).toBeUndefined();
  });

  it("keeps same-id user relay copies separate so sender identity is preserved", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "user-1" },
          role: "user",
          content: [{ type: "text", text: "Alice hello" }],
          senderLabel: "Alice",
          timestamp: 1,
        },
        {
          __openclaw: { id: "user-1" },
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual(["Alice", null]);
    expect(groups[0].messages).toHaveLength(1);
    expect(groups[1].messages).toHaveLength(1);
  });

  it("suppresses assistant HEARTBEAT_OK acknowledgements before rendering history", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: 1 },
        { role: "assistant", content: "HEARTBEAT_OK", timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "Visible reply" }], timestamp: 4 },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].role).toBe("user");
    expect(groups[1].role).toBe("assistant");
    expect(messageRecord(groups[1]).content).toStrictEqual([
      { type: "text", text: "Visible reply" },
    ]);
  });

  it("suppresses assistant HEARTBEAT_OK acknowledgements that carry hidden thinking blocks", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking scheduled work." },
            {
              type: "text",
              text: "HEARTBEAT_OK",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { id: "rs_1", type: "reasoning" },
            { type: "text", text: "HEARTBEAT_OK" },
          ],
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Useful hidden reasoning." },
            { type: "text", text: "Visible reply" },
          ],
          timestamp: 3,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toStrictEqual([
      { type: "thinking", thinking: "Useful hidden reasoning." },
      { type: "text", text: "Visible reply" },
    ]);
  });

  it("keeps HEARTBEAT_OK turns that carry visible non-text content", () => {
    const canvasBlock = createAssistantCanvasBlock({ suffix: "heartbeat_visible_content" });
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "HEARTBEAT_OK" }, canvasBlock],
          timestamp: 1,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    expect(canvasBlocksIn(groups[0])).toHaveLength(1);
  });

  it("suppresses active HEARTBEAT_OK streams before rendering", () => {
    const items = buildChatItems(
      createProps({
        stream: "HEARTBEAT_OK",
        streamStartedAt: 1,
      }),
    );

    expect(items).toStrictEqual([]);
  });

  it("suppresses active sender metadata streams before rendering", () => {
    const items = buildChatItems(
      createProps({
        stream: SENDER_METADATA_BLOCK,
        streamStartedAt: 1,
      }),
    );

    expect(items).toStrictEqual([]);
  });

  it("strips sender metadata from active stream text that has visible content", () => {
    const items = buildChatItems(
      createProps({
        stream: `${SENDER_METADATA_BLOCK}\n\nVisible reply`,
        streamStartedAt: 1,
      }),
    );

    expect(items).toEqual([
      {
        kind: "stream",
        key: "stream:main:1",
        text: "Visible reply",
        startedAt: 1,
        isStreaming: true,
      },
    ]);
  });

  it("deduplicates accumulated stream snapshots around tool cards", () => {
    const items = buildChatItems(
      createProps({
        streamSegments: [
          { text: "First thought.", ts: 1 },
          { text: "First thought. After tool.", ts: 3 },
        ],
        toolMessages: [
          { role: "toolResult", content: "Tool one", timestamp: 2 },
          { role: "toolResult", content: "Tool two", timestamp: 4 },
        ],
        stream: "First thought. After tool. Final sentence.",
        streamStartedAt: 5,
      }),
    );

    expect(items.filter((item) => item.kind === "stream")).toMatchObject([
      { text: "First thought." },
      { text: "After tool." },
      { text: "Final sentence." },
    ]);
  });

  it("keeps distinct keyed preamble segments independent from accumulated stream snapshots", () => {
    const items = buildChatItems(
      createProps({
        streamSegments: [
          { text: "Checking workspace", ts: 0, itemId: "preamble-1" },
          { text: "Checking workspace", ts: 0, itemId: "preamble-2" },
          { text: "Checking workspace details", ts: 0, itemId: "preamble-3" },
        ],
        toolMessages: [{ role: "toolResult", content: "Tool output", timestamp: 1 }],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "Checking workspace", startedAt: 0 },
      { kind: "stream", text: "Checking workspace", startedAt: 0 },
      { kind: "stream", text: "Checking workspace details", startedAt: 0 },
      { kind: "group", role: "tool" },
    ]);
  });

  it("keeps already-visible tool cards before matching-timestamp keyed preambles", () => {
    const items = buildChatItems(
      createProps({
        streamSegments: [{ text: "Checking after the tool", ts: 1, itemId: "preamble-after-tool" }],
        toolMessages: [{ role: "toolResult", content: "Tool output", timestamp: 1 }],
      }),
    );

    expect(items).toMatchObject([
      { kind: "group", role: "tool" },
      { kind: "stream", text: "Checking after the tool", startedAt: 1 },
    ]);
  });

  it("orders a keyed preamble that arrived before a later tool above that tool", () => {
    // Regression: keyed commentary must merge into the timestamp ordering path
    // rather than render below every tool card. A preamble that arrived between
    // an earlier and a later tool should stay between them while the run is live.
    const items = buildChatItems(
      createProps({
        streamSegments: [
          { text: "Planning the next step", ts: 2, itemId: "preamble-between-tools" },
        ],
        toolMessages: [
          { role: "toolResult", content: "First tool", timestamp: 1 },
          { role: "toolResult", content: "Second tool", timestamp: 3 },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "group", role: "tool" },
      { kind: "stream", text: "Planning the next step", startedAt: 2 },
      { kind: "group", role: "tool" },
    ]);
    const streamItems = items.filter((item) => item.kind === "stream");
    expect(streamItems).toHaveLength(1);
  });

  it("keeps a live tool card after the stream segment that introduced it", () => {
    const items = buildChatItems(
      createProps({
        streamSegments: [{ text: "I will inspect the file.", ts: 2_000, toolCallId: "call-read" }],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: "file contents",
            timestamp: 1_000,
          },
        ],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "I will inspect the file.",
    });
    expect(messageRecord(requireGroup(items[1])).toolCallId).toBe("call-read");
  });

  it("keeps same-millisecond stream segments interleaved with their matching tool cards", () => {
    const items = buildChatItems(
      createProps({
        streamSegments: [
          { text: "First tool.", ts: 2_000, toolCallId: "call-read" },
          { text: "First tool. Second tool.", ts: 2_000, toolCallId: "call-list" },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: "file contents",
            timestamp: 1_000,
          },
          {
            role: "toolResult",
            toolCallId: "call-list",
            toolName: "list",
            content: "file list",
            timestamp: 1_000,
          },
        ],
      }),
    );

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: "stream", text: "First tool." });
    expect(messageRecord(requireGroup(items[1])).toolCallId).toBe("call-read");
    expect(items[2]).toMatchObject({ kind: "stream", text: "Second tool." });
    expect(messageRecord(requireGroup(items[3])).toolCallId).toBe("call-list");
  });

  it("keeps a live tool card after its stream segment when an unkeyed preamble shifts indexes", () => {
    const items = buildChatItems(
      createProps({
        streamSegments: [
          { text: "Checking workspace", ts: 1_500 },
          {
            text: "Checking workspace I will inspect the file.",
            ts: 2_000,
            toolCallId: "call-read",
          },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: "file contents",
            timestamp: 1_000,
          },
        ],
      }),
    );

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "Checking workspace",
      startedAt: 1_500,
    });
    expect(items[1]).toMatchObject({
      kind: "stream",
      text: "I will inspect the file.",
    });
    expect(messageRecord(requireGroup(items[2])).toolCallId).toBe("call-read");
  });

  it("suppresses metadata-only history messages before grouping", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: SENDER_METADATA_BLOCK,
          senderLabel: "openclaw-control-ui",
          timestamp: 1,
        },
      ],
    });

    expect(groups).toStrictEqual([]);
  });

  it("renders only the last 100 history messages and shows a hidden-count notice", () => {
    const items = buildChatItems(
      createProps({
        messages: Array.from({ length: 105 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index}`,
          timestamp: index,
        })),
      }),
    );

    const groups = items.filter((item) => item.kind === "group");

    const noticeGroup = requireGroup(items[0]);
    expect(noticeGroup.messages).toHaveLength(1);
    const noticeMessage = messageRecord(noticeGroup);
    expect(noticeMessage.role).toBe("system");
    expect(noticeMessage.content).toBe("Showing last 100 messages (5 hidden).");
    expect(groups).toHaveLength(101);
    expect(messageRecord(groups[1]).content).toBe("message 5");
    expect(messageRecord(groups[groups.length - 1]).content).toBe("message 104");
  });

  it("honors a smaller history render window and preserves the hidden-count notice", () => {
    const items = buildChatItems(
      createProps({
        historyRenderLimit: 30,
        messages: Array.from({ length: 105 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index}`,
          timestamp: index,
        })),
      }),
    );

    const groups = items.filter((item) => item.kind === "group");

    const noticeGroup = requireGroup(items[0]);
    expect(messageRecord(noticeGroup).content).toBe("Showing last 30 messages (75 hidden).");
    expect(groups).toHaveLength(31);
    expect(messageRecord(groups[1]).content).toBe("message 75");
    expect(messageRecord(groups[groups.length - 1]).content).toBe("message 104");
  });

  it("budgets rendered history by tool-result content size", () => {
    const largeOutput = "x".repeat(100_000);
    const items = buildChatItems(
      createProps({
        messages: Array.from({ length: 6 }, (_, index) => ({
          role: "assistant",
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool-${index}`,
              content: largeOutput,
            },
          ],
          timestamp: index,
        })),
      }),
    );

    const groups = items.filter((item) => item.kind === "group");
    const noticeGroup = requireGroup(items[0]);
    expect(messageRecord(noticeGroup).content).toBe("Showing last 2 messages (4 hidden).");
    expect(groups).toHaveLength(2);
    expect(groups[1].messages).toHaveLength(2);
    expect(messageRecord(groups[1], 0).timestamp).toBe(4);
    expect(messageRecord(groups[1], 1).timestamp).toBe(5);
  });

  it("does not crash when history contains malformed entries", () => {
    const items = buildChatItems(
      createProps({
        messages: [
          null,
          undefined,
          {
            role: "assistant",
            content: "still visible",
            timestamp: 1,
          },
        ],
      }),
    );

    const groups = items.filter((item) => item.kind === "group");
    expect(groups).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toBe("still visible");
  });

  it("does not collapse duplicate text messages separated by another message", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "break" }], timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 3 },
      ],
    });

    expect(groups).toHaveLength(3);
    expect(groups[0].messages[0].duplicateCount).toBeUndefined();
    expect(groups[2].messages[0].duplicateCount).toBeUndefined();
  });

  it("does not collapse messages that carry canvas previews", () => {
    const canvasBlock = createAssistantCanvasBlock({ suffix: "duplicate_guard" });
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "preview" }, canvasBlock],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "preview" }, canvasBlock],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    expect(groups[0].messages[0].duplicateCount).toBeUndefined();
  });

  it("orders live tool messages before newer history messages", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Newer history reply." }],
          timestamp: 2_000,
        },
      ],
      toolMessages: [
        {
          role: "tool",
          toolCallId: "call-older-tool",
          toolName: "shell",
          content: "Older live tool output.",
          timestamp: 1_000,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.role)).toEqual(["tool", "assistant"]);
    expect(messageRecord(groups[0]).content).toBe("Older live tool output.");
    expect(messageRecord(groups[1]).content).toStrictEqual([
      { type: "text", text: "Newer history reply." },
    ]);
  });

  it("orders completed stream segments before newer history messages", () => {
    const items = buildChatItems(
      createProps({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Newer history reply." }],
            timestamp: 2_000,
          },
        ],
        streamSegments: [{ text: "Older streamed output.", ts: 1_000 }],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "Older streamed output.",
      startedAt: 1_000,
      isStreaming: false,
    });
    expect(requireGroup(items[1]).role).toBe("assistant");
  });

  it("orders timestamped chat items before history messages without timestamps", () => {
    const items = buildChatItems(
      createProps({
        messages: [{ role: "assistant", content: "Missing timestamp." }],
        streamSegments: [{ text: "Timestamped stream.", ts: Number.MAX_SAFE_INTEGER }],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "Timestamped stream.",
      startedAt: Number.MAX_SAFE_INTEGER,
      isStreaming: false,
    });
    expect(messageRecord(requireGroup(items[1])).content).toBe("Missing timestamp.");
  });

  it("renders an active stream after the persisted user turn it answers", () => {
    const items = buildChatItems(
      createProps({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Persisted prompt." }],
            timestamp: 2_000,
          },
        ],
        stream: "Visible partial answer.",
        streamStartedAt: 1_000,
      }),
    );

    expect(items).toHaveLength(2);
    expect(requireGroup(items[0]).role).toBe("user");
    expect(items[1]).toMatchObject({
      kind: "stream",
      text: "Visible partial answer.",
      startedAt: 2_001,
      isStreaming: true,
    });
  });

  it("renders submitted queued sends as user turns before chat.send ACK", () => {
    const groups = messageGroups({
      messages: [{ role: "assistant", content: "Ready.", timestamp: 1 }],
      queue: [
        {
          id: "pending-send-1",
          text: "first visible send",
          createdAt: 2,
          sendSubmittedAtMs: 10,
          sendState: "sending",
        },
      ],
    });

    expect(groups.map((group) => group.role)).toEqual(["assistant", "user"]);
    expect(messageRecord(groups[1]).content).toStrictEqual([
      { type: "text", text: "first visible send" },
    ]);
  });

  it("renders submitted queued attachment sends with attachment blocks before chat.send ACK", () => {
    const groups = messageGroups({
      queue: [
        {
          id: "pending-attachment-send-1",
          text: "see attached",
          createdAt: 2,
          sendSubmittedAtMs: 10,
          sendState: "sending",
          attachments: [
            {
              id: "attachment-1",
              mimeType: "image/png",
              fileName: "screenshot.png",
              previewUrl: "/media/screenshot.png",
            },
          ],
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toStrictEqual([
      { type: "text", text: "see attached" },
      {
        type: "image",
        url: "/media/screenshot.png",
        source: { type: "url", url: "/media/screenshot.png" },
      },
    ]);
  });

  it("does not collapse pending sends with matching history text", () => {
    const groups = messageGroups({
      messages: [{ role: "user", content: "same prompt", timestamp: 1 }],
      queue: [
        {
          id: "pending-send-1",
          text: "same prompt",
          createdAt: 2,
          sendSubmittedAtMs: 10,
          sendState: "sending",
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    expect(groups[0].messages[0].duplicateCount).toBeUndefined();
    expect(groups[0].messages[1].duplicateCount).toBeUndefined();
  });

  it("keeps failed queued sends out of the thread", () => {
    const groups = messageGroups({
      queue: [
        {
          id: "failed-send-1",
          text: "restore me to the composer",
          createdAt: 1,
          sendSubmittedAtMs: 10,
          sendState: "failed",
        },
      ],
    });

    expect(groups).toStrictEqual([]);
  });

  it("filters submitted queued sends while chat search is active", () => {
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "matching",
      queue: [
        {
          id: "pending-send-1",
          text: "matching prompt",
          createdAt: 1,
          sendSubmittedAtMs: 10,
          sendState: "sending",
        },
        {
          id: "pending-send-2",
          text: "unrelated prompt",
          createdAt: 2,
          sendSubmittedAtMs: 11,
          sendState: "sending",
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(messageRecord(groups[0]).content).toStrictEqual([
      { type: "text", text: "matching prompt" },
    ]);
  });

  it("attaches lifted canvas previews to the nearest assistant turn", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-with-canvas",
          role: "assistant",
          content: [{ type: "text", text: "First reply." }],
          timestamp: 1_000,
        },
        {
          id: "assistant-without-canvas",
          role: "assistant",
          content: [{ type: "text", text: "Later unrelated reply." }],
          timestamp: 2_000,
        },
      ],
      toolMessages: [
        {
          id: "tool-canvas-for-first-reply",
          role: "tool",
          toolCallId: "call-canvas-old",
          toolName: "canvas_render",
          content: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_nearest_turn",
              url: "/__openclaw__/canvas/documents/cv_nearest_turn/index.html",
              title: "Nearest turn demo",
              preferred_height: 320,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          timestamp: 1_001,
        },
      ],
    });

    expect(canvasBlocksIn(groups[0])).toHaveLength(1);
    expect(canvasBlocksIn(groups[1])).toStrictEqual([]);
  });

  it("preserves a metadata-only assistant anchor when lifting canvas previews", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-metadata-anchor",
          role: "assistant",
          content: SENDER_METADATA_BLOCK,
          timestamp: 1_000,
        },
      ],
      toolMessages: [
        {
          id: "tool-canvas-for-empty-anchor",
          role: "tool",
          toolCallId: "call-canvas-empty-anchor",
          toolName: "canvas_render",
          content: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_empty_anchor",
              url: "/__openclaw__/canvas/documents/cv_empty_anchor/index.html",
              title: "Empty anchor demo",
              preferred_height: 320,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          timestamp: 1_001,
        },
      ],
    });

    expect(
      groups.some((group) => firstMessageContent(group).some((block) => isCanvasBlock(block))),
    ).toBe(true);
  });

  it("does not lift generic view handles from non-canvas payloads", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-generic-inline",
          role: "assistant",
          content: [{ type: "text", text: "Rendered the item inline." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-generic-inline",
          role: "tool",
          toolCallId: "call-generic-inline",
          toolName: "plugin_card_details",
          content: JSON.stringify({
            selected_item: {
              summary: {
                label: "Alpha",
                meaning: "Generic example",
              },
              view: {
                backend: "canvas",
                id: "cv_generic_inline",
                url: "/__openclaw__/canvas/documents/cv_generic_inline/index.html",
                title: "Inline generic preview",
                preferred_height: 420,
              },
            },
          }),
          timestamp: 1001,
        },
      ],
    });

    expect(canvasBlocksIn(groups[0])).toStrictEqual([]);
  });

  it("lifts streamed canvas toolresult blocks into the assistant bubble", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-streamed-artifact",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-streamed-artifact",
          role: "assistant",
          toolCallId: "call_streamed_artifact",
          timestamp: 999,
          content: [
            {
              type: "toolcall",
              name: "canvas_render",
              arguments: { source: { type: "handle", id: "cv_streamed_artifact" } },
            },
            {
              type: "toolresult",
              name: "canvas_render",
              text: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_streamed_artifact",
                  url: "/__openclaw__/canvas/documents/cv_streamed_artifact/index.html",
                  title: "Streamed demo",
                  preferred_height: 320,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
            },
          ],
        },
      ],
    });

    const assistantGroup = groups.find((group) => group.role === "assistant");
    expect(assistantGroup).toBeDefined();

    const canvasBlocks = canvasBlocksIn(assistantGroup as MessageGroup);
    expect(canvasBlocks).toHaveLength(1);
    const canvasBlock = requireRecord(canvasBlocks[0]);
    const preview = requireRecord(canvasBlock.preview);
    expect(preview.viewId).toBe("cv_streamed_artifact");
    expect(preview.title).toBe("Streamed demo");
  });

  it("explains compaction boundaries and exposes the checkpoint action", () => {
    const items = buildChatItems(
      createProps({
        messages: [
          {
            role: "system",
            timestamp: 2_000,
            __openclaw: {
              kind: "compaction",
              id: "checkpoint-1",
            },
          },
        ],
      }),
    );

    expect(items).toHaveLength(1);
    const divider = requireRecord(items[0]);
    expect(divider.kind).toBe("divider");
    expect(divider.label).toBe("Compacted history");
    expect(divider.description).toBe(
      "The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.",
    );
    const action = requireRecord(divider.action);
    expect(action.kind).toBe("session-checkpoints");
    expect(action.label).toBe("Open checkpoints");
  });
});

describe("tool expansion state", () => {
  it("expands already-visible tool cards when auto-expand turns on", () => {
    resetChatThreadState();
    const group: MessageGroup = {
      kind: "group",
      key: "assistant-1",
      role: "assistant",
      messages: [
        {
          key: "assistant-1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolcall",
                id: "call-1",
                name: "browser.open",
                arguments: { url: "https://example.com" },
              },
            ],
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };

    syncToolCardExpansionState("main", [group], false);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(false);

    syncToolCardExpansionState("main", [group], true);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(true);
  });

  it("auto-expands top-level tool-name result disclosures", () => {
    resetChatThreadState();
    const group: MessageGroup = {
      kind: "group",
      key: "tool-name-result",
      role: "tool",
      messages: [
        {
          key: "tool-name-result",
          message: {
            role: "assistant",
            toolName: "bash",
            content: "Tool output",
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };

    syncToolCardExpansionState("tool-name-session", [group], true);

    expect(getExpandedToolCards("tool-name-session").get("toolmsg:tool-name-result")).toBe(true);
  });
});

describe("thread item cache", () => {
  it("reuses transcript items when thread inputs keep the same references", () => {
    resetChatThreadState();
    const messages = [{ role: "assistant", content: "ready" }];
    const toolMessages: unknown[] = [];
    const streamSegments: BuildChatItemsProps["streamSegments"] = [];
    const queue: NonNullable<BuildChatItemsProps["queue"]> = [];
    const input = createProps({ messages, toolMessages, streamSegments, queue });

    const first = buildCachedChatItems(input);
    expect(buildCachedChatItems({ ...input })).toBe(first);
    expect(buildCachedChatItems({ ...input, messages: [...messages] })).not.toBe(first);
  });
});

function canvasBlocksIn(group: MessageGroup): unknown[] {
  return firstMessageContent(group).filter((block) => isCanvasBlock(block));
}

function isCanvasBlock(block: unknown): boolean {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown; preview?: { kind?: unknown } }).type === "canvas" &&
    (block as { preview?: { kind?: unknown } }).preview?.kind === "canvas"
  );
}

function createAssistantCanvasBlock(params: { suffix: string }) {
  const viewId = `cv_inline_${params.suffix}`;
  return {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId,
      title: "Inline demo",
      url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      preferredHeight: 360,
    },
  };
}

describe("tool turn outcome annotation (#89683)", () => {
  function failedTool(timestamp: number) {
    return {
      role: "toolResult",
      toolName: "shell",
      content: JSON.stringify({ status: "failed", exitCode: 1 }),
      isError: true,
      timestamp,
    };
  }
  function userMsg(text: string, timestamp: number) {
    return { role: "user", content: text, timestamp };
  }
  function assistantReply(text: string, timestamp: number) {
    return { role: "assistant", content: [{ type: "text", text }], timestamp };
  }
  function toolGroups(messages: unknown[]): MessageGroup[] {
    return messageGroups({ messages }).filter((group) => group.role === "tool");
  }

  it("marks a failed tool followed by an assistant reply as turnSucceeded", () => {
    const tools = toolGroups([
      userMsg("search foo", 1),
      failedTool(2),
      assistantReply("No matches found.", 3),
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].turnSucceeded).toBe(true);
  });

  it("leaves a terminal failed tool (no assistant reply) as not-succeeded", () => {
    const tools = toolGroups([userMsg("search foo", 1), failedTool(2)]);
    expect(tools).toHaveLength(1);
    expect(tools[0].turnSucceeded).toBe(false);
  });

  it("does not count an assistant group without reply text as success", () => {
    const tools = toolGroups([
      userMsg("search foo", 1),
      failedTool(2),
      { role: "assistant", content: [], timestamp: 3 },
    ]);
    expect(tools[0].turnSucceeded).toBe(false);
  });

  it("scopes adjacent autonomous turns at an empty forwarded boundary", () => {
    const tools = toolGroups([
      failedTool(1),
      {
        role: "assistant",
        content: [],
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        senderLabel: "Forwarded from main",
        timestamp: 2,
      },
      failedTool(3),
      assistantReply("Recovered on the next autonomous turn.", 4),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([false, true]);
  });

  it("does not treat a forwarded message as the prior turn's reply", () => {
    const tools = toolGroups([
      failedTool(1),
      {
        role: "assistant",
        content: [{ type: "text", text: "Start the next autonomous task." }],
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        senderLabel: "Forwarded from main",
        timestamp: 2,
      },
      failedTool(3),
      assistantReply("Recovered on the next autonomous turn.", 4),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([false, true]);
  });

  it("treats an ordinary labeled assistant message as a reply", () => {
    const tools = toolGroups([
      userMsg("check the service", 1),
      failedTool(2),
      {
        role: "assistant",
        content: [{ type: "text", text: "Parzival recovered the service." }],
        senderLabel: "Parzival",
        timestamp: 3,
      },
    ]);
    expect(tools[0].turnSucceeded).toBe(true);
  });

  it("does not treat non-text assistant content as a turn boundary", () => {
    const tools = toolGroups([
      userMsg("make a preview", 1),
      failedTool(2),
      {
        role: "assistant",
        content: [createAssistantCanvasBlock({ suffix: "tool_turn_outcome" })],
        timestamp: 3,
      },
      failedTool(4),
      assistantReply("Done.", 5),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([true, true]);
  });

  it("scopes the outcome per turn at user boundaries", () => {
    const tools = toolGroups([
      userMsg("first", 1),
      failedTool(2),
      assistantReply("done", 3),
      userMsg("second", 4),
      failedTool(5),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([true, false]);
  });
});

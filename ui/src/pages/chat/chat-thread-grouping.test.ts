// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

function forwardedMessage(sessionKey: string, content = "Forwarded report") {
  return {
    role: "assistant",
    content,
    timestamp: 1,
    senderLabel: "Forwarded from main",
    senderSession: { sessionKey, agentId: "main" },
  };
}

function cachedGroups(messages: unknown[]) {
  return buildCachedChatItems({
    paneId: "forwarded-attribution",
    sessionKey: "agent:target:main",
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  }).filter((item) => item.kind === "group");
}

describe("forwarded source-session grouping", () => {
  beforeEach(() => resetChatThreadState());

  it("carries the first message's source session while grouping messages from that source", () => {
    const messages = [
      forwardedMessage("agent:main:main", "First report"),
      forwardedMessage("agent:main:main", "Second report"),
    ];
    const items: ChatItem[] = messages.map((message, index) => ({
      kind: "message",
      key: `message:${index}`,
      message,
    }));

    expect(groupMessages(items)).toMatchObject([
      {
        senderLabel: "Forwarded from main",
        senderSession: { sessionKey: "agent:main:main", agentId: "main" },
        messages: [{ message: messages[0] }, { message: messages[1] }],
      },
    ]);
  });

  it("splits messages from different source sessions even when the agent labels match", () => {
    const items: ChatItem[] = ["agent:main:main", "agent:main:dashboard:other"].map(
      (sessionKey, index) => ({
        kind: "message",
        key: `message:${index}`,
        message: forwardedMessage(sessionKey, `Report ${index}`),
      }),
    );

    const groups = groupMessages(items);
    expect(groups).toHaveLength(2);
    expect(groups).toMatchObject([
      { senderSession: { sessionKey: "agent:main:main" } },
      { senderSession: { sessionKey: "agent:main:dashboard:other" } },
    ]);
  });

  it("does not collapse identical reports from different source sessions before grouping", () => {
    const groups = cachedGroups([
      forwardedMessage("agent:main:main"),
      forwardedMessage("agent:main:dashboard:other"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.messages.length === 1)).toBe(true);
    expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it.each([
    { senderSession: { sessionKey: "agent:main:main", agentId: "main" } },
    { provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
  ])("clears stale human reply attribution at a forwarded boundary %o", (attribution) => {
    const groups = cachedGroups([
      { role: "user", content: "Alice's question", __openclaw: { senderId: "alice" } },
      { role: "user", content: "Bob's question", __openclaw: { senderId: "bob" } },
      { role: "assistant", content: "Answer for Bob" },
      {
        role: "assistant",
        content: "Forwarded report",
        senderLabel: "Forwarded from main",
        ...attribution,
      },
      { role: "assistant", content: "Response to the forwarded report" },
    ]);

    expect(groups).toHaveLength(5);
    expect(groups[2]?.replyToSender).toEqual({ id: "bob" });
    expect(groups[3]?.replyToSender).toBeUndefined();
    expect(groups[4]?.replyToSender).toBeUndefined();
  });

  it.each([
    { sessionKey: "agent:main:dashboard:other", agentId: "main" },
    { sessionKey: "agent:main:main", agentId: "updated" },
  ])("refreshes cached attribution when the source changes to %o", (senderSession) => {
    const message = forwardedMessage("agent:main:main");
    const initial = cachedGroups([message]);
    message.senderSession = senderSession;

    const refreshed = cachedGroups([message]);

    expect(refreshed[0]?.senderSession).toEqual(senderSession);
    expect(refreshed[0]).not.toBe(initial[0]);
  });
});

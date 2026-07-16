import { describe, expect, it, vi } from "vitest";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";

function createHost() {
  return {
    assistantAgentId: "ops",
    agentsList: { defaultId: "ops", mainKey: "home" },
  };
}

function cacheChatMessages(
  cache: ChatMessageCache,
  host: Parameters<typeof cacheChatSessionSnapshot>[1],
  target: Parameters<typeof cacheChatSessionSnapshot>[2],
  messages: unknown[],
): void {
  cacheChatSessionSnapshot(cache, host, target, {
    messages,
    pagination: { hasMore: false },
    sessionId: null,
  });
}

describe("session message cache", () => {
  it("canonicalizes main aliases without crossing agent scopes", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();

    cacheChatMessages(cache, host, { sessionKey: "home" }, ["ops"]);

    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:home" })).toEqual([
      "ops",
    ]);
    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:main" })).toEqual([
      "ops",
    ]);
    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:main:home" })).toEqual([]);
  });

  it("uses explicit event agent identity for global cache targets", () => {
    const host = {
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main" },
    };
    const cache: ChatMessageCache = new Map();

    cacheChatMessages(cache, host, { sessionKey: "global" }, ["work"]);
    cacheChatMessages(cache, host, { sessionKey: "global", agentId: "main" }, ["main"]);

    expect(readChatMessagesFromCache(cache, host, { sessionKey: "global" })).toEqual(["work"]);
    expect(
      readChatMessagesFromCache(cache, host, { sessionKey: "global", agentId: "main" }),
    ).toEqual(["main"]);
  });

  it("keeps only the 20 most recently used sessions", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    for (let index = 0; index < 20; index += 1) {
      cacheChatMessages(cache, host, { sessionKey: `agent:ops:session-${index}` }, [index]);
    }

    readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:session-0" });
    cacheChatMessages(cache, host, { sessionKey: "agent:ops:session-20" }, [20]);
    cacheChatMessages(cache, host, { sessionKey: "agent:ops:large" }, [21]);

    expect(cache.size).toBe(20);
    expect(cache.has("agent:ops:session-0")).toBe(true);
    expect(cache.has("agent:ops:session-1")).toBe(false);
    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:large" })).toEqual([21]);
  });

  it("restores messages, pagination, and backing session identity together", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: ["oldest", "latest"],
        pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
        sessionId: "session-1",
      },
    );

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })).toEqual({
      messages: ["oldest", "latest"],
      pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
      sessionId: "session-1",
    });
  });

  it("appends an inactive-session message without losing snapshot metadata", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: ["oldest"],
        pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
        sessionId: "session-1",
      },
    );

    appendChatMessageToCache(cache, host, { sessionKey: "home" }, "latest");

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })).toEqual({
      messages: ["oldest", "latest"],
      pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
      sessionId: "session-1",
    });
  });

  it("keeps deeper same-session history when another pane saves only the latest tail", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    const retained = Array.from({ length: 140 }, (_, index) => ({
      content: `retained-${index + 1}`,
      __openclaw: { seq: index + 1 },
    }));
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: retained,
        pagination: { hasMore: false, totalMessages: 140 },
        sessionId: "session-1",
      },
    );
    const refreshedTail = Array.from({ length: 40 }, (_, index) => ({
      content: `fresh-${index + 101}`,
      __openclaw: { seq: index + 101 },
    }));

    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: refreshedTail,
        pagination: { hasMore: true, nextOffset: 40, totalMessages: 140 },
        sessionId: "session-1",
      },
    );

    const snapshot = readChatSessionSnapshot(cache, host, { sessionKey: "home" });
    expect(snapshot?.messages).toHaveLength(140);
    expect(snapshot?.messages[99]).toBe(retained[99]);
    expect(snapshot?.messages[100]).toBe(refreshedTail[0]);
    expect(snapshot?.pagination).toEqual({ hasMore: false, totalMessages: 140 });
  });

  it("keeps the newer same-depth snapshot when a stale pane saves later", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    const current = [1, 2, 3].map((seq) => ({
      content: `current-${seq}`,
      __openclaw: { seq },
    }));
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: current,
        pagination: { hasMore: false, totalMessages: 3 },
        sessionId: "session-1",
      },
    );

    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: current.slice(0, 2),
        pagination: { hasMore: true, nextOffset: 2, totalMessages: 3 },
        sessionId: "session-1",
      },
    );

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })).toEqual({
      messages: current,
      pagination: { hasMore: false, totalMessages: 3 },
      sessionId: "session-1",
    });
  });

  it("does not retain history across backing session changes", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: [{ content: "old", __openclaw: { seq: 1 } }],
        pagination: { hasMore: false, totalMessages: 1 },
        sessionId: "session-1",
      },
    );
    const replacement = [{ content: "new", __openclaw: { seq: 1 } }];

    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: replacement,
        pagination: { hasMore: false, totalMessages: 1 },
        sessionId: "session-2",
      },
    );

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })?.messages).toEqual(
      replacement,
    );
  });

  it("reuses retained message weights when snapshot metadata changes", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    const toJSON = vi.fn(() => ({ role: "assistant", content: "retained" }));
    const message = { toJSON };

    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: [message],
        pagination: { hasMore: true, nextOffset: 1, totalMessages: 2 },
        sessionId: "session-1",
      },
    );
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: [message],
        pagination: { hasMore: false, totalMessages: 1 },
        sessionId: "session-1",
      },
    );

    expect(toJSON).toHaveBeenCalledOnce();
  });

  it("removes an empty identity-free snapshot after a cleared session reload", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    cacheChatMessages(cache, host, { sessionKey: "home" }, ["stale"]);

    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: [],
        pagination: { hasMore: false },
        sessionId: null,
      },
    );

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })).toBeNull();
  });

  it("caps an oversized snapshot at a raw transcript boundary", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    const content = "x".repeat(4 * 1024 * 1024);
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: [
          { content, __openclaw: { seq: 1 } },
          { content, projection: "sibling", __openclaw: { seq: 1 } },
          { content, __openclaw: { seq: 2 } },
        ],
        pagination: { hasMore: false, totalMessages: 2 },
        sessionId: "session-1",
      },
    );

    const snapshot = readChatSessionSnapshot(cache, host, { sessionKey: "home" });
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.pagination).toEqual({
      hasMore: true,
      nextOffset: 1,
      totalMessages: 2,
    });
  });

  it("evicts whole least-recently-used snapshots when the global budget is exceeded", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    const content = "x".repeat(9 * 1024 * 1024);
    for (const sessionKey of ["one", "two", "three"]) {
      cacheChatSessionSnapshot(
        cache,
        host,
        { sessionKey },
        {
          messages: [{ content, __openclaw: { seq: 1 } }],
          pagination: { hasMore: false, totalMessages: 1 },
          sessionId: sessionKey,
        },
      );
    }

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "one" })).toBeNull();
    expect(readChatSessionSnapshot(cache, host, { sessionKey: "two" })).not.toBeNull();
    expect(readChatSessionSnapshot(cache, host, { sessionKey: "three" })).not.toBeNull();
  });
});

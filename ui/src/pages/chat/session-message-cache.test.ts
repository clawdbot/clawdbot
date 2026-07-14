import { describe, expect, it } from "vitest";
import {
  cacheChatMessages,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";

function createHost() {
  return {
    assistantAgentId: "ops",
    agentsList: { defaultId: "ops", mainKey: "home" },
  };
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

  it("keeps only the 20 most recently used sessions and 100 latest messages", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    for (let index = 0; index < 20; index += 1) {
      cacheChatMessages(cache, host, { sessionKey: `agent:ops:session-${index}` }, [index]);
    }

    readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:session-0" });
    cacheChatMessages(cache, host, { sessionKey: "agent:ops:session-20" }, [20]);
    cacheChatMessages(
      cache,
      host,
      { sessionKey: "agent:ops:large" },
      Array.from({ length: 101 }, (_, index) => index),
    );

    expect(cache.size).toBe(20);
    expect(cache.has("agent:ops:session-0")).toBe(true);
    expect(cache.has("agent:ops:session-1")).toBe(false);
    expect(cache.get("agent:ops:large")).toHaveLength(100);
    expect(cache.get("agent:ops:large")?.[0]).toBe(1);
  });
});

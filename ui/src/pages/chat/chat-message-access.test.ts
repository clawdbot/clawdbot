import { describe, expect, it, vi } from "vitest";
import { resolveChatMessageAccess } from "./chat-message-access.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat message access", () => {
  it("loads full messages with the session-scoped agent", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, message: { role: "assistant" } });
    const access = resolveChatMessageAccess({
      assistantAgentId: "alpha",
      agentsList: null,
      client: { request } as unknown as ChatPageHost["client"],
      connected: true,
      hello: null,
      sessionKey: "agent:alpha:main",
    });

    expect(access.catalogKey).toBeNull();
    expect(access.chatProps.fullMessageAgentId).toBe("alpha");
    expect(access.chatProps.loadFullAssistantMessage).toBe(access.fullMessageLoader);
    await access.fullMessageLoader?.({
      sessionKey: "agent:alpha:main",
      agentId: "alpha",
      messageId: "message-1",
      kind: "assistant_message",
    });
    expect(request).toHaveBeenCalledWith("chat.message.get", {
      sessionKey: "agent:alpha:main",
      agentId: "alpha",
      messageId: "message-1",
      maxChars: 500_000,
    });
  });

  it("disables full-message loading for catalog sessions", () => {
    const access = resolveChatMessageAccess({
      assistantAgentId: "alpha",
      agentsList: null,
      client: { request: vi.fn() } as unknown as ChatPageHost["client"],
      connected: true,
      hello: null,
      sessionKey: "catalog:catalog-1:host-1:thread-1",
    });

    expect(access.catalogKey).toEqual({
      catalogId: "catalog-1",
      hostId: "host-1",
      threadId: "thread-1",
    });
    expect(access.fullMessageLoader).toBeNull();
    expect(access.chatProps.loadFullAssistantMessage).toBeNull();
  });
});

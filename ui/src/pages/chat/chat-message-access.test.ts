import { describe, expect, it, vi } from "vitest";
import { resolveChatMessageAccess } from "./chat-message-access.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat message access", () => {
  it.each([
    ["agent:alpha:main", undefined],
    ["global", "alpha"],
  ])(
    "loads full messages for %s with only necessary agent routing",
    async (sessionKey, agentId) => {
      const request = vi.fn().mockResolvedValue({ ok: true, message: { role: "assistant" } });
      const access = resolveChatMessageAccess({
        assistantAgentId: "alpha",
        agentsList: null,
        client: { request } as unknown as ChatPageHost["client"],
        connected: true,
        hello: null,
        sessionKey,
      });

      expect(access.catalogKey).toBeNull();
      expect(access.chatProps.fullMessageAgentId).toBe(agentId);
      await access.chatProps.loadFullAssistantMessage?.({
        sessionKey,
        agentId: access.chatProps.fullMessageAgentId,
        messageId: "message-1",
      });
      expect(request).toHaveBeenCalledWith("chat.message.get", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        messageId: "message-1",
        maxChars: 500_000,
      });
    },
  );

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
    expect(access.chatProps.loadFullAssistantMessage).toBeNull();
  });
});

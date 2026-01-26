import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { sendMessageBlueBubbles, resolveChatGuidForTarget } from "./send.js";
import type { BlueBubblesSendTarget } from "./types.js";

vi.mock("./accounts.js", () => ({
  resolveBlueBubblesAccount: vi.fn(({ cfg, accountId }) => {
    const config = cfg?.channels?.bluebubbles ?? {};
    return {
      accountId: accountId ?? "default",
      enabled: config.enabled !== false,
      configured: Boolean(config.serverUrl && config.password),
      config,
    };
  }),
}));

const mockFetch = vi.fn();

describe("send", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("resolveChatGuidForTarget", () => {
    it("returns chatGuid directly for chat_guid target", async () => {
      const target: BlueBubblesSendTarget = {
        kind: "chat_guid",
        chatGuid: "iMessage;-;+15551234567",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });
      expect(result).toBe("iMessage;-;+15551234567");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("queries chats to resolve chat_id target", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: 123, guid: "iMessage;-;chat123", participants: [] },
              { id: 456, guid: "iMessage;-;chat456", participants: [] },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 456 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;chat456");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/query"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("queries chats to resolve chat_identifier target", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                identifier: "chat123@group.imessage",
                guid: "iMessage;-;chat123",
                participants: [],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "chat_identifier",
        chatIdentifier: "chat123@group.imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;chat123");
    });

    it("matches chat_identifier against the 3rd component of chat GUID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;+;chat660250192681427962",
                participants: [],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "chat_identifier",
        chatIdentifier: "chat660250192681427962",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;+;chat660250192681427962");
    });

    it("resolves handle target by matching participant", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;-;+15559999999",
                participants: [{ address: "+15559999999" }],
              },
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+15551234567",
        service: "imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("prefers direct chat guid when handle also appears in a group chat", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;+;group-123",
                participants: [{ address: "+15551234567" }, { address: "+15550001111" }],
              },
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+15551234567",
        service: "imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("returns null when handle only exists in group chat (not DM)", async () => {
      // This is the critical fix: if a phone number only exists as a participant in a group chat
      // (no direct DM chat), we should NOT send to that group. Return null instead.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;+;group-the-council",
                  participants: [
                    { address: "+12622102921" },
                    { address: "+15550001111" },
                    { address: "+15550002222" },
                  ],
                },
              ],
            }),
        })
        // Empty second page to stop pagination
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
        });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+12622102921",
        service: "imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      // Should return null, NOT the group chat GUID
      expect(result).toBeNull();
    });

    it("returns null when chat not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 999 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBeNull();
    });

    it("handles API error gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 123 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBeNull();
    });

    it("paginates through chats to find match", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: Array(500)
                .fill(null)
                .map((_, i) => ({
                  id: i,
                  guid: `chat-${i}`,
                  participants: [],
                })),
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: 555, guid: "found-chat", participants: [] }],
            }),
        });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 555 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("found-chat");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("normalizes handle addresses for matching", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;-;test@example.com",
                participants: [{ address: "Test@Example.COM" }],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "test@example.com",
        service: "auto",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;test@example.com");
    });

    it("extracts guid from various response formats", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                chatGuid: "format1-guid",
                id: 100,
                participants: [],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 100 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("format1-guid");
    });
  });

  describe("sendMessageBlueBubbles", () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it("throws when text is empty", async () => {
      await expect(
        sendMessageBlueBubbles("+15551234567", "", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("requires text");
    });

    it("throws when text is whitespace only", async () => {
      await expect(
        sendMessageBlueBubbles("+15551234567", "   ", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("requires text");
    });

    it("throws when serverUrl is missing", async () => {
      await expect(sendMessageBlueBubbles("+15551234567", "Hello", {})).rejects.toThrow(
        "serverUrl is required",
      );
    });

    it("throws when password is missing", async () => {
      await expect(
        sendMessageBlueBubbles("+15551234567", "Hello", {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("throws when chatGuid cannot be resolved for non-handle targets", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      await expect(
        sendMessageBlueBubbles("chat_id:999", "Hello", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("chatGuid not found");
    });

    it("sends message successfully", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: { guid: "msg-uuid-123" },
              }),
            ),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello world!", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("msg-uuid-123");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const sendCall = mockFetch.mock.calls[1];
      expect(sendCall[0]).toContain("/api/v1/message/text");
      const body = JSON.parse(sendCall[1].body);
      expect(body.chatGuid).toBe("iMessage;-;+15551234567");
      expect(body.message).toBe("Hello world!");
      expect(body.method).toBeUndefined();
    });

    it("creates a new chat when handle target is missing", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: { guid: "new-msg-guid" },
              }),
            ),
        });

      const result = await sendMessageBlueBubbles("+15550009999", "Hello new chat", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("new-msg-guid");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const createCall = mockFetch.mock.calls[1];
      expect(createCall[0]).toContain("/api/v1/chat/new");
      const body = JSON.parse(createCall[1].body);
      expect(body.addresses).toEqual(["+15550009999"]);
      expect(body.message).toBe("Hello new chat");
    });

    it("throws when creating a new chat requires Private API", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: () => Promise.resolve("Private API not enabled"),
        });

      await expect(
        sendMessageBlueBubbles("+15550008888", "Hello", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("Private API must be enabled");
    });

    it("uses private-api when reply metadata is present", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: { guid: "msg-uuid-124" },
              }),
            ),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Replying", {
        serverUrl: "http://localhost:1234",
        password: "test",
        replyToMessageGuid: "reply-guid-123",
        replyToPartIndex: 1,
      });

      expect(result.messageId).toBe("msg-uuid-124");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const sendCall = mockFetch.mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.method).toBe("private-api");
      expect(body.selectedMessageGuid).toBe("reply-guid-123");
      expect(body.partIndex).toBe(1);
    });

    it("normalizes effect names and uses private-api for effects", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: { guid: "msg-uuid-125" },
              }),
            ),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
        effectId: "invisible ink",
      });

      expect(result.messageId).toBe("msg-uuid-125");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const sendCall = mockFetch.mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.method).toBe("private-api");
      expect(body.effectId).toBe("com.apple.MobileSMS.expressivesend.invisibleink");
    });

    it("sends message with chat_guid target directly", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: { messageId: "direct-msg-123" },
            }),
          ),
      });

      const result = await sendMessageBlueBubbles(
        "chat_guid:iMessage;-;direct-chat",
        "Direct message",
        {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      );

      expect(result.messageId).toBe("direct-msg-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles send failure", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal server error"),
        });

      await expect(
        sendMessageBlueBubbles("+15551234567", "Hello", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("send failed (500)");
    });

    it("handles empty response body", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(""),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("ok");
    });

    it("handles invalid JSON response body", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve("not valid json"),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("ok");
    });

    it("extracts messageId from various response formats", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                id: "numeric-id-456",
              }),
            ),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("numeric-id-456");
    });

    it("extracts messageGuid from response payload", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: { messageGuid: "msg-guid-789" },
              }),
            ),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("msg-guid-789");
    });

    it("resolves credentials from config", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ data: { guid: "msg-123" } })),
        });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        cfg: {
          channels: {
            bluebubbles: {
              serverUrl: "http://config-server:5678",
              password: "config-pass",
            },
          },
        },
      });

      expect(result.messageId).toBe("msg-123");
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("config-server:5678");
    });

    it("includes tempGuid in request payload", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ data: { guid: "msg" } })),
        });

      await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      const sendCall = mockFetch.mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.tempGuid).toBeDefined();
      expect(typeof body.tempGuid).toBe("string");
      expect(body.tempGuid.length).toBeGreaterThan(0);
    });
  });
});

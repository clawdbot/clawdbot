import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import {
  fetchBlueBubblesServerInfo,
  getCachedBlueBubblesPrivateApiStatus,
  isMacOS26OrHigher,
} from "./probe.js";
import type { PluginRuntime } from "./runtime-api.js";
import { clearBlueBubblesRuntime, setBlueBubblesRuntime } from "./runtime.js";
import { sendMessageBlueBubbles, resolveChatGuidForTarget, createChatForHandle } from "./send.js";
import {
  BLUE_BUBBLES_PRIVATE_API_STATUS,
  createBlueBubblesFetchGuardPassthroughInstaller,
  installBlueBubblesFetchTestHooks,
  mockBlueBubblesPrivateApiStatusOnce,
} from "./test-harness.js";
import { _setFetchGuardForTesting, type BlueBubblesSendTarget } from "./types.js";

const mockFetch = vi.fn();
const privateApiStatusMock = vi.mocked(getCachedBlueBubblesPrivateApiStatus);
const fetchServerInfoMock = vi.mocked(fetchBlueBubblesServerInfo);
const isMacOS26OrHigherMock = vi.mocked(isMacOS26OrHigher);
const setFetchGuardPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock,
});

function mockResolvedHandleTarget(
  guid: string = "iMessage;-;+15551234567",
  address: string = "+15551234567",
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({
        data: [
          {
            guid,
            participants: [{ address }],
          },
        ],
      }),
  });
}

function mockSendResponse(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockNewChatSendResponse(guid: string) {
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
            data: { guid },
          }),
        ),
    });
}

function installSsrFPolicyCapture(policies: unknown[]) {
  setFetchGuardPassthrough((policy) => {
    policies.push(policy);
  });
}

describe("send", () => {
  describe("resolveChatGuidForTarget", () => {
    const resolveHandleTargetGuid = async (
      data: Array<Record<string, unknown>>,
      service: "imessage" | "sms" | "auto" = "imessage",
    ) => {
      // First page returns the provided chats; second page is empty so the
      // pagination loop exits cleanly. We can't break early on participant or
      // non-preferred direct matches — a stronger preferred-service direct
      // match could still appear on a later page — so we always need to mock
      // at least one trailing empty page.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
        });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+15551234567",
        service,
      };
      return await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });
    };

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
      const result = await resolveHandleTargetGuid([
        {
          guid: "iMessage;-;+15559999999",
          participants: [{ address: "+15559999999" }],
        },
        {
          guid: "iMessage;-;+15551234567",
          participants: [{ address: "+15551234567" }],
        },
      ]);

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("prefers direct chat guid when handle also appears in a group chat", async () => {
      const result = await resolveHandleTargetGuid([
        {
          guid: "iMessage;+;group-123",
          participants: [{ address: "+15551234567" }, { address: "+15550001111" }],
        },
        {
          guid: "iMessage;-;+15551234567",
          participants: [{ address: "+15551234567" }],
        },
      ]);

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("prefers iMessage over SMS when both chats exist for the same handle", async () => {
      // Both chats exist; we should never silently downgrade to SMS.
      const result = await resolveHandleTargetGuid([
        {
          guid: "SMS;-;+15551234567",
          participants: [{ address: "+15551234567" }],
        },
        {
          guid: "iMessage;-;+15551234567",
          participants: [{ address: "+15551234567" }],
        },
      ]);

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("prefers iMessage over SMS even when SMS appears first", async () => {
      const result = await resolveHandleTargetGuid([
        {
          guid: "SMS;-;+15551234567",
          participants: [{ address: "+15551234567" }],
        },
        {
          guid: "iMessage;-;+15559999999",
          participants: [{ address: "+15559999999" }],
        },
        {
          guid: "iMessage;-;+15551234567",
          participants: [{ address: "+15551234567" }],
        },
      ]);

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("falls back to SMS when no iMessage chat exists for the handle", async () => {
      // First page: SMS-only DM. Second page: empty (stops pagination).
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "SMS;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
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

      expect(result).toBe("SMS;-;+15551234567");
    });

    it("respects explicit service: 'sms' and prefers SMS direct match over iMessage", async () => {
      // Regression: when caller passes `sms:+15551234567` (target.service ===
      // 'sms'), explicit SMS intent must beat the default iMessage preference.
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
                {
                  guid: "SMS;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
        });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+15551234567",
        service: "sms",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("SMS;-;+15551234567");
    });

    it("falls back to iMessage when service: 'sms' is requested but no SMS chat exists", async () => {
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
          json: () => Promise.resolve({ data: [] }),
        });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+15551234567",
        service: "sms",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("prefers a later-page direct iMessage match over an earlier participant iMessage match", async () => {
      // Regression: a participant-based iMessage match must NOT short-circuit
      // pagination and beat a direct `iMessage;-;<handle>` match on a later page.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;alt-handle",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
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
          json: () => Promise.resolve({ data: [] }),
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

    it("prefers a later-page iMessage participant match over an earlier unknown-service direct match", async () => {
      // Regression: an unknown-service direct match on page 1 must NOT short-circuit
      // pagination and beat a real iMessage participant match on page 2.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "WeirdService;-;+15551234567",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;-;alt-handle",
                  participants: [{ address: "+15551234567" }],
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
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

      expect(result).toBe("iMessage;-;alt-handle");
    });

    it("prefers iMessage over SMS via participant match", async () => {
      const result = await resolveHandleTargetGuid([
        {
          guid: "SMS;-;alt-handle",
          participants: [{ address: "+15551234567" }],
        },
        {
          guid: "iMessage;-;alt-handle",
          participants: [{ address: "+15551234567" }],
        },
      ]);

      expect(result).toBe("iMessage;-;alt-handle");
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
      fetchServerInfoMock.mockReset();
      fetchServerInfoMock.mockResolvedValue(null);
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

    it("throws when text becomes empty after markdown stripping", async () => {
      // Edge case: input like "***" or "---" passes initial check but becomes empty after stripMarkdown
      await expect(
        sendMessageBlueBubbles("+15551234567", "***", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("empty after markdown removal");
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
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-uuid-123" } });

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
      expect(body.method).toBe("apple-script");
    });

    it("auto-enables private-network fetches for loopback serverUrl when allowPrivateNetwork is not set", async () => {
      const policies: unknown[] = [];
      installSsrFPolicyCapture(policies);
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-loopback" } });

      try {
        const result = await sendMessageBlueBubbles("+15551234567", "Hello world!", {
          serverUrl: "http://localhost:1234",
          password: "test",
        });

        expect(result.messageId).toBe("msg-loopback");
        expect(policies).toEqual([{ allowPrivateNetwork: true }, { allowPrivateNetwork: true }]);
      } finally {
        _setFetchGuardForTesting(null);
      }
    });

    it("auto-enables private-network fetches for private IP serverUrl when allowPrivateNetwork is not set", async () => {
      const policies: unknown[] = [];
      installSsrFPolicyCapture(policies);
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-private-ip" } });

      try {
        const result = await sendMessageBlueBubbles("+15551234567", "Hello world!", {
          serverUrl: "http://192.168.1.5:1234",
          password: "test",
        });

        expect(result.messageId).toBe("msg-private-ip");
        expect(policies).toEqual([{ allowPrivateNetwork: true }, { allowPrivateNetwork: true }]);
      } finally {
        _setFetchGuardForTesting(null);
      }
    });

    it("strips markdown formatting from outbound messages", async () => {
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-uuid-stripped" } });

      const result = await sendMessageBlueBubbles(
        "+15551234567",
        "**Bold** and *italic* with `code`\n## Header",
        {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      );

      expect(result.messageId).toBe("msg-uuid-stripped");

      const sendCall = mockFetch.mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      // Markdown should be stripped: no asterisks, backticks, or hashes
      expect(body.message).toBe("Bold and italic with code\nHeader");
    });

    it("strips markdown when creating a new chat", async () => {
      mockNewChatSendResponse("new-msg-stripped");

      const result = await sendMessageBlueBubbles("+15550009999", "**Welcome** to the _chat_!", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("new-msg-stripped");

      const createCall = mockFetch.mock.calls[1];
      expect(createCall[0]).toContain("/api/v1/chat/new");
      const body = JSON.parse(createCall[1].body);
      // Markdown should be stripped
      expect(body.message).toBe("Welcome to the chat!");
    });

    it("creates a new chat when handle target is missing", async () => {
      mockNewChatSendResponse("new-msg-guid");

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
      mockBlueBubblesPrivateApiStatusOnce(
        privateApiStatusMock,
        BLUE_BUBBLES_PRIVATE_API_STATUS.enabled,
      );
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-uuid-124" } });

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

    it("downgrades threaded reply to plain send when private API is disabled", async () => {
      mockBlueBubblesPrivateApiStatusOnce(
        privateApiStatusMock,
        BLUE_BUBBLES_PRIVATE_API_STATUS.disabled,
      );
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-uuid-plain" } });

      const result = await sendMessageBlueBubbles("+15551234567", "Reply fallback", {
        serverUrl: "http://localhost:1234",
        password: "test",
        replyToMessageGuid: "reply-guid-123",
        replyToPartIndex: 1,
      });

      expect(result.messageId).toBe("msg-uuid-plain");
      const sendCall = mockFetch.mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.method).toBe("apple-script");
      expect(body.selectedMessageGuid).toBeUndefined();
      expect(body.partIndex).toBeUndefined();
    });

    it("normalizes effect names and uses private-api for effects", async () => {
      mockBlueBubblesPrivateApiStatusOnce(
        privateApiStatusMock,
        BLUE_BUBBLES_PRIVATE_API_STATUS.enabled,
      );
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-uuid-125" } });

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

    // macOS 26 Tahoe broke AppleScript Messages.app automation (-1700). When
    // Private API is available on these hosts, plain text sends should prefer
    // Private API even without reply/effect features. (#53159 Bug B, #64480)
    it("forces Private API for plain text on macOS 26 when available", async () => {
      mockBlueBubblesPrivateApiStatusOnce(
        privateApiStatusMock,
        BLUE_BUBBLES_PRIVATE_API_STATUS.enabled,
      );
      isMacOS26OrHigherMock.mockReturnValue(true);
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-macos26" } });

      try {
        const result = await sendMessageBlueBubbles("+15551234567", "Plain text", {
          serverUrl: "http://localhost:1234",
          password: "test",
        });

        expect(result.messageId).toBe("msg-macos26");
        const sendCall = mockFetch.mock.calls[1];
        const body = JSON.parse(sendCall[1].body);
        expect(body.method).toBe("private-api");
      } finally {
        isMacOS26OrHigherMock.mockReturnValue(false);
      }
    });

    // If macOS 26 host has Private API disabled, there is nothing we can do —
    // the AppleScript path is broken on that OS. We still tag the send
    // explicitly as apple-script rather than omitting `method`; BB Server's
    // behavior on an omitted field is version-dependent and silently drops
    // on some setups, which is the worse failure mode. (#64480)
    it("falls back to apple-script on macOS 26 when Private API is disabled", async () => {
      mockBlueBubblesPrivateApiStatusOnce(
        privateApiStatusMock,
        BLUE_BUBBLES_PRIVATE_API_STATUS.disabled,
      );
      isMacOS26OrHigherMock.mockReturnValue(true);
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-macos26-no-pa" } });

      try {
        const result = await sendMessageBlueBubbles("+15551234567", "Plain text", {
          serverUrl: "http://localhost:1234",
          password: "test",
        });

        expect(result.messageId).toBe("msg-macos26-no-pa");
        const sendCall = mockFetch.mock.calls[1];
        const body = JSON.parse(sendCall[1].body);
        expect(body.method).toBe("apple-script");
      } finally {
        isMacOS26OrHigherMock.mockReturnValue(false);
      }
    });

    it("warns and downgrades private-api features when status is unknown", async () => {
      const runtimeLog = vi.fn();
      setBlueBubblesRuntime({ log: runtimeLog } as unknown as PluginRuntime);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-uuid-unknown" } });

      try {
        const result = await sendMessageBlueBubbles("+15551234567", "Reply fallback", {
          serverUrl: "http://localhost:1234",
          password: "test",
          replyToMessageGuid: "reply-guid-123",
          effectId: "invisible ink",
        });

        expect(result.messageId).toBe("msg-uuid-unknown");
        expect(runtimeLog).toHaveBeenCalledTimes(1);
        expect(runtimeLog.mock.calls[0]?.[0]).toContain("Private API status unknown");
        expect(warnSpy).not.toHaveBeenCalled();

        const sendCall = mockFetch.mock.calls[1];
        const body = JSON.parse(sendCall[1].body);
        expect(body.method).toBe("apple-script");
        expect(body.selectedMessageGuid).toBeUndefined();
        expect(body.partIndex).toBeUndefined();
        expect(body.effectId).toBeUndefined();
      } finally {
        clearBlueBubblesRuntime();
        warnSpy.mockRestore();
      }
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
      mockResolvedHandleTarget();
      mockFetch.mockResolvedValueOnce({
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
      mockResolvedHandleTarget();
      mockFetch.mockResolvedValueOnce({
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
      mockResolvedHandleTarget();
      mockFetch.mockResolvedValueOnce({
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
      mockResolvedHandleTarget();
      mockSendResponse({ id: "numeric-id-456" });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("numeric-id-456");
    });

    it("extracts messageGuid from response payload", async () => {
      mockResolvedHandleTarget();
      mockSendResponse({ data: { messageGuid: "msg-guid-789" } });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("msg-guid-789");
    });

    it("extracts top-level message_id from response payload", async () => {
      mockResolvedHandleTarget();
      mockSendResponse({ message_id: "bb-msg-321" });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("bb-msg-321");
    });

    it("extracts nested result.message_id from response payload", async () => {
      mockResolvedHandleTarget();
      mockSendResponse({ result: { message_id: "bb-msg-654" } });

      const result = await sendMessageBlueBubbles("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(result.messageId).toBe("bb-msg-654");
    });

    it("resolves credentials from config", async () => {
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg-123" } });

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
      mockResolvedHandleTarget();
      mockSendResponse({ data: { guid: "msg" } });

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

    describe("lazy private API refresh (#43764)", () => {
      it("does not refresh when cache is populated (cache hit)", async () => {
        mockBlueBubblesPrivateApiStatusOnce(
          privateApiStatusMock,
          BLUE_BUBBLES_PRIVATE_API_STATUS.enabled,
        );
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-cached" } });

        const result = await sendMessageBlueBubbles("+15551234567", "Replying", {
          serverUrl: "http://localhost:1234",
          password: "test",
          replyToMessageGuid: "reply-guid-123",
        });

        expect(result.messageId).toBe("msg-cached");
        expect(fetchServerInfoMock).not.toHaveBeenCalled();
        const sendCall = mockFetch.mock.calls[1];
        const body = JSON.parse(sendCall[1].body);
        expect(body.method).toBe("private-api");
        expect(body.selectedMessageGuid).toBe("reply-guid-123");
      });

      it("refreshes cache when expired and reply threading is requested", async () => {
        // First call returns null (cache expired), after refresh returns enabled
        privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(true);
        fetchServerInfoMock.mockResolvedValueOnce({ private_api: true });
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-refreshed" } });

        const result = await sendMessageBlueBubbles("+15551234567", "Replying", {
          serverUrl: "http://localhost:1234",
          password: "test",
          replyToMessageGuid: "reply-guid-456",
        });

        expect(result.messageId).toBe("msg-refreshed");
        expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
        expect(fetchServerInfoMock).toHaveBeenCalledWith(
          expect.objectContaining({
            baseUrl: expect.stringContaining("localhost"),
            password: "test",
            accountId: expect.any(String),
            allowPrivateNetwork: expect.any(Boolean),
          }),
        );
        const sendCall = mockFetch.mock.calls[1];
        const body = JSON.parse(sendCall[1].body);
        expect(body.method).toBe("private-api");
        expect(body.selectedMessageGuid).toBe("reply-guid-456");
      });

      it("refreshes cache when expired and effect is requested", async () => {
        privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(true);
        fetchServerInfoMock.mockResolvedValueOnce({ private_api: true });
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-effect-refreshed" } });

        const result = await sendMessageBlueBubbles("+15551234567", "Party!", {
          serverUrl: "http://localhost:1234",
          password: "test",
          effectId: "confetti",
        });

        expect(result.messageId).toBe("msg-effect-refreshed");
        expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
        const sendCall = mockFetch.mock.calls[1];
        const body = JSON.parse(sendCall[1].body);
        expect(body.method).toBe("private-api");
        expect(body.effectId).toBe("com.apple.messages.effect.CKConfettiEffect");
      });

      it("degrades gracefully when refresh fails", async () => {
        // Cache expired, refresh throws — should fall back to existing behavior
        fetchServerInfoMock.mockRejectedValueOnce(new Error("network error"));
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-degraded" } });

        const runtimeLog = vi.fn();
        setBlueBubblesRuntime({ log: runtimeLog } as unknown as PluginRuntime);

        try {
          const result = await sendMessageBlueBubbles("+15551234567", "Reply fallback", {
            serverUrl: "http://localhost:1234",
            password: "test",
            replyToMessageGuid: "reply-guid-789",
          });

          expect(result.messageId).toBe("msg-degraded");
          expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
          // Should warn about unknown status and send without threading
          expect(runtimeLog).toHaveBeenCalledTimes(1);
          expect(runtimeLog.mock.calls[0]?.[0]).toContain("Private API status unknown");
          const sendCall = mockFetch.mock.calls[1];
          const body = JSON.parse(sendCall[1].body);
          expect(body.method).toBe("apple-script");
          expect(body.selectedMessageGuid).toBeUndefined();
        } finally {
          clearBlueBubblesRuntime();
        }
      });

      it("throws for effects when refresh succeeds with private_api: false", async () => {
        // Cache expired, refresh succeeds but Private API is explicitly disabled
        privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(false);
        fetchServerInfoMock.mockResolvedValueOnce({ private_api: false });
        mockResolvedHandleTarget();

        await expect(
          sendMessageBlueBubbles("+15551234567", "Party!", {
            serverUrl: "http://localhost:1234",
            password: "test",
            effectId: "confetti",
          }),
        ).rejects.toThrow("Private API");

        expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
      });

      it("degrades reply threading when refresh succeeds with private_api: false", async () => {
        // Cache expired, refresh succeeds but Private API is explicitly disabled
        // Should degrade without the "unknown" warning (status is known: disabled)
        privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(false);
        fetchServerInfoMock.mockResolvedValueOnce({ private_api: false });
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-disabled-after-refresh" } });

        const runtimeLog = vi.fn();
        setBlueBubblesRuntime({ log: runtimeLog } as unknown as PluginRuntime);

        try {
          const result = await sendMessageBlueBubbles("+15551234567", "Reply fallback", {
            serverUrl: "http://localhost:1234",
            password: "test",
            replyToMessageGuid: "reply-guid-disabled",
          });

          expect(result.messageId).toBe("msg-disabled-after-refresh");
          expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
          // No warning — status is known (disabled), not unknown
          expect(runtimeLog).not.toHaveBeenCalled();
          const sendCall = mockFetch.mock.calls[1];
          const body = JSON.parse(sendCall[1].body);
          expect(body.method).toBe("apple-script");
          expect(body.selectedMessageGuid).toBeUndefined();
        } finally {
          clearBlueBubblesRuntime();
        }
      });

      // Plain-text sends also need the cache populated so `isMacOS26OrHigher`
      // can read `os_version` from the same `serverInfoCache`. Without a
      // refresh on cold/expired cache, macOS 26 detection would silently
      // miss and force-route would fall back to broken AppleScript.
      // (Greptile/Codex PR #69070)
      it("refreshes cache for plain-text sends when status is unknown", async () => {
        // First call returns null (cache cold/expired). The refresh path
        // fetches server info; plain-text send still uses AppleScript when
        // Private API is disabled on the server — but the refresh ran.
        privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(false);
        fetchServerInfoMock.mockResolvedValueOnce({ private_api: false });
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-plain-refreshed" } });

        const result = await sendMessageBlueBubbles("+15551234567", "Plain message", {
          serverUrl: "http://localhost:1234",
          password: "test",
        });

        expect(result.messageId).toBe("msg-plain-refreshed");
        expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
        const sendCall = mockFetch.mock.calls[1];
        const body = JSON.parse(sendCall[1].body);
        expect(body.method).toBe("apple-script");
      });

      // Cold cache + macOS 26 + Private API enabled on refresh — the
      // refresh populates the cache, `isMacOS26OrHigher` returns true, and
      // plain-text routes through Private API instead of broken AppleScript.
      // (Greptile/Codex PR #69070)
      it("force-routes macOS 26 plain-text through Private API after cold-cache refresh", async () => {
        privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(true);
        fetchServerInfoMock.mockResolvedValueOnce({
          private_api: true,
          os_version: "26.0",
        });
        isMacOS26OrHigherMock.mockReturnValue(true);
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-macos26-refreshed" } });

        try {
          const result = await sendMessageBlueBubbles("+15551234567", "Plain message", {
            serverUrl: "http://localhost:1234",
            password: "test",
          });

          expect(result.messageId).toBe("msg-macos26-refreshed");
          expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
          const sendCall = mockFetch.mock.calls[1];
          const body = JSON.parse(sendCall[1].body);
          expect(body.method).toBe("private-api");
        } finally {
          isMacOS26OrHigherMock.mockReturnValue(false);
        }
      });

      it("degrades gracefully when refresh returns null (server unreachable)", async () => {
        // Cache expired, refresh returns null (server info unavailable)
        fetchServerInfoMock.mockResolvedValueOnce(null);
        mockResolvedHandleTarget();
        mockSendResponse({ data: { guid: "msg-null-refresh" } });

        const runtimeLog = vi.fn();
        setBlueBubblesRuntime({ log: runtimeLog } as unknown as PluginRuntime);

        try {
          const result = await sendMessageBlueBubbles("+15551234567", "Reply attempt", {
            serverUrl: "http://localhost:1234",
            password: "test",
            replyToMessageGuid: "reply-guid-000",
          });

          expect(result.messageId).toBe("msg-null-refresh");
          expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
          // privateApiStatus still null after failed refresh → warning + degradation
          expect(runtimeLog).toHaveBeenCalledTimes(1);
          expect(runtimeLog.mock.calls[0]?.[0]).toContain("Private API status unknown");
        } finally {
          clearBlueBubblesRuntime();
        }
      });
    });
  });

  describe("createChatForHandle", () => {
    it("creates a new chat and returns chatGuid from response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: { guid: "iMessage;-;+15559876543", chatGuid: "iMessage;-;+15559876543" },
            }),
          ),
      });

      const result = await createChatForHandle({
        baseUrl: "http://localhost:1234",
        password: "test",
        address: "+15559876543",
        message: "Hello!",
      });

      expect(result.chatGuid).toBe("iMessage;-;+15559876543");
      expect(result.messageId).toBeDefined();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.addresses).toEqual(["+15559876543"]);
      expect(body.message).toBe("Hello!");
    });

    it("creates a new chat without a message when message is omitted", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: { guid: "iMessage;-;+15559876543" },
            }),
          ),
      });

      const result = await createChatForHandle({
        baseUrl: "http://localhost:1234",
        password: "test",
        address: "+15559876543",
      });

      expect(result.chatGuid).toBe("iMessage;-;+15559876543");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toBe("");
    });

    it.each([
      ["data.chatGuid", { data: { chatGuid: "shape-chat-guid" } }, "shape-chat-guid"],
      ["data.guid", { data: { guid: "shape-guid" } }, "shape-guid"],
      [
        "data.chats[0].guid",
        { data: { chats: [{ guid: "shape-array-guid" }] } },
        "shape-array-guid",
      ],
      ["data.chat.guid", { data: { chat: { guid: "shape-object-guid" } } }, "shape-object-guid"],
    ])("extracts chatGuid from %s", async (_label, responseBody, expectedChatGuid) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(responseBody)),
      });

      const result = await createChatForHandle({
        baseUrl: "http://localhost:1234",
        password: "test",
        address: "+15559876543",
      });

      expect(result.chatGuid).toBe(expectedChatGuid);
    });

    it("throws when Private API is not enabled", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Private API not enabled"),
      });

      await expect(
        createChatForHandle({
          baseUrl: "http://localhost:1234",
          password: "test",
          address: "+15559876543",
        }),
      ).rejects.toThrow("Private API must be enabled");
    });

    it("returns null chatGuid when response has no chat data", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: {} })),
      });

      const result = await createChatForHandle({
        baseUrl: "http://localhost:1234",
        password: "test",
        address: "+15559876543",
        message: "Hello",
      });

      expect(result.chatGuid).toBeNull();
    });
  });
});

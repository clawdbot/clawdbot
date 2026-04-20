import { describe, expect, it, vi } from "vitest";
import {
  normalizeBlueBubblesReactionInput,
  normalizeBlueBubblesReactionInputStrict,
  sendBlueBubblesReaction,
} from "./reactions.js";
import { installBlueBubblesFetchTestHooks } from "./test-harness.js";

vi.mock("./accounts.js", async () => {
  const { createBlueBubblesAccountsMockModule } = await import("./test-harness.js");
  return createBlueBubblesAccountsMockModule();
});

const mockFetch = vi.fn();
const noopPrivateApiStatusMock = {
  mockReturnValue: () => {},
};

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock: noopPrivateApiStatusMock,
});

describe("reactions", () => {
  describe("sendBlueBubblesReaction", () => {
    async function expectRemovedReaction(emoji: string, expectedReaction = "-love") {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji,
        remove: true,
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reaction).toBe(expectedReaction);
    }

    it("throws when chatGuid is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "",
          messageGuid: "msg-123",
          emoji: "love",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("chatGuid");
    });

    it("throws when messageGuid is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "",
          emoji: "love",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("messageGuid");
    });

    it("throws when emoji is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("emoji or name");
    });

    it("throws when serverUrl is missing", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "love",
          opts: {},
        }),
      ).rejects.toThrow("serverUrl is required");
    });

    it("throws when password is missing", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "love",
          opts: {
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("password is required");
    });

    it("falls back to love for unsupported reaction type", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "👀",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reaction).toBe("love");
    });

    describe("reaction type normalization", () => {
      const testCases = [
        { input: "love", expected: "love" },
        { input: "like", expected: "like" },
        { input: "dislike", expected: "dislike" },
        { input: "laugh", expected: "laugh" },
        { input: "emphasize", expected: "emphasize" },
        { input: "question", expected: "question" },
        { input: "heart", expected: "love" },
        { input: "thumbs_up", expected: "like" },
        { input: "thumbs-down", expected: "dislike" },
        { input: "thumbs_down", expected: "dislike" },
        { input: "haha", expected: "laugh" },
        { input: "lol", expected: "laugh" },
        { input: "emphasis", expected: "emphasize" },
        { input: "exclaim", expected: "emphasize" },
        { input: "❤️", expected: "love" },
        { input: "❤", expected: "love" },
        { input: "♥️", expected: "love" },
        { input: "😍", expected: "love" },
        { input: "👍", expected: "like" },
        { input: "👎", expected: "dislike" },
        { input: "😂", expected: "laugh" },
        { input: "🤣", expected: "laugh" },
        { input: "😆", expected: "laugh" },
        { input: "‼️", expected: "emphasize" },
        { input: "‼", expected: "emphasize" },
        { input: "❗", expected: "emphasize" },
        { input: "❓", expected: "question" },
        { input: "❔", expected: "question" },
        { input: "LOVE", expected: "love" },
        { input: "Like", expected: "like" },
      ];

      for (const { input, expected } of testCases) {
        it(`normalizes "${input}" to "${expected}"`, async () => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve(""),
          });

          await sendBlueBubblesReaction({
            chatGuid: "chat-123",
            messageGuid: "msg-123",
            emoji: input,
            opts: {
              serverUrl: "http://localhost:1234",
              password: "test",
            },
          });

          const body = JSON.parse(mockFetch.mock.calls[0][1].body);
          expect(body.reaction).toBe(expected);
        });
      }
    });

    it("sends reaction successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "iMessage;-;+15551234567",
        messageGuid: "msg-uuid-123",
        emoji: "love",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/message/react"),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chatGuid).toBe("iMessage;-;+15551234567");
      expect(body.selectedMessageGuid).toBe("msg-uuid-123");
      expect(body.reaction).toBe("love");
      expect(body.partIndex).toBe(0);
    });

    it("includes password in URL query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "like",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "my-react-password",
        },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("password=my-react-password");
    });

    it("sends reaction removal with dash prefix", async () => {
      await expectRemovedReaction("love");
    });

    it("strips leading dash from emoji when remove flag is set", async () => {
      await expectRemovedReaction("-love");
    });

    it("falls back to removing love for unsupported removal reactions", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "👀",
        remove: true,
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reaction).toBe("-love");
    });

    it("uses custom partIndex when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "laugh",
        partIndex: 3,
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.partIndex).toBe(3);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Invalid reaction type"),
      });

      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "like",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("reaction failed (400): Invalid reaction type");
    });

    it("resolves credentials from config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "emphasize",
        opts: {
          cfg: {
            channels: {
              bluebubbles: {
                serverUrl: "http://react-server:7777",
                password: "react-pass",
              },
            },
          },
        },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("react-server:7777");
      expect(calledUrl).toContain("password=react-pass");
    });

    it("trims chatGuid and messageGuid", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesReaction({
        chatGuid: "  chat-with-spaces  ",
        messageGuid: "  msg-with-spaces  ",
        emoji: "question",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chatGuid).toBe("chat-with-spaces");
      expect(body.selectedMessageGuid).toBe("msg-with-spaces");
    });

    describe("reaction removal aliases", () => {
      it("handles emoji-based removal", async () => {
        await expectRemovedReaction("👍", "-like");
      });

      it("handles text alias removal", async () => {
        await expectRemovedReaction("haha", "-laugh");
      });
    });
  });

  describe("normalizeBlueBubblesReactionInputStrict", () => {
    it("maps supported emoji to canonical type", () => {
      expect(normalizeBlueBubblesReactionInputStrict("👍")).toBe("like");
      expect(normalizeBlueBubblesReactionInputStrict("❤️")).toBe("love");
      expect(normalizeBlueBubblesReactionInputStrict("😂")).toBe("laugh");
    });

    it("throws on unsupported input so validators can detect misconfiguration", () => {
      expect(() => normalizeBlueBubblesReactionInputStrict("👀")).toThrow(
        /Unsupported BlueBubbles reaction/,
      );
      expect(() => normalizeBlueBubblesReactionInputStrict("🎉")).toThrow(
        /Unsupported BlueBubbles reaction/,
      );
    });

    it("throws on empty input", () => {
      expect(() => normalizeBlueBubblesReactionInputStrict("")).toThrow(
        /requires an emoji or name/,
      );
      expect(() => normalizeBlueBubblesReactionInputStrict("   ")).toThrow(
        /requires an emoji or name/,
      );
    });
  });

  describe("normalizeBlueBubblesReactionInput (lenient)", () => {
    it("maps supported emoji to canonical type", () => {
      expect(normalizeBlueBubblesReactionInput("👍")).toBe("like");
      expect(normalizeBlueBubblesReactionInput("❤️")).toBe("love");
    });

    it("falls back to love when input is unsupported by iMessage tapback", () => {
      expect(normalizeBlueBubblesReactionInput("👀")).toBe("love");
      expect(normalizeBlueBubblesReactionInput("🎉")).toBe("love");
    });

    it("falls back to -love on unsupported remove", () => {
      expect(normalizeBlueBubblesReactionInput("👀", true)).toBe("-love");
    });

    it("still throws on empty input (strict error bubbles up unchanged)", () => {
      // Empty input is a contract error from the caller, not a decorative
      // emoji the model picked; we intentionally do not mask it.
      expect(() => normalizeBlueBubblesReactionInput("")).toThrow(/requires an emoji or name/);
    });
  });
});

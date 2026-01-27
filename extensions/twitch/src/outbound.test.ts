/**
 * Tests for outbound.ts module
 *
 * Tests cover:
 * - resolveTarget with various modes (explicit, implicit, heartbeat)
 * - sendText with markdown stripping
 * - sendMedia delegation to sendText
 * - Error handling for missing accounts/channels
 * - Abort signal handling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twitchOutbound } from "./outbound.js";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";

// Mock dependencies
vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  getAccountConfig: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageTwitchInternal: vi.fn(),
}));

vi.mock("./utils/markdown.js", () => ({
  chunkTextForTwitch: vi.fn((text) => text.split(/(.{500})/).filter(Boolean)),
}));

vi.mock("./utils/twitch.js", () => ({
  normalizeTwitchChannel: (channel: string) => channel.toLowerCase().replace(/^#/, ""),
  missingTargetError: (channel: string, hint: string) =>
    `Missing target for ${channel}. Provide ${hint}`,
}));

describe("outbound", () => {
  const mockAccount = {
    username: "testbot",
    token: "oauth:test123",
    clientId: "test-client-id",
    channel: "#testchannel",
  };

  const mockConfig = {
    channels: {
      twitch: {
        accounts: {
          default: mockAccount,
        },
      },
    },
  } as unknown as MoltbotConfig;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("metadata", () => {
    it("should have direct delivery mode", () => {
      expect(twitchOutbound.deliveryMode).toBe("direct");
    });

    it("should have 500 character text chunk limit", () => {
      expect(twitchOutbound.textChunkLimit).toBe(500);
    });

    it("should have chunker function", () => {
      expect(twitchOutbound.chunker).toBeDefined();
      expect(typeof twitchOutbound.chunker).toBe("function");
    });
  });

  describe("resolveTarget", () => {
    it("should normalize and return target in explicit mode", () => {
      const result = twitchOutbound.resolveTarget({
        to: "#MyChannel",
        mode: "explicit",
        allowFrom: [],
      });

      expect(result.ok).toBe(true);
      expect(result.to).toBe("mychannel");
    });

    it("should return target in implicit mode with wildcard allowlist", () => {
      const result = twitchOutbound.resolveTarget({
        to: "#AnyChannel",
        mode: "implicit",
        allowFrom: ["*"],
      });

      expect(result.ok).toBe(true);
      expect(result.to).toBe("anychannel");
    });

    it("should return target in implicit mode when in allowlist", () => {
      const result = twitchOutbound.resolveTarget({
        to: "#allowed",
        mode: "implicit",
        allowFrom: ["#allowed", "#other"],
      });

      expect(result.ok).toBe(true);
      expect(result.to).toBe("allowed");
    });

    it("should fallback to first allowlist entry when target not in list", () => {
      const result = twitchOutbound.resolveTarget({
        to: "#notallowed",
        mode: "implicit",
        allowFrom: ["#primary", "#secondary"],
      });

      expect(result.ok).toBe(true);
      expect(result.to).toBe("primary");
    });

    it("should accept any target when allowlist is empty", () => {
      const result = twitchOutbound.resolveTarget({
        to: "#anychannel",
        mode: "heartbeat",
        allowFrom: [],
      });

      expect(result.ok).toBe(true);
      expect(result.to).toBe("anychannel");
    });

    it("should use first allowlist entry when no target provided", () => {
      const result = twitchOutbound.resolveTarget({
        to: undefined,
        mode: "implicit",
        allowFrom: ["#fallback", "#other"],
      });

      expect(result.ok).toBe(true);
      expect(result.to).toBe("fallback");
    });

    it("should return error when no target and no allowlist", () => {
      const result = twitchOutbound.resolveTarget({
        to: undefined,
        mode: "explicit",
        allowFrom: [],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Missing target");
    });

    it("should handle whitespace-only target", () => {
      const result = twitchOutbound.resolveTarget({
        to: "   ",
        mode: "explicit",
        allowFrom: [],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Missing target");
    });

    it("should filter wildcard from allowlist when checking membership", () => {
      const result = twitchOutbound.resolveTarget({
        to: "#mychannel",
        mode: "implicit",
        allowFrom: ["*", "#specific"],
      });

      // With wildcard, any target is accepted
      expect(result.ok).toBe(true);
      expect(result.to).toBe("mychannel");
    });
  });

  describe("sendText", () => {
    it("should send message successfully", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { sendMessageTwitchInternal } = await import("./send.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        ok: true,
        messageId: "twitch-msg-123",
      });

      const result = await twitchOutbound.sendText({
        cfg: mockConfig,
        to: "#testchannel",
        text: "Hello Twitch!",
        accountId: "default",
      });

      expect(result.channel).toBe("twitch");
      expect(result.messageId).toBe("twitch-msg-123");
      expect(result.to).toBe("testchannel");
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("should throw when account not found", async () => {
      const { getAccountConfig } = await import("./config.js");

      vi.mocked(getAccountConfig).mockReturnValue(null);

      await expect(
        twitchOutbound.sendText({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Hello!",
          accountId: "nonexistent",
        }),
      ).rejects.toThrow("Twitch account not found: nonexistent");
    });

    it("should throw when no channel specified", async () => {
      const { getAccountConfig } = await import("./config.js");

      const accountWithoutChannel = { ...mockAccount, channel: undefined as unknown as string };
      vi.mocked(getAccountConfig).mockReturnValue(accountWithoutChannel);

      await expect(
        twitchOutbound.sendText({
          cfg: mockConfig,
          to: undefined,
          text: "Hello!",
          accountId: "default",
        }),
      ).rejects.toThrow("No channel specified");
    });

    it("should use account channel when target not provided", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { sendMessageTwitchInternal } = await import("./send.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        ok: true,
        messageId: "msg-456",
      });

      await twitchOutbound.sendText({
        cfg: mockConfig,
        to: undefined,
        text: "Hello!",
        accountId: "default",
      });

      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        "testchannel",
        "Hello!",
        mockConfig,
        "default",
        true,
        console,
      );
    });

    it("should handle abort signal", async () => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        twitchOutbound.sendText({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Hello!",
          accountId: "default",
          signal: abortController.signal,
        }),
      ).rejects.toThrow("Outbound delivery aborted");
    });

    it("should throw on send failure", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { sendMessageTwitchInternal } = await import("./send.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        ok: false,
        messageId: "failed-msg",
        error: "Connection lost",
      });

      await expect(
        twitchOutbound.sendText({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Hello!",
          accountId: "default",
        }),
      ).rejects.toThrow("Connection lost");
    });
  });

  describe("sendMedia", () => {
    it("should combine text and media URL", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");
      const { getAccountConfig } = await import("./config.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        ok: true,
        messageId: "media-msg-123",
      });

      const result = await twitchOutbound.sendMedia({
        cfg: mockConfig,
        to: "#testchannel",
        text: "Check this:",
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
      });

      expect(result.channel).toBe("twitch");
      expect(result.messageId).toBe("media-msg-123");
      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        expect.anything(),
        "Check this: https://example.com/image.png",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should send media URL only when no text", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");
      const { getAccountConfig } = await import("./config.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        ok: true,
        messageId: "media-only-msg",
      });

      await twitchOutbound.sendMedia({
        cfg: mockConfig,
        to: "#testchannel",
        text: undefined,
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
      });

      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        expect.anything(),
        "https://example.com/image.png",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should handle abort signal", async () => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        twitchOutbound.sendMedia({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Check this:",
          mediaUrl: "https://example.com/image.png",
          accountId: "default",
          signal: abortController.signal,
        }),
      ).rejects.toThrow("Outbound delivery aborted");
    });
  });
});

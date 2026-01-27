/**
 * Tests for send.ts module
 *
 * Tests cover:
 * - Message sending with valid configuration
 * - Account resolution and validation
 * - Channel normalization
 * - Markdown stripping
 * - Error handling for missing/invalid accounts
 * - Registry integration
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageTwitchInternal } from "./send.js";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";

// Mock dependencies
vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  getAccountConfig: vi.fn(),
}));

vi.mock("./utils/twitch.js", () => ({
  generateMessageId: vi.fn(() => "test-msg-id"),
  isAccountConfigured: vi.fn(() => true),
  normalizeTwitchChannel: (channel: string) => channel.toLowerCase().replace(/^#/, ""),
}));

vi.mock("./utils/markdown.js", () => ({
  stripMarkdownForTwitch: vi.fn((text: string) => text.replace(/\*\*/g, "")),
}));

vi.mock("./client-manager-registry.js", () => ({
  getClientManager: vi.fn(),
}));

describe("send", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

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

  describe("sendMessageTwitchInternal", () => {
    it("should send a message successfully", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { getClientManager } = await import("./client-manager-registry.js");
      const { stripMarkdownForTwitch } = await import("./utils/markdown.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          messageId: "twitch-msg-123",
        }),
      } as ReturnType<typeof getClientManager>);
      vi.mocked(stripMarkdownForTwitch).mockImplementation((text) => text);

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello Twitch!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("twitch-msg-123");
    });

    it("should strip markdown when enabled", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { getClientManager } = await import("./client-manager-registry.js");
      const { stripMarkdownForTwitch } = await import("./utils/markdown.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          messageId: "twitch-msg-456",
        }),
      } as ReturnType<typeof getClientManager>);
      vi.mocked(stripMarkdownForTwitch).mockImplementation((text) => text.replace(/\*\*/g, ""));

      await sendMessageTwitchInternal(
        "#testchannel",
        "**Bold** text",
        mockConfig,
        "default",
        true,
        mockLogger as unknown as Console,
      );

      expect(stripMarkdownForTwitch).toHaveBeenCalledWith("**Bold** text");
    });

    it("should return error when account not found", async () => {
      const { getAccountConfig } = await import("./config.js");

      vi.mocked(getAccountConfig).mockReturnValue(null);

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "nonexistent",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Account not found: nonexistent");
    });

    it("should return error when account not configured", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(false);

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not properly configured");
    });

    it("should return error when no channel specified", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");

      // Set channel to undefined to trigger the error (bypassing type check)
      const accountWithoutChannel = {
        ...mockAccount,
        channel: undefined as unknown as string,
      };
      vi.mocked(getAccountConfig).mockReturnValue(accountWithoutChannel);
      vi.mocked(isAccountConfigured).mockReturnValue(true);

      const result = await sendMessageTwitchInternal(
        "",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("No channel specified");
    });

    it("should skip sending empty message after markdown stripping", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { stripMarkdownForTwitch } = await import("./utils/markdown.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      vi.mocked(stripMarkdownForTwitch).mockReturnValue("");

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "**Only markdown**",
        mockConfig,
        "default",
        true,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("skipped");
    });

    it("should return error when client manager not found", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { getClientManager } = await import("./client-manager-registry.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      vi.mocked(getClientManager).mockReturnValue(undefined);

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Client manager not found");
    });

    it("should handle send errors gracefully", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { getClientManager } = await import("./client-manager-registry.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: vi.fn().mockRejectedValue(new Error("Connection lost")),
      } as ReturnType<typeof getClientManager>);

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Connection lost");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should use account channel when channel parameter is empty", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { getClientManager } = await import("./client-manager-registry.js");

      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        ok: true,
        messageId: "twitch-msg-789",
      });
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: mockSend,
      } as ReturnType<typeof getClientManager>);

      await sendMessageTwitchInternal(
        "",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(mockSend).toHaveBeenCalledWith(
        mockAccount,
        "testchannel", // normalized account channel
        "Hello!",
        mockConfig,
        "default",
      );
    });
  });
});

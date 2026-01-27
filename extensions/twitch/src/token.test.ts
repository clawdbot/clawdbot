/**
 * Tests for token.ts module
 *
 * Tests cover:
 * - Token resolution from config
 * - Token resolution from environment variable
 * - Fallback behavior when token not found
 * - Account ID normalization
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitchToken, type TwitchTokenSource } from "./token.js";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

describe("token", () => {
  // Multi-account config for testing non-default accounts
  const mockMultiAccountConfig = {
    channels: {
      twitch: {
        accounts: {
          default: {
            username: "testbot",
            accessToken: "oauth:config-token",
          },
          other: {
            username: "otherbot",
            accessToken: "oauth:other-token",
          },
        },
      },
    },
  } as unknown as ClawdbotConfig;

  // Simplified single-account config
  const mockSimplifiedConfig = {
    channels: {
      twitch: {
        username: "testbot",
        accessToken: "oauth:config-token",
      },
    },
  } as unknown as ClawdbotConfig;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLAWDBOT_TWITCH_ACCESS_TOKEN;
  });

  describe("resolveTwitchToken", () => {
    it("should resolve token from simplified config for default account", () => {
      const result = resolveTwitchToken(mockSimplifiedConfig, { accountId: "default" });

      expect(result.token).toBe("oauth:config-token");
      expect(result.source).toBe("config");
    });

    it("should resolve token from config for non-default account (multi-account)", () => {
      const result = resolveTwitchToken(mockMultiAccountConfig, { accountId: "other" });

      expect(result.token).toBe("oauth:other-token");
      expect(result.source).toBe("config");
    });

    it("should prioritize config token over env var (simplified config)", () => {
      process.env.CLAWDBOT_TWITCH_ACCESS_TOKEN = "oauth:env-token";

      const result = resolveTwitchToken(mockSimplifiedConfig, { accountId: "default" });

      // Config token should be used even if env var exists
      expect(result.token).toBe("oauth:config-token");
      expect(result.source).toBe("config");
    });

    it("should use env var when config token is empty (simplified config)", () => {
      process.env.CLAWDBOT_TWITCH_ACCESS_TOKEN = "oauth:env-token";

      const configWithEmptyToken = {
        channels: {
          twitch: {
            username: "testbot",
            accessToken: "",
          },
        },
      } as unknown as ClawdbotConfig;

      const result = resolveTwitchToken(configWithEmptyToken, { accountId: "default" });

      expect(result.token).toBe("oauth:env-token");
      expect(result.source).toBe("env");
    });

    it("should return empty token when neither config nor env has token (simplified config)", () => {
      const configWithoutToken = {
        channels: {
          twitch: {
            username: "testbot",
            accessToken: "",
          },
        },
      } as unknown as ClawdbotConfig;

      const result = resolveTwitchToken(configWithoutToken, { accountId: "default" });

      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });

    it("should not use env var for non-default accounts (multi-account)", () => {
      process.env.CLAWDBOT_TWITCH_ACCESS_TOKEN = "oauth:env-token";

      const configWithoutToken = {
        channels: {
          twitch: {
            accounts: {
              secondary: {
                username: "secondary",
                accessToken: "",
              },
            },
          },
        },
      } as unknown as ClawdbotConfig;

      const result = resolveTwitchToken(configWithoutToken, { accountId: "secondary" });

      // Non-default accounts shouldn't use env var
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });

    it("should handle missing account gracefully", () => {
      const configWithoutAccount = {
        channels: {
          twitch: {
            accounts: {},
          },
        },
      } as unknown as ClawdbotConfig;

      const result = resolveTwitchToken(configWithoutAccount, { accountId: "nonexistent" });

      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });

    it("should handle missing Twitch config section", () => {
      const configWithoutSection = {
        channels: {},
      } as unknown as ClawdbotConfig;

      const result = resolveTwitchToken(configWithoutSection, { accountId: "default" });

      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });
  });

  describe("TwitchTokenSource type", () => {
    it("should have correct values", () => {
      const sources: TwitchTokenSource[] = ["env", "config", "none"];

      expect(sources).toContain("env");
      expect(sources).toContain("config");
      expect(sources).toContain("none");
    });
  });
});

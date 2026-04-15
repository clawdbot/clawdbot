/**
 * Tests for setup-surface.ts helpers.
 *
 * Tests cover:
 * - promptToken helper
 * - promptUsername helper
 * - promptClientId helper
 * - promptChannelName helper
 * - promptRefreshTokenSetup helper
 * - configureWithEnvToken helper
 * - setTwitchAccount config updates
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../api.js";
import {
  configureWithEnvToken,
  promptChannelName,
  promptClientId,
  promptRefreshTokenSetup,
  promptToken,
  promptUsername,
  twitchSetupWizard,
} from "./setup-surface.js";
import type { TwitchAccountConfig } from "./types.js";

// Mock the helpers we're testing
const mockPromptText = vi.fn();
const mockPromptConfirm = vi.fn();
const mockPrompter: WizardPrompter = {
  text: mockPromptText,
  confirm: mockPromptConfirm,
} as unknown as WizardPrompter;

const mockAccount: TwitchAccountConfig = {
  username: "testbot",
  accessToken: "oauth:test123",
  clientId: "test-client-id",
  channel: "#testchannel",
};

describe("setup surface helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Don't restoreAllMocks as it breaks module-level mocks
  });

  describe("promptToken", () => {
    it("should return existing token when user confirms to keep it", async () => {
      mockPromptConfirm.mockResolvedValue(true);

      const result = await promptToken(mockPrompter, mockAccount, undefined);

      expect(result).toBe("oauth:test123");
      expect(mockPromptConfirm).toHaveBeenCalledWith({
        message: "Access token already configured. Keep it?",
        initialValue: true,
      });
      expect(mockPromptText).not.toHaveBeenCalled();
    });

    it("should validate token format", async () => {
      // Set up mocks - user doesn't want to keep existing token
      mockPromptConfirm.mockResolvedValueOnce(false);

      // Track how many times promptText is called
      let promptTextCallCount = 0;
      let capturedValidate: ((value: string) => string | undefined) | undefined;

      mockPromptText.mockImplementationOnce((_args) => {
        promptTextCallCount++;
        // Capture the validate function from the first argument
        if (_args?.validate) {
          capturedValidate = _args.validate;
        }
        return Promise.resolve("oauth:test123");
      });

      // Call promptToken
      const result = await promptToken(mockPrompter, mockAccount, undefined);

      // Verify promptText was called
      expect(promptTextCallCount).toBe(1);
      expect(result).toBe("oauth:test123");

      // Test the validate function
      if (!capturedValidate) {
        throw new Error("promptToken validate callback was not captured");
      }
      expect(capturedValidate("")).toBe("Required");
      expect(capturedValidate("notoauth")).toBe("Token should start with 'oauth:'");
      expect(capturedValidate("oauth:goodtoken")).toBeUndefined();
    });
  });

  describe("promptUsername", () => {
    it("should prompt for username with validation", async () => {
      mockPromptText.mockResolvedValue("mybot");

      const result = await promptUsername(mockPrompter, null);

      expect(result).toBe("mybot");
      expect(mockPromptText).toHaveBeenCalledWith({
        message: "Twitch bot username",
        initialValue: "",
        validate: expect.any(Function),
      });
    });
  });

  describe("promptClientId", () => {
    it("should prompt for client ID with validation", async () => {
      mockPromptText.mockResolvedValue("abc123xyz");

      const result = await promptClientId(mockPrompter, null);

      expect(result).toBe("abc123xyz");
      expect(mockPromptText).toHaveBeenCalledWith({
        message: "Twitch Client ID",
        initialValue: "",
        validate: expect.any(Function),
      });
    });
  });

  describe("promptChannelName", () => {
    it("should require a non-empty channel name", async () => {
      mockPromptText.mockResolvedValue("");

      await promptChannelName(mockPrompter, null);

      const { validate } = mockPromptText.mock.calls[0]?.[0] ?? {};
      expect(validate?.("")).toBe("Required");
      expect(validate?.("   ")).toBe("Required");
      expect(validate?.("#chan")).toBeUndefined();
    });
  });

  describe("promptRefreshTokenSetup", () => {
    it("should return empty object when user declines", async () => {
      mockPromptConfirm.mockResolvedValue(false);

      const result = await promptRefreshTokenSetup(mockPrompter, mockAccount);

      expect(result).toEqual({});
      expect(mockPromptConfirm).toHaveBeenCalledWith({
        message: "Enable automatic token refresh (requires client secret and refresh token)?",
        initialValue: false,
      });
    });

    it("should prompt for credentials when user accepts", async () => {
      mockPromptConfirm
        .mockResolvedValueOnce(true) // First call: useRefresh
        .mockResolvedValueOnce("secret123") // clientSecret
        .mockResolvedValueOnce("refresh123"); // refreshToken

      mockPromptText.mockResolvedValueOnce("secret123").mockResolvedValueOnce("refresh123");

      const result = await promptRefreshTokenSetup(mockPrompter, null);

      expect(result).toEqual({
        clientSecret: "secret123",
        refreshToken: "refresh123",
      });
    });
  });

  describe("configureWithEnvToken", () => {
    it("should prompt for username and clientId when using env token", async () => {
      // Reset and set up mocks - user accepts env token
      mockPromptConfirm.mockReset().mockResolvedValue(true as never);

      // Set up mocks for username and clientId prompts
      mockPromptText
        .mockReset()
        .mockResolvedValueOnce("testbot" as never)
        .mockResolvedValueOnce("test-client-id" as never);

      const result = await configureWithEnvToken(
        {} as Parameters<typeof configureWithEnvToken>[0],
        mockPrompter,
        null,
        "oauth:fromenv",
        false,
        {} as Parameters<typeof configureWithEnvToken>[5],
      );

      // Should return config with username and clientId
      expect(result).not.toBeNull();
      const defaultAccount = result?.cfg.channels?.twitch?.accounts?.default as
        | { username?: string; clientId?: string }
        | undefined;
      expect(defaultAccount?.username).toBe("testbot");
      expect(defaultAccount?.clientId).toBe("test-client-id");
    });

    it("writes env-token setup to the configured default account", async () => {
      mockPromptConfirm.mockReset().mockResolvedValue(true as never);
      mockPromptText
        .mockReset()
        .mockResolvedValueOnce("secondary-bot" as never)
        .mockResolvedValueOnce("secondary-client" as never);

      const result = await configureWithEnvToken(
        {
          channels: {
            twitch: {
              defaultAccount: "secondary",
            },
          },
        } as Parameters<typeof configureWithEnvToken>[0],
        mockPrompter,
        null,
        "oauth:fromenv",
        false,
        {} as Parameters<typeof configureWithEnvToken>[5],
      );

      const secondaryAccount = result?.cfg.channels?.twitch?.accounts?.secondary as
        | { username?: string; clientId?: string }
        | undefined;
      expect(secondaryAccount?.username).toBe("secondary-bot");
      expect(secondaryAccount?.clientId).toBe("secondary-client");
      expect(result?.cfg.channels?.twitch?.accounts?.default).toBeUndefined();
    });
  });

  describe("defaultAccount setup resolution", () => {
    it("reports status for the configured default account", async () => {
      const lines = twitchSetupWizard.status?.resolveStatusLines?.({
        cfg: {
          channels: {
            twitch: {
              defaultAccount: "secondary",
              accounts: {
                secondary: {
                  username: "secondary-bot",
                  accessToken: "oauth:secondary",
                  clientId: "secondary-client",
                  channel: "#secondary",
                },
              },
            },
          },
        },
      } as never);

      expect(lines).toEqual(["Twitch (secondary): configured"]);
    });
  });
});

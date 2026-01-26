/**
 * Tests for onboarding.ts helpers
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
import type { WizardPrompter } from "clawdbot/plugin-sdk";
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

describe("onboarding helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Don't restoreAllMocks as it breaks module-level mocks
  });

  describe("promptToken", () => {
    it("should return existing token when user confirms to keep it", async () => {
      const { promptToken } = await import("./onboarding.js");

      mockPromptConfirm.mockResolvedValue(true);

      const result = await promptToken(mockPrompter, mockAccount, undefined);

      expect(result).toBe("oauth:test123");
      expect(mockPromptConfirm).toHaveBeenCalledWith({
        message: "Access token already configured. Keep it?",
        initialValue: true,
      });
      expect(mockPromptText).not.toHaveBeenCalled();
    });

    it("should prompt for new token when user doesn't keep existing", async () => {
      const { promptToken } = await import("./onboarding.js");

      mockPromptConfirm.mockResolvedValue(false);
      mockPromptText.mockResolvedValue("oauth:newtoken123");

      const result = await promptToken(mockPrompter, mockAccount, undefined);

      expect(result).toBe("oauth:newtoken123");
      expect(mockPromptText).toHaveBeenCalledWith({
        message: "Twitch OAuth token (oauth:...)",
        initialValue: "",
        validate: expect.any(Function),
      });
    });

    it("should use env token as initial value when provided", async () => {
      const { promptToken } = await import("./onboarding.js");

      mockPromptConfirm.mockResolvedValue(false);
      mockPromptText.mockResolvedValue("oauth:fromenv");

      await promptToken(mockPrompter, null, "oauth:fromenv");

      expect(mockPromptText).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: "oauth:fromenv",
        }),
      );
    });

    it("should validate token format", async () => {
      const { promptToken } = await import("./onboarding.js");

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
      expect(capturedValidate).toBeDefined();
      expect(capturedValidate!("")).toBe("Required");
      expect(capturedValidate!("notoauth")).toBe("Token should start with 'oauth:'");
    });

    it("should return early when no existing token and no env token", async () => {
      const { promptToken } = await import("./onboarding.js");

      mockPromptText.mockResolvedValue("oauth:newtoken");

      const result = await promptToken(mockPrompter, null, undefined);

      expect(result).toBe("oauth:newtoken");
      expect(mockPromptConfirm).not.toHaveBeenCalled();
    });
  });

  describe("promptUsername", () => {
    it("should prompt for username with validation", async () => {
      const { promptUsername } = await import("./onboarding.js");

      mockPromptText.mockResolvedValue("mybot");

      const result = await promptUsername(mockPrompter, null);

      expect(result).toBe("mybot");
      expect(mockPromptText).toHaveBeenCalledWith({
        message: "Twitch bot username",
        initialValue: "",
        validate: expect.any(Function),
      });
    });

    it("should use existing username as initial value", async () => {
      const { promptUsername } = await import("./onboarding.js");

      mockPromptText.mockResolvedValue("testbot");

      await promptUsername(mockPrompter, mockAccount);

      expect(mockPromptText).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: "testbot",
        }),
      );
    });
  });

  describe("promptClientId", () => {
    it("should prompt for client ID with validation", async () => {
      const { promptClientId } = await import("./onboarding.js");

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
    it("should return channel name when provided", async () => {
      const { promptChannelName } = await import("./onboarding.js");

      mockPromptText.mockResolvedValue("#mychannel");

      const result = await promptChannelName(mockPrompter, null);

      expect(result).toBe("#mychannel");
    });

    it("should require a non-empty channel name", async () => {
      const { promptChannelName } = await import("./onboarding.js");

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
      const { promptRefreshTokenSetup } = await import("./onboarding.js");

      mockPromptConfirm.mockResolvedValue(false);

      const result = await promptRefreshTokenSetup(mockPrompter, mockAccount);

      expect(result).toEqual({});
      expect(mockPromptConfirm).toHaveBeenCalledWith({
        message: "Enable automatic token refresh (requires client secret and refresh token)?",
        initialValue: false,
      });
    });

    it("should prompt for credentials when user accepts", async () => {
      const { promptRefreshTokenSetup } = await import("./onboarding.js");

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

    it("should use existing values as initial prompts", async () => {
      const { promptRefreshTokenSetup } = await import("./onboarding.js");

      const accountWithRefresh = {
        ...mockAccount,
        clientSecret: "existing-secret",
        refreshToken: "existing-refresh",
      };

      mockPromptConfirm.mockResolvedValue(true);
      mockPromptText
        .mockResolvedValueOnce("existing-secret")
        .mockResolvedValueOnce("existing-refresh");

      await promptRefreshTokenSetup(mockPrompter, accountWithRefresh);

      expect(mockPromptConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: true, // Both clientSecret and refreshToken exist
        }),
      );
    });
  });

  describe("configureWithEnvToken", () => {
    it("should return null when user declines env token", async () => {
      const { configureWithEnvToken } = await import("./onboarding.js");

      // Reset and set up mock - user declines env token
      mockPromptConfirm.mockReset().mockResolvedValue(false as never);

      const result = await configureWithEnvToken(
        {} as Parameters<typeof configureWithEnvToken>[0],
        mockPrompter,
        null,
        "oauth:fromenv",
        false,
        {} as Parameters<typeof configureWithEnvToken>[5],
      );

      // Since user declined, should return null without prompting for username/clientId
      expect(result).toBeNull();
      expect(mockPromptText).not.toHaveBeenCalled();
    });

    it("should prompt for username and clientId when using env token", async () => {
      const { configureWithEnvToken } = await import("./onboarding.js");

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
      expect(result?.cfg.channels?.twitch?.accounts?.default?.username).toBe("testbot");
      expect(result?.cfg.channels?.twitch?.accounts?.default?.clientId).toBe("test-client-id");
    });
  });
});

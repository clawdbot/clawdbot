import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  sendReactionNextcloudTalk: vi.fn(),
  sendMessageNextcloudTalk: vi.fn(),
  listNextcloudTalkAccountIds: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendReactionNextcloudTalk: hoisted.sendReactionNextcloudTalk,
  sendMessageNextcloudTalk: hoisted.sendMessageNextcloudTalk,
}));

vi.mock("./accounts.js", () => ({
  listNextcloudTalkAccountIds: hoisted.listNextcloudTalkAccountIds,
  resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
}));

const { nextcloudTalkMessageActions } = await import("./message-actions.js");

const configuredAccount = {
  accountId: "default",
  enabled: true,
  baseUrl: "https://nc.example.com",
  secret: "bot-secret",
} as const;

const unconfiguredAccount = {
  accountId: "default",
  enabled: true,
  baseUrl: "",
  secret: null,
} as const;

const disabledAccount = {
  accountId: "default",
  enabled: false,
  baseUrl: "https://nc.example.com",
  secret: "bot-secret",
} as const;

describe("nextcloudTalkMessageActions", () => {
  beforeEach(() => {
    hoisted.sendReactionNextcloudTalk.mockReset();
    hoisted.sendReactionNextcloudTalk.mockResolvedValue({ ok: true });
    hoisted.sendMessageNextcloudTalk.mockReset();
    hoisted.listNextcloudTalkAccountIds.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReset();
  });

  describe("describeMessageTool", () => {
    it("returns null when no accounts are configured", () => {
      hoisted.listNextcloudTalkAccountIds.mockReturnValue([]);

      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {} as OpenClawConfig,
      });

      expect(result).toBeNull();
    });

    it("returns null when configured account has no secret/baseUrl", () => {
      hoisted.listNextcloudTalkAccountIds.mockReturnValue([unconfiguredAccount.accountId]);
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(unconfiguredAccount);

      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {} as OpenClawConfig,
      });

      expect(result).toBeNull();
    });

    it("returns null when the only listed account is disabled", () => {
      hoisted.listNextcloudTalkAccountIds.mockReturnValue([disabledAccount.accountId]);
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(disabledAccount);

      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {} as OpenClawConfig,
      });

      expect(result).toBeNull();
    });

    it("advertises send + react when an account is configured", () => {
      hoisted.listNextcloudTalkAccountIds.mockReturnValue([configuredAccount.accountId]);
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(configuredAccount);

      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {} as OpenClawConfig,
      });

      expect(result?.actions).toEqual(["send", "react"]);
    });

    it("scopes discovery to a specific accountId when provided", () => {
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(configuredAccount);

      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {} as OpenClawConfig,
        accountId: "work",
      });

      expect(hoisted.resolveNextcloudTalkAccount).toHaveBeenCalledWith({
        cfg: {},
        accountId: "work",
      });
      expect(hoisted.listNextcloudTalkAccountIds).not.toHaveBeenCalled();
      expect(result?.actions).toEqual(["send", "react"]);
    });

    it("returns null when the targeted account is disabled", () => {
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(disabledAccount);

      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {} as OpenClawConfig,
        accountId: "work",
      });

      expect(result).toBeNull();
    });
  });

  describe("supportsAction", () => {
    it("delegates send back to outbound", () => {
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    });

    it("handles react locally", () => {
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "react" })).toBe(true);
    });
  });

  describe("handleAction", () => {
    const cfg = {} as CoreConfig;

    it("invokes sendReactionNextcloudTalk with normalized params for the react action", async () => {
      const result = await nextcloudTalkMessageActions.handleAction?.({
        channel: "nextcloud-talk",
        action: "react",
        params: { to: "room:abc123", messageId: "42", emoji: "👍" },
        cfg,
        accountId: "work",
      });

      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledTimes(1);
      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledWith("room:abc123", "42", "👍", {
        accountId: "work",
        cfg,
      });
      expect(result).toMatchObject({
        details: { ok: true, added: "👍" },
      });
    });

    it("uses toolContext.currentMessageId when params.messageId is missing", async () => {
      await nextcloudTalkMessageActions.handleAction?.({
        channel: "nextcloud-talk",
        action: "react",
        params: { to: "room:abc123", emoji: "✅" },
        cfg,
        accountId: null,
        toolContext: { currentMessageId: 99 },
      });

      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledWith("room:abc123", "99", "✅", {
        accountId: undefined,
        cfg,
      });
    });

    it("requires a target room token", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { messageId: "1", emoji: "👍" },
          cfg,
        }),
      ).rejects.toThrow(/to \(room token\) required/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("requires a messageId (explicit or via toolContext)", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", emoji: "👍" },
          cfg,
        }),
      ).rejects.toThrow(/messageId required/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("requires an emoji", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", messageId: "1" },
          cfg,
        }),
      ).rejects.toThrow(/emoji required/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("rejects send through the action handler (outbound owns send)", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "send",
          params: { to: "room:abc123", text: "hi" },
          cfg,
        }),
      ).rejects.toThrow(/handled by outbound/);
    });

    it("rejects unsupported actions", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "delete",
          params: {},
          cfg,
        }),
      ).rejects.toThrow(/Action delete not supported for nextcloud-talk/);
    });

    it("rejects reaction removal requests without calling the add-reaction sender", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", messageId: "1", emoji: "👍", remove: true },
          cfg,
        }),
      ).rejects.toThrow(/removal is not supported/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("still adds the reaction when remove is explicitly false", async () => {
      await nextcloudTalkMessageActions.handleAction?.({
        channel: "nextcloud-talk",
        action: "react",
        params: { to: "room:abc123", messageId: "1", emoji: "👍", remove: false },
        cfg,
      });

      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledTimes(1);
    });

    it("propagates errors from sendReactionNextcloudTalk", async () => {
      hoisted.sendReactionNextcloudTalk.mockRejectedValueOnce(
        new Error("Nextcloud Talk reaction failed: 403 forbidden"),
      );

      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", messageId: "1", emoji: "👍" },
          cfg,
        }),
      ).rejects.toThrow(/403 forbidden/);
    });
  });
});

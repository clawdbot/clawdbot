import { describe, expect, it } from "vitest";

import type { MSTeamsConfig } from "clawdbot/plugin-sdk";
import {
  isMSTeamsGroupAllowed,
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "./policy.js";

describe("msteams policy", () => {
  describe("resolveMSTeamsRouteConfig", () => {
    it("returns team and channel config when present", () => {
      const cfg: MSTeamsConfig = {
        teams: {
          team123: {
            requireMention: false,
            channels: {
              chan456: { requireMention: true },
            },
          },
        },
      };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        teamId: "team123",
        conversationId: "chan456",
      });

      expect(res.teamConfig?.requireMention).toBe(false);
      expect(res.channelConfig?.requireMention).toBe(true);
      expect(res.allowlistConfigured).toBe(true);
      expect(res.allowed).toBe(true);
      expect(res.channelMatchKey).toBe("chan456");
      expect(res.channelMatchSource).toBe("direct");
    });

    it("returns undefined configs when teamId is missing", () => {
      const cfg: MSTeamsConfig = {
        teams: { team123: { requireMention: false } },
      };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        teamId: undefined,
        conversationId: "chan",
      });
      expect(res.teamConfig).toBeUndefined();
      expect(res.channelConfig).toBeUndefined();
      expect(res.allowlistConfigured).toBe(true);
      expect(res.allowed).toBe(false);
    });

    it("matches team and channel by name", () => {
      const cfg: MSTeamsConfig = {
        teams: {
          "My Team": {
            requireMention: true,
            channels: {
              "General Chat": { requireMention: false },
            },
          },
        },
      };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        teamName: "My Team",
        channelName: "General Chat",
        conversationId: "ignored",
      });

      expect(res.teamConfig?.requireMention).toBe(true);
      expect(res.channelConfig?.requireMention).toBe(false);
      expect(res.allowed).toBe(true);
    });
  });

  describe("resolveMSTeamsReplyPolicy", () => {
    it("forces thread replies for direct messages", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: true,
        globalConfig: { replyStyle: "top-level", requireMention: false },
      });
      expect(policy).toEqual({ requireMention: false, replyStyle: "thread" });
    });

    it("defaults to requireMention=true and replyStyle=thread", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: {},
      });
      expect(policy).toEqual({ requireMention: true, replyStyle: "thread" });
    });

    it("defaults replyStyle to top-level when requireMention=false", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: false },
      });
      expect(policy).toEqual({
        requireMention: false,
        replyStyle: "top-level",
      });
    });

    it("prefers channel overrides over team and global defaults", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: true },
        teamConfig: { requireMention: true },
        channelConfig: { requireMention: false },
      });

      // requireMention from channel -> false, and replyStyle defaults from requireMention -> top-level
      expect(policy).toEqual({
        requireMention: false,
        replyStyle: "top-level",
      });
    });

    it("inherits team mention settings when channel config is missing", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: true },
        teamConfig: { requireMention: false },
      });
      expect(policy).toEqual({
        requireMention: false,
        replyStyle: "top-level",
      });
    });

    it("uses explicit replyStyle even when requireMention defaults would differ", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: false, replyStyle: "thread" },
      });
      expect(policy).toEqual({ requireMention: false, replyStyle: "thread" });
    });
  });

  describe("isMSTeamsGroupAllowed", () => {
    it("allows when policy is open", () => {
      expect(
        isMSTeamsGroupAllowed({
          groupPolicy: "open",
          allowFrom: [],
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(true);
    });

    it("blocks when policy is disabled", () => {
      expect(
        isMSTeamsGroupAllowed({
          groupPolicy: "disabled",
          allowFrom: ["user-id"],
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(false);
    });

    it("blocks allowlist when empty", () => {
      expect(
        isMSTeamsGroupAllowed({
          groupPolicy: "allowlist",
          allowFrom: [],
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(false);
    });

    it("allows allowlist when sender matches", () => {
      expect(
        isMSTeamsGroupAllowed({
          groupPolicy: "allowlist",
          allowFrom: ["User-Id"],
          senderId: "user-id",
          senderName: "User",
        }),
      ).toBe(true);
    });

    it("allows allowlist when sender name matches", () => {
      expect(
        isMSTeamsGroupAllowed({
          groupPolicy: "allowlist",
          allowFrom: ["user"],
          senderId: "other",
          senderName: "User",
        }),
      ).toBe(true);
    });

    it("allows allowlist wildcard", () => {
      expect(
        isMSTeamsGroupAllowed({
          groupPolicy: "allowlist",
          allowFrom: ["*"],
          senderId: "other",
          senderName: "User",
        }),
      ).toBe(true);
    });
  });
});

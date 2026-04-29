import { describe, expect, it } from "vitest";
import { resolveQQBotAccess } from "./access-control.js";
import { QQBOT_ACCESS_REASON } from "./types.js";

describe("resolveQQBotAccess", () => {
  describe("DM scenarios", () => {
    it("allows default-open DMs when allowFrom is omitted", () => {
      const result = resolveQQBotAccess({ isGroup: false, senderId: "USER1" });
      expect(result).toMatchObject({
        decision: "allow",
        reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_OPEN,
        dmPolicy: "open",
        effectiveAllowFrom: ["*"],
      });
    });

    it("allows default-open DMs when allowFrom is explicitly empty", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER1",
        allowFrom: [],
      });
      expect(result).toMatchObject({
        decision: "allow",
        reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_OPEN,
        dmPolicy: "open",
        effectiveAllowFrom: ["*"],
      });
    });

    it("allows everyone with wildcard allowFrom", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER1",
        allowFrom: ["*"],
      });
      expect(result.decision).toBe("allow");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.DM_POLICY_OPEN);
    });

    it("allows sender matching the allowlist", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER1",
        allowFrom: ["USER1"],
      });
      expect(result.decision).toBe("allow");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.DM_POLICY_ALLOWLISTED);
      expect(result.dmPolicy).toBe("allowlist");
    });

    it("allows open mode when sender matches restrictive allowFrom", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER1",
        allowFrom: ["USER1"],
        dmPolicy: "open",
      });
      expect(result.decision).toBe("allow");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.DM_POLICY_ALLOWLISTED);
      expect(result.reason).toBe("dmPolicy=open (allowlisted)");
    });

    it("blocks sender not in allowlist", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER2",
        allowFrom: ["USER1"],
      });
      expect(result.decision).toBe("block");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED);
    });

    it("blocks DM when dmPolicy=disabled (even with wildcard)", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER1",
        allowFrom: ["*"],
        dmPolicy: "disabled",
      });
      expect(result.decision).toBe("block");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.DM_POLICY_DISABLED);
    });

    it("blocks DM with allowlist policy but empty allowlist", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER1",
        dmPolicy: "allowlist",
      });
      expect(result.decision).toBe("block");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.DM_POLICY_EMPTY_ALLOWLIST);
    });

    it("normalizes qqbot: prefix and case when matching", () => {
      const result = resolveQQBotAccess({
        isGroup: false,
        senderId: "qqbot:user1",
        allowFrom: ["QQBot:USER1"],
      });
      expect(result.decision).toBe("allow");
    });
  });

  describe("group scenarios", () => {
    it("inherits allowFrom for group access when no groupAllowFrom is set", () => {
      const allowed = resolveQQBotAccess({
        isGroup: true,
        senderId: "USER1",
        allowFrom: ["USER1"],
      });
      expect(allowed.decision).toBe("allow");
      expect(allowed.groupPolicy).toBe("allowlist");

      const blocked = resolveQQBotAccess({
        isGroup: true,
        senderId: "USER2",
        allowFrom: ["USER1"],
      });
      expect(blocked.decision).toBe("block");
      expect(blocked.reasonCode).toBe(QQBOT_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED);
    });

    it("uses groupAllowFrom when explicitly provided", () => {
      const result = resolveQQBotAccess({
        isGroup: true,
        senderId: "USER2",
        allowFrom: ["USER1"],
        groupAllowFrom: ["USER2"],
      });
      expect(result.decision).toBe("allow");
    });

    it("blocks when groupPolicy=disabled", () => {
      const result = resolveQQBotAccess({
        isGroup: true,
        senderId: "USER1",
        allowFrom: ["*"],
        groupPolicy: "disabled",
      });
      expect(result.decision).toBe("block");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.GROUP_POLICY_DISABLED);
    });

    it("allows anyone when groupPolicy=open", () => {
      const result = resolveQQBotAccess({
        isGroup: true,
        senderId: "RANDOM_USER",
        allowFrom: ["USER1"],
        groupPolicy: "open",
      });
      expect(result.decision).toBe("allow");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.GROUP_POLICY_ALLOWED);
    });

    it("blocks when groupPolicy=allowlist but list is empty", () => {
      const result = resolveQQBotAccess({
        isGroup: true,
        senderId: "USER1",
        groupPolicy: "allowlist",
      });
      expect(result.decision).toBe("block");
      expect(result.reasonCode).toBe(QQBOT_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST);
    });
  });

  describe("backwards compatibility (legacy allowFrom-only configs)", () => {
    it("legacy allowFrom=['*'] stays fully open for both DM and group", () => {
      const dm = resolveQQBotAccess({
        isGroup: false,
        senderId: "RANDOM",
        allowFrom: ["*"],
      });
      const group = resolveQQBotAccess({
        isGroup: true,
        senderId: "RANDOM",
        allowFrom: ["*"],
      });
      expect(dm.decision).toBe("allow");
      expect(group.decision).toBe("allow");
    });

    it("legacy allowFrom=['USER1'] locks down both DM and group to USER1", () => {
      const allowedDm = resolveQQBotAccess({
        isGroup: false,
        senderId: "USER1",
        allowFrom: ["USER1"],
      });
      const blockedGroup = resolveQQBotAccess({
        isGroup: true,
        senderId: "INTRUDER",
        allowFrom: ["USER1"],
      });
      expect(allowedDm.decision).toBe("allow");
      expect(blockedGroup.decision).toBe("block");
    });
  });
});

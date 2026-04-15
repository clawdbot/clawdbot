import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { normalizeAllowFrom, type NormalizedAllowFrom } from "./bot-access.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";

function allow(entries: string[], hasWildcard = false): NormalizedAllowFrom {
  return {
    entries,
    hasWildcard,
    hasEntries: entries.length > 0 || hasWildcard,
    invalidEntries: [],
  };
}

describe("evaluateTelegramGroupBaseAccess", () => {
  it("normalizes sender-only allowlist entries and rejects group ids", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["-1001234567890", "-100999", "@someone"],
    });
  });

  it("fails closed when explicit group allowFrom override is empty", () => {
    const result = evaluateTelegramGroupBaseAccess({
      isGroup: true,
      hasGroupAllowOverride: true,
      effectiveGroupAllow: allow([]),
      senderId: "12345",
      senderUsername: "tester",
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });

    expect(result).toEqual({ allowed: false, reason: "group-override-unauthorized" });
  });

  it("allows group message when override is not configured", () => {
    const result = evaluateTelegramGroupBaseAccess({
      isGroup: true,
      hasGroupAllowOverride: false,
      effectiveGroupAllow: allow([]),
      senderId: "12345",
      senderUsername: "tester",
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("allows sender explicitly listed in override", () => {
    const result = evaluateTelegramGroupBaseAccess({
      isGroup: true,
      hasGroupAllowOverride: true,
      effectiveGroupAllow: allow(["12345"]),
      senderId: "12345",
      senderUsername: "tester",
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });

    expect(result).toEqual({ allowed: true });
  });
});

/**
 * Minimal stubs shared across group policy tests.
 */
const baseCfg = {
  channels: { telegram: {} },
} as unknown as OpenClawConfig;

const baseTelegramCfg: TelegramAccountConfig = {
  groupPolicy: "allowlist",
} as unknown as TelegramAccountConfig;

const emptyAllow = { entries: [], hasWildcard: false, hasEntries: false, invalidEntries: [] };
const senderAllow = {
  entries: ["111"],
  hasWildcard: false,
  hasEntries: true,
  invalidEntries: [],
};

type GroupAccessParams = Parameters<typeof evaluateTelegramGroupPolicyAccess>[0];

const DEFAULT_GROUP_ACCESS_PARAMS: GroupAccessParams = {
  isGroup: true,
  chatId: "-100123456",
  cfg: baseCfg,
  telegramCfg: baseTelegramCfg,
  effectiveGroupAllow: emptyAllow,
  senderId: "999",
  senderUsername: "user",
  resolveGroupPolicy: () => ({
    allowlistEnabled: true,
    allowed: true,
    groupConfig: { requireMention: false },
  }),
  enforcePolicy: true,
  useTopicAndGroupOverrides: false,
  enforceAllowlistAuthorization: true,
  allowEmptyAllowlistEntries: false,
  requireSenderForAllowlistAuthorization: true,
  checkChatAllowlist: true,
};

function runAccess(overrides: Partial<GroupAccessParams>) {
  return evaluateTelegramGroupPolicyAccess({
    ...DEFAULT_GROUP_ACCESS_PARAMS,
    ...overrides,
    resolveGroupPolicy:
      overrides.resolveGroupPolicy ?? DEFAULT_GROUP_ACCESS_PARAMS.resolveGroupPolicy,
  });
}

describe("evaluateTelegramGroupPolicyAccess", () => {
  it("allows a group explicitly listed in groups config even when no allowFrom entries exist", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("still blocks when only wildcard match and no allowFrom entries", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: undefined,
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("rejects a group not in groups config", () => {
    const result = runAccess({
      chatId: "-100999999",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false,
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-chat-not-allowed",
      groupPolicy: "allowlist",
    });
  });

  it("still enforces sender allowlist when checkChatAllowlist is disabled", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
      checkChatAllowlist: false,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("blocks unauthorized sender even when chat is explicitly allowed and sender entries exist", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow,
      senderId: "222",
      senderUsername: "other",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-unauthorized",
      groupPolicy: "allowlist",
    });
  });

  it("allows when groupPolicy is open regardless of allowlist state", () => {
    const result = runAccess({
      telegramCfg: { groupPolicy: "open" } as TelegramAccountConfig,
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false,
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "open" });
  });

  it("rejects when groupPolicy is disabled", () => {
    const result = runAccess({
      telegramCfg: { groupPolicy: "disabled" } as TelegramAccountConfig,
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false,
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-disabled",
      groupPolicy: "disabled",
    });
  });

  it("allows non-group messages without any checks", () => {
    const result = runAccess({
      isGroup: false,
      chatId: "12345",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false,
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("blocks allowlist groups without sender identity before sender matching", () => {
    const result = runAccess({
      senderId: undefined,
      senderUsername: undefined,
      effectiveGroupAllow: senderAllow,
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-no-sender",
      groupPolicy: "allowlist",
    });
  });

  it("allows authorized sender in wildcard-matched group with sender entries", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow,
      senderId: "111",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: undefined,
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });
});

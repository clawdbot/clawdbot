import { describe, expect, it } from "vitest";
import {
  validateChatSendParams,
  validateMentionsChangedEvent,
  validateMentionsDismissParams,
  validateMentionsListParams,
  validateMentionsListResult,
  validateSessionsCreateParams,
  validateSessionsSendParams,
  validateUsersMentionableParams,
  validateUsersMentionableResult,
} from "../index.js";

describe("human mention protocol", () => {
  it.each([
    {
      method: "chat.send",
      validate: validateChatSendParams,
      target: { sessionKey: "agent:main:main" },
    },
    {
      method: "sessions.create",
      validate: validateSessionsCreateParams,
      target: { agentId: "main" },
    },
    {
      method: "sessions.send",
      validate: validateSessionsSendParams,
      target: { key: "agent:main:main" },
    },
  ])("preserves optional bounded mention annotations on $method", ({ validate, target }) => {
    const base = { ...target, message: "🙂 @Ada", idempotencyKey: "run-mentions" };
    const mention = { profileId: "profile-ada", start: 3, end: 7 };
    for (const params of [base, { ...base, mentions: [] }, { ...base, mentions: [mention] }]) {
      expect(validate(params)).toBe(true);
    }
    for (const mentions of [
      ["profile-ada"],
      [{ ...mention, profileId: "" }],
      [{ ...mention, profileId: "x".repeat(257) }],
      [{ ...mention, start: -1 }],
      [{ ...mention, start: 3.5 }],
      [{ ...mention, end: 0 }],
      [{ ...mention, senderProfileId: "forged-sender" }],
      Array.from({ length: 11 }, () => mention),
    ]) {
      expect(validate({ ...base, mentions })).toBe(false);
    }
  });

  it("requires exactly one existing or prospective session context for the directory", () => {
    for (const params of [
      { sessionKey: "agent:main:discussion" },
      { sessionKey: "agent:main:discussion", query: "Ada" },
      { sessionKey: "global", agentId: "main" },
      { agentId: "main" },
      { agentId: "main", visibility: "draft", query: "" },
    ]) {
      expect(validateUsersMentionableParams(params)).toBe(true);
    }
    for (const params of [
      {},
      { query: "Ada" },
      { sessionKey: "agent:main:discussion", visibility: "shared" },
      { agentId: "main", visibility: "private" },
      { agentId: "main", profileId: "another-profile" },
      { agentId: "main", query: "x".repeat(129) },
      { sessionKey: "" },
    ]) {
      expect(validateUsersMentionableParams(params)).toBe(false);
    }
  });

  it("keeps directory results bounded and free of private profile fields", () => {
    const user = { profileId: "profile-ada", displayName: "Ada", online: false };
    expect(validateUsersMentionableResult({ users: [user], truncated: false })).toBe(true);
    expect(
      validateUsersMentionableResult({
        users: [{ ...user, emails: ["ada@example.com"] }],
        truncated: false,
      }),
    ).toBe(false);
    expect(
      validateUsersMentionableResult({
        users: Array.from({ length: 101 }, () => user),
        truncated: true,
      }),
    ).toBe(false);
  });

  it("permits self-only list and bounded explicit dismissals without a recipient selector", () => {
    expect(validateMentionsListParams({})).toBe(true);
    expect(validateMentionsListParams({ profileId: "another-profile" })).toBe(false);
    expect(validateMentionsDismissParams({ ids: ["mention-1", "mention-2"] })).toBe(true);
    expect(validateMentionsDismissParams({ ids: [] })).toBe(true);
    for (const params of [
      { ids: ["mention-1"], profileId: "another-profile" },
      { ids: ["mention-1", "mention-1"] },
      { ids: [""] },
      { ids: Array.from({ length: 101 }, (_, index) => `mention-${index}`) },
      { all: true },
    ]) {
      expect(validateMentionsDismissParams(params)).toBe(false);
    }
  });

  it("validates bounded Inbox snapshots and keeps invalidations content-free", () => {
    const version = { gatewayInstanceId: "gateway-instance", revision: 3 };
    const item = {
      id: "mention-1",
      senderProfileId: "profile-ada",
      senderLabel: "Ada",
      sessionKey: "agent:main:discussion",
      agentId: "main",
      sessionTitle: "Discussion",
      messageId: "message-1",
      createdAt: 1,
      expiresAt: 60_001,
    };
    expect(validateMentionsListResult({ ...version, items: [item] })).toBe(true);
    expect(
      validateMentionsListResult({ ...version, items: [{ ...item, excerpt: "x".repeat(281) }] }),
    ).toBe(false);
    expect(
      validateMentionsListResult({ ...version, items: Array.from({ length: 101 }, () => item) }),
    ).toBe(false);
    expect(validateMentionsChangedEvent(version)).toBe(true);
    expect(validateMentionsChangedEvent({ ...version, item })).toBe(false);
    expect(validateMentionsChangedEvent({ ...version, revision: -1 })).toBe(false);
  });
});

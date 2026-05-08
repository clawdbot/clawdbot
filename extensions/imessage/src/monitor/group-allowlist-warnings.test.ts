import { beforeEach, describe, expect, it } from "vitest";
import {
  resetGroupAllowlistWarningsForTesting,
  warnGroupAllowlistDropPerChatOnce,
  warnGroupAllowlistMisconfigOnce,
} from "./group-allowlist-warnings.js";

beforeEach(() => {
  resetGroupAllowlistWarningsForTesting();
});

describe("warnGroupAllowlistMisconfigOnce", () => {
  it("fires when groupPolicy=allowlist and groups is undefined", () => {
    const messages: string[] = [];
    const fired = warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      groups: undefined,
      accountId: "default",
      log: (m) => messages.push(m),
    });
    expect(fired).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('groupPolicy="allowlist"');
    expect(messages[0]).toContain("channels.imessage.groups is empty");
    expect(messages[0]).toContain("default");
  });

  it("fires when groupPolicy=allowlist and groups is empty object", () => {
    const messages: string[] = [];
    const fired = warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      groups: {},
      accountId: "default",
      log: (m) => messages.push(m),
    });
    expect(fired).toBe(true);
    expect(messages).toHaveLength(1);
  });

  it("does not fire when groupPolicy is not allowlist", () => {
    const messages: string[] = [];
    const fired = warnGroupAllowlistMisconfigOnce({
      groupPolicy: "open",
      groups: undefined,
      accountId: "default",
      log: (m) => messages.push(m),
    });
    expect(fired).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("does not fire when groups has a wildcard entry", () => {
    const messages: string[] = [];
    const fired = warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      groups: { "*": { requireMention: true } },
      accountId: "default",
      log: (m) => messages.push(m),
    });
    expect(fired).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("does not fire when groups has explicit chat_id entries", () => {
    const messages: string[] = [];
    const fired = warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      groups: { "12345": {} },
      accountId: "default",
      log: (m) => messages.push(m),
    });
    expect(fired).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("only fires once per accountId", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    expect(
      warnGroupAllowlistMisconfigOnce({
        groupPolicy: "allowlist",
        groups: undefined,
        accountId: "default",
        log,
      }),
    ).toBe(true);
    expect(
      warnGroupAllowlistMisconfigOnce({
        groupPolicy: "allowlist",
        groups: undefined,
        accountId: "default",
        log,
      }),
    ).toBe(false);
    expect(messages).toHaveLength(1);
  });

  it("fires separately for distinct accountIds", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      groups: undefined,
      accountId: "primary",
      log,
    });
    warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      groups: undefined,
      accountId: "secondary",
      log,
    });
    expect(messages).toHaveLength(2);
  });
});

describe("warnGroupAllowlistDropPerChatOnce", () => {
  it("fires once per accountId:chat_id pair", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    expect(warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: 42, log })).toBe(true);
    expect(warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: 42, log })).toBe(
      false,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("chat_id=42");
    expect(messages[0]).toContain("default");
    expect(messages[0]).toContain('channels.imessage.groups["42"]');
  });

  it("fires separately for distinct chat_ids on the same account", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: 1, log });
    warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: 2, log });
    warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: 2, log });
    expect(messages).toHaveLength(2);
  });

  it("treats numeric and string chat_ids as the same key", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: 42, log });
    warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: "42", log });
    expect(messages).toHaveLength(1);
  });

  it("skips when chat_id is undefined or empty", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    expect(
      warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: undefined, log }),
    ).toBe(false);
    expect(warnGroupAllowlistDropPerChatOnce({ accountId: "default", chatId: "", log })).toBe(
      false,
    );
    expect(messages).toHaveLength(0);
  });
});

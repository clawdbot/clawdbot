// Imessage tests cover group allowlist warnings plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import {
  warnGroupAllowlistDropPerChatOnce,
  warnGroupAllowlistMisconfigOnce,
} from "./group-allowlist-warnings.js";

let accountSequence = 0;
let accountId = "";

describe("warnGroupAllowlistMisconfigOnce", () => {
  beforeEach(() => {
    accountSequence += 1;
    accountId = `test-${accountSequence}`;
  });

  it("fires when groupPolicy=allowlist has no effective groupAllowFrom", () => {
    const messages: string[] = [];
    const fired = warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      hasGroupAllowFrom: false,
      accountId,
      log: (m) => messages.push(m),
    });
    expect(fired).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('groupPolicy="allowlist"');
    expect(messages[0]).toContain("channels.imessage.groupAllowFrom");
    expect(messages[0]).toContain(accountId);
  });

  it("does not fire when groupPolicy is not allowlist", () => {
    const messages: string[] = [];
    const fired = warnGroupAllowlistMisconfigOnce({
      groupPolicy: "open",
      hasGroupAllowFrom: false,
      accountId,
      log: (m) => messages.push(m),
    });
    expect(fired).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("does not fire when groupAllowFrom admits groups despite empty groups (senderFilterBypass)", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    expect(
      warnGroupAllowlistMisconfigOnce({
        groupPolicy: "allowlist",
        hasGroupAllowFrom: true,
        accountId,
        log,
      }),
    ).toBe(false);
    expect(
      warnGroupAllowlistMisconfigOnce({
        groupPolicy: "allowlist",
        hasGroupAllowFrom: true,
        accountId,
        log,
      }),
    ).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("only fires once per accountId", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    expect(
      warnGroupAllowlistMisconfigOnce({
        groupPolicy: "allowlist",
        hasGroupAllowFrom: false,
        accountId,
        log,
      }),
    ).toBe(true);
    expect(
      warnGroupAllowlistMisconfigOnce({
        groupPolicy: "allowlist",
        hasGroupAllowFrom: false,
        accountId,
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
      hasGroupAllowFrom: false,
      accountId: `${accountId}-primary`,
      log,
    });
    warnGroupAllowlistMisconfigOnce({
      groupPolicy: "allowlist",
      hasGroupAllowFrom: false,
      accountId: `${accountId}-secondary`,
      log,
    });
    expect(messages).toHaveLength(2);
  });
});

describe("warnGroupAllowlistDropPerChatOnce", () => {
  beforeEach(() => {
    accountSequence += 1;
    accountId = `test-${accountSequence}`;
  });

  it("fires once per accountId:chat_id pair", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    expect(warnGroupAllowlistDropPerChatOnce({ accountId, chatId: 42, log })).toBe(true);
    expect(warnGroupAllowlistDropPerChatOnce({ accountId, chatId: 42, log })).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("chat_id=42");
    expect(messages[0]).toContain(accountId);
    expect(messages[0]).toContain('channels.imessage.groups["42"]');
  });

  it("fires separately for distinct chat_ids on the same account", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    warnGroupAllowlistDropPerChatOnce({ accountId, chatId: 1, log });
    warnGroupAllowlistDropPerChatOnce({ accountId, chatId: 2, log });
    warnGroupAllowlistDropPerChatOnce({ accountId, chatId: 2, log });
    expect(messages).toHaveLength(2);
  });

  it("treats numeric and string chat_ids as the same key", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    warnGroupAllowlistDropPerChatOnce({ accountId, chatId: 42, log });
    warnGroupAllowlistDropPerChatOnce({ accountId, chatId: "42", log });
    expect(messages).toHaveLength(1);
  });

  it("skips when chat_id is undefined or empty", () => {
    const messages: string[] = [];
    const log = (m: string) => messages.push(m);
    expect(warnGroupAllowlistDropPerChatOnce({ accountId, chatId: undefined, log })).toBe(false);
    expect(warnGroupAllowlistDropPerChatOnce({ accountId, chatId: "", log })).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("bounds warn-once state by least-recently-used account/chat pairs", () => {
    const messages: string[] = [];
    const log = (message: string) => messages.push(message);
    const warn = (chatId: number) => warnGroupAllowlistDropPerChatOnce({ accountId, chatId, log });

    for (let chatId = 0; chatId < 512; chatId += 1) {
      expect(warn(chatId)).toBe(true);
    }
    expect(warn(0)).toBe(false);
    expect(warn(512)).toBe(true);

    messages.length = 0;
    expect(warn(0)).toBe(false);
    expect(warn(1)).toBe(true);
    expect(warn(512)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("chat_id=1");
  });
});

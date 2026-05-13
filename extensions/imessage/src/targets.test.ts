import { describe, expect, it } from "vitest";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import { imessageDmPolicy } from "./setup-core.js";
import { parseIMessageAllowFromEntries } from "./setup-surface.js";
import {
  formatIMessageChatTarget,
  inferIMessageTargetChatType,
  isAllowedIMessageReplyContextSender,
  isAllowedIMessageSender,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

describe("imessage targets", () => {
  it("parses chat_id targets", () => {
    const target = parseIMessageTarget("chat_id:123");
    expect(target).toEqual({ kind: "chat_id", chatId: 123 });
  });

  it("parses chat targets", () => {
    const target = parseIMessageTarget("chat:456");
    expect(target).toEqual({ kind: "chat_id", chatId: 456 });
  });

  it("parses sms handles with service", () => {
    const target = parseIMessageTarget("sms:+1555");
    expect(target).toEqual({ kind: "handle", to: "+1555", service: "sms" });
  });

  it("normalizes handles", () => {
    expect(normalizeIMessageHandle("Name@Example.com")).toBe("name@example.com");
    expect(normalizeIMessageHandle(" +1 (555) 222-3333 ")).toBe("+15552223333");
  });

  it("normalizes chat_id prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_ID:123")).toBe("chat_id:123");
    expect(normalizeIMessageHandle("Chat_Id:456")).toBe("chat_id:456");
    expect(normalizeIMessageHandle("chatid:789")).toBe("chat_id:789");
    expect(normalizeIMessageHandle("CHAT:42")).toBe("chat_id:42");
  });

  it("normalizes chat_guid prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_GUID:abc-def")).toBe("chat_guid:abc-def");
    expect(normalizeIMessageHandle("ChatGuid:XYZ")).toBe("chat_guid:XYZ");
    expect(normalizeIMessageHandle("GUID:test-guid")).toBe("chat_guid:test-guid");
  });

  it("normalizes chat_identifier prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_IDENTIFIER:iMessage;-;chat123")).toBe(
      "chat_identifier:iMessage;-;chat123",
    );
    expect(normalizeIMessageHandle("ChatIdentifier:test")).toBe("chat_identifier:test");
    expect(normalizeIMessageHandle("CHATIDENT:foo")).toBe("chat_identifier:foo");
  });

  it("does not check allowFrom against conversation targets", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["chat_id:9"],
      sender: "+1555",
      chatId: 9,
    });
    expect(ok).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["imessage:chat_id:9"],
        sender: "+1555",
        chatId: 9,
      }),
    ).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["chat_guid:team-thread"],
        sender: "+1555",
        chatGuid: "team-thread",
      }),
    ).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["chat_identifier:team"],
        sender: "+1555",
        chatIdentifier: "team",
      }),
    ).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["chat_id:9"],
        sender: "+1555",
        chatId: 9,
        allowConversationTargets: true,
      }),
    ).toBe(false);
  });

  it("checks allowFrom against handle", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["user@example.com"],
      sender: "User@Example.com",
    });
    expect(ok).toBe(true);
  });

  it("checks reply context allowFrom against conversation targets", () => {
    expect(
      isAllowedIMessageReplyContextSender({
        allowFrom: ["chat_id:9"],
        sender: "+1555",
        chatId: 9,
      }),
    ).toBe(true);

    expect(
      isAllowedIMessageReplyContextSender({
        allowFrom: ["imessage:chat_guid:team-thread"],
        sender: "+1555",
        chatGuid: "team-thread",
      }),
    ).toBe(true);

    expect(
      isAllowedIMessageReplyContextSender({
        allowFrom: ["chat_identifier:team"],
        sender: "+1555",
        chatIdentifier: "team",
      }),
    ).toBe(true);
  });

  it("denies when allowFrom is empty", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: [],
      sender: "+1555",
    });
    expect(ok).toBe(false);
  });

  it("formats chat targets", () => {
    expect(formatIMessageChatTarget(42)).toBe("chat_id:42");
    expect(formatIMessageChatTarget(undefined)).toBe("");
  });

  it("only treats explicit chat targets as immediate ids", () => {
    expect(looksLikeIMessageExplicitTargetId("chat_id:42")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("sms:+15552223333")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("+15552223333")).toBe(false);
    expect(looksLikeIMessageExplicitTargetId("user@example.com")).toBe(false);
  });

  it("infers direct and group chat types from normalized targets", () => {
    expect(inferIMessageTargetChatType("+15552223333")).toBe("direct");
    expect(inferIMessageTargetChatType("chat_id:42")).toBe("group");
  });
});

describe("imessage group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        imessage: {
          groups: {
            "chat:family": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as any;

    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "chat:family" })).toBe(false);
    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "chat:other" })).toBe(true);
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "chat:family" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "chat:other" })).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("parseIMessageAllowFromEntries", () => {
  it("parses handles", () => {
    expect(parseIMessageAllowFromEntries("+15555550123, user@example.com")).toEqual({
      entries: ["+15555550123", "user@example.com"],
    });
  });

  it("returns validation errors for chat target entries", () => {
    expect(parseIMessageAllowFromEntries("chat_id:123")).toEqual({
      entries: [],
      error: "iMessage allowFrom entries must be sender handles: chat_id:123",
    });

    expect(parseIMessageAllowFromEntries("imessage:chat_id:123")).toEqual({
      entries: [],
      error: "iMessage allowFrom entries must be sender handles: imessage:chat_id:123",
    });
  });

  it("returns validation errors for chat_identifier entries", () => {
    expect(parseIMessageAllowFromEntries("chat_identifier:")).toEqual({
      entries: [],
      error: "iMessage allowFrom entries must be sender handles: chat_identifier:",
    });
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      imessageDmPolicy.getCurrent(
        {
          channels: {
            imessage: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  cliPath: "imsg",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(imessageDmPolicy.resolveConfigKeys?.({ channels: { imessage: {} } }, "work")).toEqual({
      policyKey: "channels.imessage.accounts.work.dmPolicy",
      allowFromKey: "channels.imessage.accounts.work.allowFrom",
    });
  });

  it('writes open policy state to the named account and stores inherited allowFrom with "*"', () => {
    const next = imessageDmPolicy.setPolicy(
      {
        channels: {
          imessage: {
            allowFrom: ["+15555550123"],
            accounts: {
              work: {
                cliPath: "imsg",
              },
            },
          },
        },
      },
      "open",
      "work",
    );

    expect(next.channels?.imessage?.dmPolicy).toBeUndefined();
    expect(next.channels?.imessage?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.imessage?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.imessage?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it("uses the configured default account for omitted-account DM policy reads, keys, and writes", () => {
    const cfg = {
      channels: {
        imessage: {
          allowFrom: ["+15555550123"],
          defaultAccount: "work",
          accounts: {
            work: {
              cliPath: "imsg",
              dmPolicy: "allowlist" as const,
              allowFrom: ["chat_id:123"],
            },
          },
        },
      },
    };

    expect(imessageDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(imessageDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.imessage.accounts.work.dmPolicy",
      allowFromKey: "channels.imessage.accounts.work.allowFrom",
    });

    const next = imessageDmPolicy.setPolicy(cfg, "open");

    expect(next.channels?.imessage?.dmPolicy).toBeUndefined();
    expect(next.channels?.imessage?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.imessage?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.imessage?.accounts?.work?.allowFrom).toEqual(["chat_id:123", "*"]);
  });
});

// Imessage tests cover targets plugin behavior.
import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import { imessageDmPolicy } from "./setup-core.js";
import { parseIMessageAllowFromEntries } from "./setup-surface.js";
import type { IMessageService, IMessageTarget } from "./targets.js";
import {
  assertDeliverableIMessageHandle,
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
    expect(target).toEqual({
      kind: "handle",
      to: "+1555",
      service: "sms",
      serviceExplicit: true,
    });
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
    expect(looksLikeIMessageExplicitTargetId("7d5297154d5f436d83dbbdf03fcc8fdd")).toBe(true);
  });

  it("infers direct and group chat types from normalized targets", () => {
    expect(inferIMessageTargetChatType("+15552223333")).toBe("direct");
    expect(inferIMessageTargetChatType("chat_id:42")).toBe("group");
  });

  it("treats bare 32-char hex strings as chat identifiers, not phone numbers", () => {
    const hex = "7d5297154d5f436d83dbbdf03fcc8fdd";
    expect(normalizeIMessageHandle(hex)).toBe(`chat_identifier:${hex}`);
    expect(normalizeIMessageHandle(hex.toUpperCase())).toBe(`chat_identifier:${hex}`);
    expect(parseIMessageTarget(hex)).toEqual({
      kind: "chat_identifier",
      chatIdentifier: hex,
    });
    expect(parseIMessageTarget(`imessage:${hex.toUpperCase()}`)).toEqual({
      kind: "chat_identifier",
      chatIdentifier: hex,
    });
    expect(inferIMessageTargetChatType(hex)).toBe("group");
  });

  it.each(["7d5297154d5f436d83dbbdf03fcc8fd", "7d5297154d5f436d83dbbdf03fcc8fdg"])(
    "keeps non-hex or wrong-length value %s on the handle path",
    (value) => {
      expect(normalizeIMessageHandle(value)).toBe(value);
      expect(parseIMessageTarget(value)).toEqual({ kind: "handle", to: value, service: "auto" });
    },
  );

  it("normalizes tel URIs without treating arbitrary prefixed identifiers as phone numbers", () => {
    expect(normalizeIMessageHandle("tel:+1 (555) 222-3333")).toBe("+15552223333");
    expect(normalizeIMessageHandle("tel:C0AG22RN7L3")).toBe("tel:C0AG22RN7L3");
  });

  it("accepts the all-digit edge of the 32-hex identifier contract", () => {
    const identifier = "1".repeat(32);
    expect(parseIMessageTarget(identifier)).toEqual({
      kind: "chat_identifier",
      chatIdentifier: identifier,
    });
  });

  it("parses bare numeric handles structurally; deliverability is a send-layer verdict (#125461)", () => {
    // Parsing stays structural so a configured `service: "sms"` short code can
    // reach the SMS transport; the send layer owns the deliverability verdict.
    expect(parseIMessageTarget("5")).toEqual({ kind: "handle", to: "5", service: "auto" });
  });

  it("reports undeliverable bare numeric handles unless delivery has an SMS path (#125461)", () => {
    // A bare digit string looks like a Messages chat row id, not a phone
    // handle; pre-fix it normalized to `+<digits>` and the channel send
    // silently failed (-1728). The error must steer the caller to chat_id /
    // full E.164 / sms: / auto:.
    const bareTarget = parseIMessageTarget("5");
    const shortE164 = parseIMessageTarget("+123456");
    const rejectedAsHandle = (target: IMessageTarget, service: IMessageService) =>
      expect(() => assertDeliverableIMessageHandle({ target, service }));
    rejectedAsHandle(bareTarget, "auto").toThrow(/chat_id/);
    rejectedAsHandle(bareTarget, "auto").toThrow(/sms:/);
    rejectedAsHandle(shortE164, "imessage").toThrow(/chat_id/);
    // An SMS short code is a legitimate target once the service resolves to
    // sms, whether from the typed prefix or the account configuration.
    expect(() =>
      assertDeliverableIMessageHandle({ target: bareTarget, service: "sms" }),
    ).not.toThrow();
    expect(() =>
      assertDeliverableIMessageHandle({
        target: parseIMessageTarget("sms:12345"),
        service: "sms",
      }),
    ).not.toThrow();
    // An explicit `auto:` prefix is the documented `auto:<contact>` contract:
    // the operator asked Messages to choose iMessage or SMS, so a short code
    // is intent, not a row-id typo. An account-level `auto` default keeps the
    // verdict — only the typed prefix carries it.
    expect(() =>
      assertDeliverableIMessageHandle({
        target: parseIMessageTarget("auto:12345"),
        service: "auto",
      }),
    ).not.toThrow();
    expect(() =>
      assertDeliverableIMessageHandle({
        target: parseIMessageTarget("auto:12345"),
        service: undefined,
      }),
    ).not.toThrow();
    // Explicit iMessage selection still rejects a handle that cannot be one.
    rejectedAsHandle(parseIMessageTarget("imessage:12345"), "imessage").toThrow(/chat_id/);
    // Full E.164 handles and non-phone targets stay deliverable.
    expect(() =>
      assertDeliverableIMessageHandle({
        target: parseIMessageTarget("+15552223333"),
        service: "auto",
      }),
    ).not.toThrow();
    expect(() =>
      assertDeliverableIMessageHandle({
        target: parseIMessageTarget("user@example.com"),
        service: "auto",
      }),
    ).not.toThrow();
    // Chat-scoped targets never hit the handle verdict.
    expect(() =>
      assertDeliverableIMessageHandle({
        target: parseIMessageTarget("chat_id:5"),
        service: "auto",
      }),
    ).not.toThrow();
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
    } as OpenClawConfig;

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

  installChannelDmPolicyContractSuite({
    dmPolicy: imessageDmPolicy,
    cases: [
      {
        name: "iMessage named accounts",
        channel: "imessage",
        accountId: "work",
        accountConfig: { cliPath: "imsg" },
        inheritedAllowFrom: ["+15555550123"],
        defaultAccount: {
          rootAllowFrom: ["+15555550123"],
          accountAllowFrom: ["chat_id:123"],
        },
      },
    ],
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./monitor/inbound-processing.js";
import { parseIMessageNotification } from "./monitor/parse-notification.js";
import type { IMessagePayload } from "./monitor/types.js";

function baseCfg(): OpenClawConfig {
  return {
    channels: {
      imessage: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groups: { "*": { requireMention: true } },
      },
    },
    session: { mainKey: "main" },
    messages: {
      groupChat: { mentionPatterns: ["@openclaw"] },
    },
  } as unknown as OpenClawConfig;
}

function resolve(params: {
  cfg?: OpenClawConfig;
  message: IMessagePayload;
  storeAllowFrom?: string[];
}) {
  const cfg = params.cfg ?? baseCfg();
  const groupHistories = new Map();
  return resolveIMessageInboundDecision({
    cfg,
    accountId: "default",
    message: params.message,
    opts: {},
    messageText: (params.message.text ?? "").trim(),
    bodyText: (params.message.text ?? "").trim(),
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: cfg.channels?.imessage?.groupPolicy ?? "open",
    dmPolicy: cfg.channels?.imessage?.dmPolicy ?? "pairing",
    storeAllowFrom: params.storeAllowFrom ?? [],
    historyLimit: 0,
    groupHistories,
  });
}

function resolveDispatchDecision(params: {
  cfg: OpenClawConfig;
  message: IMessagePayload;
  groupHistories?: Parameters<typeof resolveIMessageInboundDecision>[0]["groupHistories"];
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
}) {
  const groupHistories = params.groupHistories ?? new Map();
  const decision = resolveIMessageInboundDecision({
    cfg: params.cfg,
    accountId: "default",
    message: params.message,
    opts: {},
    messageText: params.message.text ?? "",
    bodyText: params.message.text ?? "",
    allowFrom: params.allowFrom ?? ["*"],
    groupAllowFrom: params.groupAllowFrom ?? [],
    groupPolicy: params.groupPolicy ?? "open",
    dmPolicy: params.dmPolicy ?? "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories,
  });
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected dispatch decision");
  }
  return { decision, groupHistories };
}

function buildDispatchContextPayload(params: { cfg: OpenClawConfig; message: IMessagePayload }) {
  const { cfg, message } = params;
  const { decision, groupHistories } = resolveDispatchDecision({ cfg, message });

  const { ctxPayload } = buildIMessageInboundContext({
    cfg,
    decision,
    message,
    historyLimit: 0,
    groupHistories,
  });

  return ctxPayload;
}

describe("imessage monitor gating + envelope builders", () => {
  it("parseIMessageNotification rejects malformed payloads", () => {
    expect(
      parseIMessageNotification({
        message: { chat_id: 1, sender: { nested: "nope" } },
      }),
    ).toBeNull();
  });

  it("parseIMessageNotification preserves destination_caller_id metadata", () => {
    expect(
      parseIMessageNotification({
        message: {
          id: 1,
          sender: "+15550001111",
          destination_caller_id: "+15550002222",
          is_from_me: true,
          text: "hello",
        },
      }),
    ).toMatchObject({
      destination_caller_id: "+15550002222",
    });
  });

  it("drops group messages without mention by default", () => {
    const decision = resolve({
      message: {
        id: 1,
        chat_id: 99,
        sender: "+15550001111",
        is_from_me: false,
        text: "hello group",
        is_group: true,
      },
    });
    expect(decision.kind).toBe("drop");
    if (decision.kind !== "drop") {
      throw new Error("expected drop decision");
    }
    expect(decision.reason).toBe("no mention");
  });

  it("dispatches group messages with mention and builds a group envelope", () => {
    const cfg = baseCfg();
    const message: IMessagePayload = {
      id: 3,
      chat_id: 42,
      sender: "+15550002222",
      is_from_me: false,
      text: "@openclaw ping",
      is_group: true,
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    };
    const ctxPayload = buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload.ChatType).toBe("group");
    expect(ctxPayload.SessionKey).toBe("agent:main:imessage:group:42");
    expect(String(ctxPayload.Body ?? "")).toContain("+15550002222:");
    expect(String(ctxPayload.Body ?? "")).not.toContain("[from:");
    expect(ctxPayload.To).toBe("chat_id:42");
  });

  it("includes reply-to context fields + suffix", () => {
    const cfg = baseCfg();
    const message: IMessagePayload = {
      id: 5,
      chat_id: 55,
      sender: "+15550001111",
      is_from_me: false,
      text: "replying now",
      is_group: false,
      reply_to_id: 9001,
      reply_to_text: "original message",
      reply_to_sender: "+15559998888",
    };
    const ctxPayload = buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload.ReplyToId).toBe("9001");
    expect(ctxPayload.ReplyToBody).toBe("original message");
    expect(ctxPayload.ReplyToSender).toBe("+15559998888");
    expect(String(ctxPayload.Body ?? "")).toContain("[Replying to +15559998888 id:9001]");
    expect(String(ctxPayload.Body ?? "")).toContain("original message");
  });

  it("drops group reply context from non-allowlisted senders in allowlist mode", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "allowlist";
    cfg.channels.imessage.contextVisibility = "allowlist";

    const message: IMessagePayload = {
      id: 6,
      chat_id: 55,
      sender: "+15550001111",
      is_from_me: false,
      text: "@openclaw replying now",
      is_group: true,
      reply_to_id: 9001,
      reply_to_text: "blocked quote",
      reply_to_sender: "+15559998888",
    };
    const { decision, groupHistories } = resolveDispatchDecision({
      cfg,
      message,
      allowFrom: ["*"],
      groupAllowFrom: ["+15550001111"],
      groupPolicy: "allowlist",
    });
    const { ctxPayload } = buildIMessageInboundContext({
      cfg,
      decision,
      message,
      historyLimit: 0,
      groupHistories,
    });

    expect(ctxPayload.ReplyToId).toBeUndefined();
    expect(ctxPayload.ReplyToBody).toBeUndefined();
    expect(ctxPayload.ReplyToSender).toBeUndefined();
    expect(String(ctxPayload.Body ?? "")).not.toContain("[Replying to");
  });

  it("keeps group reply context in allowlist_quote mode", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "allowlist";
    cfg.channels.imessage.contextVisibility = "allowlist_quote";

    const message: IMessagePayload = {
      id: 7,
      chat_id: 55,
      sender: "+15550001111",
      is_from_me: false,
      text: "@openclaw replying now",
      is_group: true,
      reply_to_id: 9001,
      reply_to_text: "quoted context",
      reply_to_sender: "+15559998888",
    };
    const { decision, groupHistories } = resolveDispatchDecision({
      cfg,
      message,
      allowFrom: ["*"],
      groupAllowFrom: ["+15550001111"],
      groupPolicy: "allowlist",
    });
    const { ctxPayload } = buildIMessageInboundContext({
      cfg,
      decision,
      message,
      historyLimit: 0,
      groupHistories,
    });

    expect(ctxPayload.ReplyToId).toBe("9001");
    expect(ctxPayload.ReplyToBody).toBe("quoted context");
    expect(ctxPayload.ReplyToSender).toBe("+15559998888");
    expect(String(ctxPayload.Body ?? "")).toContain("[Replying to +15559998888 id:9001]");
  });

  it("treats configured chat_id as a group session even when is_group is false", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groups = { "2": { requireMention: false } };

    const groupHistories = new Map();
    const message: IMessagePayload = {
      id: 14,
      chat_id: 2,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello",
      is_group: false,
    };
    const { decision } = resolveDispatchDecision({ cfg, message, groupHistories });
    expect(decision.isGroup).toBe(true);
    expect(decision.route.sessionKey).toBe("agent:main:imessage:group:2");
  });

  it("allows group messages when requireMention is true but no mentionPatterns exist", () => {
    const cfg = baseCfg();
    cfg.messages ??= {};
    cfg.messages.groupChat ??= {};
    cfg.messages.groupChat.mentionPatterns = [];

    const groupHistories = new Map();
    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 12,
        chat_id: 777,
        sender: "+15550001111",
        is_from_me: false,
        text: "hello group",
        is_group: true,
      },
      opts: {},
      messageText: "hello group",
      bodyText: "hello group",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories,
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("blocks group messages when imessage.groups is set without a wildcard", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groups = { "99": { requireMention: false } };

    const groupHistories = new Map();
    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 13,
        chat_id: 123,
        sender: "+15550001111",
        is_from_me: false,
        text: "@openclaw hello",
        is_group: true,
      },
      opts: {},
      messageText: "@openclaw hello",
      bodyText: "@openclaw hello",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories,
    });
    expect(decision.kind).toBe("drop");
  });

  it("honors group allowlist and ignores pairing-store senders in groups", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "allowlist";

    const groupHistories = new Map();
    const denied = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 3,
        chat_id: 202,
        sender: "+15550003333",
        is_from_me: false,
        text: "@openclaw hi",
        is_group: true,
      },
      opts: {},
      messageText: "@openclaw hi",
      bodyText: "@openclaw hi",
      allowFrom: ["*"],
      groupAllowFrom: ["chat_id:101"],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
      storeAllowFrom: ["+15550003333"],
      historyLimit: 0,
      groupHistories,
    });
    expect(denied.kind).toBe("drop");

    const allowed = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 33,
        chat_id: 101,
        sender: "+15550003333",
        is_from_me: false,
        text: "@openclaw ok",
        is_group: true,
      },
      opts: {},
      messageText: "@openclaw ok",
      bodyText: "@openclaw ok",
      allowFrom: ["*"],
      groupAllowFrom: ["chat_id:101"],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
      storeAllowFrom: ["+15550003333"],
      historyLimit: 0,
      groupHistories,
    });
    expect(allowed.kind).toBe("dispatch");
  });

  it("blocks group messages when groupPolicy is disabled", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "disabled";

    const groupHistories = new Map();
    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 10,
        chat_id: 303,
        sender: "+15550003333",
        is_from_me: false,
        text: "@openclaw hi",
        is_group: true,
      },
      opts: {},
      messageText: "@openclaw hi",
      bodyText: "@openclaw hi",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "disabled",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories,
    });
    expect(decision.kind).toBe("drop");
  });
});

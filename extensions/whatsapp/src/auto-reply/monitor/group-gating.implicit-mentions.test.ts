// Whatsapp tests cover group gating implicit-mention policy behavior.
import { describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";

const SELF_E164 = "+15550000001";
const OTHER_E164 = "+15550000002";
const GROUP_ID = "group@g.us";

// A group message from another member, with no mention text, that quotes/replies to a
// message whose sender is the bot's own identity (the reply-to-bot / quoted_bot case).
function makeReplyToSelfMsg(accountId = "default"): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "m1", timestamp: 1700000000 },
    payload: { body: "thanks for that" },
    platform: {
      chatJid: GROUP_ID,
      recipientJid: SELF_E164,
      self: { e164: SELF_E164 },
      sender: { e164: OTHER_E164, name: "Alice" },
    },
    quote: {
      context: {
        id: "q1",
        body: "earlier bot message",
        sender: { e164: SELF_E164 },
      },
    },
    admission: {
      accountId,
      conversation: { kind: "group", id: GROUP_ID },
      sender: { id: OTHER_E164 },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
  } as never);
}

function makeParams(msg: AdmittedWebInboundMessage, cfg: unknown) {
  return {
    cfg,
    msg,
    groupHistoryKey: `whatsapp:group:${GROUP_ID}`,
    agentId: "main",
    sessionKey: `agent:main:whatsapp:group:${GROUP_ID}`,
    baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
    groupHistories: new Map<string, GroupHistoryEntry[]>(),
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn: vi.fn() },
  } as never;
}

const MENTION_CFG = { messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } } };

function whatsappCfg(whatsapp: Record<string, unknown>) {
  return { channels: { whatsapp: { groupPolicy: "open", ...whatsapp } }, ...MENTION_CFG };
}

describe("applyGroupGating implicit-mention policy", () => {
  it("admits a reply-to-bot message by default (quoted_bot implicit mention)", async () => {
    const res = await applyGroupGating(makeParams(makeReplyToSelfMsg(), whatsappCfg({})));
    expect(res.shouldProcess).toBe(true);
  });

  it("skips a reply-to-bot message when implicitMentions.quotedBot is false", async () => {
    const res = await applyGroupGating(
      makeParams(makeReplyToSelfMsg(), whatsappCfg({ implicitMentions: { quotedBot: false } })),
    );
    expect(res.shouldProcess).toBe(false);
  });

  it("inherits accounts.default.implicitMentions for a named account", async () => {
    // A named account ("work") must inherit accounts.default.implicitMentions the same
    // way WhatsApp inherits its other account fields.
    const res = await applyGroupGating(
      makeParams(
        makeReplyToSelfMsg("work"),
        whatsappCfg({
          accounts: { default: { implicitMentions: { quotedBot: false } }, work: {} },
        }),
      ),
    );
    expect(res.shouldProcess).toBe(false);
  });

  it("keeps accounts.default flags when a named account overrides a different flag", async () => {
    // accounts.work only overrides replyToBot; accounts.default.quotedBot:false must survive
    // (a partial named override must not clear sibling flags set on accounts.default).
    const res = await applyGroupGating(
      makeParams(
        makeReplyToSelfMsg("work"),
        whatsappCfg({
          accounts: {
            default: { implicitMentions: { quotedBot: false } },
            work: { implicitMentions: { replyToBot: false } },
          },
        }),
      ),
    );
    expect(res.shouldProcess).toBe(false);
  });
});

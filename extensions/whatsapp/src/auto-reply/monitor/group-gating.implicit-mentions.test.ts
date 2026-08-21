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
function makeReplyToSelfMsg(): AdmittedWebInboundMessage {
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
      accountId: "default",
      conversation: { kind: "group", id: GROUP_ID },
      sender: { id: OTHER_E164 },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
  } as never);
}

function makeParams(msg: AdmittedWebInboundMessage, implicitMentions?: { quotedBot?: boolean }) {
  return {
    cfg: {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          ...(implicitMentions ? { implicitMentions } : {}),
        },
      },
      messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
    },
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

describe("applyGroupGating implicit-mention policy", () => {
  it("admits a reply-to-bot message by default (quoted_bot implicit mention)", async () => {
    const res = await applyGroupGating(makeParams(makeReplyToSelfMsg()));
    expect(res.shouldProcess).toBe(true);
  });

  it("skips a reply-to-bot message when implicitMentions.quotedBot is false", async () => {
    const res = await applyGroupGating(makeParams(makeReplyToSelfMsg(), { quotedBot: false }));
    expect(res.shouldProcess).toBe(false);
  });
});

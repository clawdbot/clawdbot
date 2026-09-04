// Whatsapp tests cover group gating self-number mention fallback dispatch behavior.
import { describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";

const GROUP_JID = "120363401234567890@g.us";
const SELF_E164 = "+15551234567";

function makeGroupMsg(body: string): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: `msg-${body.slice(0, 12)}`, timestamp: 1700000000 },
    payload: { body },
    platform: {
      chatJid: GROUP_JID,
      recipientJid: SELF_E164,
      selfE164: SELF_E164,
      selfJid: "15551234567@s.whatsapp.net",
      sender: { e164: "+15550000002", name: "Alice" },
    },
    admission: {
      accountId: "default",
      conversation: { kind: "group", id: GROUP_JID },
      sender: { id: "+15550000002" },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
  });
}

type ApplyGroupGatingParams = Parameters<typeof applyGroupGating>[0];

function makeParams(msg: AdmittedWebInboundMessage) {
  return {
    cfg: {
      channels: { whatsapp: { groupPolicy: "open", groups: { "*": {} } } },
    } as never as ApplyGroupGatingParams["cfg"],
    msg,
    groupHistoryKey: `whatsapp:group:${GROUP_JID}`,
    agentId: "main",
    sessionKey: `agent:main:whatsapp:group:${GROUP_JID}`,
    // No configured mention patterns: the self-number fallback decides the outcome.
    baseMentionConfig: { mentionRegexes: [] } satisfies MentionConfig,
    groupHistories: new Map<string, GroupHistoryEntry[]>(),
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn: vi.fn() },
  };
}

describe("applyGroupGating self-number mention fallback", () => {
  it.each([
    ["+1 555 123 4567", "spaced with a leading plus"],
    ["+1 (555) 123-4567", "parenthesised and hyphenated"],
    ["1.555.123.4567", "dot separated"],
    ["15551234567", "contiguous digits"],
  ])("dispatches an agent turn when the body contains %s (%s)", async (body, _label) => {
    const msg = makeGroupMsg(`please call ${body} when free`);
    const result = await applyGroupGating(makeParams(msg));

    expect(result.shouldProcess).toBe(true);
    expect(msg.groupMention).toEqual({ wasMentioned: true, requireMention: true });
  });

  it("dispatches when the number sits on its own line", async () => {
    const msg = makeGroupMsg("call me\n+1 555 123 4567\nthanks");
    const result = await applyGroupGating(makeParams(msg));

    expect(result.shouldProcess).toBe(true);
    expect(msg.groupMention).toEqual({ wasMentioned: true, requireMention: true });
  });

  it.each([
    ["Meeting at 15:55, room 123, ext 4567", "digits spread across unrelated numbers"],
    ["invoice 9915551234567001 is overdue", "the number embedded in a longer number"],
    ["1555\n1234567", "two numbers split by a line break"],
    ["1555\r\n1234567", "two numbers split by a CRLF break"],
  ])("keeps the message as context without dispatching: %s (%s)", async (body, _label) => {
    const msg = makeGroupMsg(body);
    const result = await applyGroupGating(makeParams(msg));

    expect(result.shouldProcess).toBe(false);
    expect(msg.groupMention).toEqual({ wasMentioned: false, requireMention: true });
  });
});

// Whatsapp tests cover group gating.audio preflight plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import {
  createTestWebAudioInboundMessage,
  createTestWebInboundMessage,
} from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";

function makeGroupAudioMsg(): AdmittedWebInboundMessage {
  return createTestWebAudioInboundMessage({
    platform: {
      chatJid: "1203630@g.us",
      sender: { e164: "+15550000002", name: "Alice" },
    },
    admission: {
      conversation: {
        kind: "group",
        id: "1203630@g.us",
      },
      sender: {
        id: "+15550000002",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    wasMentioned: false,
  });
}

function makeParams(
  msg: AdmittedWebInboundMessage,
  groupHistories: Map<string, GroupHistoryEntry[]>,
) {
  return {
    cfg: {
      channels: {
        whatsapp: {
          groupPolicy: "open",
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
    } as never,
    msg,
    groupHistoryKey: "whatsapp:group:1203630",
    agentId: "main",
    sessionKey: "agent:main:whatsapp:group:1203630",
    baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
    groupHistories,
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn: vi.fn() },
  };
}

describe("applyGroupGating audio preflight mention text", () => {
  let groupHistories: Map<string, GroupHistoryEntry[]>;

  beforeEach(() => {
    groupHistories = new Map();
  });

  it("defers a missing mention without storing placeholder history", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      deferMissingMention: true,
    });

    expect(result).toEqual({ shouldProcess: false, needsMentionText: true });
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("accepts voice transcript text that satisfies mention gating", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "openclaw please summarize the thread",
    });

    expect(result).toEqual({ shouldProcess: true });
    expect(msg.groupMention).toEqual({ wasMentioned: true, requireMention: true });
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("carries always-on activation into dispatch", async () => {
    vi.mocked(resolveGroupActivationFor).mockResolvedValueOnce("always");
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating(makeParams(msg, groupHistories));

    expect(result).toEqual({ shouldProcess: true });
    expect(msg.groupMention).toEqual({ wasMentioned: false, requireMention: false });
  });

  it("stores transcript text instead of the audio placeholder when mention is still missing", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "please summarize the thread",
    });

    expect(result).toEqual({ shouldProcess: false });
    expect(groupHistories.get("whatsapp:group:1203630")).toEqual([
      {
        sender: "Alice (+15550000002)",
        body: "please summarize the thread",
        timestamp: 1700000000,
        id: "msg-1",
        senderJid: undefined,
      },
    ]);
  });

  it("stores a structured media fact for an unmentioned image", async () => {
    const msg = createTestWebInboundMessage({
      payload: {
        body: "",
        media: { path: "/tmp/image.jpg", type: "image/jpeg", kind: "image" },
      },
      platform: {
        chatJid: "1203630@g.us",
        sender: { e164: "+15550000002", name: "Alice" },
      },
      admission: {
        conversation: { kind: "group", id: "1203630@g.us" },
        sender: { id: "+15550000002" },
        senderAccess: { reasonCode: "group_policy_allowed" },
      },
      wasMentioned: false,
    });

    expect(await applyGroupGating(makeParams(msg, groupHistories))).toEqual({
      shouldProcess: false,
    });
    expect(groupHistories.get("whatsapp:group:1203630")?.[0]?.media).toEqual([
      {
        path: "/tmp/image.jpg",
        url: "/tmp/image.jpg",
        contentType: "image/jpeg",
        kind: "image",
      },
    ]);
  });
});

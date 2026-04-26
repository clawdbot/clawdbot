import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";

function makeGroupAudioMsg(): WebInboundMsg {
  return {
    id: "msg-1",
    from: "1203630@g.us",
    to: "+15550000001",
    body: "<media:audio>",
    chatId: "1203630@g.us",
    chatType: "group",
    conversationId: "1203630@g.us",
    mediaType: "audio/ogg; codecs=opus",
    mediaPath: "/tmp/voice.ogg",
    timestamp: 1700000000,
    accountId: "default",
    sender: { e164: "+15550000002", name: "Alice" },
  } as WebInboundMsg;
}

function makeParams(msg: WebInboundMsg, groupHistories: Map<string, GroupHistoryEntry[]>) {
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
    conversationId: "1203630@g.us",
    groupHistoryKey: "whatsapp:group:1203630",
    agentId: "main",
    sessionKey: "agent:main:whatsapp:group:1203630",
    baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
    groupHistories,
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn() },
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
    expect(msg.wasMentioned).toBe(true);
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("stores transcript text instead of the audio placeholder when mention is still missing", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "please summarize the thread",
    });

    expect(result).toEqual({ shouldProcess: false });
    expect(groupHistories.get("whatsapp:group:1203630")).toEqual([
      expect.objectContaining({
        body: "please summarize the thread",
      }),
    ]);
  });
});

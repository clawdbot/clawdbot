import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  classifyChannelInboundEvent,
  resolveUnmentionedGroupInboundPolicy,
} from "./classification.js";

describe("classifyChannelInboundEvent", () => {
  it("defaults inbound messages to user requests", () => {
    expect(classifyChannelInboundEvent({ conversation: { kind: "group" } })).toBe("user_request");
  });

  it("classifies unmentioned policy-enabled group messages as room events", () => {
    expect(
      classifyChannelInboundEvent({
        conversation: { kind: "group" },
        unmentionedGroupPolicy: "room_event",
      }),
    ).toBe("room_event");
  });

  it("keeps direct messages, mentions, commands, and aborts as user requests", () => {
    for (const params of [
      { conversation: { kind: "direct" as const } },
      { conversation: { kind: "group" as const }, wasMentioned: true },
      { conversation: { kind: "group" as const }, hasControlCommand: true },
      { conversation: { kind: "group" as const }, hasAbortRequest: true },
      { conversation: { kind: "group" as const }, commandSource: "native" as const },
    ]) {
      expect(
        classifyChannelInboundEvent({
          ...params,
          unmentionedGroupPolicy: "room_event",
        }),
      ).toBe("user_request");
    }
  });
});

describe("resolveUnmentionedGroupInboundPolicy", () => {
  it("lets agent group chat policy override the global default", () => {
    const cfg = {
      messages: { groupChat: { unmentionedInbound: "user_request" } },
      agents: {
        list: [
          {
            id: "room-agent",
            groupChat: { unmentionedInbound: "room_event" },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(resolveUnmentionedGroupInboundPolicy({ cfg, agentId: "room-agent" })).toBe("room_event");
    expect(resolveUnmentionedGroupInboundPolicy({ cfg, agentId: "other" })).toBe("user_request");
  });
});

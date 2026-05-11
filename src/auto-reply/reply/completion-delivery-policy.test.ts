import { describe, expect, it } from "vitest";
import {
  completionRequiresMessageToolDelivery,
  resolveCompletionChatType,
  shouldRouteCompletionThroughRequesterSession,
} from "./completion-delivery-policy.js";

describe("completion delivery policy", () => {
  it.each([
    {
      name: "canonical group key",
      requesterSessionKey: "agent:main:telegram:group:-100123",
      expected: "group",
    },
    {
      name: "canonical channel key",
      requesterSessionKey: "agent:main:slack:channel:C123",
      expected: "channel",
    },
    {
      name: "canonical direct key",
      requesterSessionKey: "agent:main:discord:dm:U123",
      expected: "direct",
    },
    {
      name: "legacy Discord guild channel key",
      requesterSessionKey: "agent:main:discord:guild-123:channel-456",
      expected: "channel",
    },
    {
      name: "legacy WhatsApp group key",
      requesterSessionKey: "agent:main:whatsapp:123@g.us",
      expected: "group",
    },
  ])("infers $name", ({ requesterSessionKey, expected }) => {
    expect(resolveCompletionChatType({ requesterSessionKey })).toBe(expected);
  });

  it("prefers explicit session chat type over key inference", () => {
    expect(
      resolveCompletionChatType({
        requesterSessionKey: "agent:main:slack:channel:C123",
        requesterEntry: { chatType: "direct" },
      }),
    ).toBe("direct");
  });

  it.each([
    { to: "group:ops", expected: "group" },
    { to: "channel:C123", expected: "channel" },
    { to: "thread:171.222", expected: "channel" },
    { to: "dm:U123", expected: "direct" },
    { to: "direct:U123", expected: "direct" },
    { to: "user:U123", expected: "direct" },
  ] as const)("falls back to origin target prefix $to", ({ to, expected }) => {
    expect(
      resolveCompletionChatType({
        requesterSessionKey: "agent:main:opaque:unknown-target",
        directOrigin: { channel: "test", to },
      }),
    ).toBe(expected);
  });

  it("requires message-tool delivery for group and channel completions by default", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:whatsapp:123@g.us",
      }),
    ).toBe(true);
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:discord:guild-123:channel-456",
      }),
    ).toBe(true);
  });

  it("honors automatic group visible-reply config", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
        requesterSessionKey: "agent:main:slack:channel:C123",
      }),
    ).toBe(false);
  });

  it("requires message-tool delivery for direct completions only when globally configured", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:discord:dm:U123",
      }),
    ).toBe(false);
    expect(
      completionRequiresMessageToolDelivery({
        cfg: { messages: { visibleReplies: "message_tool" } },
        requesterSessionKey: "agent:main:discord:dm:U123",
      }),
    ).toBe(true);
  });

  it("routes group and channel task completions through the requester session", () => {
    expect(shouldRouteCompletionThroughRequesterSession("agent:main:whatsapp:123@g.us")).toBe(true);
    expect(
      shouldRouteCompletionThroughRequesterSession("agent:main:discord:guild-123:channel-456"),
    ).toBe(true);
    expect(shouldRouteCompletionThroughRequesterSession("agent:main:discord:dm:U123")).toBe(false);
  });
});

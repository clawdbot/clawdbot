import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";

describe("resolveSlackMessageSubtypeHandler", () => {
  it("resolves message_changed metadata and identifiers", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "D1",
      event_ts: "123.456",
      message: { ts: "123.456", user: "U1" },
      previous_message: { ts: "123.450", user: "U2" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("message_changed");
    expect(handler?.resolveSenderId(event)).toBe("U1");
    expect(handler?.resolveChannelId(event)).toBe("D1");
    expect(handler?.resolveChannelType(event)).toBeUndefined();
    expect(handler?.contextKey(event)).toBe("slack:message:changed:D1:123.456");
    expect(handler?.describe("DM with @user")).toContain("edited");
  });

  it("resolves message_deleted metadata and identifiers", () => {
    const event = {
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      deleted_ts: "123.456",
      event_ts: "123.457",
      previous_message: { ts: "123.450", user: "U1" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("message_deleted");
    expect(handler?.resolveSenderId(event)).toBe("U1");
    expect(handler?.resolveChannelId(event)).toBe("C1");
    expect(handler?.resolveChannelType(event)).toBeUndefined();
    expect(handler?.contextKey(event)).toBe("slack:message:deleted:C1:123.456");
    expect(handler?.describe("general")).toContain("deleted");
  });

  it("resolves thread_broadcast metadata and identifiers", () => {
    const event = {
      type: "message",
      subtype: "thread_broadcast",
      channel: "C1",
      event_ts: "123.456",
      message: { ts: "123.456", user: "U1" },
      user: "U1",
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("thread_broadcast");
    expect(handler?.resolveSenderId(event)).toBe("U1");
    expect(handler?.resolveChannelId(event)).toBe("C1");
    expect(handler?.resolveChannelType(event)).toBeUndefined();
    expect(handler?.contextKey(event)).toBe("slack:thread:broadcast:C1:123.456");
    expect(handler?.describe("general")).toContain("broadcast");
  });

  it("returns undefined for regular messages", () => {
    const event = {
      type: "message",
      channel: "D1",
      user: "U1",
      text: "hello",
    } as unknown as SlackMessageEvent;
    expect(resolveSlackMessageSubtypeHandler(event)).toBeUndefined();
  });
});

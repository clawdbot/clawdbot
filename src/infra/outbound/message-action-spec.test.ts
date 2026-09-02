// Verifies message-action target requirements and alias detection, including
// plugin aliases only when non-standard params are present.
import { describe, expect, it, vi } from "vitest";
import {
  actionHasResourceReference,
  actionHasTarget,
  actionRequiresTarget,
  MESSAGE_ACTION_TARGET_MODE,
} from "./message-action-spec.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", async () => ({
  getBootstrapChannelPlugin: (
    await import("./message-action-runner.test-support.js")
  ).createPinboardMessageActionBootstrapRegistryMock(),
}));

describe("actionRequiresTarget", () => {
  it.each([
    ["send", true],
    ["channel-info", true],
    ["broadcast", false],
    ["search", false],
    ["conversation-open", false],
  ])("returns %s for %s", (action, expected) => {
    expect(actionRequiresTarget(action as never)).toBe(expected);
  });
});

describe("actionHasTarget", () => {
  it.each([
    { action: "send", params: { to: "  channel:C1  " }, expected: true },
    { action: "channel-info", params: { channelId: "  C123  " }, expected: true },
    { action: "send", params: { to: "   ", channelId: "" }, expected: false },
    {
      action: "read",
      params: { messageId: "msg_123" },
      ctx: { channel: "pinboard" },
      expected: true,
    },
    { action: "edit", params: { messageId: "  msg_123  " }, expected: true },
    {
      action: "pin",
      params: { messageId: "msg_123" },
      ctx: { channel: "pinboard" },
      expected: true,
    },
    {
      action: "unpin",
      params: { messageId: "msg_123" },
      ctx: { channel: "pinboard" },
      expected: true,
    },
    {
      action: "list-pins",
      params: { chatId: "oc_123" },
      ctx: { channel: "pinboard" },
      expected: true,
    },
    {
      action: "channel-info",
      params: { chatId: "oc_123" },
      ctx: { channel: "pinboard" },
      expected: true,
    },
    { action: "react", params: { chatGuid: "chat-guid" }, expected: true },
    { action: "react", params: { chatIdentifier: "chat-id" }, expected: true },
    { action: "react", params: { chatId: 42 }, expected: true },
    {
      action: "react",
      params: { messageId: "msg_123" },
      ctx: { channel: "imessage" },
      expected: true,
    },
    {
      action: "upload-file",
      params: { chatIdentifier: "chat-id" },
      ctx: { channel: "imessage" },
      expected: true,
    },
    { action: "read", params: { messageId: "msg_123" }, expected: false },
    {
      action: "pin",
      params: { messageId: "msg_123" },
      ctx: { channel: "workspace" },
      expected: false,
    },
    {
      action: "channel-info",
      params: { chatId: "oc_123" },
      ctx: { channel: "richchat" },
      expected: false,
    },
    { action: "edit", params: { messageId: "   " }, expected: false },
    { action: "react", params: { chatGuid: "" }, expected: false },
    { action: "react", params: { chatId: Number.NaN }, expected: false },
    { action: "react", params: { chatId: Number.POSITIVE_INFINITY }, expected: false },
    {
      action: "send",
      params: { messageId: "msg_123", chatId: 42 },
      expected: false,
    },
  ])("resolves target presence for %j", ({ action, params, ctx, expected }) => {
    expect(actionHasTarget(action as never, params, ctx)).toBe(expected);
  });
});

describe("actionHasResourceReference", () => {
  it.each([
    {
      action: "react" as const,
      params: { messageId: "msg_123" },
      channel: "imessage",
      expected: true,
    },
    {
      action: "poll-vote" as const,
      params: { pollId: "poll_123" },
      channel: "imessage",
      expected: true,
    },
    {
      action: "react" as const,
      params: { chatGuid: "iMessage;+;chat0000" },
      channel: "imessage",
      expected: false,
    },
    {
      action: "react" as const,
      params: { messageId: "msg_123" },
      channel: undefined,
      expected: false,
    },
    {
      action: "pin" as const,
      params: { messageId: "msg_123" },
      channel: "pinboard",
      expected: false,
    },
  ])("$action resource classification is $expected", ({ action, params, channel, expected }) => {
    expect(actionHasResourceReference(action, params, { channel })).toBe(expected);
  });
});

describe("MESSAGE_ACTION_TARGET_MODE coverage", () => {
  it("routes dice to the `to` field like other outbound sends", () => {
    expect(MESSAGE_ACTION_TARGET_MODE.dice).toBe("to");
    expect(actionRequiresTarget("dice")).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { actionHasTarget, actionRequiresTarget } from "./message-action-spec.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", async () => ({
  getBootstrapChannelPlugin: (
    await import("./message-action-test-fixtures.js")
  ).createPinboardMessageActionBootstrapRegistryMock(),
}));

describe("actionRequiresTarget", () => {
  it.each([
    ["send", true],
    ["channel-info", true],
    ["broadcast", false],
    ["search", false],
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

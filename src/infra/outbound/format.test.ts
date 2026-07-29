// Covers direct/gateway outbound summary formatting.
import { describe, expect, it, vi } from "vitest";
import { formatGatewaySummary, formatOutboundDeliverySummary } from "./format.js";

const getChannelPluginMock = vi.hoisted(() =>
  vi.fn((channel: string) => {
    const labels: Record<string, string> = {
      alpha: "Alpha",
      localchat: "Local Chat",
      richchat: "Rich Chat",
      workspace: "Workspace",
      teamchat: "Team Chat",
    };
    const label = labels[channel];
    return label ? { meta: { label } } : undefined;
  }),
);

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: getChannelPluginMock,
  getChannelPlugin: getChannelPluginMock,
}));
describe("formatOutboundDeliverySummary", () => {
  it.each([
    {
      channel: "alpha" as const,
      result: undefined,
      expected: "✅ Sent via Alpha. Message ID: unknown",
    },
    {
      channel: "localchat" as const,
      result: undefined,
      expected: "✅ Sent via Local Chat. Message ID: unknown",
    },
    {
      channel: "alpha" as const,
      result: {
        channel: "alpha" as const,
        messageId: "m1",
        chatId: "c1",
      },
      expected: "✅ Sent via Alpha. Message ID: m1 (chat c1)",
    },
    {
      channel: "richchat" as const,
      result: {
        channel: "richchat" as const,
        messageId: "d1",
        channelId: "chan",
      },
      expected: "✅ Sent via Rich Chat. Message ID: d1 (channel chan)",
    },
    {
      channel: "workspace" as const,
      result: {
        channel: "workspace" as const,
        messageId: "s1",
        roomId: "room-1",
      },
      expected: "✅ Sent via Workspace. Message ID: s1 (room room-1)",
    },
    {
      channel: "teamchat" as const,
      result: {
        channel: "teamchat" as const,
        messageId: "t1",
        conversationId: "conv-1",
      },
      expected: "✅ Sent via Team Chat. Message ID: t1 (conversation conv-1)",
    },
  ])("formats delivery summary for %j", ({ channel, result, expected }) => {
    expect(formatOutboundDeliverySummary(channel, result)).toBe(expected);
  });
});

describe("formatGatewaySummary", () => {
  it.each([
    {
      input: { channel: "directchat", messageId: "m1" },
      expected: "✅ Sent via gateway (directchat). Message ID: m1",
    },
    {
      input: { action: "Poll sent", channel: "richchat", messageId: "p1" },
      expected: "✅ Poll sent via gateway (richchat). Message ID: p1",
    },
    {
      input: {},
      expected: "✅ Sent via gateway. Message ID: unknown",
    },
  ])("formats gateway summary for %j", ({ input, expected }) => {
    expect(formatGatewaySummary(input)).toBe(expected);
  });
});

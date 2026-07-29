// Covers channel/target inference, legacy target rewrite, target validation,
// and plugin alias-aware message-action normalization.
import { describe, expect, it, vi } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", async () => ({
  getBootstrapChannelPlugin: (
    await import("./message-action-test-fixtures.js")
  ).createPinboardMessageActionBootstrapRegistryMock(),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (value: string) => ["workspace", "forum"].includes(value),
  normalizeMessageChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
}));

describe("normalizeMessageActionInput", () => {
  type NormalizeMessageActionInputCase = {
    input: Parameters<typeof normalizeMessageActionInput>[0];
    expectedFields?: Record<string, unknown>;
    absentFields?: string[];
  };

  it.each([
    {
      input: {
        action: "send",
        args: {
          target: "channel:C1",
          to: "legacy",
          channelId: "legacy-channel",
        },
      },
      expectedFields: { target: "channel:C1", to: "channel:C1" },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "send",
        args: {
          target: "1214056829",
          channelId: "",
          to: "   ",
        },
      },
      expectedFields: { target: "1214056829", to: "1214056829" },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "send",
        args: {
          to: "channel:C1",
        },
      },
      expectedFields: { target: "channel:C1", to: "channel:C1" },
    },
    {
      input: {
        action: "send",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
      expectedFields: { target: "channel:C1", to: "channel:C1" },
    },
    {
      input: {
        action: "send",
        args: {},
        toolContext: {
          currentChannelId: "user:U1",
          currentChannelProvider: "slack",
        },
      },
      expectedFields: { target: "user:U1", to: "user:U1" },
    },
    {
      input: {
        action: "send",
        args: {},
        toolContext: {
          currentMessagingTarget: "user:U1",
          currentChannelProvider: "slack",
        },
      },
      expectedFields: { target: "user:U1", to: "user:U1" },
    },
    {
      input: {
        action: "send",
        args: {
          target: "channel:C1",
        },
        toolContext: {
          currentChannelId: "C1",
          currentChannelProvider: "workspace",
        },
      },
      expectedFields: { channel: "workspace" },
    },
    {
      input: {
        action: "broadcast",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "send",
        args: {
          target: "channel:C1",
        },
        toolContext: {
          currentChannelProvider: "webchat",
        },
      },
      absentFields: ["channel"],
    },
    {
      input: {
        action: "edit",
        args: {
          messageId: "msg_123",
        },
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
      expectedFields: { messageId: "msg_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "react",
        args: {
          channel: "imessage",
          messageId: "msg_123",
        },
        toolContext: {
          currentChannelId: "chat_guid:iMessage;+;chat0000",
          currentChannelProvider: "imessage",
        },
      },
      expectedFields: {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        messageId: "msg_123",
      },
    },
    {
      input: {
        action: "edit",
        args: {
          channel: "imessage",
          messageId: "msg_123",
        },
        toolContext: {
          currentChannelId: "chat_guid:iMessage;+;chat0000",
          currentChannelProvider: "imessage",
        },
      },
      expectedFields: {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        messageId: "msg_123",
      },
    },
    {
      input: {
        action: "unsend",
        args: {
          channel: "imessage",
          messageId: "msg_123",
        },
        toolContext: {
          currentChannelId: "chat_guid:iMessage;+;chat0000",
          currentChannelProvider: "imessage",
        },
      },
      expectedFields: {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        messageId: "msg_123",
      },
    },
    {
      input: {
        action: "poll-vote",
        args: {
          channel: "imessage",
          pollId: "poll_123",
        },
        toolContext: {
          currentChannelId: "chat_guid:iMessage;+;chat0000",
          currentChannelProvider: "imessage",
        },
      },
      expectedFields: {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        pollId: "poll_123",
      },
    },
    {
      input: {
        action: "pin",
        args: {
          channel: "pinboard",
          messageId: "om_123",
        },
      },
      expectedFields: { messageId: "om_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "list-pins",
        args: {
          channel: "pinboard",
          chatId: "oc_123",
        },
      },
      expectedFields: { chatId: "oc_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "poll",
        args: {
          channel: "imessage",
          chatGuid: "iMessage;+;chat0000",
        },
      },
      expectedFields: {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        chatGuid: "iMessage;+;chat0000",
      },
    },
    {
      input: {
        action: "poll-vote",
        args: {
          channel: "imessage",
          chatId: 42,
        },
      },
      expectedFields: { target: "chat_id:42", to: "chat_id:42", chatId: 42 },
    },
    {
      input: {
        action: "read",
        args: {
          channel: "workspace",
          messageId: "123.456",
        },
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "workspace",
        },
      },
      expectedFields: { target: "C12345678", messageId: "123.456" },
    },
    {
      input: {
        action: "channel-info",
        args: {
          channelId: "C123",
        },
      },
      expectedFields: { target: "C123", channelId: "C123" },
      absentFields: ["to"],
    },
  ] satisfies NormalizeMessageActionInputCase[])(
    "normalizes message action input for %j",
    ({ input, expectedFields, absentFields }) => {
      const normalized = normalizeMessageActionInput(input);
      if (expectedFields) {
        for (const [field, value] of Object.entries(expectedFields)) {
          expect(normalized[field]).toBe(value);
        }
      }
      for (const field of absentFields ?? []) {
        expect(field in normalized).toBe(false);
      }
    },
  );

  it("throws when required target remains unresolved", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {},
      }),
    ).toThrow(/requires a target/);
  });

  it.each([
    { name: "a nonempty targets array", targets: ["C_TARGET"] },
    { name: "an empty targets array", targets: [] },
    { name: "a malformed targets value", targets: "C_TARGET" },
  ])("does not replace $name with the current conversation", ({ targets }) => {
    expect(() =>
      normalizeMessageActionInput({
        action: "read",
        args: { targets },
        toolContext: {
          currentChannelId: "C_CURRENT",
          currentChannelProvider: "workspace",
        },
      }),
    ).toThrow(/requires a target/);
  });

  it.each(["react", "edit", "delete"] as const)(
    "infers the exact current conversation for a provider-owned %s message resource",
    (action) => {
      expect(
        normalizeMessageActionInput({
          action,
          args: { channel: "forum", messageId: "901" },
          toolContext: {
            currentChannelProvider: "forum",
            currentChannelId: "-1001:topic:77",
          },
          targetAliasSpec: {
            aliases: ["messageId"],
            deliveryTargetAliases: [],
          },
        }),
      ).toMatchObject({
        channel: "forum",
        messageId: "901",
        target: "-1001:topic:77",
        to: "-1001:topic:77",
      });
    },
  );

  it.each([
    { action: "react" as const, args: { channel: "imessage", messageId: "msg_123" } },
    { action: "poll-vote" as const, args: { channel: "imessage", pollId: "poll_123" } },
  ])(
    "throws when $action has only a resource reference and no current target",
    ({ action, args }) => {
      expect(() =>
        normalizeMessageActionInput({
          action,
          args,
        }),
      ).toThrow(/requires a target/);
    },
  );

  it("rejects conflicting canonical and plugin delivery targets", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "poll-vote",
        args: {
          channel: "imessage",
          target: "chat_guid:iMessage;-;+15550001111",
          chatGuid: "iMessage;-;+15559998888",
        },
      }),
    ).toThrow(/conflicting target and delivery alias/);
  });
});

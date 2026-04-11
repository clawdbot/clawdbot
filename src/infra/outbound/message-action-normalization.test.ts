import { describe, expect, it, vi } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (channel: string) =>
    channel === "feishu"
      ? {
          actions: {
            messageActionTargetAliases: {
              read: { aliases: ["messageId"] },
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
              "list-pins": { aliases: ["chatId"] },
              "channel-info": { aliases: ["chatId"] },
            },
          },
        }
      : undefined,
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
        args: {
          target: "channel:C1",
        },
        toolContext: {
          currentChannelId: "C1",
          currentChannelProvider: "slack",
        },
      },
      expectedFields: { channel: "slack" },
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
        action: "pin",
        args: {
          channel: "feishu",
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
          channel: "feishu",
          chatId: "oc_123",
        },
      },
      expectedFields: { chatId: "oc_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "slack",
          messageId: "123.456",
        },
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "slack",
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
});

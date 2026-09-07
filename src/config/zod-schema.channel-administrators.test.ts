import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const grant = {
  channel: "discord",
  accountId: "operations",
  senderId: "123456789012345678",
  conversationId: "234567890123456789",
};

describe("channel administrator configuration", () => {
  it.each([undefined, {}])("does not add grants to existing commands config %j", (commands) => {
    const result = OpenClawSchema.safeParse({ commands });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands?.channelAdministrators).toBeUndefined();
    }
  });

  it.each([{ channelAdministrators: [] }, { channelAdministrators: [grant] }])(
    "preserves explicit grants without coercion: $channelAdministrators",
    ({ channelAdministrators }) => {
      const result = OpenClawSchema.safeParse({ commands: { channelAdministrators } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.commands?.channelAdministrators).toEqual(channelAdministrators);
      }
    },
  );

  it.each(["channel", "accountId", "senderId", "conversationId"] as const)(
    "requires the exact %s binding",
    (field) => {
      const incomplete: Record<string, unknown> = { ...grant };
      delete incomplete[field];
      const result = OpenClawSchema.safeParse({
        commands: { channelAdministrators: [incomplete] },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: ["commands", "channelAdministrators", 0, field] }),
          ]),
        );
      }
    },
  );

  it.each([
    { channel: "*" },
    { channel: "slack" },
    { channel: "Discord" },
    { channel: " discord " },
    { accountId: "" },
    { accountId: " " },
    { accountId: "*" },
    { accountId: "operations-*" },
    { accountId: "operations?" },
    { accountId: " operations" },
    { accountId: "operations " },
    { senderId: "" },
    { senderId: "*" },
    { senderId: "owner" },
    { senderId: "<@123456789012345678>" },
    { senderId: "discord:123456789012345678" },
    { senderId: "123456789012345678 " },
    { senderId: 123 },
    { conversationId: "" },
    { conversationId: "*" },
    { conversationId: "#operations" },
    { conversationId: "channel:234567890123456789" },
    { conversationId: " 234567890123456789" },
    { conversationId: 234 },
    { guildId: "345678901234567890" },
  ])("rejects ambiguous or unsupported grant %j", (override) => {
    expect(
      OpenClawSchema.safeParse({
        commands: { channelAdministrators: [{ ...grant, ...override }] },
      }).success,
    ).toBe(false);
  });
});

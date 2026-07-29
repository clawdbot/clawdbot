// Whatsapp tests cover provider-owned message action target declarations.
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

describe("WhatsApp message action targets", () => {
  it("declares chatJid as reaction delivery authority", () => {
    const aliasSpec = whatsappPlugin.actions?.messageActionTargetAliases?.react;

    expect(aliasSpec?.aliases).toEqual(["chatJid", "messageId"]);
    expect(aliasSpec?.deliveryTargetAliases).toEqual(["chatJid"]);
    expect(
      aliasSpec?.resolveDeliveryTarget?.({ args: { chatJid: "15551234567@s.whatsapp.net" } }),
    ).toBe("+15551234567");
    expect(
      aliasSpec?.resolveDeliveryTarget?.({ args: { chatJid: "whatsapp:12345-67890@g.us" } }),
    ).toBe("12345-67890@g.us");
    expect(
      aliasSpec?.resolveDeliveryTarget?.({ args: { chatJid: "invalid@jid" } }),
    ).toBeUndefined();
  });
});

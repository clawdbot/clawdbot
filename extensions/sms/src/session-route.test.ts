import { describe, expect, it } from "vitest";
import { smsPlugin } from "./channel.js";

describe("SMS outbound session routing", () => {
  it("classifies valid phone numbers as direct", () => {
    expect(smsPlugin.messaging?.inferTargetChatType?.({ to: "+1 (555) 123-4567" })).toBe("direct");
    expect(smsPlugin.messaging?.inferTargetChatType?.({ to: "not-a-phone" })).toBeUndefined();
  });

  it("uses the canonical inbound phone session", async () => {
    const route = await smsPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "sms:+1 (555) 123-4567",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:sms:direct:+15551234567",
      recipientSessionExact: true,
      peer: { kind: "direct", id: "+15551234567" },
      from: "sms:+15551234567",
      to: "sms:+15551234567",
    });
  });

  it("rejects invalid phone targets", async () => {
    const route = await smsPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "not-a-phone",
    });

    expect(route).toBeNull();
  });
});

// Whatsapp tests cover session route plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";

describe("resolveWhatsAppOutboundSessionRoute", () => {
  it("routes newsletter JIDs as channel sessions", () => {
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "120363401234567890@newsletter",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:whatsapp:channel:120363401234567890@newsletter",
      baseSessionKey: "agent:main:whatsapp:channel:120363401234567890@newsletter",
      recipientSessionExact: true,
      peer: {
        kind: "channel",
        id: "120363401234567890@newsletter",
      },
      chatType: "channel",
      from: "120363401234567890@newsletter",
      to: "120363401234567890@newsletter",
    });
  });

  it("keeps direct user targets on direct session semantics", () => {
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "+15551234567",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      baseSessionKey: "agent:main:whatsapp:direct:+15551234567",
      recipientSessionExact: true,
      peer: {
        kind: "direct",
        id: "+15551234567",
      },
      chatType: "direct",
      from: "+15551234567",
      to: "+15551234567",
    });
  });

  it("uses the inbound account suffix for named-account groups", () => {
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "work",
      target: "123@g.us",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work",
      baseSessionKey: "agent:main:whatsapp:group:123@g.us",
      recipientSessionExact: true,
    });
  });
});

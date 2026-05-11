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
      peer: {
        kind: "direct",
        id: "+15551234567",
      },
      chatType: "direct",
      from: "+15551234567",
      to: "+15551234567",
    });
  });
});

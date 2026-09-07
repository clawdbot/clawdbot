import { describe, expect, it } from "vitest";
import { signalPlugin } from "./channel.js";

describe("Signal outbound session routing", () => {
  it("rejects username aliases as canonical recipient sessions", async () => {
    const route = await signalPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "username:alice.01",
    });

    expect(route?.recipientSessionExact).toBe("direct-alias");
  });

  it("accepts canonical phone recipients", async () => {
    const route = await signalPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "+15551234567",
    });

    expect(route?.recipientSessionExact).toBe(true);
  });

  it("does not claim UUID recipients that inbound may canonicalize to a phone", async () => {
    const route = await signalPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    expect(route?.recipientSessionExact).toBe("direct-alias");
  });
});

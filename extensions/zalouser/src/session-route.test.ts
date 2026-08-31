import { describe, expect, it } from "vitest";
import { resolveZalouserOutboundSessionRoute } from "./session-route.js";

describe("resolveZalouserOutboundSessionRoute", () => {
  it("does not claim store-dependent DM migration routes as exact", () => {
    const route = resolveZalouserOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "user:u-123",
    });

    expect(route?.recipientSessionExact).toBe(false);
  });

  it("accepts canonical group routes", () => {
    const route = resolveZalouserOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "group:g-123",
    });

    expect(route?.recipientSessionExact).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { resolveZaloOutboundSessionRoute } from "./session-route.js";

describe("resolveZaloOutboundSessionRoute", () => {
  it("does not claim ambiguous bare chat ids as canonical sessions", () => {
    const route = resolveZaloOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "123456789",
    });

    expect(route?.recipientSessionExact).toBe(false);
  });

  it.each([
    ["user:123456789", "direct"],
    ["group:123456789", "group"],
  ] as const)("accepts explicit %s routes", (target, kind) => {
    const route = resolveZaloOutboundSessionRoute({ cfg: {}, agentId: "main", target });

    expect(route?.recipientSessionExact).toBe(true);
    expect(route?.peer).toEqual({ kind, id: "123456789" });
  });
});

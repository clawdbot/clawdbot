import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("gateway tailscale bind validation", () => {
  it("accepts loopback bind when tailscale serve/funnel is enabled", () => {
    const serveRes = validateConfigObject({
      gateway: {
        bind: "loopback",
        tailscale: { mode: "serve" },
      },
    });
    expect(serveRes.ok).toBe(true);

    const funnelRes = validateConfigObject({
      gateway: {
        bind: "loopback",
        tailscale: { mode: "funnel" },
      },
    });
    expect(funnelRes.ok).toBe(true);
  });

  it("accepts custom loopback bind host with tailscale serve/funnel", () => {
    const res = validateConfigObject({
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
        tailscale: { mode: "serve" },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects IPv6 custom bind host for tailscale serve/funnel", () => {
    const res = validateConfigObject({
      gateway: {
        bind: "custom",
        customBindHost: "::1",
        tailscale: { mode: "serve" },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((issue) => issue.path)).toContain("gateway.bind");
    }
  });

  it("rejects non-loopback bind when tailscale serve/funnel is enabled", () => {
    const lanRes = validateConfigObject({
      gateway: {
        bind: "lan",
        tailscale: { mode: "serve" },
      },
    });
    expect(lanRes.ok).toBe(false);
    if (!lanRes.ok) {
      expect(lanRes.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "gateway.bind",
            message: expect.stringContaining("gateway.bind must resolve to loopback"),
          }),
        ]),
      );
    }

    const customRes = validateConfigObject({
      gateway: {
        bind: "custom",
        customBindHost: "10.0.0.5",
        tailscale: { mode: "funnel" },
      },
    });
    expect(customRes.ok).toBe(false);
    if (!customRes.ok) {
      expect(customRes.issues.map((issue) => issue.path)).toContain("gateway.bind");
    }
  });
});

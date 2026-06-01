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

  it("validates Tailscale service names", () => {
    const validRes = validateConfigObject({
      gateway: {
        bind: "loopback",
        tailscale: { mode: "serve", serviceName: "svc:openclaw-gateway" },
      },
    });
    expect(validRes.ok).toBe(true);

    for (const serviceName of ["openclaw", "svc:", "svc:-openclaw", "svc:OpenClaw"]) {
      const res = validateConfigObject({
        gateway: {
          bind: "loopback",
          tailscale: { mode: "serve", serviceName },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues).toContainEqual({
          path: "gateway.tailscale.serviceName",
          message:
            'Tailscale serviceName must use the "svc:<dns-label>" format, for example "svc:openclaw"',
        });
      }
    }
  });

  it("rejects explicit no-auth when tailscale serve or funnel exposes the gateway", () => {
    const serveRes = validateConfigObject({
      gateway: {
        bind: "loopback",
        auth: { mode: "none" },
        tailscale: { mode: "serve" },
      },
    });
    expect(serveRes.ok).toBe(false);
    if (!serveRes.ok) {
      expect(serveRes.issues).toEqual([
        {
          path: "gateway.auth.mode",
          message:
            "gateway.auth.mode=none cannot be used with gateway.tailscale.mode=serve; configure token, password, or trusted-proxy auth before exposing the gateway through Tailscale",
        },
      ]);
    }

    const funnelRes = validateConfigObject({
      gateway: {
        bind: "loopback",
        auth: { mode: "none" },
        tailscale: { mode: "funnel" },
      },
    });
    expect(funnelRes.ok).toBe(false);
    if (!funnelRes.ok) {
      expect(funnelRes.issues).toEqual([
        {
          path: "gateway.auth.mode",
          message:
            "gateway.tailscale.mode=funnel requires gateway.auth.mode=password; auth.mode=none cannot be used when exposing the gateway through Tailscale Funnel",
        },
      ]);
    }
  });

  it("allows explicit no-auth for loopback-only gateway config", () => {
    const res = validateConfigObject({
      gateway: {
        bind: "loopback",
        auth: { mode: "none" },
        tailscale: { mode: "off" },
      },
    });
    expect(res.ok).toBe(true);
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
      expect(lanRes.issues).toEqual([
        {
          path: "gateway.bind",
          message:
            'gateway.bind must resolve to loopback when gateway.tailscale.mode=serve (use gateway.bind="loopback" or gateway.bind="custom" with gateway.customBindHost="127.0.0.1")',
        },
      ]);
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

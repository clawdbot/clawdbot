import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROXY_ATTRIBUTION_GUIDANCE,
  createGatewayUnattributableProxyReporter,
  markGatewayIngressTransport,
  prepareGatewayIngressAttribution,
} from "./ingress-attribution.js";

function request(params?: {
  remoteAddress?: string;
  forwardedFor?: string;
  funnel?: boolean;
  login?: string;
}): IncomingMessage {
  return {
    socket: { remoteAddress: params?.remoteAddress ?? "127.0.0.1" },
    headers: {
      ...(params?.forwardedFor
        ? {
            "x-forwarded-for": params.forwardedFor,
            "x-forwarded-proto": "https",
            "x-forwarded-host": "gateway.tailnet.ts.net",
          }
        : {}),
      ...(params?.funnel ? { "tailscale-funnel-request": "?1" } : {}),
      ...(params?.login ? { "tailscale-user-login": params.login } : {}),
    },
  } as IncomingMessage;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway ingress attribution", () => {
  it("keeps clean headerless loopback on the ordinary listener local", async () => {
    const attribution = prepareGatewayIngressAttribution({ req: request() });

    expect(attribution).toMatchObject({
      kind: "direct-local",
      rateLimit: { subject: { key: "127.0.0.1" }, resetOnSuccess: true },
    });
  });

  it("rejects proxy-shaped traffic on the ordinary listener", async () => {
    const attribution = prepareGatewayIngressAttribution({
      req: request({ forwardedFor: "100.64.0.10" }),
    });

    expect(attribution).toMatchObject({
      kind: "unattributable-proxy",
      reason: "proxy_attribution_required",
    });
  });

  it.each([
    ["Serve identity", { login: "alice@example.com" }, {}],
    ["Funnel marker", { funnel: true }, { externalTailscaleExposure: "funnel" }],
  ])(
    "attributes externally managed Tailscale %s as an ordinary trusted proxy",
    async (_name, headers, expected) => {
      const attribution = prepareGatewayIngressAttribution({
        req: request({ forwardedFor: "203.0.113.10", ...headers }),
        trustedProxies: ["127.0.0.1"],
      });

      expect(attribution).toMatchObject({
        kind: "trusted-proxy",
        clientIp: "203.0.113.10",
        rateLimit: { subject: { key: "203.0.113.10" } },
        ...expected,
      });
    },
  );

  it.each([
    ["missing", undefined],
    ["loopback", "127.0.0.1"],
  ])(
    "rejects trusted Tailscale headers with a %s forwarded client",
    async (_name, forwardedFor) => {
      const attribution = prepareGatewayIngressAttribution({
        req: request({ forwardedFor, login: "alice@example.com" }),
        trustedProxies: ["127.0.0.1"],
      });

      expect(attribution).toMatchObject({
        kind: "unattributable-proxy",
        reason: "proxy_attribution_required",
      });
    },
  );

  it("attributes managed Serve by listener provenance and verifies its identity lazily", async () => {
    const req = request({ forwardedFor: "100.64.0.10", login: "alice@example.com" });
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
    const tailscaleWhois = vi.fn(async () => ({
      login: "alice@example.com",
      name: "Alice",
    }));

    const attribution = prepareGatewayIngressAttribution({ req, tailscaleWhois });

    expect(attribution).toMatchObject({
      kind: "tailscale-serve",
      clientIp: "100.64.0.10",
      rateLimit: {
        subject: { key: "100.64.0.10" },
        resetOnSuccess: true,
      },
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
    if (attribution.kind !== "tailscale-serve") {
      throw new Error("expected Serve attribution");
    }
    await expect(attribution.verifyIdentity()).resolves.toMatchObject({
      login: "alice@example.com",
    });
    expect(tailscaleWhois).toHaveBeenCalledWith("100.64.0.10");
  });

  it("gives managed Funnel clients separate validated source buckets", async () => {
    const first = request({ forwardedFor: "203.0.113.10", funnel: true });
    const second = request({ forwardedFor: "203.0.113.11", funnel: true });
    markGatewayIngressTransport(first, { kind: "managed-tailscale", mode: "funnel" });
    markGatewayIngressTransport(second, { kind: "managed-tailscale", mode: "funnel" });

    const [firstAttribution, secondAttribution] = [
      prepareGatewayIngressAttribution({ req: first }),
      prepareGatewayIngressAttribution({ req: second }),
    ];

    expect(firstAttribution).toMatchObject({
      kind: "tailscale-funnel",
      rateLimit: { subject: { key: "203.0.113.10" } },
    });
    expect(secondAttribution).toMatchObject({
      kind: "tailscale-funnel",
      rateLimit: { subject: { key: "203.0.113.11" } },
    });
  });

  it("attributes unmarked tailnet traffic to the managed Funnel policy", async () => {
    const req = request({ forwardedFor: "100.64.0.10", login: "alice@example.com" });
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "funnel" });

    expect(prepareGatewayIngressAttribution({ req })).toMatchObject({
      kind: "tailscale-funnel",
      clientIp: "100.64.0.10",
    });
  });

  it("rejects an invalid marker on the managed Funnel listener", async () => {
    const req = request({ forwardedFor: "203.0.113.10" });
    req.headers["tailscale-funnel-request"] = "?0";
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "funnel" });

    expect(prepareGatewayIngressAttribution({ req })).toMatchObject({
      kind: "unattributable-proxy",
    });
  });

  it("reports distinct unattributable proxy sources while suppressing repeats", async () => {
    const warn = vi.fn();
    const report = createGatewayUnattributableProxyReporter({ warn });
    const first = prepareGatewayIngressAttribution({
      req: request({ remoteAddress: "192.0.2.10", forwardedFor: "100.64.0.10" }),
    });
    const second = prepareGatewayIngressAttribution({
      req: request({ remoteAddress: "192.0.2.11", forwardedFor: "100.64.0.11" }),
    });
    if (first.kind === "unattributable-proxy") {
      report(first);
      report(first);
    }
    if (second.kind === "unattributable-proxy") {
      report(second);
    }

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("192.0.2.10"),
      expect.stringContaining("192.0.2.11"),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gateway.trustedProxies"));
  });

  it("reports a continuing source again after the suppression window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.fn();
    const report = createGatewayUnattributableProxyReporter({ warn });
    const attribution = prepareGatewayIngressAttribution({
      req: request({ remoteAddress: "192.0.2.10", forwardedFor: "100.64.0.10" }),
    });
    if (attribution.kind !== "unattributable-proxy") {
      throw new Error("expected unattributable proxy");
    }

    report(attribution);
    vi.advanceTimersByTime(5 * 60_000);
    report(attribution);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("keeps a source suppressed when the aggregate budget refills beside it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.fn();
    const report = createGatewayUnattributableProxyReporter({ warn });
    const attribution = prepareGatewayIngressAttribution({
      req: request({ remoteAddress: "192.0.2.10", forwardedFor: "100.64.0.10" }),
    });
    if (attribution.kind !== "unattributable-proxy") {
      throw new Error("expected unattributable proxy");
    }

    // Warn this source one second before the aggregate budget refills.
    vi.setSystemTime(5 * 60_000 - 1_000);
    report(attribution);
    expect(warn).toHaveBeenCalledTimes(1);

    // The budget refills two seconds later; the source is still inside its own window.
    vi.setSystemTime(5 * 60_000 + 1_000);
    report(attribution);
    expect(warn).toHaveBeenCalledTimes(1);

    // It is reported again only once its own five minutes have elapsed.
    vi.setSystemTime(5 * 60_000 - 1_000 + 5 * 60_000);
    report(attribution);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not let continued traffic keep a source suppressed forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.fn();
    const report = createGatewayUnattributableProxyReporter({ warn });
    const attribution = prepareGatewayIngressAttribution({
      req: request({ remoteAddress: "192.0.2.10", forwardedFor: "100.64.0.10" }),
    });
    if (attribution.kind !== "unattributable-proxy") {
      throw new Error("expected unattributable proxy");
    }

    // A peer that never stops sending must not refresh its own suppression record.
    for (let minute = 0; minute <= 6; minute += 1) {
      vi.setSystemTime(minute * 60_000);
      report(attribution);
    }

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("bounds warnings from a flood of unique proxy sources", async () => {
    const warn = vi.fn();
    const report = createGatewayUnattributableProxyReporter({ warn });

    for (let index = 0; index < 1_000; index += 1) {
      report({
        kind: "unattributable-proxy",
        reason: "proxy_attribution_required",
        guidance: PROXY_ATTRIBUTION_GUIDANCE,
        remoteAddress: `192.0.2.${index}`,
      });
    }

    expect(warn).toHaveBeenCalledTimes(16);
  });
});

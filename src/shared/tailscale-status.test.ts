// Tailscale status tests cover status parsing and validation.
import { describe, expect, it, vi } from "vitest";
import {
  extractTailscaleServeGatewayUrls,
  inspectTailscaleServeGatewayUrlsWithRunner,
  resolveTailnetHostWithRunner,
  resolveTailscalePublishedHost,
  resolveTailscaleServeGatewayUrlsWithRunner,
} from "./tailscale-status.js";

describe("shared/tailscale-status", () => {
  it("keeps the deprecated named-Service formatter for shipped plugin SDK callers", () => {
    expect(
      resolveTailscalePublishedHost({
        tailscaleMode: "serve",
        tailnetHost: "node.tailnet.ts.net",
        serviceName: "svc:openclaw",
      }),
    ).toBe("openclaw.tailnet.ts.net");
  });

  it("returns null when no runner is provided", async () => {
    await expect(resolveTailnetHostWithRunner()).resolves.toBeNull();
  });

  it("prefers DNS names and trims trailing dots from status json", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'noise\n{"Self":{"DNSName":"mac.tail123.ts.net.","TailscaleIPs":["100.64.0.8"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("mac.tail123.ts.net");
    expect(run).toHaveBeenCalledWith(["tailscale", "status", "--json"], { timeoutMs: 5000 });
  });

  it("falls back across command candidates and then to the first tailscale ip", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("missing binary")).mockResolvedValueOnce({
      code: 0,
      stdout: '{"Self":{"TailscaleIPs":["100.64.0.9","fd7a::1"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.9");
    expect(run).toHaveBeenNthCalledWith(
      2,
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "status", "--json"],
      {
        timeoutMs: 5000,
      },
    );
  });

  it("falls back to the first tailscale ip when DNSName is blank", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '{"Self":{"DNSName":"","TailscaleIPs":["100.64.0.10","fd7a::2"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.10");
  });

  it("continues to later command candidates when earlier output has no usable host", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"Self":{}}' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"Self":{"DNSName":"backup.tail.ts.net."}}',
      });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("backup.tail.ts.net");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("continues when the first candidate returns success but malformed Self data", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"Self":"bad"}' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'prefix {"Self":{"TailscaleIPs":["100.64.0.11"]}} suffix',
      });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.11");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns null for non-zero exits, blank output, or invalid json", async () => {
    for (const result of [
      { code: null, stdout: "boom" },
      { code: 1, stdout: "boom" },
      { code: 0, stdout: "   " },
      { code: 0, stdout: "not-json" },
    ]) {
      const run = vi.fn().mockResolvedValue(result);
      await expect(resolveTailnetHostWithRunner(run)).resolves.toBeNull();
    }
  });

  it.each([
    "http://127.0.0.1:18789",
    "https://localhost:18789",
    "https+insecure://[::1]:18789/api",
    "localhost:18789",
    "18789",
  ])("discovers the shipped SDK proxy form %s without granting ownership", async (proxy) => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
        Web: {
          "mac.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:8096" } },
          },
          "mac.tail.ts.net:8443": {
            Handlers: { "/": { Proxy: proxy } },
          },
        },
      }),
    });

    await expect(resolveTailscaleServeGatewayUrlsWithRunner(18789, run)).resolves.toEqual([
      "wss://mac.tail.ts.net:8443",
    ]);
    expect(run).toHaveBeenCalledWith(["tailscale", "serve", "status", "--json"], {
      timeoutMs: 5000,
    });
  });

  it("ignores non-root, non-HTTPS, and non-loopback Serve handlers", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        TCP: { "80": { HTTP: true }, "443": { HTTPS: true } },
        Web: {
          "mac.tail.ts.net:80": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
          },
          "mac.tail.ts.net:443": {
            Handlers: { "/openclaw": { Proxy: "http://127.0.0.1:18789" } },
          },
          "other.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "http://192.168.1.20:18789" } },
          },
        },
      }),
    });

    await expect(resolveTailscaleServeGatewayUrlsWithRunner(18789, run)).resolves.toEqual([]);
  });

  it("ignores load-balanced Tailscale Services and public Funnel routes", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: {
          "mac.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
          },
        },
        AllowFunnel: { "mac.tail.ts.net:443": true },
        Services: {
          "svc:openclaw": {
            TCP: { "443": { HTTPS: true } },
            Web: {
              "openclaw.tail.ts.net:443": {
                Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
              },
            },
          },
        },
      }),
    });

    await expect(resolveTailscaleServeGatewayUrlsWithRunner(18789, run)).resolves.toEqual([]);
  });

  it.each([
    [443, "http://127.0.0.1:18789", true],
    [8443, "http://localhost:18789/", true],
    [8443, "http://127.0.0.1:8096", false],
    [443, "https://127.0.0.1:18789", false],
    [443, "http://127.0.0.1:18789/api", false],
    [443, "http://127.0.0.1:18789/?other", false],
    [443, "http://192.0.2.1:18789", false],
  ])("recognizes only an own root on HTTPS port %s targeting %s", (httpsPort, proxy, owned) => {
    const host = `fixture.tail.ts.net:${httpsPort}`;
    const raw = JSON.stringify({
      TCP: { [httpsPort]: { HTTPS: true } },
      Web: { [host]: { Handlers: { "/": { Proxy: proxy } } } },
      AllowFunnel: { [host]: true },
    });
    expect(extractTailscaleServeGatewayUrls(raw, 18789, true)).toEqual(
      owned ? [`wss://fixture.tail.ts.net${httpsPort === 443 ? "" : `:${httpsPort}`}`] : [],
    );
  });

  it.each([
    [443, 443, false],
    [8443, 8443, false],
    [443, 8443, true],
  ])(
    "requires HTTPS port %s to be exclusive across hostnames (sibling port %s)",
    (port, siblingPort, owned) => {
      const url = `wss://old.tail.ts.net${port === 443 ? "" : `:${port}`}`;
      const raw = JSON.stringify({
        TCP: { [port]: { HTTPS: true }, [siblingPort]: { HTTPS: true } },
        Web: {
          [`old.tail.ts.net:${port}`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } } },
          [`current.tail.ts.net:${siblingPort}`]: {
            Handlers: { "/": { Proxy: "http://127.0.0.1:8096" } },
          },
        },
      });
      expect(extractTailscaleServeGatewayUrls(raw, 18789, true)).toEqual(owned ? [url] : []);
      expect(extractTailscaleServeGatewayUrls(raw, 18789)).toEqual([url]);
    },
  );

  it("distinguishes malformed Serve status from an empty valid configuration", async () => {
    const malformed = vi.fn().mockResolvedValue({ code: 0, stdout: "not-json" });
    const empty = vi.fn().mockResolvedValue({ code: 0, stdout: "{}" });

    await expect(inspectTailscaleServeGatewayUrlsWithRunner(18789, malformed)).resolves.toEqual({
      status: "invalid",
    });
    await expect(inspectTailscaleServeGatewayUrlsWithRunner(18789, empty)).resolves.toEqual({
      status: "ok",
      urls: [],
    });
    await expect(resolveTailscaleServeGatewayUrlsWithRunner(18789, malformed)).resolves.toEqual([]);
  });
});

// Hosted plugin surface URL tests document forwarded-host/proto precedence for
// URLs exposed to plugin-hosted UI surfaces.
import { describe, expect, it } from "vitest";
import { resolveHostedPluginSurfaceUrl } from "./hosted-plugin-surface-url.js";

describe("resolveHostedPluginSurfaceUrl", () => {
  it("maps the default Gateway port to the public HTTPS port behind a proxy", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18789,
        requestHost: "10.0.0.2:18789",
        forwardedHost: "gateway.example.com",
        forwardedProto: "https",
      }),
    ).toBe("https://gateway.example.com:443");
  });

  it("prefers forwarded host over request host", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18900,
        requestHost: "10.0.0.2:18900",
        forwardedHost: "gateway.example.com",
        forwardedProto: "https",
      }),
    ).toBe("https://gateway.example.com:443");
  });

  it("keeps forwarded host ports when present", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18900,
        requestHost: "10.0.0.2:18900",
        forwardedHost: "gateway.example.com:9443",
        forwardedProto: "https",
      }),
    ).toBe("https://gateway.example.com:9443");
  });

  it("keeps a directly requested custom Gateway port", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18900,
        requestHost: "gateway.example.com:18900",
        scheme: "https",
      }),
    ).toBe("https://gateway.example.com:18900");
  });

  it("does not double-bracket IPv6 hosts from the Host header", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18789,
        requestHost: "[2606:4700::1111]:18789",
        scheme: "http",
      }),
    ).toBe("http://[2606:4700::1111]:18789");
  });

  it("does not double-bracket IPv6 hosts from forwarded headers", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18789,
        requestHost: "10.0.0.2:18789",
        forwardedHost: "[2606:4700::1111]:8443",
        forwardedProto: "https",
      }),
    ).toBe("https://[2606:4700::1111]:8443");
  });
});

// Hosted plugin surface URL tests document forwarded-host/proto precedence for
// URLs exposed to plugin-hosted UI surfaces.
import { describe, expect, it } from "vitest";
import {
  type HostedPluginSurfaceUrlParams,
  resolveHostedPluginSurfaceUrl,
} from "./hosted-plugin-surface-url.js";

describe("resolveHostedPluginSurfaceUrl", () => {
  it.each([
    {
      name: "maps the default Gateway port to the public HTTPS port behind a proxy",
      params: {
        port: 18789,
        requestHost: "10.0.0.2:18789",
        forwardedHost: "gateway.example.com",
        forwardedProto: "https",
      },
      expected: "https://gateway.example.com:443",
    },
    {
      name: "prefers forwarded host over request host",
      params: {
        port: 18900,
        requestHost: "10.0.0.2:18900",
        forwardedHost: "gateway.example.com",
        forwardedProto: "https",
      },
      expected: "https://gateway.example.com:443",
    },
    {
      name: "keeps forwarded host ports when present",
      params: {
        port: 18900,
        requestHost: "10.0.0.2:18900",
        forwardedHost: "gateway.example.com:9443",
        forwardedProto: "https",
      },
      expected: "https://gateway.example.com:9443",
    },
    {
      name: "keeps a directly requested custom Gateway port",
      params: {
        port: 18900,
        requestHost: "gateway.example.com:18900",
        scheme: "https",
      },
      expected: "https://gateway.example.com:18900",
    },
    {
      name: "keeps an IPv4 host and port",
      params: { port: 18900, requestHost: "192.0.2.1:18900" },
      expected: "http://192.0.2.1:18900",
    },
    {
      name: "keeps one bracket pair on a directly requested IPv6 host",
      params: { port: 18900, requestHost: "[2001:db8::1]:18900" },
      expected: "http://[2001:db8::1]:18900",
    },
    {
      name: "keeps one bracket pair on a forwarded IPv6 host and its explicit port",
      params: {
        port: 18900,
        requestHost: "192.0.2.1:18900",
        forwardedHost: "[2001:db8::1]:9443",
        forwardedProto: "https",
      },
      expected: "https://[2001:db8::1]:9443",
    },
    {
      name: "uses the default HTTP port for a directly requested IPv6 host without a port",
      params: { port: 18900, requestHost: "[2001:db8::1]" },
      expected: "http://[2001:db8::1]:80",
    },
    {
      name: "uses the default HTTPS port for a directly requested IPv6 host without a port",
      params: { port: 18900, requestHost: "[2001:db8::1]", scheme: "https" },
      expected: "https://[2001:db8::1]:443",
    },
    {
      name: "uses the default HTTPS port for a forwarded IPv6 host without a port",
      params: {
        port: 18900,
        requestHost: "192.0.2.1:18900",
        forwardedHost: ["[2001:db8::1], ignored.example.com"],
        forwardedProto: ["https"],
      },
      expected: "https://[2001:db8::1]:443",
    },
    {
      name: "adds brackets to a bare IPv6 socket address",
      params: { port: 18900, localAddress: "::1" },
      expected: "http://[::1]:18900",
    },
    {
      name: "adds brackets to a bare IPv6 override and keeps the configured port",
      params: {
        port: 18900,
        hostOverride: "2001:db8::2",
        forwardedHost: "[2001:db8::1]:9443",
        forwardedProto: "https",
      },
      expected: "https://[2001:db8::2]:18900",
    },
    {
      name: "keeps one bracket pair on an IPv6 override",
      params: { port: 18900, hostOverride: "[2001:db8::2]", scheme: "https" },
      expected: "https://[2001:db8::2]:18900",
    },
    {
      name: "preserves DNS override spelling",
      params: { port: 18900, hostOverride: "Gateway.Example.COM." },
      expected: "http://Gateway.Example.COM.:18900",
    },
  ] satisfies { name: string; params: HostedPluginSurfaceUrlParams; expected: string }[])(
    "$name",
    ({ params, expected }) => {
      const resolved = resolveHostedPluginSurfaceUrl(params);
      expect(resolved).toBe(expected);
      expect(new URL(resolved ?? "").origin).toBe(new URL(expected).origin);
    },
  );
});

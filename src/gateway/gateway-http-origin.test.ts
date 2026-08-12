import { describe, expect, it } from "vitest";
import { resolveLoopbackGatewayHttpOrigin } from "./gateway-http-origin.js";

describe("resolveLoopbackGatewayHttpOrigin", () => {
  it.each([
    {
      label: "IPv4 loopback",
      requestHost: "127.0.0.1:18789",
      encrypted: false,
      expected: "http://127.0.0.1:18789",
    },
    {
      label: "encrypted IPv6 loopback",
      requestHost: "[::1]:443",
      encrypted: true,
      expected: "https://[::1]",
    },
  ])(
    "derives the Gateway origin for a direct $label connection",
    ({ requestHost, encrypted, expected }) => {
      expect(resolveLoopbackGatewayHttpOrigin({ requestHost, directLocal: true, encrypted })).toBe(
        expected,
      );
    },
  );

  it.each([
    { label: "non-local connection", requestHost: "127.0.0.1:18789", directLocal: false },
    { label: "non-loopback host", requestHost: "gateway.example.test", directLocal: true },
    { label: "userinfo host", requestHost: "localhost@elsewhere.example", directLocal: true },
    { label: "path-bearing host", requestHost: "localhost:18789/not-a-host", directLocal: true },
  ])("rejects a $label", ({ requestHost, directLocal }) => {
    expect(
      resolveLoopbackGatewayHttpOrigin({
        requestHost,
        directLocal,
        encrypted: false,
      }),
    ).toBeUndefined();
  });
});

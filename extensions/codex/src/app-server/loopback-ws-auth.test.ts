// Regression tests: DNS hostname bypass of the remote-auth WS loopback boundary.
// Origin/main uses isLoopbackHost() from openclaw/plugin-sdk/ssrf-runtime in
// config-security.ts, which correctly rejects DNS hostnames via
// parseCanonicalIpAddress. These tests lock in the behavior against regression.
import { describe, expect, it } from "vitest";

// Import through config.ts (the stable re-export facade) which delegates
// to config-security.ts — the active authentication boundary.
const { assertCodexAppServerConnectionSecurity } = await import("./config.js");

describe("isLoopbackWebSocketUrl (via assertCodexAppServerConnectionSecurity)", () => {
  it("rejects DNS hostnames that start with 127.", () => {
    // DNS hostnames must NOT bypass the remote-auth boundary.
    // Origin/main uses isLoopbackHost → parseCanonicalIpAddress which
    // only accepts literal IPs — DNS hostnames are correctly rejected.
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://127.evil.com/app",
        authToken: undefined,
        headers: {},
      }),
    ).toThrow(/remote Codex app-server WebSocket URLs require/);
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "wss://127.example.com/codex",
        authToken: undefined,
        headers: {},
      }),
    ).toThrow(/remote Codex app-server WebSocket URLs require/);
  });

  it("rejects DNS hostnames with a 127-like subdomain", () => {
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "wss://ws.127.com/codex",
        authToken: undefined,
        headers: {},
      }),
    ).toThrow(/remote Codex app-server WebSocket URLs require/);
  });

  it("still classifies literal 127/8 IPv4 as loopback", () => {
    // Valid IPv4 loopback addresses must still skip auth.
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://127.0.0.1:3333/app",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://127.255.255.254/codex",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
  });

  it("still classifies localhost and ::1 as loopback", () => {
    // isLoopbackHost handles localhost at the parseHostForAddressChecks level.
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://localhost:3333/app",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://[::1]:3333/app",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
  });

  it("does not throw for non-WS transports (they are always local-loopback)", () => {
    // Non-websocket transports bypass the WS URL check entirely.
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "stdio",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
  });

  it("does not throw for remote WS with valid auth", () => {
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "wss://remote.example.com/codex",
        authToken: "secret",
        headers: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://remote.example.com/codex",
        headers: { authorization: "Bearer token" },
      }),
    ).not.toThrow();
  });
});

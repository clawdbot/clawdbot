// Browser tests cover CDP URL and error contracts.
import { describe, expect, it } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  parseBrowserHttpUrl,
} from "./cdp.helpers.js";
import {
  BrowserCdpEndpointBlockedError,
  BrowserValidationError,
  toBrowserErrorResponse,
} from "./errors.js";

describe("browser error mapping", () => {
  it("maps blocked browser targets to conflict responses", () => {
    const err = new Error(
      "Browser target is unavailable after SSRF policy blocked its navigation.",
    );
    err.name = "BlockedBrowserTargetError";

    expect(toBrowserErrorResponse(err)).toEqual({
      status: 409,
      message: "Browser target is unavailable after SSRF policy blocked its navigation.",
      reason: "navigation_blocked",
    });
  });

  it("preserves BrowserError mappings", () => {
    expect(toBrowserErrorResponse(new BrowserValidationError("bad input"))).toEqual({
      status: 400,
      message: "bad input",
    });
  });

  it("sanitizes navigation-target SSRF policy errors without leaking raw policy details", () => {
    expect(
      toBrowserErrorResponse(
        new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
      ),
    ).toEqual({
      status: 400,
      message: "browser navigation blocked by policy",
      reason: "navigation_blocked",
    });
  });

  it("maps CDP endpoint policy blocks to a distinct endpoint-scoped message", () => {
    expect(toBrowserErrorResponse(new BrowserCdpEndpointBlockedError())).toEqual({
      status: 400,
      message: "browser endpoint blocked by policy",
    });
  });
});

describe("isWebSocketUrl", () => {
  it("recognizes ws and wss URLs", () => {
    expect(isWebSocketUrl("ws://127.0.0.1:9222")).toBe(true);
    expect(isWebSocketUrl("ws://example.com/devtools/browser/ABC")).toBe(true);
    expect(isWebSocketUrl("wss://connect.example.com")).toBe(true);
    expect(isWebSocketUrl("wss://connect.example.com?apiKey=abc")).toBe(true);
  });

  it("rejects other protocols and invalid input", () => {
    expect(isWebSocketUrl("http://127.0.0.1:9222")).toBe(false);
    expect(isWebSocketUrl("https://production-sfo.browserless.io?token=abc")).toBe(false);
    expect(isWebSocketUrl("not-a-url")).toBe(false);
    expect(isWebSocketUrl("")).toBe(false);
    expect(isWebSocketUrl("ftp://example.com")).toBe(false);
  });
});

describe("isDirectCdpWebSocketEndpoint", () => {
  it("recognizes ws/wss URLs with a /devtools/<kind>/<id> path", () => {
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools/browser/ABC")).toBe(true);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools/page/42")).toBe(true);
    expect(isDirectCdpWebSocketEndpoint("wss://connect.example.com/devtools/browser/xyz")).toBe(
      true,
    );
    expect(
      isDirectCdpWebSocketEndpoint("wss://connect.example.com/devtools/browser/xyz?token=secret"),
    ).toBe(true);
  });

  it("rejects bare ws/wss URLs that need discovery", () => {
    // Reproduces the configuration shape reported in #68027.
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("wss://browserless.example")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("wss://browserless.example/?token=abc")).toBe(false);
  });

  it("rejects non-CDP paths, other protocols, and invalid input", () => {
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/json/version")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/devtools/")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("ws://127.0.0.1:9222/other/path")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("http://127.0.0.1:9222/devtools/browser/ABC")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("https://host/devtools/browser/ABC")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("not-a-url")).toBe(false);
    expect(isDirectCdpWebSocketEndpoint("")).toBe(false);
  });
});

describe("parseBrowserHttpUrl with WebSocket protocols", () => {
  it("applies default ports", () => {
    const secure = parseBrowserHttpUrl("wss://connect.example.com?apiKey=abc", "test");
    expect(secure.parsed.protocol).toBe("wss:");
    expect(secure.port).toBe(443);
    expect(secure.normalized).toContain("wss://connect.example.com");

    const insecure = parseBrowserHttpUrl("ws://127.0.0.1/devtools", "test");
    expect(insecure.parsed.protocol).toBe("ws:");
    expect(insecure.port).toBe(80);
  });

  it("preserves explicit and HTTP ports", () => {
    expect(parseBrowserHttpUrl("wss://connect.example.com:8443/path", "test").port).toBe(8443);
    expect(parseBrowserHttpUrl("http://127.0.0.1:9222", "test").port).toBe(9222);
    expect(parseBrowserHttpUrl("https://browserless.example?token=abc", "test").port).toBe(443);
  });

  it("rejects unsupported protocols", () => {
    expect(() => parseBrowserHttpUrl("ftp://example.com", "test")).toThrow(
      "must be http(s) or ws(s)",
    );
    expect(() => parseBrowserHttpUrl("file:///etc/passwd", "test")).toThrow(
      "must be http(s) or ws(s)",
    );
  });
});

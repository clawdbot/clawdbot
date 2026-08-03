import { describe, expect, it } from "vitest";
import { hasHttpUrlPrefix, isHttpsUrl, isHttpUrl, isWebSocketUrl } from "./url-protocol.js";

describe("hasHttpUrlPrefix", () => {
  it.each([
    ["http://example.com", true],
    ["HTTPS://user:pass@example.com:8443/path", true],
    ["https://", true],
    [" https://example.com", false],
    ["//example.com", false],
    ["example.com", false],
    ["wss://example.com", false],
  ])("classifies %j", (value, expected) => {
    expect(hasHttpUrlPrefix(value)).toBe(expected);
  });
});

describe("parsed URL protocol predicates", () => {
  it.each([
    ["http://example.com", true, false, false],
    ["HTTPS://user:pass@example.com:8443/path", true, true, false],
    ["ws://example.com", false, false, true],
    ["WSS://example.com:9443/socket", false, false, true],
    ["file:///tmp/example", false, false, false],
  ])("classifies %s", (value, http, https, websocket) => {
    const url = new URL(value);
    expect(isHttpUrl(url)).toBe(http);
    expect(isHttpsUrl(url)).toBe(https);
    expect(isWebSocketUrl(url)).toBe(websocket);
  });

  it("returns false for malformed and relative strings", () => {
    expect(isHttpUrl("https://")).toBe(false);
    expect(isHttpsUrl("/relative")).toBe(false);
    expect(isWebSocketUrl("not a URL")).toBe(false);
  });

  it("parses string inputs without changing URL constructor behavior", () => {
    expect(isHttpUrl("  HTTP://user:pass@example.com:8080/path  ")).toBe(true);
    expect(isHttpsUrl(" HTTPS://example.com ")).toBe(true);
    expect(isWebSocketUrl(" WSS://example.com:9443/socket ")).toBe(true);
  });
});

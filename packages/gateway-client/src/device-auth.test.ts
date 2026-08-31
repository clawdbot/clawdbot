// Tests for device auth payload builders and metadata normalization.
import { describe, expect, it } from "vitest";
import {
  buildDeviceAuthPayload,
  buildDeviceAuthPayloadV3,
  normalizeDeviceMetadataForAuth,
} from "./device-auth.js";

describe("normalizeDeviceMetadataForAuth", () => {
  it("returns empty string for undefined", () => {
    expect(normalizeDeviceMetadataForAuth(undefined)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(normalizeDeviceMetadataForAuth(null)).toBe("");
  });

  it("returns empty string for number", () => {
    expect(normalizeDeviceMetadataForAuth(123 as never)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeDeviceMetadataForAuth("")).toBe("");
  });

  it("returns empty string for whitespace-only string", () => {
    expect(normalizeDeviceMetadataForAuth("   ")).toBe("");
  });

  it("trims whitespace", () => {
    expect(normalizeDeviceMetadataForAuth("  value  ")).toBe("value");
  });

  it("lowercases uppercase letters", () => {
    expect(normalizeDeviceMetadataForAuth("HelloWorld")).toBe("helloworld");
  });

  it("preserves lowercase letters", () => {
    expect(normalizeDeviceMetadataForAuth("alreadylowercase")).toBe("alreadylowercase");
  });

  it("preserves digits and symbols", () => {
    expect(normalizeDeviceMetadataForAuth("iOS_17.1")).toBe("ios_17.1");
  });

  it("handles mixed content", () => {
    expect(normalizeDeviceMetadataForAuth("macOS-Silicon")).toBe("macos-silicon");
  });
});

describe("buildDeviceAuthPayload", () => {
  it("builds v2 payload with all fields", () => {
    const payload = buildDeviceAuthPayload({
      deviceId: "dev-123",
      clientId: "client-456",
      clientMode: "mode-a",
      role: "admin",
      scopes: ["read", "write"],
      signedAtMs: 1234567890,
      token: "secret-token",
      nonce: "abc123",
    });
    expect(payload).toBe("v2|dev-123|client-456|mode-a|admin|read,write|1234567890|secret-token|abc123");
  });

  it("handles empty token as empty string", () => {
    const payload = buildDeviceAuthPayload({
      deviceId: "dev-1",
      clientId: "cli-1",
      clientMode: "m",
      role: "r",
      scopes: ["s"],
      signedAtMs: 0,
      token: undefined,
      nonce: "n",
    });
    expect(payload).toBe("v2|dev-1|cli-1|m|r|s|0||n");
  });

  it("handles null token as empty string", () => {
    const payload = buildDeviceAuthPayload({
      deviceId: "dev-1",
      clientId: "cli-1",
      clientMode: "m",
      role: "r",
      scopes: ["s"],
      signedAtMs: 0,
      token: null,
      nonce: "n",
    });
    expect(payload).toBe("v2|dev-1|cli-1|m|r|s|0||n");
  });

  it("handles single scope", () => {
    const payload = buildDeviceAuthPayload({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["only"],
      signedAtMs: 1,
      token: "t",
      nonce: "n",
    });
    expect(payload).toBe("v2|d|c|m|r|only|1|t|n");
  });

  it("handles empty scopes array", () => {
    const payload = buildDeviceAuthPayload({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: [],
      signedAtMs: 1,
      token: "t",
      nonce: "n",
    });
    expect(payload).toBe("v2|d|c|m|r||1|t|n");
  });
});

describe("buildDeviceAuthPayloadV3", () => {
  it("builds v3 payload with platform and deviceFamily", () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: "dev-123",
      clientId: "client-456",
      clientMode: "mode-a",
      role: "admin",
      scopes: ["read", "write"],
      signedAtMs: 1234567890,
      token: "secret-token",
      nonce: "abc123",
      platform: "iOS",
      deviceFamily: "iPhone",
    });
    expect(payload).toBe(
      "v3|dev-123|client-456|mode-a|admin|read,write|1234567890|secret-token|abc123|ios|iphone",
    );
  });

  it("normalizes platform and deviceFamily to lowercase", () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["s"],
      signedAtMs: 0,
      nonce: "n",
      platform: "macOS",
      deviceFamily: "MacBookPro",
    });
    expect(payload).toBe("v3|d|c|m|r|s|0||n|macos|macbookpro");
  });

  it("handles undefined platform and deviceFamily", () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["s"],
      signedAtMs: 0,
      nonce: "n",
    });
    expect(payload).toBe("v3|d|c|m|r|s|0||n||");
  });

  it("handles null platform and deviceFamily", () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["s"],
      signedAtMs: 0,
      nonce: "n",
      platform: null,
      deviceFamily: null,
    });
    expect(payload).toBe("v3|d|c|m|r|s|0||n||");
  });

  it("trims platform and deviceFamily before lowercasing", () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["s"],
      signedAtMs: 0,
      nonce: "n",
      platform: "  iOS  ",
      deviceFamily: "  iPad  ",
    });
    expect(payload).toBe("v3|d|c|m|r|s|0||n|ios|ipad");
  });
});

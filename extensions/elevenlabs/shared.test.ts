import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELEVENLABS_BASE_URL,
  normalizeElevenLabsBaseUrl,
  normalizeElevenLabsRealtimeBaseUrl,
} from "./shared.js";

describe("normalizeElevenLabsBaseUrl", () => {
  it("returns the default when the base URL is missing or blank", () => {
    expect(normalizeElevenLabsBaseUrl(undefined)).toBe(DEFAULT_ELEVENLABS_BASE_URL);
    expect(normalizeElevenLabsBaseUrl("   ")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("trims and strips trailing slashes from a valid URL", () => {
    expect(normalizeElevenLabsBaseUrl("  https://custom.example.com/  ")).toBe(
      "https://custom.example.com",
    );
    expect(normalizeElevenLabsBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("rejects an explicit malformed override instead of silently retargeting", () => {
    // An operator's explicit endpoint must not be swapped for the default; fail
    // actionably here so the request cannot target an unintended host, and so a
    // downstream `new URL(...)` never throws an opaque TypeError.
    expect(() => normalizeElevenLabsBaseUrl("not a url")).toThrow(/Invalid ElevenLabs baseUrl/);
    expect(() => normalizeElevenLabsBaseUrl("////")).toThrow(/Invalid ElevenLabs baseUrl/);
  });

  it("rejects a parseable but unsupported (non-HTTP(S)) scheme", () => {
    // `new URL()` accepts ftp:/data:/custom schemes, but downstream fetch and
    // WebSocket paths only support http(s) ElevenLabs endpoints.
    expect(() => normalizeElevenLabsBaseUrl("ftp://files.example.com")).toThrow(
      /unsupported scheme/,
    );
    expect(() => normalizeElevenLabsBaseUrl("data:text/plain,x")).toThrow(/unsupported scheme/);
  });

  it("does not leak URL credentials or sensitive query values in validation errors", () => {
    // Rejection errors may reach logs/diagnostics; they must not echo userinfo
    // or credential-bearing query parameters from the configured baseUrl.
    const nonHttp = "ftp://user:sup3r-secret@files.example.com/x?api_key=leak-me";
    expect(() => normalizeElevenLabsBaseUrl(nonHttp)).toThrow(/unsupported scheme/);
    try {
      normalizeElevenLabsBaseUrl(nonHttp);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("sup3r-secret");
      expect(message).not.toContain("leak-me");
      expect(message).not.toContain("api_key");
    }
    // A malformed value that embeds a token must not be echoed either.
    const malformed = "http://:not a url token=abcd1234secret";
    try {
      normalizeElevenLabsBaseUrl(malformed);
    } catch (error) {
      expect((error as Error).message).not.toContain("abcd1234secret");
    }
  });

  it("keeps every accepted result parseable as an http(s) URL", () => {
    for (const input of ["https://ok.example.com/", "http://a.b:9000"]) {
      const normalized = normalizeElevenLabsBaseUrl(input);
      const url = new URL(normalized);
      expect(["http:", "https:"]).toContain(url.protocol);
    }
  });

  it("maps HTTP endpoints and preserves explicit WebSocket endpoints for realtime", () => {
    expect(normalizeElevenLabsRealtimeBaseUrl("https://api.example.com/")).toBe(
      "wss://api.example.com",
    );
    expect(normalizeElevenLabsRealtimeBaseUrl("wss://realtime.example.com/")).toBe(
      "wss://realtime.example.com",
    );
    expect(normalizeElevenLabsRealtimeBaseUrl("ws://localhost:8080/")).toBe("ws://localhost:8080");
  });
});

import { describe, expect, it } from "vitest";
import { isRefreshTokenReusedError } from "./oauth.js";

// Direct tests for the refresh_token_reused classifier. This is the gate that
// triggers the retry/adoption recovery path; a false negative here means we
// fail over to an expensive model instead of adopting the winner's fresh
// token.

describe("isRefreshTokenReusedError", () => {
  describe("positive cases", () => {
    it("detects the canonical OAuth snake_case code", () => {
      expect(isRefreshTokenReusedError(new Error("refresh_token_reused"))).toBe(true);
    });

    it("detects mixed-case variants", () => {
      expect(isRefreshTokenReusedError(new Error("REFRESH_TOKEN_REUSED"))).toBe(true);
      expect(isRefreshTokenReusedError(new Error("Refresh_Token_Reused"))).toBe(true);
    });

    it("detects OpenAI-style natural-language variants", () => {
      expect(
        isRefreshTokenReusedError(
          new Error("Your refresh token has already been used to generate a new access token."),
        ),
      ).toBe(true);
      expect(
        isRefreshTokenReusedError(
          new Error("The refresh token has already been used to generate a new access token."),
        ),
      ).toBe(true);
    });

    it("detects full JSON-wrapped 401 payloads", () => {
      expect(
        isRefreshTokenReusedError(
          new Error(
            '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","type":"invalid_request_error","code":"refresh_token_reused"}}',
          ),
        ),
      ).toBe(true);
    });

    it("detects when message is a plain string (non-Error throw)", () => {
      expect(isRefreshTokenReusedError("refresh_token_reused")).toBe(true);
    });

    it("detects when message is wrapped via Error.cause (single level)", () => {
      // formatErrorMessage traverses the .cause chain and concatenates
      // messages with " | ", so a marker hidden in the cause still counts.
      const inner = new Error("refresh_token_reused");
      const outer = new Error("OAuth token refresh failed", { cause: inner });
      expect(isRefreshTokenReusedError(outer)).toBe(true);
    });

    it("detects when message is wrapped in a multi-level cause chain", () => {
      const root = new Error("already been used to generate a new access token");
      const mid = new Error("plugin adapter failure", { cause: root });
      const outer = new Error("OAuth token refresh failed", { cause: mid });
      expect(isRefreshTokenReusedError(outer)).toBe(true);
    });

    it("detects when cause is a bare string (no Error wrapper)", () => {
      const outer = new Error("upstream", { cause: "refresh_token_reused" });
      expect(isRefreshTokenReusedError(outer)).toBe(true);
    });

    it("still matches when the marker phrase is embedded in a longer message", () => {
      expect(
        isRefreshTokenReusedError(
          new Error("auth failed: already been used to generate a new access token (retry)"),
        ),
      ).toBe(true);
    });
  });

  describe("negative cases", () => {
    it("returns false for unrelated auth errors", () => {
      expect(isRefreshTokenReusedError(new Error("invalid_grant"))).toBe(false);
      expect(isRefreshTokenReusedError(new Error("HTTP 500 Internal Server Error"))).toBe(false);
      expect(isRefreshTokenReusedError(new Error("network timeout"))).toBe(false);
      expect(isRefreshTokenReusedError(new Error("expired or revoked"))).toBe(false);
    });

    it("returns false for null/undefined/non-stringable values", () => {
      expect(isRefreshTokenReusedError(null)).toBe(false);
      expect(isRefreshTokenReusedError(undefined)).toBe(false);
      expect(isRefreshTokenReusedError(42)).toBe(false);
      expect(isRefreshTokenReusedError({})).toBe(false);
    });

    it("returns false for an empty error message", () => {
      expect(isRefreshTokenReusedError(new Error(""))).toBe(false);
    });
  });

  describe("fuzz: random noisy messages", () => {
    function makeSeededRandom(seed: number): () => number {
      let t = seed >>> 0;
      return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = t;
        r = Math.imul(r ^ (r >>> 15), r | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
    }

    function randomJunk(rng: () => number, maxLen: number): string {
      const len = Math.floor(rng() * maxLen);
      const chars: string[] = [];
      for (let i = 0; i < len; i += 1) {
        chars.push(String.fromCodePoint(32 + Math.floor(rng() * 95)));
      }
      return chars.join("");
    }

    function randomlyCased(s: string, rng: () => number): string {
      return s
        .split("")
        .map((c) => (rng() < 0.5 ? c.toUpperCase() : c.toLowerCase()))
        .join("");
    }

    it("always detects the marker when embedded at random positions with noise", () => {
      const rng = makeSeededRandom(0xabad1dea);
      const markers = [
        "refresh_token_reused",
        "Your refresh token has already been used to generate a new access token",
        "already been used to generate a new access token",
      ];
      for (let i = 0; i < 500; i += 1) {
        const marker = randomlyCased(markers[i % markers.length], rng);
        const prefix = randomJunk(rng, 64);
        const suffix = randomJunk(rng, 64);
        const msg = `${prefix}${marker}${suffix}`;
        expect(isRefreshTokenReusedError(new Error(msg))).toBe(true);
        // Same for plain-string throws.
        expect(isRefreshTokenReusedError(msg)).toBe(true);
      }
    });

    it("never yields a false positive on marker-free random messages", () => {
      const rng = makeSeededRandom(0x1337_beef);
      for (let i = 0; i < 500; i += 1) {
        // Bound length so we never randomly emit one of the marker substrings.
        const msg = randomJunk(rng, 32);
        if (
          msg.toLowerCase().includes("refresh_token_reused") ||
          msg.toLowerCase().includes("refresh token has already been used") ||
          msg.toLowerCase().includes("already been used to generate a new access token")
        ) {
          // Extremely unlikely with 32-char random junk; skip if it happens.
          continue;
        }
        expect(isRefreshTokenReusedError(new Error(msg))).toBe(false);
      }
    });
  });
});

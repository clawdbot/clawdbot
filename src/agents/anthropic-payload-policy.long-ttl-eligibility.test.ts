// Verifies that OpenRouter is treated as long-TTL-eligible for Anthropic
// `cache_control` markers, so users routing Anthropic models through
// OpenRouter can reach the 1-hour cache TTL via env-driven defaults the same
// way `api.anthropic.com` does (see openclaw#9600).
import "./ai-transport-runtime-host.js";
import { resolveAnthropicEphemeralCacheControl } from "@openclaw/ai/transports";
import { afterEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = process.env.OPENCLAW_CACHE_RETENTION;

function restoreEnv(): void {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.OPENCLAW_CACHE_RETENTION;
  } else {
    process.env.OPENCLAW_CACHE_RETENTION = ORIGINAL_ENV;
  }
}

describe("resolveAnthropicEphemeralCacheControl — long-TTL endpoint eligibility", () => {
  afterEach(restoreEnv);

  it("emits a 1-hour cache_control marker when cacheRetention='long' is explicitly set on OpenRouter", () => {
    const result = resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", "long");
    expect(result).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("emits a 1-hour cache_control marker when OPENCLAW_CACHE_RETENTION=long env is set on OpenRouter", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const result = resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", undefined);
    expect(result).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("emits a short (5-minute) cache_control marker when cacheRetention='short' on OpenRouter", () => {
    const result = resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", "short");
    expect(result).toEqual({ type: "ephemeral" });
  });

  it("still returns undefined for cacheRetention='none' on OpenRouter", () => {
    const result = resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", "none");
    expect(result).toBeUndefined();
  });

  it("emits a 1-hour cache_control marker on api.anthropic.com (regression guard)", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const result = resolveAnthropicEphemeralCacheControl("https://api.anthropic.com", undefined);
    expect(result).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does NOT emit a 1-hour TTL for unknown hosts when only env is set", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const result = resolveAnthropicEphemeralCacheControl("https://example.com/v1", undefined);
    // Unknown host should fall back to the short marker (no ttl field).
    expect(result).toEqual({ type: "ephemeral" });
  });

  it("still honors explicit cacheRetention='long' on unknown hosts (custom Anthropic-compatible proxies)", () => {
    const result = resolveAnthropicEphemeralCacheControl(
      "https://custom-anthropic-proxy.example.com",
      "long",
    );
    expect(result).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  // The OpenRouter stream wrapper treats `provider: "openrouter"` with no
  // `baseUrl` as a verified default route. It signals that fact via the
  // `longTtlEligibleRoute` argument so the default route is not stuck on the
  // 5-minute marker under env-driven long retention.
  it("emits a 1-hour marker on the verified OpenRouter default route (baseUrl undefined) when env long is set", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const result = resolveAnthropicEphemeralCacheControl(undefined, undefined, true);
    expect(result).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("emits a 1-hour marker on a verified OpenRouter route when cacheRetention='long' and baseUrl undefined", () => {
    const result = resolveAnthropicEphemeralCacheControl(undefined, "long", true);
    expect(result).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does NOT emit a 1-hour marker on an unverified default route (baseUrl undefined) when only env long is set", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const result = resolveAnthropicEphemeralCacheControl(undefined, undefined, false);
    // Default (non-OpenRouter) route stays conservative on env-driven long retention.
    expect(result).toEqual({ type: "ephemeral" });
  });

  it("still returns undefined for cacheRetention='none' even on a verified long-TTL route", () => {
    const result = resolveAnthropicEphemeralCacheControl(undefined, "none", true);
    expect(result).toBeUndefined();
  });
});

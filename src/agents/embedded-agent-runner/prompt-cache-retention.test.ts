// Coverage for prompt-cache retention resolution by provider and model API.
import { describe, expect, it } from "vitest";
import { isGooglePromptCacheEligible, resolveCacheRetention } from "./prompt-cache-retention.js";

describe("prompt cache retention", () => {
  it("passes explicit cacheRetention through for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "google",
        "google-generative-ai",
        "gemini-3.1-pro-preview",
      ),
    ).toBe("long");
  });

  it("maps legacy cacheControlTtl for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "5m" },
        "google",
        "google-generative-ai",
        "gemini-2.5-flash",
      ),
    ).toBe("short");
  });

  it("does not default cacheRetention for direct Google models without explicit config", () => {
    expect(
      resolveCacheRetention(undefined, "google", "google-generative-ai", "gemini-3.1-pro-preview"),
    ).toBeUndefined();
  });

  it("passes explicit cacheRetention through for openai-completions providers when supportsPromptCacheKey (issue #81281)", () => {
    // Regression: prefix-caching OpenAI-compatible backends opt in with
    // supportsPromptCacheKey, so explicit user retention must pass through.
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "omlx-local",
        "openai-completions",
        "local_model",
        true,
      ),
    ).toBe("long");
    expect(
      resolveCacheRetention(
        { cacheRetention: "short" },
        "omlx-local",
        "openai-completions",
        "local_model",
        true,
      ),
    ).toBe("short");
    expect(
      resolveCacheRetention(
        { cacheRetention: "none" },
        "omlx-local",
        "openai-completions",
        "local_model",
        true,
      ),
    ).toBe("none");
  });

  it("keeps undocumented cacheRetention values outside the Bedrock runtime contract", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "standard" },
        "amazon-bedrock",
        "openai-completions",
        "us.anthropic.claude-sonnet-4-6",
      ),
    ).toBeUndefined();
  });

  it("does not honor explicit cacheRetention for openai-completions without supportsPromptCacheKey", () => {
    // Providers that route via openai-completions but do not advertise prompt
    // caching must keep retention out of outgoing payloads.
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "amazon.nova-micro-v1:0",
      ),
    ).toBeUndefined();
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "omlx-local",
        "openai-completions",
        "local_model",
        false,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for openai-completions without explicit cacheRetention", () => {
    // Without an explicit user choice, openai-completions providers fall back
    // to the transport-level default ("short") rather than receiving a
    // wrapper-injected value.
    expect(
      resolveCacheRetention(undefined, "omlx-local", "openai-completions", "local_model", true),
    ).toBeUndefined();
    expect(
      resolveCacheRetention({}, "omlx-local", "openai-completions", "local_model", true),
    ).toBeUndefined();
  });

  it("does not map legacy cacheControlTtl for openai-completions prompt-cache-key providers", () => {
    // Legacy TTL aliases were Anthropic/Google semantics; OpenAI-compatible
    // completions providers need an explicit cacheRetention value before the
    // wrapper forwards retention to the transport.
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "1h" },
        "omlx-local",
        "openai-completions",
        "local_model",
        true,
      ),
    ).toBeUndefined();
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "5m" },
        "omlx-local",
        "openai-completions",
        "local_model",
        true,
      ),
    ).toBeUndefined();
  });

  it("identifies supported direct Google cache families", () => {
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      }),
    ).toBe(true);
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-2.5-flash",
      }),
    ).toBe(true);
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-live-2.5-flash-preview",
      }),
    ).toBe(false);
  });
});

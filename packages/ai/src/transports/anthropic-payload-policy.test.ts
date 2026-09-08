import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  applyAnthropicPayloadPolicyToParams,
  isAnthropicServerToolClearingEnabled,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicEphemeralCacheControl,
  resolveAnthropicServerCompactionPlan,
} from "./anthropic-payload-policy.js";

describe("resolveAnthropicEphemeralCacheControl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "https://aiplatform.googleapis.com",
    "https://us-east5-aiplatform.googleapis.com",
    "https://aiplatform.us.rep.googleapis.com",
    "https://aiplatform.eu.rep.googleapis.com",
  ])("preserves env-configured long retention for the official %s endpoint", (baseUrl) => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

    expect(resolveAnthropicEphemeralCacheControl(baseUrl, undefined)).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("keeps env-configured long retention restricted for custom proxy endpoints", () => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

    expect(
      resolveAnthropicEphemeralCacheControl("https://proxy.example.test/vertex", undefined),
    ).toEqual({ type: "ephemeral" });
  });

  it("preserves explicitly configured long retention for custom proxy endpoints", () => {
    expect(
      resolveAnthropicEphemeralCacheControl("https://proxy.example.test/vertex", "long"),
    ).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  describe("OpenRouter long-TTL eligibility", () => {
    it("emits a 1-hour cache_control marker when cacheRetention='long' is explicitly set on OpenRouter", () => {
      expect(resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", "long")).toEqual(
        {
          type: "ephemeral",
          ttl: "1h",
        },
      );
    });

    it("emits a 1-hour cache_control marker when OPENCLAW_CACHE_RETENTION=long env is set on OpenRouter", () => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
      expect(
        resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", undefined),
      ).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    });

    it("emits a short (5-minute) cache_control marker when cacheRetention='short' on OpenRouter", () => {
      expect(
        resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", "short"),
      ).toEqual({
        type: "ephemeral",
      });
    });

    it("still returns undefined for cacheRetention='none' on OpenRouter", () => {
      expect(
        resolveAnthropicEphemeralCacheControl("https://openrouter.ai/api/v1", "none"),
      ).toBeUndefined();
    });

    it("emits a 1-hour cache_control marker on api.anthropic.com (regression guard)", () => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
      expect(resolveAnthropicEphemeralCacheControl("https://api.anthropic.com", undefined)).toEqual(
        {
          type: "ephemeral",
          ttl: "1h",
        },
      );
    });

    it("does NOT emit a 1-hour TTL for unknown hosts when only env is set", () => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
      // Unknown host keeps the short marker at the resolver layer (no ttl field).
      expect(resolveAnthropicEphemeralCacheControl("https://example.com/v1", undefined)).toEqual({
        type: "ephemeral",
      });
    });

    it("still honors explicit cacheRetention='long' on unknown hosts (custom Anthropic-compatible proxies)", () => {
      expect(
        resolveAnthropicEphemeralCacheControl("https://custom-anthropic-proxy.example.com", "long"),
      ).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    // The OpenRouter stream wrapper treats `provider: "openrouter"` with no
    // `baseUrl` as a verified default route. It signals that fact via the
    // `longTtlEligibleRoute` argument so the default route is not stuck on the
    // 5-minute marker under env-driven long retention.
    it("emits a 1-hour marker on the verified OpenRouter default route (baseUrl undefined) when env long is set", () => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
      expect(resolveAnthropicEphemeralCacheControl(undefined, undefined, true)).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    });

    it("emits a 1-hour marker on a verified OpenRouter route when cacheRetention='long' and baseUrl undefined", () => {
      expect(resolveAnthropicEphemeralCacheControl(undefined, "long", true)).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    });

    it("does NOT emit a 1-hour marker on an unverified default route (baseUrl undefined) when only env long is set", () => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
      // Default (non-OpenRouter) route stays conservative on env-driven long retention.
      expect(resolveAnthropicEphemeralCacheControl(undefined, undefined, false)).toEqual({
        type: "ephemeral",
      });
    });

    it("still returns undefined for cacheRetention='none' even on a verified long-TTL route", () => {
      expect(resolveAnthropicEphemeralCacheControl(undefined, "none", true)).toBeUndefined();
    });
  });
});

describe("Anthropic compaction authentication eligibility", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };
  const extraParams = { anthropicServerCompaction: true };

  it("rejects OAuth credentials without changing config-only threshold planning", () => {
    expect(resolveAnthropicServerCompactionPlan(model, extraParams)).toEqual({
      enabled: true,
      threshold: 140_000,
    });
    expect(resolveAnthropicServerCompactionPlan(model, extraParams, "test-api-key")).toEqual({
      enabled: true,
      threshold: 140_000,
    });
    expect(
      resolveAnthropicServerCompactionPlan(model, extraParams, "test-sk-ant-oat-fixture"),
    ).toEqual({ enabled: false });
  });

  it("uses the same host-resolved credential shape as the transport", () => {
    const host = getAiTransportHost();
    configureAiTransportHost({ ...host, resolveSecretSentinel: () => "test-sk-ant-oat-fixture" });
    try {
      expect(
        resolveAnthropicServerCompactionPlan(model, extraParams, "credential-sentinel"),
      ).toEqual({ enabled: false });
    } finally {
      configureAiTransportHost(host);
    }
  });
});

describe("Anthropic tool-clearing policy", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };

  it.each([undefined, "", "  "])(
    "requires resolved authentication before disabling client pruning: %j",
    (apiKey) => {
      expect(isAnthropicServerToolClearingEnabled(model, apiKey)).toBe(false);
    },
  );

  it.each([
    { tools: { allow: ["look*"] }, excluded: ["exec_retired", "other_retired", "search"] },
    {
      tools: { allow: ["look*"], deny: ["exec*"] },
      excluded: ["exec_retired", "other_retired", "search"],
    },
    { tools: { deny: ["exec*"] }, excluded: ["exec_retired"] },
  ])("applies pruning filters to exposed and historical tools: $tools", ({ tools, excluded }) => {
    const payload: Record<string, unknown> = {
      tools: [{ name: "lookup" }, { name: "search" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "old_exec", name: "exec_retired", input: {} },
            { type: "tool_use", id: "old_other", name: "other_retired", input: {} },
            { type: "tool_use", id: "old_lookup", name: "lookup_retired", input: {} },
          ],
        },
      ],
    };
    const policy = resolveAnthropicPayloadPolicy({
      ...model,
      cacheTtlPruning: { tools },
    });
    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());
    expect(payload.context_management).toEqual({
      edits: [
        expect.objectContaining({
          type: "clear_tool_uses_20250919",
          exclude_tools: excluded,
        }),
      ],
    });
  });
});

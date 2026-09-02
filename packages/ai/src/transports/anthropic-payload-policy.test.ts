import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
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

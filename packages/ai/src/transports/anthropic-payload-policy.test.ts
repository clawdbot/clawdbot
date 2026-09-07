import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  partitionAnthropicRuntimeContextCarriers,
  resolveAnthropicEphemeralCacheControl,
  resolveAnthropicServerCompactionPlan,
} from "./anthropic-payload-policy.js";

describe("partitionAnthropicRuntimeContextCarriers", () => {
  it("splits carriers out of the messages array and returns their text in order", () => {
    const stable = { role: "user", content: "stable question" };
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const carrierString = {
      role: "user",
      content: "volatile metadata",
      runtimeContextCarrier: true,
    };
    const carrierBlocks = {
      role: "user",
      content: [
        { type: "text", text: "more " },
        { type: "image", source: {} },
        { type: "text", text: "context" },
      ],
      runtimeContextCarrier: true,
    };
    const { messages, carrierTexts } = partitionAnthropicRuntimeContextCarriers([
      stable,
      carrierString,
      assistant,
      carrierBlocks,
    ]);
    // Non-carrier messages (including assistant turns) are preserved in order.
    expect(messages).toEqual([stable, assistant]);
    // Text is extracted (images dropped, text blocks concatenated) in order.
    expect(carrierTexts).toEqual(["volatile metadata", "more context"]);
  });

  it("ignores an assistant message even if it is mislabeled as a carrier", () => {
    const carrierAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "nope" }],
      runtimeContextCarrier: true,
    };
    const { messages, carrierTexts } = partitionAnthropicRuntimeContextCarriers([carrierAssistant]);
    expect(messages).toEqual([carrierAssistant]);
    expect(carrierTexts).toEqual([]);
  });

  it("drops whitespace-only carriers", () => {
    const { messages, carrierTexts } = partitionAnthropicRuntimeContextCarriers([
      { role: "user", content: "   ", runtimeContextCarrier: true },
    ]);
    expect(messages).toEqual([]);
    expect(carrierTexts).toEqual([]);
  });
});

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

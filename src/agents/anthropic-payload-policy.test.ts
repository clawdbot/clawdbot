import { describe, expect, it } from "vitest";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

type TestPayload = {
  messages: Array<{ role: string; content: unknown }>;
  service_tier?: string;
  system?: unknown;
};

function textBlock(text: string, cache_control?: { type: "ephemeral"; ttl?: "1h" }) {
  return {
    type: "text",
    text,
    ...(cache_control ? { cache_control } : {}),
  };
}

function boundarySystemPayload(): TestPayload {
  return {
    system: [
      {
        type: "text",
        text: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
      },
    ],
    messages: [{ role: "user", content: "Hello" }],
  };
}

function simpleTextPayload(): TestPayload {
  return {
    system: [{ type: "text", text: "Follow policy." }],
    messages: [{ role: "user", content: "Hello" }],
  };
}

function expectShortEphemeralTextPayload(payload: TestPayload) {
  expect(payload.system).toEqual([textBlock("Follow policy.", { type: "ephemeral" })]);
  expect(payload.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
  });
}

describe("anthropic payload policy", () => {
  it("tags the last TWO user turns so consecutive requests can chain the cache", () => {
    // Anthropic reads cache only at the CURRENT request breakpoint positions.
    // With a single trailing breakpoint, turn N+1 has no breakpoint at turn
    // N's write position, the lookup misses, and the whole history re-writes
    // every turn even when the rendered bytes are identical (measured live:
    // byte-equal system + fingerprint-equal history and still a full ~31.5k
    // 1h cache write per turn). The penultimate user turn must carry a
    // marker too, so the previous turn's entry is reachable.
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [{ type: "text", text: "Follow policy." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "First ask" }] },
        { role: "assistant", content: [{ type: "text", text: "First reply" }] },
        { role: "user", content: [{ type: "text", text: "Second ask" }] },
        { role: "assistant", content: [{ type: "text", text: "Second reply" }] },
        { role: "user", content: [{ type: "text", text: "Third ask" }] },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    const marker = { type: "ephemeral", ttl: "1h" };
    // Oldest user turn stays unmarked: two message breakpoints + system stay
    // within Anthropic's four-breakpoint budget.
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "First ask" }],
    });
    expect(payload.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Second ask", cache_control: marker }],
    });
    expect(payload.messages[4]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Third ask", cache_control: marker }],
    });
    // Assistant turns are never marked.
    expect(payload.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "First reply" }],
    });
  });

  it("applies native Anthropic service tier and cache markers without widening cache scope", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
      serviceTier: "standard_only",
    });
    const payload: TestPayload = {
      system: [
        { type: "text", text: "Follow policy." },
        { type: "text", text: "Use tools carefully." },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Working." }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_result", tool_use_id: "tool_1", content: "done" },
          ],
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.service_tier).toBe("standard_only");
    expect(payload.system).toEqual([
      textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" }),
      textBlock("Use tools carefully.", { type: "ephemeral", ttl: "1h" }),
    ]);
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Working." }],
    });
    expect(payload.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "done",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    });
  });

  it("denies proxied Anthropic service tier but honors explicit long TTL for custom hosts", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "long",
      enableCacheControl: true,
      serviceTier: "auto",
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload).not.toHaveProperty("service_tier");
    expect(payload.system).toEqual([textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" })]);
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
  });

  it("keeps implicit env-driven long retention conservative for custom hosts", () => {
    const previous = process.env.OPENCLAW_CACHE_RETENTION;
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    try {
      const policy = resolveAnthropicPayloadPolicy({
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://proxy.example.com/anthropic",
        enableCacheControl: true,
      });
      const payload = simpleTextPayload();

      applyAnthropicPayloadPolicyToParams(payload, policy);

      expectShortEphemeralTextPayload(payload);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_CACHE_RETENTION;
      } else {
        process.env.OPENCLAW_CACHE_RETENTION = previous;
      }
    }
  });

  it("keeps explicit short retention unchanged for custom hosts", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expectShortEphemeralTextPayload(payload);
  });

  it("splits cached stable system content from uncached dynamic content", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const payload = boundarySystemPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      textBlock("Stable prefix", { type: "ephemeral", ttl: "1h" }),
      textBlock("Dynamic lab suffix"),
    ]);
  });

  it("applies 1h TTL for Vertex AI endpoints with long cache retention", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic-vertex",
      api: "anthropic-messages",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [
        { type: "text", text: "Follow policy." },
        { type: "text", text: "Use tools carefully." },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" }),
      textBlock("Use tools carefully.", { type: "ephemeral", ttl: "1h" }),
    ]);
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
  });

  it("applies 5m ephemeral cache for Vertex AI endpoints with short cache retention", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic-vertex",
      api: "anthropic-messages",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([textBlock("Follow policy.", { type: "ephemeral" })]);
  });

  it("strips the boundary even when cache retention is disabled", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "none",
      enableCacheControl: true,
    });
    const payload = boundarySystemPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([textBlock("Stable prefix\nDynamic lab suffix")]);
  });
});

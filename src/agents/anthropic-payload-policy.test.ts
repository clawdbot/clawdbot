import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import "./ai-transport-runtime-host.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "@openclaw/ai/transports";
/**
 * Tests Anthropic payload policy mutation.
 * Covers service tier, cache-control retention, prompt cache boundaries, and
 * deprecated marker compatibility.
 */
import { describe, expect, it } from "vitest";

type TestPayload = {
  messages: Array<{ role: string; content: unknown }>;
  service_tier?: string;
  system?: unknown;
  tools?: unknown;
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

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

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
        { type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } },
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "done",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    });
  });

  it("anchors the cache marker on the last stable user turn, skipping a trailing runtime-context carrier", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const stableUser = { role: "user", content: [{ type: "text", text: "stable question" }] };
    const carrier = { role: "user", content: "volatile current-turn metadata" };
    const payload: TestPayload = {
      system: [{ type: "text", text: "system" }],
      messages: [stableUser, carrier],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set([1]));

    // Deepest breakpoint anchors on the stable user turn...
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "stable question", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    });
    // ...and NOT on the trailing volatile carrier (left uncached as a plain string).
    expect(payload.messages[1]).toEqual({
      role: "user",
      content: "volatile current-turn metadata",
    });
  });

  it("keeps a stable user marker while advancing through trailing tool results", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [{ type: "text", text: "Follow policy." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Investigate the cache writes." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll inspect the logs." }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll inspect the next log." }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_2", content: "next chunk" }],
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Investigate the cache writes.",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    expect(payload.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
    });
    expect(payload.messages[4]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          content: "next chunk",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("falls back to the latest tool result when no user text or image exists", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [{ type: "text", text: "Follow policy." }],
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "first" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Continue." }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_2", content: "second" }],
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "first" }],
    });
    expect(payload.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          content: "second",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("uses the latest tool result when only one message cache marker remains", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [
        { type: "text", text: "Claude Code identity." },
        { type: "text", text: "Follow policy." },
      ],
      tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Investigate the cache writes." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll inspect the logs." }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Investigate the cache writes." }],
    });
    expect(payload.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "log chunk",
          cache_control: { type: "ephemeral" },
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

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

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

      applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

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

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

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

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

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

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

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

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

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

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.system).toEqual([textBlock("Stable prefix\nDynamic lab suffix")]);
  });
});

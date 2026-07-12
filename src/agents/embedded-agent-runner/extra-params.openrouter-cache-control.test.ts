// Coverage for OpenRouter Anthropic cache_control payload rewriting.

import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { createOpenRouterSystemCacheWrapper } from "../../llm/providers/stream-wrappers/proxy.js";

type StreamPayload = {
  messages: Array<{
    role: string;
    content: unknown;
  }>;
};

function runOpenRouterPayload(
  payload: StreamPayload,
  modelId: string,
  streamOptions: Parameters<StreamFn>[2] = {},
) {
  // The wrapper mutates provider payloads via onPayload; capture the final body
  // directly so assertions match transport-facing JSON.
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const streamFn = createOpenRouterSystemCacheWrapper(baseStreamFn);
  void streamFn(
    {
      api: "openai-completions",
      provider: "openrouter",
      id: modelId,
    } as never,
    { messages: [] } as never,
    streamOptions,
  );
}

describe("extra-params: OpenRouter Anthropic cache_control", () => {
  it("injects cache_control into system message for OpenRouter Anthropic models", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(
      expectDefined(payload.messages[0], "payload.messages[0] test invariant").content,
    ).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(expectDefined(payload.messages[1], "payload.messages[1] test invariant").content).toBe(
      "Hello",
    );
  });

  it("adds cache_control to last content block when system message is already array", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = expectDefined(payload.messages[0], "payload.messages[0] test invariant")
      .content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Part 1" });
    expect(content[1]).toEqual({
      type: "text",
      text: "Part 2",
      cache_control: { type: "ephemeral" },
    });
  });

  it("uses long cache retention for OpenRouter Anthropic cache markers", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6", { cacheRetention: "long" });

    expect(
      expectDefined(payload.messages[0], "payload.messages[0] test invariant").content,
    ).toEqual([
      {
        type: "text",
        text: "You are a helpful assistant.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("skips new cache markers when OpenRouter Anthropic cache retention is none", () => {
    // Disabling retention must remove stale thinking-block cache markers too;
    // OpenRouter rejects those markers on reasoning content.
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "internal",
              thinkingSignature: "sig_1",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6", { cacheRetention: "none" });

    expect(expectDefined(payload.messages[0], "payload.messages[0] test invariant").content).toBe(
      "You are a helpful assistant.",
    );
    expect(
      expectDefined(payload.messages[1], "payload.messages[1] test invariant").content,
    ).toEqual([{ type: "thinking", thinking: "internal", thinkingSignature: "sig_1" }]);
  });

  it("does not inject cache_control for OpenRouter non-Anthropic models", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    runOpenRouterPayload(payload, "google/gemini-3-pro");

    expect(expectDefined(payload.messages[0], "payload.messages[0] test invariant").content).toBe(
      "You are a helpful assistant.",
    );
  });

  it("leaves payload unchanged when no system message exists", () => {
    const payload = {
      messages: [{ role: "user", content: "Hello" }],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(expectDefined(payload.messages[0], "payload.messages[0] test invariant").content).toBe(
      "Hello",
    );
  });

  it("does not inject cache_control into thinking blocks", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(
      expectDefined(payload.messages[0], "payload.messages[0] test invariant").content,
    ).toEqual([
      { type: "text", text: "Part 1" },
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
    ]);
  });

  it("removes pre-existing cache_control from assistant thinking blocks", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "internal",
              thinkingSignature: "sig_1",
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: "visible" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(
      expectDefined(payload.messages[0], "payload.messages[0] test invariant").content,
    ).toEqual([
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
      { type: "text", text: "visible" },
    ]);
  });
});

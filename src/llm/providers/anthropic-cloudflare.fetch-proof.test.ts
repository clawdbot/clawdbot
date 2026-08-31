import type { Context, Model } from "@openclaw/ai";
// Anthropic Cloudflare AI Gateway constructor guard-specific proof: the SSRF
// guard blocks a private-IP request before the SDK's default global fetch is
// ever reached. This proves the stream facade installs OpenClaw's guarded
// fetch through the AI transport host, not just that a fetch option exists.
//
// Unlike anthropic.test.ts (which mocks the Anthropic SDK to verify
// constructor options), this test stubs `globalThis.fetch` to COUNT calls.
// Behavior only the guarded model fetch can produce.
import { afterEach, describe, expect, it, vi } from "vitest";
// Importing the facade installs the OpenClaw AI transport host ports.
import "../stream.js";

const CLOUDFLARE_ANTHROPIC_MODEL = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "cloudflare-ai-gateway",
  baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

describe("Anthropic Cloudflare guard-specific SSRF blocking proof", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks a private-IP request before globalThis.fetch is called (guard-specific behavior)", async () => {
    let globalFetchCalled = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        globalFetchCalled++;
        return new Response(null, { status: 500 });
      }),
    );

    // Override the model baseUrl to a private link-local IP that the guard blocks.
    const blockedModel = {
      ...CLOUDFLARE_ANTHROPIC_MODEL,
      baseUrl: "http://169.254.169.254/v1",
    } satisfies Model<"anthropic-messages">;

    const { streamAnthropic } = await import("@openclaw/ai/internal/anthropic");
    const stream = streamAnthropic(blockedModel, context, {
      apiKey: "sk-ant-test",
      // Retries only repeat the same deterministic guard rejection.
      maxRetries: 0,
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();

    // Guard-specific: SSRF blocked the private-IP request before
    // globalThis.fetch was ever called.
    expect(globalFetchCalled).toBe(0);
  });
});

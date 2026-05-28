import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("expected Cloudflare AI Gateway provider");
  }
  expect(provider.id).toBe("cloudflare-ai-gateway");
  return provider;
}

describe("cloudflare-ai-gateway plugin", () => {
  it("registers a stream wrapper that strips Anthropic thinking assistant prefill", () => {
    const provider = registerProvider();
    expect(provider.wrapStreamFn).toBeTypeOf("function");
    if (!provider.wrapStreamFn) {
      throw new Error("expected Cloudflare AI Gateway stream wrapper");
    }

    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
          { role: "user", content: "Return JSON." },
          { role: "assistant", content: "{" },
        ],
      };
      options?.onPayload?.(payload as never, _model as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn({
      provider: "cloudflare-ai-gateway",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages" },
      streamFn: baseStreamFn,
    } as never);
    expect(wrapped).toBeTypeOf("function");
    if (!wrapped) {
      throw new Error("expected Cloudflare AI Gateway wrapped stream function");
    }

    void wrapped(
      { provider: "cloudflare-ai-gateway", api: "anthropic-messages" } as never,
      {} as never,
      {},
    );

    if (!capturedPayload) {
      throw new Error("expected Cloudflare AI Gateway payload capture");
    }
    expect(capturedPayload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });
});

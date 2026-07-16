import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createFireworksKimiThinkingDisabledWrapper,
  wrapFireworksProviderStream,
} from "./stream.js";

function capturePayload(params: {
  provider: string;
  api: string;
  modelId: string;
  initialPayload?: Record<string, unknown>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createFireworksKimiThinkingDisabledWrapper(baseStreamFn);
  void wrapped(
    {
      api: params.api,
      provider: params.provider,
      id: params.modelId,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    {},
  );

  return captured;
}

describe("createFireworksKimiThinkingDisabledWrapper", () => {
  it("forces thinking disabled for Fireworks Kimi models", () => {
    expect(
      capturePayload({
        provider: "fireworks",
        api: "openai-completions",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
      }),
    ).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("forces thinking disabled for Fireworks Kimi k2.5 aliases", () => {
    expect(
      capturePayload({
        provider: "fireworks",
        api: "openai-completions",
        modelId: "accounts/fireworks/routers/kimi-k2.5-turbo",
      }),
    ).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("strips reasoning fields when disabling Fireworks Kimi thinking", () => {
    const payload = capturePayload({
      provider: "fireworks",
      api: "openai-completions",
      modelId: "accounts/fireworks/models/kimi-k2p5",
      initialPayload: {
        reasoning_effort: "low",
        reasoning: { effort: "low" },
        reasoningEffort: "low",
      },
    });

    expect(payload).toEqual({ thinking: { type: "disabled" } });
  });

  it("passes sanitized payloads to caller onPayload hooks", () => {
    let callbackPayload: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        reasoning_effort: "high",
        reasoning: { effort: "high" },
      };
      options?.onPayload?.(payload, _model);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createFireworksKimiThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "fireworks",
        id: "accounts/fireworks/routers/kimi-k2p5-turbo",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {
        onPayload: (payload) => {
          callbackPayload = payload as Record<string, unknown>;
        },
      },
    );

    expect(callbackPayload).toEqual({ thinking: { type: "disabled" } });
  });

  it("returns no provider wrapper for non-target Fireworks requests", () => {
    expect(
      wrapFireworksProviderStream({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
        model: {
          api: "openai-completions",
          provider: "fireworks",
          id: "accounts/fireworks/models/qwen3.6-plus",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();

    expect(
      wrapFireworksProviderStream({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
        model: {
          api: "openai-responses",
          provider: "fireworks",
          id: "accounts/fireworks/routers/kimi-k2p5-turbo",
        } as Model<"openai-responses">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();

    expect(
      wrapFireworksProviderStream({
        provider: "fireworks-ai",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
        model: {
          api: "openai-completions",
          provider: "fireworks-ai",
          id: "accounts/fireworks/routers/kimi-k2p5-turbo",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");

    expect(
      wrapFireworksProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.4",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});

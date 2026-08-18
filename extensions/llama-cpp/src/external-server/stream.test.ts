import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { wrapLlamaServerStream } from "./stream.js";

function capturePayloadHook(thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"]) {
  let payloadHook: ((payload: unknown, model: unknown) => unknown) | undefined;
  const underlying = vi.fn((_model, _context, options) => {
    payloadHook = options?.onPayload;
    return {} as ReturnType<StreamFn>;
  }) as StreamFn;
  const wrapped = wrapLlamaServerStream({
    streamFn: underlying,
    thinkingLevel,
  } as ProviderWrapStreamFnContext);
  void wrapped({ provider: "llama-server" } as never, { messages: [] }, {});
  if (!payloadHook) {
    throw new Error("expected llama-server payload hook");
  }
  return payloadHook;
}

describe("llama-server stream payload", () => {
  it("maps thinking off to llama-server chat-template kwargs", async () => {
    const payloadHook = capturePayloadHook("off");

    await expect(
      payloadHook(
        {
          model: "model",
          chat_template_kwargs: { preserve_thinking: true, enable_thinking: true },
        },
        {},
      ),
    ).resolves.toEqual({
      model: "model",
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
    });
  });

  it("does not force thinking on when OpenClaw selected another level", async () => {
    const payloadHook = capturePayloadHook("high");
    const payload = { model: "model" };

    await expect(payloadHook(payload, {})).resolves.toBe(payload);
  });
});

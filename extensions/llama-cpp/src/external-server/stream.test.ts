import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { wrapLlamaServerStream } from "./stream.js";

function capturePayloadHook(
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
  options: Record<string, unknown> = {},
) {
  let payloadHook: ((payload: unknown, model: unknown) => unknown) | undefined;
  const underlying = vi.fn((_model, _context, streamOptions) => {
    payloadHook = streamOptions?.onPayload;
    return {} as ReturnType<StreamFn>;
  }) as StreamFn;
  const wrapped = wrapLlamaServerStream({
    streamFn: underlying,
    thinkingLevel,
  } as ProviderWrapStreamFnContext);
  void wrapped({ provider: "llama-cpp" } as never, { messages: [] }, options as never);
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

  it("maps OpenAI nested JSON Schema to llama-server's direct schema field", async () => {
    const payloadHook = capturePayloadHook("off");
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };

    await expect(
      payloadHook(
        {
          model: "model",
          response_format: {
            type: "json_schema",
            json_schema: { name: "openclaw_response", schema },
          },
        },
        {},
      ),
    ).resolves.toMatchObject({
      response_format: { type: "json_object", schema },
    });
  });

  it("injects a direct schema when the shared transport omits it", async () => {
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    const payloadHook = capturePayloadHook("off", { responseFormat: schema });

    await expect(payloadHook({ model: "model" }, {})).resolves.toMatchObject({
      response_format: { type: "json_object", schema },
    });
  });
});

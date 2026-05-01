import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { expect } from "vitest";

type XaiToolPayloadFunction = {
  function?: Record<string, unknown>;
};

type XaiTestPayload = Record<string, unknown> & {
  tools?: Array<{ type?: string; function?: Record<string, unknown> }>;
  input?: unknown[];
};

function createXaiToolStreamPayload(): XaiTestPayload {
  return {
    reasoning: { effort: "high" },
    tools: [
      {
        type: "function",
        function: {
          name: "write",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      },
    ],
  };
}

export function createXaiPayloadCaptureStream() {
  let capturedModelId = "";
  let capturedPayload: XaiTestPayload | undefined;

  const streamFn: StreamFn = (model, _context, options) => {
    capturedModelId = model.id;
    const payload = createXaiToolStreamPayload();
    options?.onPayload?.(payload as never, model as never);
    capturedPayload = payload;
    return {
      result: async () => ({}) as never,
      async *[Symbol.asyncIterator]() {},
    } as unknown as ReturnType<StreamFn>;
  };

  return {
    streamFn,
    getCapturedModelId: () => capturedModelId,
    getCapturedPayload: () => capturedPayload,
  };
}

export function runXaiGrok4ResponseStream(streamFn: StreamFn | null | undefined) {
  void streamFn?.(
    {
      api: "openai-responses",
      provider: "xai",
      id: "grok-4",
    } as Model<"openai-responses">,
    { messages: [] } as Context,
    {},
  );
}

export function expectXaiFastToolStreamShaping(
  capture: ReturnType<typeof createXaiPayloadCaptureStream>,
) {
  const capturedPayload = capture.getCapturedPayload();
  expect(capture.getCapturedModelId()).toBe("grok-4-fast");
  expect(capturedPayload).toMatchObject({ tool_stream: true });
  expect(capturedPayload).not.toHaveProperty("reasoning");
  const payloadTools = capturedPayload?.tools as XaiToolPayloadFunction[] | undefined;
  expect(payloadTools?.[0]?.function).not.toHaveProperty("strict");
}

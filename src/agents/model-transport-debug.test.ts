import { emitModelTransportDebug } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";

describe("emitModelTransportDebug", () => {
  function createLogger() {
    const info = vi.fn();
    const debug = vi.fn();
    return {
      log: { info, debug } as unknown as Parameters<typeof emitModelTransportDebug>[0],
      info,
      debug,
    };
  }

  it("emits model-fetch metadata at info level by default", () => {
    const { log, info, debug } = createLogger();

    emitModelTransportDebug(
      log,
      "[model-fetch] response provider=openai api=chat model=gpt status=200 latencyMs=42",
    );

    expect(info).toHaveBeenCalledWith(
      "[model-fetch] response provider=openai api=chat model=gpt status=200 latencyMs=42",
    );
    expect(debug).not.toHaveBeenCalled();
  });

  it("keeps non-model-fetch transport diagnostics at debug level by default", () => {
    const { log, info, debug } = createLogger();

    emitModelTransportDebug(log, "[model-sse] event type=response.output_text.delta");

    expect(debug).toHaveBeenCalledWith("[model-sse] event type=response.output_text.delta");
    expect(info).not.toHaveBeenCalled();
  });
});

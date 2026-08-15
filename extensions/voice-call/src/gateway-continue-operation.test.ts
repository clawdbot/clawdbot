// Voice Call tests cover gateway continue operation plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { createVoiceCallContinueOperationStore } from "./gateway-continue-operation.js";

describe("voice-call gateway continue operation store", () => {
  it("caps async continue poll timeouts from voice and tts config", () => {
    const store = createVoiceCallContinueOperationStore({
      config: {
        transcriptTimeoutMs: Number.MAX_SAFE_INTEGER,
        tts: { timeoutMs: Number.MAX_SAFE_INTEGER },
      } as never,
      coreConfig: { messages: {} } as never,
    });

    const started = store.start({
      callId: "call-1",
      rt: {
        config: {},
      } as never,
      run: async () => await new Promise(() => {}),
    });

    expect(started.pollTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});

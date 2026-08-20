import { describe, expect, it, vi } from "vitest";
import {
  createVoiceTranscriptOperationRegistry,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "./voice-transcript.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("VoiceTranscriptOperationRegistry", () => {
  it("keeps overflow terminal through drain and releases it only on close", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const first = deferred();
    const key = "agent\0voice-overflow";
    const accepted = [
      registry.run(key, async () => await first.promise),
      ...Array.from({ length: VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount }, () =>
        registry.run(key, async () => undefined),
      ),
    ];

    await expect(registry.run(key, async () => undefined)).rejects.toThrow(
      "voice transcript persistence queue capacity exceeded",
    );
    first.resolve();
    await Promise.all(accepted);

    const controlOperation = vi.fn();
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).rejects.toThrow("voice transcript persistence queue capacity exceeded");
    expect(controlOperation).not.toHaveBeenCalled();

    const closeOperation = vi.fn();
    await registry.close(key, async () => {
      closeOperation();
    });
    expect(closeOperation).toHaveBeenCalledOnce();
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).resolves.toBeUndefined();
    expect(controlOperation).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  createVoiceCaptureState,
  finishVoiceCapture,
  scheduleVoiceCaptureFinalize,
} from "./capture-state.js";

describe("voice capture state", () => {
  it("increments generations per speaker", () => {
    const state = createVoiceCaptureState();
    const first = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);
    finishVoiceCapture(state, "u1", first);
    const second = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("clears active speaker state before destroying a finalized capture", async () => {
    vi.useFakeTimers();
    try {
      const state = createVoiceCaptureState();
      const destroy = vi.fn(() => {
        expect(state.activeSpeakers.has("u1")).toBe(false);
        expect(state.activeCaptureStreams.has("u1")).toBe(false);
      });
      beginVoiceCapture(state, "u1", { destroy } as never);

      expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
      await vi.advanceTimersByTimeAsync(1_200);

      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a pending finalize be canceled for the same generation", () => {
    const state = createVoiceCaptureState();
    const generation = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);

    expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
    expect(clearVoiceCaptureFinalizeTimer(state, "u1", generation)).toBe(true);
    expect(state.captureFinalizeTimers.has("u1")).toBe(false);
  });
});

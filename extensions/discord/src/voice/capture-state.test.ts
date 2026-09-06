// Discord tests cover capture state plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  createVoiceCaptureState,
  finishVoiceCapture,
  scheduleVoiceCaptureFinalize,
  stopVoiceCaptureState,
} from "./capture-state.js";

describe("voice capture state", () => {
  it("keeps a replacement's finalize timer when an old decode finishes", async () => {
    vi.useFakeTimers();
    try {
      const state = createVoiceCaptureState();
      const first = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);
      finishVoiceCapture(state, "u1", first);
      const destroy = vi.fn();
      beginVoiceCapture(state, "u1", { destroy } as never);
      scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 });

      expect(finishVoiceCapture(state, "u1", first)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(destroy).toHaveBeenCalledOnce();
      expect(state.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears active speaker state before destroying a finalized capture", async () => {
    vi.useFakeTimers();
    try {
      const state = createVoiceCaptureState();
      const destroy = vi.fn(() => {
        expect(state.has("u1")).toBe(false);
      });
      beginVoiceCapture(state, "u1", { destroy } as never);

      expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
      await vi.advanceTimersByTimeAsync(1_200);

      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a pending finalize be canceled for the same capture", () => {
    const state = createVoiceCaptureState();
    const capture = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);

    expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
    expect(clearVoiceCaptureFinalizeTimer(capture)).toBe(true);
    expect(clearVoiceCaptureFinalizeTimer(capture)).toBe(false);
  });

  it("retires every capture and cancels timers before terminal stream teardown", async () => {
    vi.useFakeTimers();
    try {
      const state = createVoiceCaptureState();
      const destroy = vi.fn(() => expect(state.size).toBe(0));
      const onFinalize = vi.fn();
      for (const userId of ["u1", "u2"]) {
        beginVoiceCapture(state, userId, { destroy } as never);
        scheduleVoiceCaptureFinalize({ state, userId, delayMs: 1_200, onFinalize });
      }

      stopVoiceCaptureState(state);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(onFinalize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

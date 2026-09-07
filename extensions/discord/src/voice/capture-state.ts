import type { Readable } from "node:stream";

type VoiceCaptureEntry = {
  stream?: Readable;
  startRecording?: () => void;
  finalizeTimer?: ReturnType<typeof setTimeout>;
};

export type VoiceCaptureState = Map<string, VoiceCaptureEntry>;

export function createVoiceCaptureState(): VoiceCaptureState {
  return new Map();
}

export function stopVoiceCaptureState(state: VoiceCaptureState): void {
  const captures = [...state.values()];
  // Retire every capture before stream teardown can invoke retained callbacks.
  state.clear();
  for (const capture of captures) {
    clearVoiceCaptureFinalizeTimer(capture);
    capture.stream?.destroy();
  }
}

export function clearVoiceCaptureFinalizeTimer(capture: VoiceCaptureEntry): boolean {
  if (!capture.finalizeTimer) {
    return false;
  }
  clearTimeout(capture.finalizeTimer);
  delete capture.finalizeTimer;
  return true;
}

export async function waitForVoiceCaptureAdmission(params: {
  capture: VoiceCaptureEntry;
  conversationAuthorized: Promise<boolean>;
  isRecordingCurrent: () => boolean;
}): Promise<boolean> {
  const recordingStarted = new Promise<void>((resolve) => {
    params.capture.startRecording = resolve;
  });
  try {
    await Promise.race([params.conversationAuthorized, recordingStarted]);
  } catch (error) {
    // Receive owns conversation failures once recording has its own authority.
    if (!params.isRecordingCurrent()) {
      throw error;
    }
  } finally {
    delete params.capture.startRecording;
  }
  return params.isRecordingCurrent() || (await params.conversationAuthorized);
}

export function beginVoiceCapture(
  state: VoiceCaptureState,
  userId: string,
  stream?: Readable,
): VoiceCaptureEntry {
  const capture = { stream };
  state.set(userId, capture);
  return capture;
}

export function finishVoiceCapture(
  state: VoiceCaptureState,
  userId: string,
  capture: VoiceCaptureEntry,
): boolean {
  clearVoiceCaptureFinalizeTimer(capture);
  // An old decode can finish after silence finalized it and a new capture started.
  if (state.get(userId) !== capture) {
    return false;
  }
  state.delete(userId);
  return true;
}

export function scheduleVoiceCaptureFinalize(params: {
  state: VoiceCaptureState;
  userId: string;
  delayMs: number;
  onFinalize?: (capture: VoiceCaptureEntry) => void;
}): boolean {
  const { state, userId, delayMs, onFinalize } = params;
  const capture = state.get(userId);
  if (!capture) {
    return false;
  }
  clearVoiceCaptureFinalizeTimer(capture);
  capture.finalizeTimer = setTimeout(() => {
    if (!finishVoiceCapture(state, userId, capture)) {
      return;
    }
    onFinalize?.(capture);
    capture.stream?.destroy();
  }, delayMs);
  return true;
}

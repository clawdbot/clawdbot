// Realtime transcription provider facade for the voice-call plugin runtime.
import * as transcription from "openclaw/plugin-sdk/realtime-transcription";

export function acquireRealtimeTranscriptionProvider(
  ...args: Parameters<typeof transcription.acquireRealtimeTranscriptionProvider>
): ReturnType<typeof transcription.acquireRealtimeTranscriptionProvider> {
  if (typeof transcription.acquireRealtimeTranscriptionProvider === "function") {
    return transcription.acquireRealtimeTranscriptionProvider(...args);
  }
  // Older supported hosts own these callbacks and do not expose registration disposal.
  return {
    provider: transcription.getRealtimeTranscriptionProvider(...args),
    release() {},
    run: (operation) => operation(),
  };
}

export function acquireRealtimeTranscriptionProviders(
  ...args: Parameters<typeof transcription.acquireRealtimeTranscriptionProviders>
): ReturnType<typeof transcription.acquireRealtimeTranscriptionProviders> {
  if (typeof transcription.acquireRealtimeTranscriptionProviders === "function") {
    return transcription.acquireRealtimeTranscriptionProviders(...args);
  }
  return {
    providers: transcription.listRealtimeTranscriptionProviders(...args),
    release() {},
    run: (operation) => operation(),
  };
}

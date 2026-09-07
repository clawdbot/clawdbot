// Realtime voice provider facade for the voice-call plugin runtime.
import * as realtimeVoice from "openclaw/plugin-sdk/realtime-voice";

export {
  getRealtimeVoiceProvider,
  listRealtimeVoiceProviders,
} from "openclaw/plugin-sdk/realtime-voice";

export function acquireConfiguredRealtimeVoiceProvider(
  ...args: Parameters<typeof realtimeVoice.acquireConfiguredRealtimeVoiceProvider>
): ReturnType<typeof realtimeVoice.acquireConfiguredRealtimeVoiceProvider> {
  if (typeof realtimeVoice.acquireConfiguredRealtimeVoiceProvider === "function") {
    return realtimeVoice.acquireConfiguredRealtimeVoiceProvider(...args);
  }
  // The published host range includes hosts whose registries have no disposal API.
  // Preserve their host-owned callbacks; newer hosts always take the explicit lease.
  return {
    ...realtimeVoice.resolveConfiguredRealtimeVoiceProvider(...args),
    release() {},
    run: (operation) => operation(),
  };
}

import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
} from "./capability-provider.types.js";

/** Default export of capabilityCatalogEntry. Each present family is complete, even when empty. */
export type PluginCapabilityCatalog = {
  speechProviders?: readonly SpeechProviderPlugin[];
  realtimeTranscriptionProviders?: readonly RealtimeTranscriptionProviderPlugin[];
  realtimeVoiceProviders?: readonly RealtimeVoiceProviderPlugin[];
};

// Compat surface: openclaw/plugin-sdk/realtime-transcription
// Provides stable types and registry helpers for realtime transcription providers.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque per-provider configuration blob. */
export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;

/** An active speech-to-text streaming session. */
export type RealtimeTranscriptionSession = {
  /** Establish the connection to the STT service. */
  connect: () => Promise<void>;
  /** Send a chunk of raw audio bytes to the STT service. */
  sendAudio: (data: Buffer | Uint8Array) => void;
  /** Close the session and release resources. */
  close: () => void;
  /** Returns true if the session is currently connected. */
  isConnected: () => boolean;
};

/** A realtime transcription provider plugin registration. */
export type RealtimeTranscriptionProviderPlugin = {
  /** Unique provider identifier. */
  id: string;
  /** Human-readable label for the provider. */
  label: string;
  /** Returns true if this provider is configured in the current environment. */
  isConfigured: (cfg?: unknown) => boolean;
  /** Creates a new transcription session using the given provider config. */
  createSession: (params: {
    providerConfig: RealtimeTranscriptionProviderConfig;
    onTranscript?: (text: string) => void;
    onPartialTranscript?: (text: string) => void;
    [key: string]: unknown;
  }) => RealtimeTranscriptionSession;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _registry = new Map<string, RealtimeTranscriptionProviderPlugin>();

/** Register a realtime transcription provider. */
export function registerRealtimeTranscriptionProvider(
  plugin: RealtimeTranscriptionProviderPlugin,
): void {
  _registry.set(plugin.id, plugin);
}

/** Retrieve a registered realtime transcription provider by ID. */
export function getRealtimeTranscriptionProvider(
  id: string,
): RealtimeTranscriptionProviderPlugin | null {
  return _registry.get(id) ?? null;
}

/** List all registered realtime transcription providers. */
export function listRealtimeTranscriptionProviders(): RealtimeTranscriptionProviderPlugin[] {
  return [..._registry.values()];
}

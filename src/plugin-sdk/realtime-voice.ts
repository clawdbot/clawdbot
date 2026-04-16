// Compat surface: openclaw/plugin-sdk/realtime-voice
// Provides stable types and registry helpers for realtime voice providers.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque per-provider configuration blob. */
export type RealtimeVoiceProviderConfig = Record<string, unknown>;

/** A realtime bidirectional voice bridge. */
export type RealtimeVoiceBridge = {
  connect: () => Promise<void>;
  sendAudio: (data: Buffer | Uint8Array) => void;
  setMediaTimestamp?: (timestamp: number) => void;
  submitToolResult?: (toolCallId: string, result: unknown) => void;
  acknowledgeMark?: (mark: string) => void;
  [key: string]: unknown;
};

/** A realtime voice provider plugin registration. */
export type RealtimeVoiceProviderPlugin = {
  /** Unique provider identifier. */
  id: string;
  /** Human-readable label for the provider. */
  label: string;
  /** Returns true if this provider is configured in the current environment. */
  isConfigured: (cfg?: unknown) => boolean;
  /** Creates a new bidirectional voice bridge. */
  createBridge: (params?: {
    providerConfig?: RealtimeVoiceProviderConfig;
    [key: string]: unknown;
  }) => RealtimeVoiceBridge;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _registry = new Map<string, RealtimeVoiceProviderPlugin>();

/** Register a realtime voice provider. */
export function registerRealtimeVoiceProvider(plugin: RealtimeVoiceProviderPlugin): void {
  _registry.set(plugin.id, plugin);
}

/** Retrieve a registered realtime voice provider by ID. */
export function getRealtimeVoiceProvider(id: string): RealtimeVoiceProviderPlugin | null {
  return _registry.get(id) ?? null;
}

/** List all registered realtime voice providers. */
export function listRealtimeVoiceProviders(): RealtimeVoiceProviderPlugin[] {
  return [..._registry.values()];
}

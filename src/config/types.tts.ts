export type TtsProvider = string;

export type TtsMode = "final" | "all";

export type TtsAutoMode = "off" | "always" | "inbound" | "tagged";

export type TtsModelOverrideConfig = {
  /** Enable model-provided overrides for TTS. */
  enabled?: boolean;
  /** Allow model-provided TTS text blocks. */
  allowText?: boolean;
  /** Allow model-provided provider override (default: false). */
  allowProvider?: boolean;
  /** Allow model-provided voice/voiceId override. */
  allowVoice?: boolean;
  /** Allow model-provided modelId override. */
  allowModelId?: boolean;
  /** Allow model-provided voice settings override. */
  allowVoiceSettings?: boolean;
  /** Allow model-provided normalization or language overrides. */
  allowNormalization?: boolean;
  /** Allow model-provided seed override. */
  allowSeed?: boolean;
};

export type TtsProviderConfigMap = Record<string, Record<string, unknown>>;

export type TtsPersonaFallbackPolicy = "preserve-persona" | "provider-defaults" | "fail";

export type TtsPersonaPromptConfig = {
  profile?: string;
  scene?: string;
  sampleContext?: string;
  style?: string;
  accent?: string;
  pacing?: string;
  constraints?: string[];
};

export type TtsPersonaConfig = {
  label?: string;
  description?: string;
  /** Preferred provider for this persona. Explicit provider prefs still win. */
  provider?: TtsProvider;
  fallbackPolicy?: TtsPersonaFallbackPolicy;
  prompt?: TtsPersonaPromptConfig;
  /** Provider-specific persona bindings keyed by speech provider id. */
  providers?: TtsProviderConfigMap;
};

export type ResolvedTtsPersona = TtsPersonaConfig & {
  id: string;
};

export type TtsConfig = {
  /** Auto-TTS mode (preferred). */
  auto?: TtsAutoMode;
  /** Legacy: enable auto-TTS when `auto` is not set. */
  enabled?: boolean;
  /** Apply TTS to final replies only or to all replies (tool/block/final). */
  mode?: TtsMode;
  /** Primary TTS provider (fallbacks are automatic). */
  provider?: TtsProvider;
  /** Active TTS persona id. */
  persona?: string;
  /** Named TTS personas. */
  personas?: Record<string, TtsPersonaConfig>;
  /** Optional model override for TTS auto-summary (provider/model or alias). */
  summaryModel?: string;
  /** Allow the model to override TTS parameters. */
  modelOverrides?: TtsModelOverrideConfig;
  /** Provider-specific TTS settings keyed by speech provider id. */
  providers?: TtsProviderConfigMap;
  /** Optional path for local TTS user preferences JSON. */
  prefsPath?: string;
  /** Hard cap for text sent to TTS (chars). */
  maxTextLength?: number;
  /** API request timeout (ms). */
  timeoutMs?: number;
};

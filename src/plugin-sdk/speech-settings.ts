// Lightweight speech settings primitives for package-owned TTS configuration.
// Keep provider registries and synthesis runtimes out of this entrypoint.

export type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "../tts/tts-types.js";
export { normalizeSpeechProviderId } from "../tts/provider-registry-core.js";
export { normalizeTtsAutoMode } from "../tts/tts-auto-mode.js";
export { resolveEffectiveTtsConfig, type TtsConfigResolutionContext } from "../tts/tts-config.js";

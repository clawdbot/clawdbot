// Deepinfra plugin module implements media models behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEEPINFRA_BASE_URL } from "./provider-models.js";

export { DEEPINFRA_BASE_URL };

export const DEEPINFRA_NATIVE_BASE_URL = "https://api.deepinfra.com/v1/inference";

// Structural capability shapes — not model IDs.
export const DEFAULT_DEEPINFRA_IMAGE_SIZE = "1024x1024";
export const DEFAULT_DEEPINFRA_TTS_VOICE = "af_bella";
export const DEEPINFRA_VIDEO_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const DEEPINFRA_VIDEO_DURATIONS = [5, 8] as const;

// Per-surface fallback lists — used when no discovered/static catalog is
// supplied. First entry is the default. Prefer discoverDeepInfraSurfaces().
export const DEEPINFRA_IMAGE_FALLBACK_MODELS = [
  "black-forest-labs/FLUX-1-schnell",
  "run-diffusion/Juggernaut-Lightning-Flux",
  "black-forest-labs/FLUX-1-dev",
  "Qwen/Qwen-Image-Max",
  "stabilityai/sdxl-turbo",
] as const;

export const DEEPINFRA_TTS_FALLBACK_MODELS = [
  "hexgrad/Kokoro-82M",
  "Qwen/Qwen3-TTS",
  "ResembleAI/chatterbox-turbo",
  "sesame/csm-1b",
] as const;

export const DEEPINFRA_VIDEO_FALLBACK_MODELS = [
  "Pixverse/Pixverse-T2V",
  "Pixverse/Pixverse-T2V-HD",
  "Wan-AI/Wan2.6-T2V",
  "google/veo-3.1-fast",
] as const;

export const DEEPINFRA_STT_FALLBACK_MODELS = [
  "openai/whisper-large-v3-turbo",
  "openai/whisper-large-v3",
] as const;

export const DEEPINFRA_EMBED_FALLBACK_MODELS = ["BAAI/bge-m3"] as const;

export const DEEPINFRA_VLM_FALLBACK_MODELS = ["moonshotai/Kimi-K2.5"] as const;

export function normalizeDeepInfraModelRef(model: string | undefined, fallback: string): string {
  const value = normalizeOptionalString(model) ?? fallback;
  return value.startsWith("deepinfra/") ? value.slice("deepinfra/".length) : value;
}

export function normalizeDeepInfraBaseUrl(value: unknown, fallback = DEEPINFRA_BASE_URL): string {
  return (normalizeOptionalString(value) ?? fallback).replace(/\/+$/u, "");
}

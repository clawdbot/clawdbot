import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEEPINFRA_BASE_URL } from "./provider-models.js";

export { DEEPINFRA_BASE_URL };

export const DEEPINFRA_NATIVE_BASE_URL = "https://api.deepinfra.com/v1/inference";

export const DEFAULT_DEEPINFRA_IMAGE_MODEL = "black-forest-labs/FLUX-1-schnell";
export const DEFAULT_DEEPINFRA_IMAGE_SIZE = "1024x1024";
export const DEEPINFRA_IMAGE_MODELS = [
  DEFAULT_DEEPINFRA_IMAGE_MODEL,
  "run-diffusion/Juggernaut-Lightning-Flux",
  "black-forest-labs/FLUX-1-dev",
  "Qwen/Qwen-Image-Max",
  "stabilityai/sdxl-turbo",
] as const;

export const DEFAULT_DEEPINFRA_EMBEDDING_MODEL = "BAAI/bge-m3";

export const DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
export const DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL = "moonshotai/Kimi-K2.5";

export const DEFAULT_DEEPINFRA_TTS_MODEL = "hexgrad/Kokoro-82M";
export const DEFAULT_DEEPINFRA_TTS_VOICE = "af_alloy";
export const DEEPINFRA_TTS_MODELS = [
  DEFAULT_DEEPINFRA_TTS_MODEL,
  "ResembleAI/chatterbox-turbo",
  "sesame/csm-1b",
  "Qwen/Qwen3-TTS",
] as const;

export const DEFAULT_DEEPINFRA_VIDEO_MODEL = "Pixverse/Pixverse-T2V";
export const DEEPINFRA_VIDEO_MODELS = [
  DEFAULT_DEEPINFRA_VIDEO_MODEL,
  "Pixverse/Pixverse-T2V-HD",
  "Wan-AI/Wan2.1-T2V-1.3B",
  "google/veo-3.0-fast",
] as const;

export const DEEPINFRA_VIDEO_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const DEEPINFRA_VIDEO_DURATIONS = [5, 8] as const;

export function normalizeDeepInfraModelRef(model: string | undefined, fallback: string): string {
  const value = normalizeOptionalString(model) ?? fallback;
  return value.startsWith("deepinfra/") ? value.slice("deepinfra/".length) : value;
}

export function normalizeDeepInfraBaseUrl(value: unknown, fallback = DEEPINFRA_BASE_URL): string {
  return (normalizeOptionalString(value) ?? fallback).replace(/\/+$/u, "");
}

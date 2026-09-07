import type { MediaUnderstandingCapability } from "./types.js";

// Shared defaults for media-understanding limits, prompts, and concurrency.

const MB = 1024 * 1024;

/** Default max response characters for bounded text outputs. */
export const DEFAULT_MAX_CHARS = 500;
/** Default max response characters by capability. */
export const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<
  MediaUnderstandingCapability,
  number | undefined
> = {
  image: DEFAULT_MAX_CHARS,
  audio: undefined,
  video: DEFAULT_MAX_CHARS,
};
/** Default input byte limits by capability. */
export const DEFAULT_MAX_BYTES: Record<MediaUnderstandingCapability, number> = {
  image: 10 * MB,
  audio: 20 * MB,
  video: 50 * MB,
};
/** Default request timeout by capability. */
export const DEFAULT_TIMEOUT_SECONDS: Record<MediaUnderstandingCapability, number> = {
  image: 60,
  audio: 60,
  video: 120,
};
/** Default prompts by capability. */
export const DEFAULT_PROMPT: Record<MediaUnderstandingCapability, string> = {
  image: "Describe the image.",
  audio: "Transcribe the audio.",
  video: "Describe the video.",
};
/** Upper bound for base64-expanded video payloads. */
export const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
/** CLI output buffer used by provider child processes. */
export const CLI_OUTPUT_MAX_BUFFER = 5 * MB;
/** Default parallel media-understanding request count. */
export const DEFAULT_MEDIA_CONCURRENCY = 2;
/** Minimum bytes for audio files before transcription is attempted. */
export const MIN_AUDIO_FILE_BYTES = 1024;

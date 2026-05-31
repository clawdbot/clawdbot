import { MediaUnderstandingCapability } from "./types.mjs";

//#region packages/media-understanding-common/src/defaults.d.ts
declare const DEFAULT_MAX_CHARS = 500;
declare const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<MediaUnderstandingCapability, number | undefined>;
declare const DEFAULT_MAX_BYTES: Record<MediaUnderstandingCapability, number>;
declare const DEFAULT_TIMEOUT_SECONDS: Record<MediaUnderstandingCapability, number>;
declare const DEFAULT_PROMPT: Record<MediaUnderstandingCapability, string>;
declare const DEFAULT_VIDEO_MAX_BASE64_BYTES: number;
declare const CLI_OUTPUT_MAX_BUFFER: number;
declare const DEFAULT_MEDIA_CONCURRENCY = 2;
declare const MIN_AUDIO_FILE_BYTES = 1024;
//#endregion
export { CLI_OUTPUT_MAX_BUFFER, DEFAULT_MAX_BYTES, DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS_BY_CAPABILITY, DEFAULT_MEDIA_CONCURRENCY, DEFAULT_PROMPT, DEFAULT_TIMEOUT_SECONDS, DEFAULT_VIDEO_MAX_BASE64_BYTES, MIN_AUDIO_FILE_BYTES };
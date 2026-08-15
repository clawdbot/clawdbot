/** Shared stdout/stderr buffer cap for ffmpeg and ffprobe child processes. */
export const MEDIA_FFMPEG_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Default ffprobe timeout for lightweight metadata probes. */
export const MEDIA_FFPROBE_TIMEOUT_MS = 10_000;
/** Default ffmpeg timeout for bounded media conversion work. */
export const MEDIA_FFMPEG_TIMEOUT_MS = 45_000;
/** Maximum audio duration accepted by ffmpeg-backed media flows. */
export const MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS = 20 * 60;

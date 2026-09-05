import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
export const DEFAULT_VYDRA_BASE_URL = "https://www.vydra.ai/api/v1";
export const DEFAULT_VYDRA_IMAGE_MODEL = "grok-imagine";
export const DEFAULT_VYDRA_VIDEO_MODEL = "veo3";
export const DEFAULT_VYDRA_SPEECH_MODEL = "elevenlabs/tts";
export const DEFAULT_VYDRA_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export function normalizeVydraBaseUrl(value: string | undefined): string {
  const fallback = DEFAULT_VYDRA_BASE_URL;
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return fallback;
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname === "vydra.ai") {
      url.hostname = "www.vydra.ai";
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (!pathname) {
      url.pathname = "/api/v1";
    } else {
      url.pathname = pathname;
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    return fallback;
  }
}

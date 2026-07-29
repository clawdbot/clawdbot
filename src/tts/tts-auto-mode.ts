// TTS auto mode helpers decide when speech should be generated automatically.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { TtsAutoMode } from "../config/types.tts.js";

/** Accepted TTS auto modes from config, prefs, and session-level overrides. */
export const TTS_AUTO_MODES = new Set<TtsAutoMode>(["off", "always", "inbound", "tagged"]);

/** Normalize an unknown value into a supported TTS auto mode. */
export function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (TTS_AUTO_MODES.has(normalized as TtsAutoMode)) {
    return normalized as TtsAutoMode;
  }
  return undefined;
}

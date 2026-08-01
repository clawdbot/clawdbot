// Gateway generic server utilities.
// Normalizes voice-wake triggers and formats unknown errors for logs/responses.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";

export { formatErrorMessage as formatError } from "../infra/errors.js";

/** Normalizes voice-wake trigger config with bounded count/length and defaults. */
export function normalizeVoiceWakeTriggers(input: unknown): string[] {
  const cleaned = normalizeTrimmedStringList(input)
    .slice(0, 32)
    .map((value) => truncateUtf16Safe(value, 64));
  return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}

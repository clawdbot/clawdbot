// Gateway generic server utilities.
// Normalizes voice-wake triggers and formats unknown errors for logs/responses.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";

/** Normalizes voice-wake trigger config with bounded count/length and defaults. */
export function normalizeVoiceWakeTriggers(input: unknown): string[] {
  const cleaned = normalizeTrimmedStringList(input)
    .slice(0, 32)
    .map((value) => truncateUtf16Safe(value, 64));
  return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}

/** Formats unknown gateway errors without throwing on unusual status/code shapes. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  const statusValue = (err as { status?: unknown })?.status;
  const codeValue = (err as { code?: unknown })?.code;
  const hasStatus = statusValue !== undefined;
  const hasCode = codeValue !== undefined;
  if (hasStatus || hasCode) {
    const statusText =
      typeof statusValue === "string" || typeof statusValue === "number"
        ? String(statusValue)
        : "unknown";
    const codeText =
      typeof codeValue === "string" || typeof codeValue === "number"
        ? String(codeValue)
        : "unknown";
    return `status=${statusText} code=${codeText}`;
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

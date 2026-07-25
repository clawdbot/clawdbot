import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// Shared sanitization for doctor/lint/repair errors shown in terminal output.
const ERR_MESSAGE_MAX_LEN = 256;

/** Removes control characters and caps error messages before doctor prints them. */
export function scrubDoctorErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let stripped = "";
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code > 0x1f && code !== 0x7f) {
      stripped += raw.charAt(index);
    }
  }
  if (stripped.length <= ERR_MESSAGE_MAX_LEN) {
    return stripped;
  }
  return `${truncateUtf16Safe(stripped, ERR_MESSAGE_MAX_LEN - 3)}...`;
}

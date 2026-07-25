// Focused low-level text/runtime helpers used by bundled plugins.

/** Escapes text for safe insertion into HTML text and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export {
  CONFIG_DIR,
  clamp,
  clampInt,
  clampNumber,
  displayPath,
  displayString,
  ensureDir,
  escapeRegExp,
  normalizeE164,
  pathExists,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  safeParseJson,
  shortenHomeInString,
  shortenHomePath,
  sleep,
  sliceUtf16Safe,
  truncateUtf16Safe,
} from "../utils.js";
export { fetchWithTimeout } from "../utils/fetch-timeout.js";
export { withTimeout } from "../utils/with-timeout.js";

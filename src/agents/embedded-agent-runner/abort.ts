import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

/**
 * Runner abort check. Catches any abort-related message for embedded runners.
 * More permissive than the core isAbortError since runners need to catch
 * various abort signals from different sources.
 */
export function isRunnerAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  if (name === "AbortError") {
    return true;
  }
  const message =
    "message" in err && typeof err.message === "string"
      ? normalizeLowercaseStringOrEmpty(err.message)
      : "";
  return message.includes("aborted");
}

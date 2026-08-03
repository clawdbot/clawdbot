/**
 * Detects abort-shaped errors from embedded-agent runner dependencies.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Return true for AbortError objects or lower-level aborted messages. */
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

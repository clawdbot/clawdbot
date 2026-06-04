// Normalizes source identifiers for externally supplied content.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Hook session sources that carry untrusted external content into agent prompts. */
export type HookExternalContentSource = "gmail" | "webhook";

/**
 * Resolve a hook session key into its external content source.
 * Unknown `hook:*` sessions are treated as webhooks so legacy/custom hooks stay wrapped.
 */
export function resolveHookExternalContentSource(
  sessionKey: string,
): HookExternalContentSource | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (normalized.startsWith("hook:gmail:")) {
    return "gmail";
  }
  if (normalized.startsWith("hook:webhook:") || normalized.startsWith("hook:")) {
    return "webhook";
  }
  return undefined;
}

/** Map hook session provenance to the prompt-facing external content source label. */
export function mapHookExternalContentSource(
  source: HookExternalContentSource,
): "email" | "webhook" {
  return source === "gmail" ? "email" : "webhook";
}

/** Return true when a session key should receive external-content prompt wrapping. */
export function isExternalHookSession(sessionKey: string): boolean {
  return resolveHookExternalContentSource(sessionKey) !== undefined;
}

import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type HookExternalContentSource = "gmail" | "webhook";

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

export function mapHookExternalContentSource(
  source: HookExternalContentSource,
): "email" | "webhook" {
  return source === "gmail" ? "email" : "webhook";
}

export function isExternalHookSession(sessionKey: string): boolean {
  return resolveHookExternalContentSource(sessionKey) !== undefined;
}

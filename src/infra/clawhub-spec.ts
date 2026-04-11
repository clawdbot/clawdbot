import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function parseClawHubPluginSpec(raw: string): {
  name: string;
  version?: string;
  baseUrl?: string;
} | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("clawhub:")) {
    return null;
  }
  const spec = trimmed.slice("clawhub:".length).trim();
  if (!spec) {
    return null;
  }
  const atIndex = spec.lastIndexOf("@");
  if (atIndex <= 0 || atIndex >= spec.length - 1) {
    return { name: spec };
  }
  return {
    name: spec.slice(0, atIndex).trim(),
    version: spec.slice(atIndex + 1).trim() || undefined,
  };
}

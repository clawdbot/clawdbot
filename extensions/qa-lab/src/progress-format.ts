import { parseBooleanValue } from "openclaw/plugin-sdk/string-coerce-runtime";

export function parseQaProgressBooleanEnv(value: string | undefined): boolean | undefined {
  return parseBooleanValue(value);
}

export function sanitizeQaProgressValue(value: string): string {
  let normalized = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    normalized += isControl ? " " : char;
  }
  normalized = normalized.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : "<empty>";
}

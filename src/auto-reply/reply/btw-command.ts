import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeCommandBody, type CommandNormalizeOptions } from "../commands-registry.js";

const BTW_COMMAND_RE = /^\/btw(?::|\s|$)/i;

export function isBtwRequestText(text?: string, options?: CommandNormalizeOptions): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  return BTW_COMMAND_RE.test(normalized);
}

export function extractBtwQuestion(
  text?: string,
  options?: CommandNormalizeOptions,
): string | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  const match = normalized.match(/^\/btw(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  return normalizeOptionalString(match[1]) ?? "";
}

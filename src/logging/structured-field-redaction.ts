import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

export function maskStructuredFieldValue(value: string): string {
  if (value === "***") {
    return value;
  }
  if (value.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = sliceUtf16Safe(value, 0, DEFAULT_REDACT_KEEP_START);
  const end = sliceUtf16Safe(value, -DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function pathEndsWith(path: readonly string[], suffix: readonly string[]): boolean {
  if (path.length < suffix.length) {
    return false;
  }
  return suffix.every((part, index) => path[path.length - suffix.length + index] === part);
}

export function shouldRedactStructuredAuthorizationCode(
  key: string,
  path: readonly string[],
): boolean {
  if (key.toLowerCase() !== "code") {
    return false;
  }
  const normalizedPath = path.map((part) => part.toLowerCase());
  if (
    normalizedPath.length === 1 ||
    pathEndsWith(normalizedPath, ["error", "code"]) ||
    pathEndsWith(normalizedPath, ["nodeerror", "code"]) ||
    pathEndsWith(normalizedPath, ["status", "code"]) ||
    pathEndsWith(normalizedPath, ["details", "code"]) ||
    pathEndsWith(normalizedPath, ["warnings", "code"])
  ) {
    return false;
  }
  return true;
}

// Google Meet plugin module implements shared Meet URL contracts.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeMeetUrl(input: unknown): string {
  const raw = normalizeOptionalString(input);
  if (!raw) {
    throw new Error("url required");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be a valid Google Meet URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "meet.google.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("url must be an explicit https://meet.google.com/... URL");
  }
  if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:$|[/?#])/i.test(url.pathname)) {
    throw new Error("url must include a Google Meet meeting code");
  }
  return url.toString();
}

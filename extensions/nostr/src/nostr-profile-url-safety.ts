import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { isBlockedHostnameOrIp } from "../runtime-api.js";

export function validateUrlSafety(urlStr: string): { ok: true } | { ok: false; error: string } {
  try {
    const url = new URL(urlStr);

    if (url.protocol !== "https:") {
      return { ok: false, error: "URL must use https:// protocol" };
    }

    const hostname = normalizeLowercaseStringOrEmpty(url.hostname);

    if (isBlockedHostnameOrIp(hostname)) {
      return { ok: false, error: "URL must not point to private/internal addresses" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }
}

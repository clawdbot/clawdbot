import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";

export function validateUrlSafety(urlStr: string): { ok: true } | { ok: false; error: string } {
  try {
    const url = new URL(urlStr);

    if (url.protocol !== "https:") {
      return { ok: false, error: "URL must use https:// protocol" };
    }

    const hostname = url.hostname.trim().toLowerCase();

    if (isBlockedHostnameOrIp(hostname)) {
      return { ok: false, error: "URL must not point to private/internal addresses" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }
}

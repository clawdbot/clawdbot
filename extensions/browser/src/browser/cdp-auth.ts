function decodeUrlUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Merge URL basic-auth credentials into headers without overriding explicit auth. */
export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const mergedHeaders = { ...headers };
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(mergedHeaders).some(
      (key) => key.trim().toLowerCase() === "authorization",
    );
    if (hasAuthHeader) {
      return mergedHeaders;
    }
    if (parsed.username || parsed.password) {
      const username = decodeUrlUserInfo(parsed.username);
      const password = decodeUrlUserInfo(parsed.password);
      const auth = Buffer.from(`${username}:${password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

/** Remove URL userinfo after callers have converted it to an Authorization header. */
export function stripCdpUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) {
      return url;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

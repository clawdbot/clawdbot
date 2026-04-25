const BROWSER_SERVICE_RATE_LIMIT_MESSAGE =
  "Browser service rate limit reached. " +
  "Wait for the current session to complete, or retry later.";

const BROWSERBASE_RATE_LIMIT_MESSAGE =
  "Browserbase rate limit reached (max concurrent sessions). " +
  "Wait for the current session to complete, or upgrade your plan.";

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isBrowserbaseUrl(url: string): boolean {
  if (!isAbsoluteHttp(url)) {
    return false;
  }
  try {
    const host = new URL(url).hostname.trim().toLowerCase();
    return host === "browserbase.com" || host.endsWith(".browserbase.com");
  } catch {
    return false;
  }
}

export function resolveBrowserRateLimitMessage(url: string): string {
  return isBrowserbaseUrl(url)
    ? BROWSERBASE_RATE_LIMIT_MESSAGE
    : BROWSER_SERVICE_RATE_LIMIT_MESSAGE;
}

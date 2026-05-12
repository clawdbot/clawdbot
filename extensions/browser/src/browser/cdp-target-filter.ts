const BROWSER_INTERNAL_TARGET_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "edge://",
  "brave://",
  "vivaldi://",
  "opera://",
];

export type BrowserTargetUrlLike = {
  url?: string | null;
};

export function isBrowserInternalTargetUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return BROWSER_INTERNAL_TARGET_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isSelectableCdpBrowserTarget(target: BrowserTargetUrlLike): boolean {
  return !isBrowserInternalTargetUrl(target.url);
}

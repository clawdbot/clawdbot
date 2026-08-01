/**
 * CDP target filtering helpers.
 *
 * Browser-internal pages cannot be reliably automated as user content, so tab
 * selection filters them before exposing targets to browser actions.
 */
const BROWSER_INTERNAL_TARGET_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "edge://",
  "brave://",
  "vivaldi://",
  "opera://",
];

type BrowserTargetUrlLike = {
  url?: string | null;
  type?: string | null;
};

/** Return true for browser-owned chrome/devtools/internal URLs. */
function isBrowserInternalTargetUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return BROWSER_INTERNAL_TARGET_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Return true when a CDP page target should be selectable by user-facing actions. */
export function isSelectableCdpBrowserTarget(target: BrowserTargetUrlLike): boolean {
  return target.type === "page" && !isBrowserInternalTargetUrl(target.url);
}

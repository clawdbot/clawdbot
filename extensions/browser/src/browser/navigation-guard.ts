/**
 * Browser navigation SSRF guard.
 *
 * Validates page navigation URLs and redirect chains before or after browser
 * navigation while accounting for browser proxy routing.
 */
import { isIP } from "node:net";
import {
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import { matchesHostnameAllowlist, normalizeHostname } from "../sdk-security-runtime.js";
import {
  BROWSER_OAUTH_CALLBACK_PATH_RE,
  BROWSER_OAUTH_CREDENTIAL_QUERY_KEYS,
  BROWSER_OPAQUE_CREDENTIAL_PATH_RE,
  getBrowserUrlParameterSets,
  hasBrowserOAuthContext,
  isBrowserGenericCredentialQueryKey,
  isBrowserCredentialQueryKey,
} from "./browser-url-credentials.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
const NAVIGATION_BLOCKED_QUERY_KEYS = new Set([
  ...BROWSER_OAUTH_CREDENTIAL_QUERY_KEYS,
  "client_secret",
]);
const BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE =
  "Navigation blocked: URL-embedded credentials are not supported for page navigation. Set HTTP Basic auth with `openclaw browser set credentials <username> <password>` or use an authenticated browser profile.";
const BROWSER_OPAQUE_CREDENTIAL_PATH_GLOBAL_RE = new RegExp(
  BROWSER_OPAQUE_CREDENTIAL_PATH_RE.source,
  "giu",
);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // Keep non-network navigation explicit; about:blank is the only allowed bootstrap URL.
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

function hasNavigationCredentialQuery(parsed: URL): boolean {
  const parameterSets = getBrowserUrlParameterSets(parsed);
  return parameterSets.some((params) =>
    [...params].some(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      return (
        value.trim().length > 0 &&
        (NAVIGATION_BLOCKED_QUERY_KEYS.has(normalizedKey) ||
          isBrowserGenericCredentialQueryKey(key))
      );
    }),
  );
}

function getNavigationHashParts(hash: string): {
  route: string;
  rawQuery?: string;
  hasQueryDelimiter: boolean;
  params?: URLSearchParams;
} {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = fragment.indexOf("?");
  const route =
    queryIndex >= 0
      ? fragment.slice(0, queryIndex)
      : fragment.startsWith("/") || !fragment.includes("=")
        ? fragment
        : "";
  const hasQueryDelimiter = queryIndex >= 0;
  const query = queryIndex >= 0 ? fragment.slice(queryIndex + 1) : route ? "" : fragment;
  return {
    route,
    ...(queryIndex >= 0 || !route ? { rawQuery: query } : {}),
    hasQueryDelimiter,
    ...(query.includes("=") ? { params: new URLSearchParams(query) } : {}),
  };
}

function redactNavigationParameterSet(
  params: URLSearchParams,
  oauthContext: boolean,
): { value: string; changed: boolean } {
  const redacted = new URLSearchParams();
  let changed = false;
  for (const [key, value] of params) {
    const shouldRedact = isBrowserCredentialQueryKey(key, oauthContext);
    const redactedValue = shouldRedact ? "REDACTED" : value;
    changed ||= redactedValue !== value;
    redacted.append(key, redactedValue);
  }
  return { value: redacted.toString(), changed };
}

function redactOpaqueCredentialPath(value: string): { value: string; changed: boolean } {
  const redacted = value.replace(BROWSER_OPAQUE_CREDENTIAL_PATH_GLOBAL_RE, "$1REDACTED");
  return { value: redacted, changed: redacted !== value };
}

/** Redact URL credentials while preserving safe navigation context for output. */
export function redactBrowserNavigationUrl(url: string): string {
  const rawUrl = url.trim();
  if (!rawUrl) {
    return rawUrl;
  }
  try {
    const parsed = new URL(rawUrl);
    const originalUsername = parsed.username;
    const originalPassword = parsed.password;
    const originalPathname = parsed.pathname;
    const originalSearch = parsed.search;
    const originalHash = parsed.hash;
    parsed.username = "";
    parsed.password = "";
    const hashParts = getNavigationHashParts(parsed.hash);
    const parameterSets = getBrowserUrlParameterSets(parsed);
    const hashRoute = hashParts.route;
    const oauthContext =
      hasBrowserOAuthContext(parsed, parameterSets) ||
      BROWSER_OAUTH_CALLBACK_PATH_RE.test(hashRoute);
    const redactedPathname = redactOpaqueCredentialPath(parsed.pathname);
    if (redactedPathname.changed) {
      parsed.pathname = redactedPathname.value;
    }
    const redactedSearch = redactNavigationParameterSet(parsed.searchParams, oauthContext);
    if (redactedSearch.changed) {
      parsed.search = `?${redactedSearch.value}`;
    }
    const redactedHashRoute = redactOpaqueCredentialPath(hashParts.route);
    const redactedHash = hashParts.params
      ? redactNavigationParameterSet(hashParts.params, oauthContext)
      : undefined;
    if (redactedHashRoute.changed || redactedHash?.changed) {
      const route = redactedHashRoute.value;
      const query = redactedHash?.value ?? hashParts.rawQuery;
      const querySeparator = hashParts.hasQueryDelimiter ? "?" : "";
      parsed.hash = `#${route}${query !== undefined ? `${querySeparator}${query}` : ""}`;
    }
    return originalUsername === parsed.username &&
      originalPassword === parsed.password &&
      originalPathname === parsed.pathname &&
      originalSearch === parsed.search &&
      originalHash === parsed.hash
      ? rawUrl
      : parsed.toString();
  } catch {
    return "[redacted invalid browser URL]";
  }
}

/** Raised when a browser navigation URL fails syntax or policy validation. */
export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

/** Parse a page-navigation URL and reject credentials before any transport dispatch. */
export function parseBrowserNavigationUrl(url: string): URL {
  const rawUrl = url.trim();
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const diagnostic = rawUrl.includes("@") ? "[redacted credential-bearing URL]" : rawUrl;
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${diagnostic}`);
  }

  if (parsed.username || parsed.password || hasNavigationCredentialQuery(parsed)) {
    throw new InvalidBrowserNavigationUrlError(BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE);
  }
  return parsed;
}

/** Policy inputs applied to browser page navigation checks. */
export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationProxyMode;
};

/** Describes whether the browser itself is routing page traffic through a proxy. */
export type BrowserNavigationProxyMode = "direct" | "explicit-browser-proxy";

/** Minimal request shape used to walk browser redirect chains. */
type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

/** Build a navigation-policy object while omitting default direct proxy mode. */
export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
  opts?: { browserProxyMode?: BrowserNavigationProxyMode },
): BrowserNavigationPolicyOptions {
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(opts?.browserProxyMode && opts.browserProxyMode !== "direct"
      ? { browserProxyMode: opts.browserProxyMode }
      : {}),
  };
}

/** Return true when strict policy requires redirect-chain inspection. */
function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean {
  return ssrfPolicy?.dangerouslyAllowPrivateNetwork === false;
}

/** Return true when a URL needs redirect inspection under strict policy. */
export function requiresInspectableBrowserNavigationRedirectsForUrl(
  url: string,
  ssrfPolicy?: SsrFPolicy,
): boolean {
  if (!requiresInspectableBrowserNavigationRedirects(ssrfPolicy)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isIpLiteralHostname(hostname: string): boolean {
  return isIP(normalizeHostname(hostname)) !== 0;
}

function isExplicitlyAllowedBrowserHostname(hostname: string, ssrfPolicy?: SsrFPolicy): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const allowedHostnames = (ssrfPolicy?.allowedHostnames ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter(Boolean);
  return allowedHostnames.length > 0
    ? matchesHostnameAllowlist(normalizedHostname, allowedHostnames)
    : false;
}

/** Assert that a requested browser navigation URL is policy-allowed. */
export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const parsed = parseBrowserNavigationUrl(opts.url);

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  // Browser proxy routing hides the final connect target from this process.
  // Only block when the browser profile is known to be proxy-routed; Gateway
  // provider proxy env alone is not proof of browser page proxy behavior.
  if (
    opts.browserProxyMode === "explicit-browser-proxy" &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed",
    );
  }

  // Browser navigations happen in Chromium's network stack, not Node's. In
  // strict mode, a hostname-based URL would be resolved twice by different
  // resolvers, so Node-side pinning cannot guarantee the browser connects to
  // the same address that passed policy checks.
  if (
    opts.ssrfPolicy &&
    opts.ssrfPolicy.dangerouslyAllowPrivateNetwork === false &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) &&
    !isIpLiteralHostname(parsed.hostname) &&
    !isExplicitlyAllowedBrowserHostname(parsed.hostname, opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy requires an IP-literal URL because browser DNS rebinding protections are unavailable for hostname-based navigation",
    );
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://). In strict
 * mode this intentionally re-applies the hostname gate after redirects.
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = opts.url.trim();
  if (!rawUrl) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) ||
    isAllowedNonNetworkNavigationUrl(parsed)
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}

/** Assert that every URL in a browser redirect chain is policy-allowed. */
export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const url of chain.toReversed()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
    });
  }
}

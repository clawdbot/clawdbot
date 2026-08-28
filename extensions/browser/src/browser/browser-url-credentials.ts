/** Shared URL credential classification for Browser Steward redaction paths. */

const BROWSER_SIGNED_URL_QUERY_KEYS = new Set([
  "sig",
  "signature",
  "se",
  "sp",
  "sr",
  "st",
  "sv",
  "skoid",
  "sktid",
  "skt",
  "ske",
  "sks",
  "skv",
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-algorithm",
  "x-goog-credential",
  "x-goog-date",
  "x-goog-expires",
  "x-goog-signature",
]);

export const BROWSER_OAUTH_CREDENTIAL_QUERY_KEYS = new Set([
  "access_token",
  "auth_code",
  "authorization_code",
  "code_verifier",
  "id_token",
  "oauth_token",
  "oauth_verifier",
  "refresh_token",
]);

const BROWSER_OAUTH_CONTEXT_QUERY_KEYS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "iss",
  "nonce",
  "redirect_uri",
  "response_type",
  "scope",
  "session_state",
  "state",
]);

export const BROWSER_OAUTH_CALLBACK_PATH_RE =
  /(?:^|[\\/._-])(?:auth|authorize|authorization|callback|oidc|oauth2?|signin-oidc|sso)(?:[\\/._-]|$)/iu;
export const BROWSER_OPAQUE_CREDENTIAL_PATH_RE =
  /((?:^|\/)(?:password[-_]?reset|reset|magic[-_]?login|verify|verification|invite|invitation)\/)([^/?#]+)(?=\/|$)/iu;

type BrowserUrlCredentialClass =
  | "api key"
  | "password"
  | "token"
  | "cookie"
  | "private key"
  | "secret";

const BROWSER_GENERIC_CREDENTIAL_QUERY_KEYS = new Map<string, BrowserUrlCredentialClass>([
  ["api_key", "api key"],
  ["apikey", "api key"],
  ["x_api_key", "api key"],
  ["password", "password"],
  ["passphrase", "password"],
  ["passwd", "password"],
  ["authorization", "token"],
  ["bearer", "token"],
  ["auth_token", "token"],
  ["access_token", "token"],
  ["refresh_token", "token"],
  ["id_token", "token"],
  ["oauth_token", "token"],
  ["oauth_verifier", "token"],
  ["session_token", "token"],
  ["csrf_token", "token"],
  ["xsrf_token", "token"],
  ["bearer_token", "token"],
  ["token", "token"],
  ["cookie", "cookie"],
  ["session_cookie", "cookie"],
  ["private_key", "private key"],
  ["privatekey", "private key"],
  ["seed", "private key"],
  ["seed_phrase", "private key"],
  ["mnemonic", "private key"],
  ["recovery_phrase", "private key"],
  ["secret", "secret"],
  ["credential", "secret"],
]);

function classifyGenericCredentialQueryKey(key: string): BrowserUrlCredentialClass | undefined {
  const normalizedKey = key.toLowerCase().replace(/[\s-]+/g, "_");
  return BROWSER_GENERIC_CREDENTIAL_QUERY_KEYS.get(normalizedKey);
}

export function getBrowserUrlParameterSets(parsed: URL): URLSearchParams[] {
  const sets = [parsed.searchParams];
  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const queryIndex = fragment.indexOf("?");
  const query = queryIndex >= 0 ? fragment.slice(queryIndex + 1) : fragment;
  if (query.includes("=")) {
    sets.push(new URLSearchParams(query));
  }
  return sets;
}

export function hasBrowserOAuthContext(
  parsed: URL,
  parameterSets: URLSearchParams[] = getBrowserUrlParameterSets(parsed),
): boolean {
  return (
    BROWSER_OAUTH_CALLBACK_PATH_RE.test(parsed.pathname) ||
    parameterSets.some((params) =>
      [...params.keys()].some((key) => BROWSER_OAUTH_CONTEXT_QUERY_KEYS.has(key.toLowerCase())),
    )
  );
}

export function isBrowserCredentialQueryKey(key: string, oauthContext: boolean): boolean {
  return classifyBrowserCredentialQueryKey(key, oauthContext) !== undefined;
}

export function isBrowserGenericCredentialQueryKey(key: string): boolean {
  return classifyGenericCredentialQueryKey(key) !== undefined;
}

function classifyBrowserCredentialQueryKey(
  key: string,
  oauthContext: boolean,
): BrowserUrlCredentialClass | undefined {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "client_secret") {
    return "secret";
  }
  if (
    BROWSER_SIGNED_URL_QUERY_KEYS.has(normalizedKey) ||
    BROWSER_OAUTH_CREDENTIAL_QUERY_KEYS.has(normalizedKey) ||
    (normalizedKey === "code" && oauthContext)
  ) {
    return "token";
  }
  return classifyGenericCredentialQueryKey(key);
}

export function classifyBrowserUrlCredential(
  value: string,
  classifyLabel: (label: string) => string | undefined,
): string | undefined {
  const candidates = value.match(/\bhttps?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/g, ""));
      if (url.username || url.password || BROWSER_OPAQUE_CREDENTIAL_PATH_RE.test(url.pathname)) {
        return url.username || url.password ? "password" : "token";
      }
      const parameterSets = getBrowserUrlParameterSets(url);
      const oauthContext = hasBrowserOAuthContext(url, parameterSets);
      for (const params of parameterSets) {
        for (const [key, queryValue] of params) {
          if (!queryValue.trim()) {
            continue;
          }
          const credentialClass = classifyBrowserCredentialQueryKey(key, oauthContext);
          if (credentialClass) {
            return credentialClass;
          }
          const labelClass = classifyLabel(key);
          if (labelClass) {
            return labelClass;
          }
        }
      }
    } catch {
      // Continue scanning other URL-like values.
    }
  }
  return undefined;
}

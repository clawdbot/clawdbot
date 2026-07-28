// Googlechat plugin module mints Application Default Credentials access tokens
// for keyless (serviceAccountAdc) outbound auth.
//
// On GCE / workload identity, the token is issued by the instance metadata
// server, which lives on the link-local address 169.254.169.254
// (metadata.google.internal). google-auth-library's Compute client would fetch
// it via gcp-metadata's own gaxios instance, i.e. OUTSIDE OpenClaw's SSRF
// guard. Instead we mint the token ourselves and route the request through
// fetchWithSsrFGuard with a narrowly-scoped policy: the metadata host is
// hostname-allowlisted AND the private-network opt-in is set (the guard's only
// sanctioned path to the link-local metadata IP). Without that policy the guard
// blocks the metadata server by default, so keyless auth never reaches the
// network boundary through an unguarded transport.
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
  mergeSsrFPolicies,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

const METADATA_HOST = "metadata.google.internal";
const METADATA_TOKEN_URL = `http://${METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/token`;

// Scope the guard opt-in as tightly as the guard allows: only the metadata
// host, only with the private-network flag. This is the same idiom other
// extensions use to reach a trusted private-network endpoint (see fal / tlon).
// Built lazily (not at module load) so partial mocks of ssrf-runtime in
// unrelated tests don't have to stub these helpers just to import auth.ts.
let metadataTokenPolicy: SsrFPolicy | undefined;
let metadataTokenPolicyBuilt = false;

/** @internal Exported for tests: asserts the metadata-boundary policy shape. */
export function getMetadataTokenPolicy(): SsrFPolicy | undefined {
  if (!metadataTokenPolicyBuilt) {
    metadataTokenPolicy = mergeSsrFPolicies(
      buildHostnameAllowlistPolicyFromSuffixAllowlist([METADATA_HOST]),
      ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
    );
    metadataTokenPolicyBuilt = true;
  }
  return metadataTokenPolicy;
}

const METADATA_TOKEN_TIMEOUT_MS = 30_000;
const MAX_METADATA_TOKEN_BYTES = 64 * 1024;
// Treat a token as expired slightly early so we never hand out one that lapses
// mid-request.
const TOKEN_EXPIRY_SKEW_MS = 60_000;

type MetadataTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
};

type GuardedFetch = typeof fetchWithSsrFGuard;

// Injection seam for tests (guarded fetch + clock); not exported — tests reach
// it structurally via Parameters<typeof getGoogleChatAdcAccessToken>.
type AdcTokenDeps = {
  guardedFetch?: GuardedFetch;
  now?: () => number;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function requestMetadataToken(
  scopes: readonly string[],
  guardedFetch: GuardedFetch,
): Promise<{ token: string; expiresInSeconds: number }> {
  const url = `${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(scopes.join(","))}`;
  const { response, release } = await guardedFetch({
    url,
    init: { headers: { "Metadata-Flavor": "Google" } },
    policy: getMetadataTokenPolicy(),
    auditContext: "googlechat.auth.adc-metadata",
    timeoutMs: METADATA_TOKEN_TIMEOUT_MS,
  });
  try {
    if (!response.ok) {
      throw new Error(`Google Chat ADC token request failed (${response.status})`);
    }
    const parsed = await readProviderJsonResponse<MetadataTokenResponse>(
      response,
      "Google Chat ADC token fetch failed",
      { maxBytes: MAX_METADATA_TOKEN_BYTES },
    );
    const token = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
    if (!token) {
      throw new Error("Google Chat ADC token response missing access_token");
    }
    const expiresInSeconds =
      typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : 0;
    return { token, expiresInSeconds };
  } finally {
    await release();
  }
}

/**
 * Return an access token for the ambient service account, minted via the GCE
 * metadata server through the SSRF guard. Cached until shortly before expiry.
 */
export async function getGoogleChatAdcAccessToken(
  scopes: readonly string[],
  deps: AdcTokenDeps = {},
): Promise<string> {
  const cacheKey = scopes.toSorted().join(",");
  const now = deps.now ?? Date.now;
  const currentTime = now();

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_EXPIRY_SKEW_MS > currentTime) {
    return cached.token;
  }

  const guardedFetch = deps.guardedFetch ?? fetchWithSsrFGuard;
  const { token, expiresInSeconds } = await requestMetadataToken(scopes, guardedFetch);
  tokenCache.set(cacheKey, {
    token,
    expiresAt: currentTime + Math.max(0, expiresInSeconds) * 1000,
  });
  return token;
}

/** @internal Clears the module-scoped token cache between tests. */
export function resetAdcTokenCacheForTests(): void {
  tokenCache.clear();
}
